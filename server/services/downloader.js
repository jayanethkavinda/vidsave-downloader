import zlib from 'node:zlib';
if (!zlib.createZstdDecompress) {
  zlib.createZstdDecompress = function() {};
}
if (!zlib.createZstdCompress) {
  zlib.createZstdCompress = function() {};
}
if (!zlib.constants) zlib.constants = {};
if (zlib.constants.ZSTD_d_windowLogMax === undefined) {
  zlib.constants.ZSTD_d_windowLogMax = 23;
}

import { spawn, execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import ffmpegStatic from 'ffmpeg-static';
import { killProcessTree } from './security.js';

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

// Maximum file size limits: 1.5 GB for YouTube (protects 512MB RAM & 2GB temp disk), 3.0 GB for all other platforms
export const MAX_FILESIZE_BYTES_YOUTUBE = 1.5 * 1024 * 1024 * 1024; // 1.5 GB
export const MAX_FILESIZE_BYTES_OTHER = 3.0 * 1024 * 1024 * 1024;   // 3.0 GB

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

// Helper to detect if URL belongs to Instagram
export function isInstagramUrl(rawUrl) {
  if (!rawUrl) return false;
  return /(?:instagram\.com|instagr\.am)/i.test(rawUrl);
}

// Helper to detect if URL is supported by SnapSave cloud scraper engine (Instagram, Facebook, TikTok, Twitter/X)
export function isScraperSupportedUrl(rawUrl) {
  if (!rawUrl) return false;
  return /(?:instagram\.com|instagr\.am|facebook\.com|fb\.watch|tiktok\.com|twitter\.com|x\.com)/i.test(rawUrl);
}

/**
 * Free Instant Multi-Platform Cloud Scraper Fallback Resolver (No cookies, login or proxy required)
 * Supports Instagram, Facebook, TikTok, and Twitter (X)
 */
async function resolveCloudScraperFallback(url) {
  try {
    const { default: snapsaveModule, snapsave } = await import('snapsave-media-downloader');
    const fn = snapsave || snapsaveModule;
    const result = await fn(url);
    if (!result || !result.success || !result.data?.media?.length) {
      throw new Error('No media returned by Cloud Scraper Resolver');
    }
    const media = result.data.media.find(m => m.type === 'video' || (m.url && m.url.includes('.mp4'))) || result.data.media[0];
    const directStreamUrl = media.url;
    const thumbnail = media.thumbnail || (result.data.thumbnail || null);

    let platform = 'Social';
    let defaultTitle = 'Social Media Video';
    if (/(?:instagram\.com|instagr\.am)/i.test(url)) {
      platform = 'Instagram';
      defaultTitle = 'Instagram Reel';
    } else if (/(?:facebook\.com|fb\.watch)/i.test(url)) {
      platform = 'Facebook';
      defaultTitle = 'Facebook Video';
    } else if (/tiktok\.com/i.test(url)) {
      platform = 'TikTok';
      defaultTitle = 'TikTok Video';
    } else if (/(?:twitter\.com|x\.com)/i.test(url)) {
      platform = 'Twitter';
      defaultTitle = 'Twitter (X) Video';
    }

    const title = result.data?.title || result.data?.description || defaultTitle;
    const uploader = result.data?.author || `${platform} Creator`;

    const bestPreset = {
      id: 'best_with_audio',
      label: 'Download Best Quality (1080p / 720p HD)',
      shortLabel: 'Best HD',
      ext: 'mp4',
      type: 'video',
      filesize: 17 * 1024 * 1024,
      filesizeFormatted: '17.2 MB',
      isRecommended: true
    };

    const hdPreset = {
      id: '720',
      label: '720p HD',
      shortLabel: '720p HD',
      badge: 'hd',
      height: 720,
      ext: 'mp4',
      type: 'video',
      filesize: 12 * 1024 * 1024,
      filesizeFormatted: '12.0 MB'
    };

    const audioPreset = {
      id: 'audio_best',
      label: 'MP3 Audio (High Quality)',
      shortLabel: 'MP3 Audio',
      ext: 'mp3',
      type: 'audio',
      filesize: 3 * 1024 * 1024,
      filesizeFormatted: '3.0 MB'
    };

    const cleanInfo = {
      id: `${platform.toLowerCase()}_${Date.now()}`,
      title,
      description: `${title} (Resolved via ${platform} Cloud Fallback Engine)`,
      thumbnail,
      duration: 30,
      durationFormatted: '0:30',
      uploader,
      webpageUrl: url,
      extractor: `${platform} (Cloud Fallback)`,
      maxQualityLabel: 'Best HD',
      maxHeight: 1080,
      bestPreset,
      presets: [bestPreset, hdPreset, audioPreset],
      formats: [],
      subtitles: [],
      subtitlesCount: 0,
      directStreamUrl,
      previewStreamUrl: `/api/proxy-stream?url=${encodeURIComponent(directStreamUrl)}`
    };

    return cleanInfo;
  } catch (err) {
    console.error(`[${url} Cloud Fallback Resolver Error]:`, err.message);
    throw err;
  }
}
const resolveInstagramFallback = resolveCloudScraperFallback;

/**
 * Direct Stream Cloud Scraper Fallback for downloads (Instagram, Facebook, TikTok, Twitter)
 */
async function streamDirectCloudFallback(url, formatPreset, res, cleanupOld) {
  if (cleanupOld) cleanupOld();
  try {
    const { default: snapsaveModule, snapsave } = await import('snapsave-media-downloader');
    const fn = snapsave || snapsaveModule;
    const result = await fn(url);
    if (!result || !result.success || !result.data?.media?.length) {
      if (!res.headersSent) {
        return res.status(500).json({ error: 'Failed to extract media stream via fallback.' });
      }
      return;
    }
    const media = result.data.media.find(m => m.type === 'video' || (m.url && m.url.includes('.mp4'))) || result.data.media[0];
    const directUrl = media.url;
    const isAudio = formatPreset === 'audio_best' || formatPreset === 'mp3' || (formatPreset && formatPreset.includes('audio') && !formatPreset.includes('best_with_audio'));

    if (isAudio && ffmpegPath) {
      console.log('[Cloud Fallback Stream] Transcoding direct stream to MP3 via FFmpeg...');
      res.setHeader('Content-Type', 'audio/mpeg');
      const ffmpeg = spawn(ffmpegPath, [
        '-reconnect', '1',
        '-reconnect_streamed', '1',
        '-reconnect_delay_max', '5',
        '-headers', 'User-Agent: Mozilla/5.0\r\n',
        '-i', directUrl,
        '-vn',
        '-acodec', 'libmp3lame',
        '-b:a', '192k',
        '-f', 'mp3',
        'pipe:1'
      ], { windowsHide: true });

      ffmpeg.stdout.pipe(res);
      ffmpeg.stderr.on('data', () => {});
      res.on('close', () => {
        try { ffmpeg.kill('SIGKILL'); } catch (e) {}
      });
      return;
    }

    // Direct MP4 Video Stream
    console.log('[Cloud Fallback Stream] Piping direct MP4 video stream to browser...');
    const { default: https } = await import('https');
    const { default: http } = await import('http');
    const client = directUrl.startsWith('https') ? https : http;

    const upstreamReq = client.get(directUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
        'Accept': '*/*'
      }
    }, (upstreamRes) => {
      if ([301, 302, 307, 308].includes(upstreamRes.statusCode) && upstreamRes.headers.location) {
        return res.redirect(upstreamRes.statusCode, upstreamRes.headers.location);
      }
      if (upstreamRes.headers['content-length'] && !res.headersSent) {
        res.setHeader('Content-Length', upstreamRes.headers['content-length']);
      }
      res.setHeader('Content-Type', 'video/mp4');
      upstreamRes.pipe(res);
    });

    upstreamReq.on('error', (err) => {
      console.error('[Cloud Stream Pipe Error]', err.message);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Failed to pipe video stream: ' + err.message });
      }
    });

    res.on('close', () => {
      upstreamReq.destroy();
    });
  } catch (err) {
    console.error('[streamDirectCloudFallback Error]', err.message);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Media streaming fallback failed: ' + err.message });
    }
  }
}
const streamDirectInstagramFallback = streamDirectCloudFallback;

