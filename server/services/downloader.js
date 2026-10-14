import { spawn, execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import ffmpegStatic from 'ffmpeg-static';

// Automatically detect Python command (python3 on Linux/Render, python on Windows)
function getPythonCommand() {
  const candidates = ['python3', 'python', 'py'];
  for (const cmd of candidates) {
    try {
      execSync(`${cmd} --version`, { stdio: 'ignore' });
      return cmd;
    } catch (e) {
      // continue to next candidate
    }
  }
  return 'python3';
}

export const PYTHON_BIN = getPythonCommand();
console.log(`[Downloader Engine] Using Python binary: "${PYTHON_BIN}"`);

// Automatically detect robust ffmpeg path:
// On Linux/Docker (Render), ALWAYS use the native system /usr/bin/ffmpeg (apt installed) to avoid ffmpeg-static SIGSEGV code -11
// On Windows, use ffmpeg-static (ffmpeg.exe)
let ffmpegPath = '';
if (process.platform === 'linux') {
  if (fs.existsSync('/usr/bin/ffmpeg')) {
    ffmpegPath = '/usr/bin/ffmpeg';
  } else {
    try {
      const candidate = execSync('which ffmpeg', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }).trim();
      if (candidate && fs.existsSync(candidate)) ffmpegPath = candidate;
    } catch (_) {}
  }
}

if (!ffmpegPath) {
  if (ffmpegStatic && fs.existsSync(ffmpegStatic)) {
    ffmpegPath = ffmpegStatic;
  }
}
console.log(`[Downloader Engine] Using FFmpeg binary: "${ffmpegPath || 'system PATH'}"`);

const COOKIE_FILE = path.resolve('ytdlp_session_cookies.txt');

// Remove legacy root cookies.txt to prevent yt-dlp from implicitly auto-loading it
try {
  const legacyCookie = path.resolve('cookies.txt');
  if (fs.existsSync(legacyCookie)) {
    fs.unlinkSync(legacyCookie);
  }
} catch (e) {}

if (process.env.YTDLP_COOKIES && process.env.YTDLP_COOKIES.trim().length > 0) {
  try {
    const raw = process.env.YTDLP_COOKIES.trim();
    const unescaped = raw.replace(/\\r\\n/g, '\n').replace(/\\n/g, '\n');
    let lines = unescaped.split(/\r?\n/).map(line => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return line;
      const parts = trimmed.split(/\s+/);
      if (parts.length >= 7) {
        return parts.slice(0, 6).concat(parts.slice(6).join(' ')).join('\t');
      }
      return line;
    });
    if (!lines[0] || !lines[0].includes('Netscape')) {
      lines.unshift('# Netscape HTTP Cookie File');
    }
    fs.writeFileSync(COOKIE_FILE, lines.join('\n'), 'utf8');
    console.log('[Downloader Engine] Initialized and normalized session cookies.');
  } catch (e) {
    console.error('[Downloader Engine] Failed to write cookies from env:', e.message);
  }
}

if (fs.existsSync(COOKIE_FILE)) {
  const content = fs.readFileSync(COOKIE_FILE, 'utf8');
  const cookieLines = content.split('\n').filter(l => l.trim() && !l.startsWith('#'));
  console.log(`[Downloader Engine] Cookie file lines: ${cookieLines.length}`);
  console.log(`[Downloader Engine] Has tabs: ${content.includes('\t')}`);
  console.log(`[Downloader Engine] First line starts with: ${content.split('\n')[0]}`);
} else {
  console.log('[Downloader Engine] Cookie file NOT found');
}

// Helper to detect if URL belongs to YouTube
function isYouTubeUrl(rawUrl) {
  if (!rawUrl) return false;
  return /(?:youtube\.com|youtu\.be)/i.test(rawUrl);
}

/**
 * Common yt-dlp arguments for anti-bot bypass & headers
 */
