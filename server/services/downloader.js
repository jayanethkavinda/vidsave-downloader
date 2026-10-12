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

const PYTHON_BIN = getPythonCommand();
console.log(`[Downloader Engine] Using Python binary: "${PYTHON_BIN}"`);

// Automatically detect robust ffmpeg path from ffmpeg-static or imageio_ffmpeg
let ffmpegPath = (ffmpegStatic && fs.existsSync(ffmpegStatic)) ? ffmpegStatic : '';
if (!ffmpegPath) {
  try {
    const candidate = execSync(`${PYTHON_BIN} -c "import imageio_ffmpeg; print(imageio_ffmpeg.get_ffmpeg_exe())"`, { 
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore']
    }).trim();
    if (candidate && fs.existsSync(candidate)) {
      ffmpegPath = candidate;
    }
  } catch (e) {
    ffmpegPath = '';
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
function buildYtdlpArgs(url = '', useCookies = true) {
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
    return (bytes / (1024 * 1024 * 1024)).toFixed(1) + ' GB';
  }
  return Math.round(bytes / (1024 * 1024)) + ' MB';
}

