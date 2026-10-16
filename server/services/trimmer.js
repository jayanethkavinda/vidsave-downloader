import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { 
  PYTHON_BIN, 
  ffmpegPath, 
  buildYtdlpArgs, 
  isYouTubeUrl 
} from './downloader.js';
import { 
  MAX_FILESIZE_BYTES_YOUTUBE, 
  MAX_FILESIZE_BYTES_OTHER, 
  killProcessTree 
} from './security.js';
import { formatBytes } from './sizeCalculator.js';

/**
 * Platform URL detector for scraper fallback (Instagram, Facebook, TikTok, Twitter/X)
 */
export function isScraperSupportedUrl(rawUrl) {
  if (!rawUrl) return false;
  return /(?:instagram\.com|instagr\.am|facebook\.com|fb\.watch|tiktok\.com|twitter\.com|x\.com)/i.test(rawUrl);
}

/**
 * Formats seconds into HH:MM:SS.xx format required by yt-dlp --download-sections
 * Example: 15.5 -> "00:00:15.50"
 */
export function formatTrimTime(t) {
  if (typeof t === 'number' || /^\d+(\.\d+)?$/.test(String(t).trim())) {
    const s = Math.max(0, parseFloat(t));
    const hrs = Math.floor(s / 3600);
    const mins = Math.floor((s % 3600) / 60);
    const secs = (s % 60).toFixed(2);
    return `${hrs.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}:${secs.padStart(5, '0')}`;
  }
  return String(t).trim();
}

/**
 * Dynamic File Size Estimator for video/audio segments based on bitrate formulas
 * Matches sizeCalculator engine accuracy
 */
export function estimateTrimmedSize(clipDurationSec, format = 'best') {
  const duration = Math.max(0.5, parseFloat(clipDurationSec) || 10);
  const bitrates = {
    '1080': 3500, // ~3.5 Mbps (~437 KB/s)
    '720': 1800,  // ~1.8 Mbps (~225 KB/s)
    '480': 900,   // ~900 kbps (~112 KB/s)
    '360': 500,   // ~500 kbps (~62 KB/s)
    'best': 3500, // Standard high-def estimate
    'audio': 192, // 192 kbps MP3 (~24 KB/s)
    'mp3': 192
  };

  const kbps = bitrates[format] || 2500;
  const estimatedBytes = Math.round((kbps * 1000 * duration) / 8);

  return {
    estimatedBytes,
    formattedSize: formatBytes(estimatedBytes) || '~1 MB'
  };
}

/**
 * Quota & Safety Limits Validator
 * Enforces YouTube 1.5GB cap and other platforms 3.0GB cap
 */
export function validateTrimQuota(url, estimatedBytes) {
  const isYt = isYouTubeUrl(url);
  const maxLimit = isYt ? MAX_FILESIZE_BYTES_YOUTUBE : MAX_FILESIZE_BYTES_OTHER;

  if (estimatedBytes > maxLimit) {
    return {
      allowed: false,
      maxLimit,
      maxFormatted: formatBytes(maxLimit),
      error: `Selected clip duration exceeds platform download limit (${formatBytes(maxLimit)}). Please select a shorter segment.`
    };
  }
  return { allowed: true };
}

/**
 * Direct Cloud Fallback Trimming using SnapSave direct CDN URL and FFmpeg stream copy
 * Executes in 1-2 seconds with zero re-encoding when yt-dlp faces platform bot restrictions
 */
export async function trimDirectCloudFallback(url, startSec, endSec, isAudio, tempFile, res, cleanupOld) {
  if (cleanupOld) cleanupOld();
  try {
    const { default: snapsaveModule, snapsave } = await import('snapsave-media-downloader');
    const fn = snapsave || snapsaveModule;
    const result = await fn(url);

    if (!result || !result.success || !result.data?.media?.length) {
      if (!res.headersSent) {
        return res.status(500).json({ error: 'Direct media extraction failed for trimmer fallback.' });
      }
      return;
    }

    const media = result.data.media.find(m => m.type === 'video' || (m.url && m.url.includes('.mp4'))) || result.data.media[0];
    const directUrl = media.url;
    const bin = ffmpegPath || 'ffmpeg';

    const ffmpegArgs = [
      '-ss', startSec.toString(),
      '-to', endSec.toString(),
      '-headers', 'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64)\r\n',
      '-i', directUrl,
    ];

    if (isAudio) {
      ffmpegArgs.push('-vn', '-acodec', 'libmp3lame', '-b:a', '192k', tempFile);
    } else {
      ffmpegArgs.push('-c:v', 'copy', '-c:a', 'copy', tempFile);
    }

    console.log(`[Trimmer Cloud Fallback] Running direct FFmpeg cut on ${directUrl.slice(0, 50)}...`);
    const proc = spawn(bin, ffmpegArgs, { windowsHide: true });

    proc.on('close', (code) => {
      if (code !== 0 || !fs.existsSync(tempFile)) {
        if (!res.headersSent) {
          res.status(500).json({ error: 'FFmpeg stream cut failed during cloud fallback.' });
        }
        try { fs.unlinkSync(tempFile); } catch (_) {}
        return;
      }

      try {
        const stats = fs.statSync(tempFile);
        res.setHeader('Content-Length', stats.size);
        const stream = fs.createReadStream(tempFile);
        stream.pipe(res);
        stream.on('close', () => {
          try { fs.unlinkSync(tempFile); } catch (_) {}
        });
        stream.on('error', () => {
          try { fs.unlinkSync(tempFile); } catch (_) {}
        });
      } catch (_) {
        try { fs.unlinkSync(tempFile); } catch (_) {}
      }
    });

    proc.on('error', (err) => {
      console.error('[Trimmer Cloud Fallback FFmpeg Error]', err.message);
      if (!res.headersSent) {
        res.status(500).json({ error: 'FFmpeg spawn error in fallback: ' + err.message });
      }
      try { fs.unlinkSync(tempFile); } catch (_) {}
    });

  } catch (err) {
    console.error('[trimDirectCloudFallback Error]', err.message);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Media trim cloud fallback failed: ' + err.message });
    }
  }
}