export function buildYtdlpArgs(url = '', useCookies = true) {
  const args = [
    '--ignore-config',
    '--no-warnings',
    '--no-playlist',
    '--no-check-formats',
    '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
    '--add-header', 'Accept-Language:en-US,en;q=0.9',
    '--retries', '2',
    '--socket-timeout', '20',
    '--force-ipv4',
  ];

  if (ffmpegPath) {
    args.push('--ffmpeg-location', ffmpegPath);
  }

  if (useCookies) {
    const cookiePath = process.env.YTDLP_COOKIES_PATH
      ? path.resolve(process.env.YTDLP_COOKIES_PATH)
      : (fs.existsSync(COOKIE_FILE) ? COOKIE_FILE : null);

    if (cookiePath && fs.existsSync(cookiePath)) {
      args.push('--cookies', cookiePath);
    }
  }

  // Optimize proxy bandwidth: Apply proxy ONLY for YouTube to protect proxy data limits!
  // TikTok, Instagram, Facebook, Twitter, Pinterest download directly on unlimited server network.
  if (process.env.YTDLP_PROXY && (!url || isYouTubeUrl(url))) {
    args.push('--proxy', process.env.YTDLP_PROXY);
  }

  return args;
}

/**
 * Helper to run yt-dlp metadata extraction
 */
function execYtdlpJson(url, extraArgs = [], useCookies = true) {
  return new Promise((resolve, reject) => {
    const args = [
      '-m', 'yt_dlp',
      '--dump-single-json',
      ...buildYtdlpArgs(url, useCookies),
      ...extraArgs,
      url,
    ];

    const child = spawn(PYTHON_BIN, args, {
      windowsHide: true,
      maxBuffer: 1024 * 1024 * 35,
    });

    let stdoutData = '';
    let stderrData = '';

    child.stdout.on('data', (chunk) => {
      stdoutData += chunk.toString();
    });

    child.stderr.on('data', (chunk) => {
      stderrData += chunk.toString();
    });

    child.on('close', (code) => {
      if (code !== 0) {
        return reject({ code, stderr: stderrData });
      }
      try {
        resolve(JSON.parse(stdoutData));
      } catch (err) {
        reject({ code: -1, stderr: `JSON parse error: ${err.message}` });
      }
    });

    child.on('error', (err) => {
      reject({ code: -1, stderr: err.message });
    });
  });
}

/**
 * Get video metadata with automatic multi-tier fallback
 */
