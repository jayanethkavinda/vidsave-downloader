import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { 
  PYTHON_BIN, 
  ffmpegPath, 
  buildYtdlpArgs, 
  isYouTubeUrl, 
  isScraperSupportedUrl 
} from './coreEngine.js';
import { killProcessTree } from './security.js';

/**
 * Direct Stream Trimmer Cloud Fallback (Instagram, Facebook, TikTok, Twitter)
 */
export async function trimDirectCloudFallback(url, startSec, endSec, isAudio, tempFile, res, cleanupOld) {
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
      } catch (e) {
        try { fs.unlinkSync(tempFile); } catch (_) {}
      }
    });
  } catch (err) {
    console.error('[trimDirectCloudFallback Error]', err.message);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Media trim fallback failed: ' + err.message });
    }
  }
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
  } else if (format === '4320') {
    formatArg = isYt
      ? 'bestvideo[height<=4320][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=4320]+bestaudio/best[height<=4320]/best'
      : 'best[height<=4320][ext=mp4]/best[width<=4320][ext=mp4]/best[height<=4320]/bestvideo[height<=4320]+bestaudio/best';
  } else if (format === '2160') {
    formatArg = isYt
      ? 'bestvideo[height<=2160][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=2160]+bestaudio/best[height<=2160]/best'
      : 'best[height<=2160][ext=mp4]/best[width<=2160][ext=mp4]/best[height<=2160]/bestvideo[height<=2160]+bestaudio/best';
  } else if (format === '1440') {
    formatArg = isYt
      ? 'bestvideo[height<=1440][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=1440]+bestaudio/best[height<=1440]/best'
      : 'best[height<=1440][ext=mp4]/best[width<=1440][ext=mp4]/best[height<=1440]/bestvideo[height<=1440]+bestaudio/best';
  } else if (format === '1080') {
    formatArg = isYt
      ? 'bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=1080]+bestaudio/best[height<=1080]/best'
      : 'best[height<=1080][ext=mp4]/best[width<=1080][ext=mp4]/best[height<=1080]/bestvideo[height<=1080]+bestaudio/best';
  } else if (format === '720') {
    formatArg = isYt
      ? 'bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=720]+bestaudio/best[height<=720]/best'
      : 'best[height<=720][ext=mp4]/best[width<=720][ext=mp4]/best[height<=720]/bestvideo[height<=720]+bestaudio/best';
  } else if (format === '480') {
    formatArg = isYt
      ? 'bestvideo[height<=480][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=480]+bestaudio/best[height<=480]/best'
      : 'best[height<=480][ext=mp4]/best[width<=480][ext=mp4]/best[height<=480]/bestvideo[height<=480]+bestaudio/best';
  } else if (format === '360') {
    formatArg = isYt
      ? 'bestvideo[height<=360][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=360]+bestaudio/best[height<=360]/best'
      : 'best[height<=360][ext=mp4]/best[width<=360][ext=mp4]/best[height<=360]/best';
  } else {
    // 'best' - 100% Original creator upload quality
    formatArg = isYt
      ? 'bestvideo+bestaudio/best'
      : 'best[ext=mp4]/best/bestvideo+bestaudio';
  }

  const args = [
    '-m', 'yt_dlp',
    '-f', formatArg,
    '--download-sections', sectionArg,
    '--downloader-args', 'ffmpeg:-threads 1',
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