/**
 * Supercharged Video & Audio Segment Trimmer Download Stream
 * Uses modern yt-dlp --download-sections and --force-keyframes-at-cuts
 * Downloads ONLY requested byte ranges directly from CDN (2-4MB instead of entire video)
 */
export function streamTrimmedDownload(url, startTime, endTime, type = 'video', format = 'best', res) {
  const isAudio = type === 'audio' || type === 'mp3' || format === 'audio' || format === 'mp3';
  const ext = isAudio ? 'mp3' : 'mp4';
  const tempDir = os.tmpdir();
  const tempFile = path.join(tempDir, `vidsave_trim_${Date.now()}_${Math.random().toString(36).substring(7)}.${ext}`);

  const rawStart = parseFloat(startTime);
  const rawEnd = parseFloat(endTime);
  const startSec = Math.max(0, isFinite(rawStart) ? rawStart : 0);
  const requestedEnd = isFinite(rawEnd) ? rawEnd : (startSec + 10);

  // Maximum cap of 15 minutes (900s) to prevent memory & CPU DoS
  const maxCap = startSec + 900;
  const endSec = Math.min(maxCap, Math.max(startSec + 0.5, requestedEnd));
  const clipDuration = endSec - startSec;

  // Quotas & Safety limit pre-check
  const { estimatedBytes } = estimateTrimmedSize(clipDuration, format);
  const quota = validateTrimQuota(url, estimatedBytes);
  if (!quota.allowed) {
    if (!res.headersSent) {
      return res.status(400).json({ error: quota.error });
    }
    return;
  }

  const startStr = formatTrimTime(startSec);
  const endStr = formatTrimTime(endSec);
  const sectionArg = `*${startStr}-${endStr}`;

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
    // 'best' - Original upload quality
    formatArg = isYt
      ? 'bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=1080]+bestaudio/best[height<=1080]/best'
      : 'bestvideo+bestaudio/best';
  }

  console.log(`[Trimmer Engine] Requesting cut range: ${sectionArg} for URL: ${url} (format: ${format})`);

  const args = [
    '-m', 'yt_dlp',
    '-f', formatArg,
    '--download-sections', sectionArg,
    '--force-keyframes-at-cuts',
    '--no-playlist',
    '--no-warnings',
  ];

  if (isAudio) {
    args.push('-x', '--audio-format', 'mp3', '--audio-quality', '0');
  } else if (isYt) {
    args.push('--merge-output-format', 'mp4');
  }

  args.push(...buildYtdlpArgs(url, true));
  args.push('-o', tempFile, '--', url);

  const child = spawn(PYTHON_BIN, args, {
    windowsHide: true,
    detached: process.platform !== 'win32'
  });

  const watchdog = setTimeout(() => {
    console.warn(`[Trimmer Watchdog] Trim timed out after 5 mins: ${url}`);
    killProcessTree(child);
    cleanup();
  }, 5 * 60 * 1000);
  if (watchdog.unref) watchdog.unref();

  const cleanup = () => {
    clearTimeout(watchdog);
    try {
      if (fs.existsSync(tempFile)) {
        fs.unlinkSync(tempFile);
      }
    } catch (e) {
      console.error('[Trimmer Cleanup Error]', e.message);
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
    clearTimeout(watchdog);
    if (code !== 0 || !fs.existsSync(tempFile)) {
      console.error('[Trimmer Failed]', stderrLog.slice(-300));
      if (isScraperSupportedUrl(url)) {
        console.log(`[Trimmer Engine] yt-dlp failed for ${url}, switching to Direct Cloud Fallback...`);
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
        console.error('[Trimmer Stream Error]', err);
        cleanup();
      });
    } catch (err) {
      console.error('[Trimmer File Read Error]', err);
      cleanup();
    }
  });

  child.on('error', (err) => {
    console.error('[Trimmer Spawn Error]', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Trim spawn failed: ' + err.message });
    }
    cleanup();
  });
}