export async function getVideoInfo(url) {
  let rawInfo = null;

  // Attempt 1: Standard extraction (with normalized cookies + node JS runtime)
  try {
    rawInfo = await execYtdlpJson(url, [], true);
  } catch (err1) {
    console.warn('[Downloader Engine] Primary extraction attempt failed, trying fallback client...', err1.stderr || err1);

    // Attempt 2: Fallback extraction (desktop web + tv client bypass)
    try {
      rawInfo = await execYtdlpJson(url, ['--extractor-args', 'youtube:player_client=web,tv'], false);
    } catch (err2) {
      console.error('[Downloader Engine] Fallback extraction failed:', err2.stderr || err2);
      const cleanErr = (err2.stderr || err1.stderr || 'Failed to extract video information').trim();
      throw new Error(cleanErr);
    }
  }

  try {
    const rawFormats = Array.isArray(rawInfo.formats) ? rawInfo.formats : [];
    const duration = rawInfo.duration || 0;

    // Separate audio formats & find best audio size
    const audioFormats = rawFormats.filter(f => f.acodec !== 'none' && f.vcodec === 'none');
    const bestAudio = audioFormats.sort((a, b) => (b.filesize || b.abr || 0) - (a.filesize || a.abr || 0))[0];
    let audioSize = bestAudio?.filesize || bestAudio?.filesize_approx;
    if (!audioSize && bestAudio?.abr && duration) {
      audioSize = Math.round((bestAudio.abr * 1000 / 8) * duration);
    }
    if (!audioSize && duration) {
      audioSize = Math.round(16000 * duration); // ~128kbps fallback
    }

    // Video formats
    const videoFormats = rawFormats.filter(f => f.vcodec !== 'none');
    
    // Find all unique available heights from video formats (supports both horizontal & vertical videos like TikTok/Reels)
    const availableHeights = new Set();
    videoFormats.forEach(f => {
      let h = f.height;
      if (!h && f.format_note) {
        const m = f.format_note.match(/(\d+)p/);
        if (m) h = parseInt(m[1], 10);
      }
      const effectiveRes = (f.width && f.height) ? Math.min(f.width, f.height) : h;
      if (effectiveRes) availableHeights.add(effectiveRes);
    });

    if (rawInfo.height) {
      const rawRes = (rawInfo.width && rawInfo.height) ? Math.min(rawInfo.width, rawInfo.height) : rawInfo.height;
      availableHeights.add(rawRes);
    }

    const maxHeight = availableHeights.size > 0 ? Math.max(...availableHeights) : (rawInfo.height || 720);

    // Standard resolution tiers: from 8K down to 360p
    const RESOLUTION_TIERS = [
      { minHeight: 3800, id: '4320', label: '8K Ultra HD (4320p)', shortLabel: '8K Ultra HD', badge: 'ultra', estByteRate: 14 * 1024 * 1024 },
      { minHeight: 2000, id: '2160', label: '4K Ultra HD (2160p)', shortLabel: '4K Ultra HD', badge: 'ultra', estByteRate: 5.5 * 1024 * 1024 },
      { minHeight: 1300, id: '1440', label: '2K Quad HD (1440p)', shortLabel: '2K Quad HD', badge: 'hd', estByteRate: 2.8 * 1024 * 1024 },
      { minHeight: 900,  id: '1080', label: '1080p Full HD', shortLabel: '1080p Full HD', badge: 'hd', estByteRate: 1.3 * 1024 * 1024 },
      { minHeight: 600,  id: '720',  label: '720p HD', shortLabel: '720p HD', badge: 'hd', estByteRate: 0.6 * 1024 * 1024 },
      { minHeight: 400,  id: '480',  label: '480p SD', shortLabel: '480p SD', badge: 'sd', estByteRate: 0.28 * 1024 * 1024 },
      { minHeight: 250,  id: '360',  label: '360p Fast', shortLabel: '360p Fast', badge: 'sd', estByteRate: 0.14 * 1024 * 1024 },
    ];

    // Filter tiers that actually exist in this video
    const matchedTiers = [];
    for (let i = 0; i < RESOLUTION_TIERS.length; i++) {
      const tier = RESOLUTION_TIERS[i];
      const upperTier = i > 0 ? RESOLUTION_TIERS[i - 1] : null;

      const hasTier = Array.from(availableHeights).some(h => {
        if (upperTier) {
          return h >= tier.minHeight && h < upperTier.minHeight;
        }
        return h >= tier.minHeight;
      }) || (matchedTiers.length === 0 && maxHeight >= tier.minHeight);

      if (hasTier) {
        const matchingFormats = videoFormats.filter(f => {
          const rawH = f.height || (f.format_note && parseInt(f.format_note)) || 0;
          const h = (f.width && f.height) ? Math.min(f.width, f.height) : rawH;
          if (upperTier) return h >= tier.minHeight && h < upperTier.minHeight;
          return h >= tier.minHeight;
        });

        const bestFmt = matchingFormats.sort((a, b) => {
          const aIsMp4 = a.ext === 'mp4' ? 1 : 0;
          const bIsMp4 = b.ext === 'mp4' ? 1 : 0;
          if (bIsMp4 !== aIsMp4) return bIsMp4 - aIsMp4;
          const aSize = a.filesize || a.filesize_approx || (a.tbr && duration ? Math.round((a.tbr * 1000 / 8) * duration) : 0);
          const bSize = b.filesize || b.filesize_approx || (b.tbr && duration ? Math.round((b.tbr * 1000 / 8) * duration) : 0);
          return aSize - bSize;
        })[0] || matchingFormats[0];

        let vSize = bestFmt?.filesize || bestFmt?.filesize_approx;
        if (!vSize && (bestFmt?.vbr || bestFmt?.tbr) && duration) {
          vSize = Math.round(((bestFmt.vbr || bestFmt.tbr) * 1000 / 8) * duration);
        }
        if (!vSize && duration) {
          vSize = Math.round(tier.estByteRate * duration);
        }

        const totalSize = vSize ? (vSize + (bestFmt?.acodec === 'none' ? (audioSize || 0) : 0)) : Math.round(tier.estByteRate * (duration || 30));

        matchedTiers.push({
          id: tier.id,
          label: tier.label,
          shortLabel: tier.shortLabel,
          badge: tier.badge,
          height: tier.minHeight,
          ext: 'mp4',
          type: 'video',
          filesize: totalSize,
          filesizeFormatted: formatBytes(totalSize)
        });
      }
    }

    if (matchedTiers.length === 0) {
      const fallbackTier = maxHeight >= 720 ? RESOLUTION_TIERS[4] : RESOLUTION_TIERS[5];
      const estSize = Math.round(fallbackTier.estByteRate * (duration || 60));
      matchedTiers.push({
        id: fallbackTier.id,
        label: fallbackTier.label,
        shortLabel: fallbackTier.shortLabel,
        badge: fallbackTier.badge,
        height: fallbackTier.minHeight,
        ext: 'mp4',
        type: 'video',
        filesize: estSize,
        filesizeFormatted: formatBytes(estSize)
      });
    }

    const topTier = matchedTiers[0];
    const maxQualityLabel = topTier.shortLabel;

    const bestPreset = {
      id: 'best_with_audio',
      label: `Download Best Quality (${maxQualityLabel})`,
      shortLabel: maxQualityLabel,
      ext: 'mp4',
      type: 'video',
      filesize: topTier.filesize,
      filesizeFormatted: topTier.filesizeFormatted,
      isRecommended: true
    };

    const audioPreset = {
      id: 'audio_best',
      label: 'MP3 Audio (High Quality)',
      shortLabel: 'MP3 Audio',
      ext: 'mp3',
      type: 'audio',
      filesize: audioSize || Math.round(16000 * (duration || 60)),
      filesizeFormatted: formatBytes(audioSize || Math.round(16000 * (duration || 60)))
    };

    const presets = [bestPreset, ...matchedTiers, audioPreset];

    // Formats list for advanced inspection
    const formats = [];
    const seenHeights = new Set();
    const sortedFormats = videoFormats.sort((a, b) => (b.height || 0) - (a.height || 0));

    for (const f of sortedFormats) {
      const height = f.height || (f.format_note && f.format_note.match(/\d+p/) ? parseInt(f.format_note) : null);
      const qualityLabel = height ? `${height}p` : (f.format_note || 'Video');
      if (height && seenHeights.has(qualityLabel)) continue;
      if (height) seenHeights.add(qualityLabel);

      formats.push({
        formatId: f.format_id,
        ext: f.ext || 'mp4',
        resolution: qualityLabel,
        filesize: f.filesize || f.filesize_approx || null,
        hasVideo: true,
        hasAudio: f.acodec !== 'none',
        isDirectUrl: !!f.url && f.protocol && !f.protocol.includes('m3u8'),
        directUrl: f.url || null,
        note: f.format_note || ''
      });
    }

    const subtitles = extractSubtitles(rawInfo);

    // Dedicated preview URL for in-browser HTML5 preview (TikTok, Instagram, Facebook, etc.)
    const isYt = isYouTubeUrl(rawInfo.webpage_url || url);
    const directStreamUrl = rawInfo.url || (formats.find(f => f.directUrl && f.hasVideo && !f.directUrl.includes('.m3u8'))?.directUrl) || null;
    
    // Smart Strategy:
    // If video is > 10 minutes (600s) and directStreamUrl is available:
    // Use zero-load /api/proxy-stream with HTTP Range pass-through (0 server storage, instant playback)
    // If video is <= 10 minutes (or directStreamUrl not available):
    // Use lightweight 360p /api/preview (1-2MB, 100% reliable)
    let previewStreamUrl = null;
    if (!isYt) {
      const durationSec = rawInfo.duration || 0;
      if (durationSec > 600 && directStreamUrl) {
        previewStreamUrl = `/api/proxy-stream?url=${encodeURIComponent(directStreamUrl)}`;
      } else {
        previewStreamUrl = `/api/preview?url=${encodeURIComponent(rawInfo.webpage_url || url)}`;
      }
    }

    const cleanInfo = {
      id: rawInfo.id,
      title: rawInfo.title || 'Extracted Media',
      description: rawInfo.description ? rawInfo.description.slice(0, 300) : '',
      thumbnail: rawInfo.thumbnail || (rawInfo.thumbnails && rawInfo.thumbnails.length ? rawInfo.thumbnails[rawInfo.thumbnails.length - 1].url : null),
      duration: rawInfo.duration || 0,
      durationFormatted: formatDuration(rawInfo.duration || 0),
      uploader: rawInfo.uploader || rawInfo.channel || rawInfo.extractor || 'Web Media',
      webpageUrl: rawInfo.webpage_url || url,
      extractor: rawInfo.extractor_key || rawInfo.extractor || 'Universal Web',
      maxQualityLabel,
      maxHeight,
      bestPreset,
      presets,
      formats: formats.slice(0, 15),
      subtitles,
      subtitlesCount: subtitles.length,
      directStreamUrl,
      previewStreamUrl
    };

    return cleanInfo;
  } catch (err) {
    throw new Error(`Failed to parse video info: ${err.message}`);
  }
}