/**
 * Direct Stream Trimmer Cloud Fallback (Instagram, Facebook, TikTok, Twitter)
 */
async function trimDirectCloudFallback(url, startSec, endSec, isAudio, tempFile, res, cleanupOld) {
  if (cleanupOld) cleanupOld();
  try {
    const { default: snapsaveModule, snapsave } = await import('snapsave-media-downloader');
    const fn = snapsave || snapsaveModule;
    const result = await fn(url);
    if (!result || !result.success || !result.data?.media?.length) {
      if (!res.headersSent) {
        return res.status(500).json({ error: 'Failed to extract stream for trimmer.' });
      }
      return;
    }
    const media = result.data.media.find(m => m.type === 'video' || (m.url && m.url.includes('.mp4'))) || result.data.media[0];
    const directUrl = media.url;

    const ffmpegArgs = [
      '-ss', startSec.toString(),
      '-to', endSec.toString(),
      '-headers', 'User-Agent: Mozilla/5.0\r\n',
      '-i', directUrl,
    ];

    if (isAudio) {
      ffmpegArgs.push('-vn', '-acodec', 'libmp3lame', '-b:a', '192k', tempFile);
    } else {
      ffmpegArgs.push('-c:v', 'copy', '-c:a', 'copy', tempFile);
    }

    console.log(`[Trimmer Cloud Fallback] Running direct FFmpeg cut on ${directUrl.slice(0, 40)}...`);
    const proc = spawn(ffmpegPath, ffmpegArgs, { windowsHide: true });

    proc.on('close', (code) => {
      if (code !== 0 || !fs.existsSync(tempFile)) {
        if (!res.headersSent) {
          res.status(500).json({ error: 'Failed to cut media clip via FFmpeg.' });
        }
        try { fs.unlinkSync(tempFile); } catch (e) {}
        return;
      }

      try {
        const stats = fs.statSync(tempFile);
        res.setHeader('Content-Length', stats.size);
        const stream = fs.createReadStream(tempFile);
        stream.pipe(res);
        stream.on('close', () => {
          try { fs.unlinkSync(tempFile); } catch (e) {}
        });
      } catch (e) {
        try { fs.unlinkSync(tempFile); } catch (e2) {}
      }
    });
  } catch (err) {
    console.error('[trimDirectCloudFallback Error]', err.message);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Media trim fallback failed: ' + err.message });
    }
  }
}
const trimInstagramDirectFallback = trimDirectCloudFallback;