/**
 * Multi-Tier Universal Downloader with FFmpeg Video+Audio multiplexing.
 * Writes to a safe temp file so that:
 * 1. 8K, 4K, 1440p, 1080p, and 720p downloads ALWAYS include clear synchronized sound.
 * 2. Exact Content-Length is sent to browser for full download progress bar.
 * 3. File is cleanly unlinked/deleted immediately upon download finish.
 */
export function streamVideoDownload(url, formatPreset, res) {
  let formatArg;
  const isAudio = formatPreset === 'audio_best' || formatPreset === 'mp3' || (formatPreset && formatPreset.includes('audio') && !formatPreset.includes('best_with_audio'));

  const buildTierFormat = (res) => {
    return `bestvideo[height<=${res}]+bestaudio/bestvideo[width<=${res}]+bestaudio/best[height<=${res}]/best[width<=${res}]/best`;
  };

  if (isAudio) {
    formatArg = 'bestaudio/best';
  } else if (formatPreset === '4320') {
    formatArg = buildTierFormat(4320);
  } else if (formatPreset === '2160') {
    formatArg = buildTierFormat(2160);
  } else if (formatPreset === '1440') {
    formatArg = buildTierFormat(1440);
  } else if (formatPreset === '1080') {
    formatArg = buildTierFormat(1080);
  } else if (formatPreset === '720') {
    formatArg = buildTierFormat(720);
  } else if (formatPreset === '480') {
    formatArg = buildTierFormat(480);
  } else if (formatPreset === '360') {
    formatArg = buildTierFormat(360);
  } else if (formatPreset && formatPreset !== 'best' && formatPreset !== 'best_with_audio') {
    formatArg = buildTierFormat(formatPreset);
  } else {
    // Top quality (8K / 4K / 1080p with audio)
    formatArg = 'bestvideo+bestaudio/best';
  }

  const ext = isAudio ? 'mp3' : 'mp4';
  const tempDir = os.tmpdir();
  const tempFile = path.join(tempDir, `vidsave_${Date.now()}_${Math.random().toString(36).substring(7)}.${ext}`);

  const args = [
    '-m', 'yt_dlp',
    '-f', formatArg,
  ];

  if (isAudio) {
    args.push('-x', '--audio-format', 'mp3', '--audio-quality', '0');
  } else {
    args.push(
      '--merge-output-format', 'mp4',
      '--postprocessor-args', 'ffmpeg:-c:v copy -c:a aac'
    );
  }

  args.push('-o', tempFile, ...buildYtdlpArgs(url), url);

  console.log(`[Download Stream] Processing ${formatPreset} download into temp container: ${tempFile}`);

  const child = spawn(PYTHON_BIN, args, {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  });

  child.stderr.on('data', (data) => {
    const msg = data.toString();
    if (msg.includes('ERROR:')) {
      console.error('[yt-dlp error]', msg.trim());
    }
  });

  const cleanup = () => {
    try {
      if (fs.existsSync(tempFile)) {
        fs.unlinkSync(tempFile);
      }
      const dir = path.dirname(tempFile);
      const baseNoExt = path.basename(tempFile, path.extname(tempFile));
      const remnants = fs.readdirSync(dir).filter(f => f.startsWith(baseNoExt));
      for (const r of remnants) {
        try { fs.unlinkSync(path.join(dir, r)); } catch (e) {}
      }
    } catch (e) {}
  };

  res.on('close', () => {
    if (!child.killed) {
      try { child.kill('SIGKILL'); } catch (e) {}
    }
    cleanup();
  });

  child.on('close', (code) => {
    let actualFile = tempFile;
    if (!fs.existsSync(actualFile)) {
      const dir = path.dirname(tempFile);
      const baseNoExt = path.basename(tempFile, path.extname(tempFile));
      try {
        const found = fs.readdirSync(dir).find(f => f.startsWith(baseNoExt) && !f.endsWith('.part') && !f.endsWith('.ytdl'));
        if (found) {
          actualFile = path.join(dir, found);
        }
      } catch (e) {}
    }

    if (code !== 0 || !fs.existsSync(actualFile)) {
      console.error(`[Download Stream] yt-dlp execution failed with exit code ${code}`);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Download processing failed. Please check the video link.' });
      }
      cleanup();
      return;
    }

    try {
      const stat = fs.statSync(actualFile);
      if (!res.headersSent) {
        res.setHeader('Content-Length', stat.size);
      }
      const stream = fs.createReadStream(actualFile);
      stream.pipe(res);
      stream.on('close', cleanup);
      stream.on('error', (err) => {
        console.error('[Stream Error]', err);
        cleanup();
      });
    } catch (err) {
      console.error('[File Read Error]', err);
      cleanup();
    }
  });

  child.on('error', (err) => {
    console.error('[spawn error]', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Download spawn failed: ' + err.message });
    }
    cleanup();
  });
}

/**
 * Stream trimmed video/audio section using HTTP range seeking and FFmpeg cut
 */
export function streamTrimmedDownload(url, startTime, endTime, type = 'video', res) {
  const isAudio = type === 'audio' || type === 'mp3';
  const ext = isAudio ? 'mp3' : 'mp4';
  const tempDir = os.tmpdir();
  const tempFile = path.join(tempDir, `vidsave_trim_${Date.now()}_${Math.random().toString(36).substring(7)}.${ext}`);

  const formatTime = (t) => {
    if (typeof t === 'number' || /^\d+(\.\d+)?$/.test(String(t).trim())) {
      const s = Math.max(0, parseFloat(t));
      const hrs = Math.floor(s / 3600);
      const mins = Math.floor((s % 3600) / 60);
      const secs = (s % 60).toFixed(2);
      return `${hrs.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}:${secs.padStart(5, '0')}`;
    }
    return String(t).trim();
  };

  const startSec = Math.max(0, parseFloat(startTime) || 0);
  const endSec = Math.max(startSec + 1, parseFloat(endTime) || (startSec + 10));

  const startStr = formatTime(startSec);
  const endStr = formatTime(endSec);
  const sectionArg = `*${startStr}-${endStr}`;

  console.log(`[Trimmer Engine] Requesting cut range: ${sectionArg} for URL: ${url}`);

  const isYt = isYouTubeUrl(url);
  let formatArg;
  if (isAudio) {
    formatArg = 'bestaudio/best';
  } else if (isYt) {
    formatArg = 'bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=720]+bestaudio/best[height<=720]/best';
  } else {
    // TikTok, Instagram, Twitter, Facebook: Direct single-stream, zero complex merging (prevents code -11)
    formatArg = 'best[height<=1080]/best[ext=mp4]/best';
  }

  const args = [
    '-m', 'yt_dlp',
    '-f', formatArg,
    '--download-sections', sectionArg,
  ];

  if (isAudio) {
    args.push('-x', '--audio-format', 'mp3', '--audio-quality', '0');
  } else if (isYt) {
    // Only separate YouTube DASH streams require merge
    args.push('--merge-output-format', 'mp4');
  }

  args.push(...buildYtdlpArgs(url, true));
  args.push('-o', tempFile, url);

  const cleanup = () => {
    try {
      if (fs.existsSync(tempFile)) {
        fs.unlinkSync(tempFile);
      }
    } catch (e) {
      console.error('[Cleanup Error]', e.message);
    }
  };

  res.on('close', cleanup);
  res.on('finish', cleanup);

  const child = spawn(PYTHON_BIN, args, { windowsHide: true });
  let stderrLog = '';

  child.stderr.on('data', (d) => {
    stderrLog += d.toString();
  });

  child.on('close', (code) => {
    if (code !== 0 || !fs.existsSync(tempFile)) {
      console.error('[Trimmer Failed]', stderrLog);
      if (!res.headersSent) {
        res.status(500).json({ error: `Trimmer processing failed: ${stderrLog.slice(-300)}` });
      }
      cleanup();
      return;
    }

    try {
      const stats = fs.statSync(tempFile);
      res.setHeader('Content-Length', stats.size);
      const stream = fs.createReadStream(tempFile);
      stream.pipe(res);
      stream.on('close', cleanup);
      stream.on('error', (err) => {
        console.error('[Stream Error]', err);
        cleanup();
      });
    } catch (err) {
      console.error('[File Read Error]', err);
      cleanup();
    }
  });

  child.on('error', (err) => {
    console.error('[spawn error]', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Trim spawn failed: ' + err.message });
    }
    cleanup();
  });
}