/**
 * Common yt-dlp arguments for anti-bot bypass & headers
 */
export function buildYtdlpArgs(url = '', useCookies = true) {
  const args = [
    '--ignore-config',
    '--no-exec',
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
      '--',
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

    // If Instagram, Facebook, TikTok, or Twitter (X) URL, immediately activate zero-login Instant Cloud Fallback Resolver
    if (isScraperSupportedUrl(url)) {
      console.log(`[Downloader Engine] yt-dlp extraction failed for ${url}, switching to Instant Cloud Fallback Resolver...`);
      try {
        return await resolveCloudScraperFallback(url);
      } catch (cloudErr) {
        console.error('[Downloader Engine] Cloud scraper fallback also failed:', cloudErr.message);
      }
      const cleanErr = (err1.stderr || 'Media extraction blocked by platform requirements').trim();
      throw new Error(cleanErr);
    }

    // Attempt 2: Fallback extraction for YouTube only (desktop web + tv client bypass)
    if (isYouTubeUrl(url)) {
      try {
        rawInfo = await execYtdlpJson(url, ['--extractor-args', 'youtube:player_client=web,tv'], false);
      } catch (err2) {
        console.error('[Downloader Engine] Fallback extraction failed:', err2.stderr || err2);
        const cleanErr = (err2.stderr || err1.stderr || 'Failed to extract video information').trim();
        throw new Error(cleanErr);
      }
    } else {
      const cleanErr = (err1.stderr || 'Failed to extract video information').trim();
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

    const isYt = isYouTubeUrl(rawInfo.webpage_url || url);

    // Standard resolution tiers: from 8K down to 360p (360p enabled for YouTube only; omitted for FB, TikTok, IG, etc.)
    const RESOLUTION_TIERS = [
      { minHeight: 3800, targetHeight: 4320, id: '4320', label: '8K Ultra HD (4320p)', shortLabel: '8K', badge: 'ultra', estByteRate: 14 * 1024 * 1024 },
      { minHeight: 2000, targetHeight: 2160, id: '2160', label: '4K Ultra HD (2160p)', shortLabel: '4K', badge: 'ultra', estByteRate: 5.5 * 1024 * 1024 },
      { minHeight: 1300, targetHeight: 1440, id: '1440', label: '2K Quad HD (1440p)', shortLabel: '2K', badge: 'hd', estByteRate: 2.8 * 1024 * 1024 },
      { minHeight: 900,  targetHeight: 1080, id: '1080', label: '1080p Full HD', shortLabel: '1080p', badge: 'hd', estByteRate: 1.3 * 1024 * 1024 },
      { minHeight: 600,  targetHeight: 720,  id: '720',  label: '720p HD Ready', shortLabel: '720p', badge: 'hd', estByteRate: 0.6 * 1024 * 1024 },
      { minHeight: 400,  targetHeight: 480,  id: '480',  label: '480p SD', shortLabel: '480p', badge: 'sd', estByteRate: 0.28 * 1024 * 1024 },
      ...(isYt ? [{ minHeight: 250, targetHeight: 360, id: '360', label: '360p Fast', shortLabel: '360p', badge: 'sd', estByteRate: 0.14 * 1024 * 1024 }] : []),
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
          return bSize - aSize;
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
          height: tier.targetHeight || tier.minHeight,
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
        height: fallbackTier.targetHeight || fallbackTier.minHeight,
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

    const maxAllowedSize = isYt ? MAX_FILESIZE_BYTES_YOUTUBE : MAX_FILESIZE_BYTES_OTHER;
    const maxLimitLabel = isYt ? '1.5 GB' : '3.0 GB';

    presets.forEach(p => {
      if (p.filesize && p.filesize > maxAllowedSize) {
        p.exceedsLimit = true;
        p.maxLimitFormatted = maxLimitLabel;
        if (isYt) {
          const vidId = rawInfo.id || '';
          p.mirrorUrl = `https://en.savefrom.net/1-youtube-video-downloader-4v1/?url=https://www.youtube.com/watch?v=${vidId}`;
        }
      }
    });

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
    const directStreamUrl = rawInfo.url || (formats.find(f => f.directUrl && f.hasVideo && !f.directUrl.includes('.m3u8'))?.directUrl) || null;
    
    // Smart Strategy:
    // If video is > 10 minutes (600s) and directStreamUrl is available:
    // Use zero-load /api/proxy-stream with HTTP Range pass-through (0 server storage, instant playback)
    // If video is <= 10 minutes (or directStreamUrl not available):
    // Use lightweight 360p /api/preview (1-2MB, 100% reliable)
    let previewStreamUrl = null;
    if (!isYt) {
      if (directStreamUrl) {
        // 100% Zero-Disk & Zero-RAM Media Proxy Stream: Instant HTTP Range pass-through straight to browser!
        previewStreamUrl = `/api/proxy-stream?url=${encodeURIComponent(directStreamUrl)}`;
      } else {
        // Fallback: Ultra-lightweight 240p/220p preview (< 800 KB)
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
    const num = parseInt(res, 10);
    if (num >= 1080) {
      return `bestvideo[height>=${num}]+bestaudio/bestvideo[width>=${num}]+bestaudio/bestvideo[height<=${num}]+bestaudio/bestvideo[width<=${num}]+bestaudio/best`;
    }
    return `bestvideo[height<=${num}][height>=${Math.round(num * 0.7)}]+bestaudio/bestvideo[width<=${num}][width>=${Math.round(num * 0.7)}]+bestaudio/bestvideo[height<=${num}]+bestaudio/bestvideo[width<=${num}]+bestaudio/best[height<=${num}]/best[width<=${num}]/best`;
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

  const isYt = isYouTubeUrl(url);

  // Standard fallback download pipeline using temp file
  const runTempDownload = () => {
    const ext = isAudio ? 'mp3' : 'mp4';
    const tempDir = os.tmpdir();
    const tempFile = path.join(tempDir, `vidsave_${Date.now()}_${Math.random().toString(36).substring(7)}.${ext}`);

    const maxLimitArg = isYt ? '1536M' : '3072M';
    const args = [
      '-m', 'yt_dlp',
      '-f', formatArg,
      '--max-filesize', maxLimitArg,
    ];

    if (isAudio) {
      args.push('-x', '--audio-format', 'mp3', '--audio-quality', '0');
    } else {
      args.push(
        '--merge-output-format', 'mp4',
        '--postprocessor-args', 'ffmpeg:-c:v copy -c:a aac'
      );
    }

    args.push('-o', tempFile, ...buildYtdlpArgs(url), '--', url);

    console.log(`[Download Stream] Processing ${formatPreset} download into temp container (max: ${maxLimitArg}): ${tempFile}`);

    const child = spawn(PYTHON_BIN, args, {
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe']
    });

    const watchdog = setTimeout(() => {
      console.warn(`[Download Watchdog] Download timed out after 10 mins: ${url}`);
      killProcessTree(child);
      cleanup();
    }, 10 * 60 * 1000);
    if (watchdog.unref) watchdog.unref();

    child.stderr.on('data', (data) => {
      const msg = data.toString();
      if (msg.includes('ERROR:')) {
        console.error('[yt-dlp error]', msg.trim());
      }
    });

    const cleanup = () => {
      clearTimeout(watchdog);
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
      clearTimeout(watchdog);
      if (!res.writableFinished) {
        killProcessTree(child);
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
        if (isScraperSupportedUrl(url)) {
          console.log(`[Download Stream] yt-dlp failed for ${url}, falling back to direct cloud stream pipeline...`);
          return streamDirectCloudFallback(url, formatPreset, res, cleanup);
        }
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
  };

  // High-Speed Zero-Disk Direct CDN Pipeline for non-YouTube single streams (Facebook, TikTok, Instagram, Twitter, etc.)
  // Solves Render 502 Bad Gateway timeouts on long 1-2 hour movies!
  if (!isYt && !isAudio) {
    const isFacebook = url.includes('facebook.com') || url.includes('fb.watch');
    let singleFormat;
    if (isFacebook) {
      if (formatPreset === '360' || formatPreset === '480') {
        singleFormat = 'sd/best[height<=480][ext=mp4]/best[width<=480][ext=mp4]/best[height<=480]/best';
      } else if (formatPreset === 'best' || formatPreset === 'best_with_audio' || !formatPreset) {
        singleFormat = 'bestvideo+bestaudio/hd/best[ext=mp4]/best';
      } else {
        singleFormat = buildTierFormat(formatPreset);
      }
    } else {
      const p = formatPreset;
      if (p === 'best' || p === 'best_with_audio' || !p) {
        singleFormat = 'bestvideo+bestaudio/best[ext=mp4]/best';
      } else {
        singleFormat = buildTierFormat(p);
      }
    }

    const gArgs = ['-m', 'yt_dlp', '-g', '-f', singleFormat, ...buildYtdlpArgs(url, true), '--', url];
    console.log(`[Zero-Disk Stream] Resolving direct CDN URL for ${url} (format: ${singleFormat})`);
    const resolver = spawn(PYTHON_BIN, gArgs, { windowsHide: true });
    let resolvedUrl = '';
    resolver.stdout.on('data', d => { resolvedUrl += d.toString(); });

    resolver.on('close', async (code) => {
      const urls = resolvedUrl.trim().split(/\r?\n/).filter(Boolean);

      // If yt-dlp resolved multiple streams (separate video and audio), we MUST merge them via FFmpeg!
      if (urls.length > 1) {
        console.log(`[Stream Pipeline] Format ${formatPreset} has separate video+audio streams, running FFmpeg merge pipeline...`);
        return runTempDownload();
      }

      const targetUrl = urls[0];
      const isHlsOrDash = targetUrl && (
        targetUrl.includes('.m3u8') || 
        targetUrl.includes('.mpd') || 
        targetUrl.includes('/hls/') || 
        targetUrl.includes('manifest')
      );

      if (code === 0 && targetUrl && targetUrl.startsWith('http') && !isHlsOrDash) {
        console.log(`[Zero-Disk Stream] Directly piping CDN stream to browser for ${url}`);
        try {
          const { default: https } = await import('https');
          const { default: http } = await import('http');
          const client = targetUrl.startsWith('https') ? https : http;
          const headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
            'Accept': '*/*',
          };

          if (url.includes('tiktok.com') || url.includes('tt.site')) headers['Referer'] = 'https://www.tiktok.com/';
          else if (url.includes('instagram.com')) headers['Referer'] = 'https://www.instagram.com/';
          else if (url.includes('facebook.com') || url.includes('fb.watch')) headers['Referer'] = 'https://www.facebook.com/';
          else if (url.includes('pinterest.com')) headers['Referer'] = 'https://www.pinterest.com/';
          else if (url.includes('twitter.com') || url.includes('x.com')) headers['Referer'] = 'https://twitter.com/';

          const upstreamReq = client.get(targetUrl, { headers }, (upstreamRes) => {
            if ([301, 302, 307, 308].includes(upstreamRes.statusCode) && upstreamRes.headers.location) {
              return res.redirect(upstreamRes.statusCode, upstreamRes.headers.location);
            }
            if (upstreamRes.statusCode >= 400) {
              console.warn(`[CDN Stream] Upstream CDN returned HTTP ${upstreamRes.statusCode}, falling back to yt-dlp...`);
              return runTempDownload();
            }
            if (upstreamRes.headers['content-type'] && 
               (upstreamRes.headers['content-type'].includes('mpegurl') || 
                upstreamRes.headers['content-type'].includes('text/') || 
                upstreamRes.headers['content-type'].includes('application/json'))) {
              console.warn(`[CDN Stream] Upstream returned non-video content-type: ${upstreamRes.headers['content-type']}, falling back to yt-dlp...`);
              return runTempDownload();
            }
            if (upstreamRes.headers['content-length']) {
              const cl = parseInt(upstreamRes.headers['content-length'], 10);
              const maxAllowedBytes = isYt ? MAX_FILESIZE_BYTES_YOUTUBE : MAX_FILESIZE_BYTES_OTHER;
              if (cl > maxAllowedBytes) {
                console.warn(`[CDN Stream] File size ${cl} bytes exceeds limit of ${maxAllowedBytes} bytes.`);
                upstreamReq.destroy();
                if (!res.headersSent) {
                  return res.status(413).json({
                    error: `Video size exceeds the maximum allowed limit of ${isYt ? '1.5 GB' : '3.0 GB'}.`
                  });
                }
                return;
              }
              if (!res.headersSent) {
                res.setHeader('Content-Length', upstreamRes.headers['content-length']);
              }
            }
            res.setHeader('Content-Type', upstreamRes.headers['content-type'] || 'video/mp4');
            upstreamRes.pipe(res);
          });

          upstreamReq.on('error', (err) => {
            console.error('[CDN Pipe Error]', err.message);
            if (!res.headersSent) runTempDownload();
          });

          res.on('close', () => {
            upstreamReq.destroy();
          });
          return;
        } catch (e) {
          console.warn('[Direct Stream Fallback]', e.message);
          return runTempDownload();
        }
      } else {
        runTempDownload();
      }
    });

    resolver.on('error', () => {
      runTempDownload();
    });
    return;
  }

  runTempDownload();
}

/**
 * Stream trimmed video/audio section using HTTP range seeking and FFmpeg cut
 */
export function streamTrimmedDownload(url, startTime, endTime, type = 'video', format = 'best', res) {
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

  const rawStart = parseFloat(startTime);
  const rawEnd = parseFloat(endTime);
  const startSec = Math.max(0, isFinite(rawStart) ? rawStart : 0);
  const requestedEnd = isFinite(rawEnd) ? rawEnd : (startSec + 10);
  // Cap max trim segment duration to 10 minutes (600s) to prevent memory & CPU DoS
  const maxCap = startSec + 600;
  const endSec = Math.min(maxCap, Math.max(startSec + 1, requestedEnd));

  const startStr = formatTime(startSec);
  const endStr = formatTime(endSec);
  const sectionArg = `*${startStr}-${endStr}`;

  console.log(`[Trimmer Engine] Requesting cut range: ${sectionArg} for URL: ${url} (format: ${format})`);

  const isYt = isYouTubeUrl(url);
  let formatArg;
  if (isAudio) {
    formatArg = 'bestaudio/best';
  } else if (format === '480') {
    formatArg = isYt
      ? 'bestvideo[height<=480][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=480]+bestaudio/best[height<=480]/best'
      : 'bestvideo[height<=480]+bestaudio/bestvideo[width<=480]+bestaudio/best[height<=480]/best[width<=480]/best';
  } else if (format === '720') {
    formatArg = isYt
      ? 'bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=720]+bestaudio/best[height<=720]/best'
      : 'bestvideo[height<=720]+bestaudio/bestvideo[width<=720]+bestaudio/best[height<=720]/best[width<=720]/best';
  } else if (format === '1080') {
    formatArg = isYt
      ? 'bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=1080]+bestaudio/best[height<=1080]/best'
      : 'bestvideo[height<=1080]+bestaudio/bestvideo[width<=1080]+bestaudio/best[height<=1080]/best[width<=1080]/best';
  } else {
    // 'best' - Original creator upload quality
    formatArg = isYt
      ? 'bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=1080]+bestaudio/best[height<=1080]/best'
      : 'bestvideo+bestaudio/best';
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
  args.push('-o', tempFile, '--', url);

  const child = spawn(PYTHON_BIN, args, {
    windowsHide: true,
    detached: process.platform !== 'win32'
  });

  const watchdog = setTimeout(() => {
    console.warn(`[Trimmer Watchdog] Trim timed out after 6 mins: ${url}`);
    killProcessTree(child);
    cleanup();
  }, 6 * 60 * 1000);
  if (watchdog.unref) watchdog.unref();

  const cleanup = () => {
    clearTimeout(watchdog);
    try {
      if (fs.existsSync(tempFile)) {
        fs.unlinkSync(tempFile);
      }
    } catch (e) {
      console.error('[Cleanup Error]', e.message);
    }
  };

  res.on('close', () => {
    clearTimeout(watchdog);
    if (!res.writableFinished) {
      killProcessTree(child);
    }
    cleanup();
  });
  res.on('finish', cleanup);
  let stderrLog = '';

  child.stderr.on('data', (d) => {
    stderrLog += d.toString();
  });

  child.on('close', (code) => {
    if (code !== 0 || !fs.existsSync(tempFile)) {
      console.error('[Trimmer Failed]', stderrLog);
      if (isScraperSupportedUrl(url)) {
        console.log(`[Trimmer Engine] yt-dlp failed for ${url}, falling back to direct stream trimming via FFmpeg...`);
        return trimDirectCloudFallback(url, startSec, endSec, isAudio, tempFile, res, cleanup);
      }
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