function formatDuration(seconds) {
  if (!seconds) return '0:00';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  if (mins >= 60) {
    const hrs = Math.floor(mins / 60);
    const remMins = mins % 60;
    return `${hrs}:${remMins < 10 ? '0' : ''}${remMins}:${secs < 10 ? '0' : ''}${secs}`;
  }
  return `${mins}:${secs < 10 ? '0' : ''}${secs}`;
}

function formatBytes(bytes) {
  if (!bytes || isNaN(bytes) || bytes <= 0) return null;
  if (bytes >= 1024 * 1024 * 1024) {
    return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
  }
  if (bytes >= 1024 * 1024) {
    const mb = bytes / (1024 * 1024);
    return mb >= 10 ? Math.round(mb) + ' MB' : mb.toFixed(1) + ' MB';
  }
  // KB files: always show decimal MB (e.g. 760 KB = 0.74 MB), never 0 MB
  const mbDecimal = (bytes / (1024 * 1024)).toFixed(2);
  return (parseFloat(mbDecimal) > 0 ? mbDecimal : '0.01') + ' MB';
}

/**
 * Extract structured subtitles from raw yt-dlp metadata
 */
export function extractSubtitles(rawInfo) {
  if (!rawInfo) return [];
  const subtitles = [];
  const seenKeys = new Set();

  let dn = null;
  try {
    dn = new Intl.DisplayNames(['en'], { type: 'language' });
  } catch (e) {
    // fallback
  }

  const getLangName = (code) => {
    try {
      if (dn) {
        const base = code.split('-')[0].toLowerCase();
        return dn.of(code) || dn.of(base) || code.toUpperCase();
      }
    } catch (e) {}
    return code.toUpperCase();
  };

  // 1. Official / Manual Subtitles (higher accuracy)
  if (rawInfo.subtitles && typeof rawInfo.subtitles === 'object') {
    for (const [langCode, formats] of Object.entries(rawInfo.subtitles)) {
      if (!Array.isArray(formats) || formats.length === 0) continue;

      const bestFmt = formats.find(f => f.ext === 'vtt' && !f.url?.includes('m3u8'))
        || formats.find(f => f.ext === 'srt')
        || formats.find(f => f.url && !f.url?.includes('m3u8'))
        || formats[0];

      let subUrl = bestFmt.url || null;
      if (subUrl && subUrl.includes('timedtext') && subUrl.includes('fmt=')) {
        subUrl = subUrl.replace(/fmt=[^&]+/, 'fmt=vtt');
      }

      const langName = formats[0].name || getLangName(langCode);
      const uniqueKey = `manual_${langCode.toLowerCase()}`;
      seenKeys.add(uniqueKey);

      subtitles.push({
        id: uniqueKey,
        code: langCode,
        language: langName,
        isAuto: false,
        url: subUrl,
        exts: ['srt', 'vtt']
      });
    }
  }

  // 2. Auto-Generated Captions (100+ languages including Sinhala)
  if (rawInfo.automatic_captions && typeof rawInfo.automatic_captions === 'object') {
    for (const [langCode, formats] of Object.entries(rawInfo.automatic_captions)) {
      if (!Array.isArray(formats) || formats.length === 0) continue;

      const bestFmt = formats.find(f => f.ext === 'vtt' && !f.url?.includes('m3u8'))
        || formats.find(f => f.url && !f.url?.includes('m3u8'))
        || formats[0];

      let subUrl = bestFmt.url || null;
      if (subUrl && subUrl.includes('timedtext') && subUrl.includes('fmt=')) {
        subUrl = subUrl.replace(/fmt=[^&]+/, 'fmt=vtt');
      }

      const langName = formats[0].name || getLangName(langCode);
      const uniqueKey = `auto_${langCode.toLowerCase()}`;
      if (seenKeys.has(uniqueKey)) continue;
      seenKeys.add(uniqueKey);

      subtitles.push({
        id: uniqueKey,
        code: langCode,
        language: langName,
        isAuto: true,
        url: subUrl,
        exts: ['srt', 'vtt']
      });
    }
  }

  // Prioritize most common languages: English, Sinhala, Spanish, French, German, Hindi, etc.
  const priorityLangs = ['en', 'si', 'es', 'fr', 'de', 'hi', 'ja', 'zh', 'ar', 'ru', 'pt', 'it', 'id', 'ta'];

  subtitles.sort((a, b) => {
    // Official subtitles appear before auto-generated
    if (a.isAuto !== b.isAuto) return a.isAuto ? 1 : -1;

    const aBase = a.code.split('-')[0].toLowerCase();
    const bBase = b.code.split('-')[0].toLowerCase();
    const aPriority = priorityLangs.indexOf(aBase);
    const bPriority = priorityLangs.indexOf(bBase);

    if (aPriority !== -1 && bPriority === -1) return -1;
    if (aPriority === -1 && bPriority !== -1) return 1;
    if (aPriority !== -1 && bPriority !== -1) return aPriority - bPriority;

    return a.language.localeCompare(b.language);
  });

  return subtitles;
}

/**
 * Convert standard WEBVTT subtitle text to SRT format
 */
export function convertVttToSrt(vttContent) {
  if (!vttContent) return '';
  const lines = vttContent.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const srt = [];
  let counter = 1;
  let inHeader = true;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (inHeader) {
      if (line.includes('-->')) {
        inHeader = false;
      } else {
        continue;
      }
    }

    if (line.includes('-->')) {
      srt.push(counter++);
      const cleanTime = line
        .replace(/(\d{2}:\d{2}:\d{2})\.(\d{3})/g, '$1,$2')
        .replace(/(\d{2}:\d{2})\.(\d{3})/g, '00:$1,$2')
        .replace(/\s+[a-z]+:[^\s]+/gi, '')
        .trim();
      srt.push(cleanTime);
    } else if (line === '') {
      if (srt.length > 0 && srt[srt.length - 1] !== '') {
        srt.push('');
      }
    } else {
      const cleanText = line.replace(/<[^>]+>/g, '').trim();
      if (cleanText) {
        srt.push(cleanText);
      }
    }
  }
  return srt.join('\r\n');
}

/**
 * Convert YouTube SRV1/XML transcript to clean WEBVTT
 */
export function convertSrv1ToVtt(xmlContent) {
  if (!xmlContent) return 'WEBVTT\n';
  const regex = /<text start="([\d.]+)" dur="([\d.]+)"[^>]*>([\s\S]*?)<\/text>/gi;
  let match;
  const vtt = ['WEBVTT\n'];

  function secToTime(sec) {
    const s = Math.max(0, parseFloat(sec) || 0);
    const hrs = Math.floor(s / 3600).toString().padStart(2, '0');
    const mins = Math.floor((s % 3600) / 60).toString().padStart(2, '0');
    const secs = Math.floor(s % 60).toString().padStart(2, '0');
    const ms = Math.floor((s % 1) * 1000).toString().padStart(3, '0');
    return `${hrs}:${mins}:${secs}.${ms}`;
  }

  while ((match = regex.exec(xmlContent)) !== null) {
    const start = parseFloat(match[1]);
    const dur = parseFloat(match[2]);
    const end = start + dur;
    let text = match[3]
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .trim();
    if (text) {
      vtt.push(`${secToTime(start)} --> ${secToTime(end)}\n${text}\n`);
    }
  }
  return vtt.join('\n');
}


