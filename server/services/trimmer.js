import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { killProcessTree } from './security.js';
import { PYTHON_BIN, buildYtdlpArgs } from './downloader.js';

// In-memory set of currently downloading preview jobs to avoid duplicate ffmpeg instances
const ACTIVE_PREVIEW_JOBS = new Map();

// Periodic cleanup of temporary preview files (older than 45 minutes)
setInterval(() => {
  try {
    const tmpDir = os.tmpdir();
    const files = fs.readdirSync(tmpDir);
    const now = Date.now();
    for (const f of files) {
      if (f.startsWith('vidsave_prev_') && f.endsWith('.mp4')) {
        const fullPath = path.join(tmpDir, f);
        try {
          const stat = fs.statSync(fullPath);
          if (now - stat.mtimeMs > 45 * 60 * 1000) {
            fs.unlinkSync(fullPath);
          }
        } catch (_) {}
      }
    }
  } catch (_) {}
}, 15 * 60 * 1000);

/**
 * Format seconds to HH:MM:SS.xxx for yt-dlp download sections
 */
function toSectionTimestamp(seconds) {
  const s = Math.max(0, parseFloat(seconds) || 0);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = (s % 60).toFixed(2);
  return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${sec.toString().padStart(5, '0')}`;
}

/**
 * Stream Trimmed Segment Download
 * Uses yt-dlp native --download-sections to download ONLY the user-selected duration (e.g. 15s)
 * instead of downloading the entire video.
 */
export function streamTrimmedDownload(url, startSec, endSec, type, formatPreset, res) {
  const isAudio = type === 'audio' || type === 'mp3';
  const ext = isAudio ? 'mp3' : 'mp4';
  const tempFile = path.join(os.tmpdir(), `vidsave_trim_${Date.now()}_${Math.random().toString(36).substring(7)}.${ext}`);

  const startStamp = toSectionTimestamp(startSec);
  const endStamp = toSectionTimestamp(endSec);
  const sectionArg = `*${startStamp}-${endStamp}`;

  const formatSelector = isAudio 
    ? 'bestaudio/best' 
    : (formatPreset === '1080' ? 'bestvideo[height<=1080]+bestaudio/best' : 'bestvideo+bestaudio/best');

  // Lossless copy for video, clean MP3 encoding for audio
  const postArgs = isAudio 
    ? 'ffmpeg:-vn -acodec libmp3lame -b:a 192k'
    : 'ffmpeg:-c:v copy -c:a aac';

  const args = [
    '-m', 'yt_dlp',
    '-f', formatSelector,
    '--download-sections', sectionArg,
    '--force-keyframes-at-cuts',
    '--postprocessor-args', postArgs,
    '--merge-output-format', isAudio ? 'mp3' : 'mp4',
    '-o', tempFile,
    ...buildYtdlpArgs(url),
    '--',
    url
  ];

  console.log(`[Trimmer Engine] Downloading ONLY section ${sectionArg} (${type}) -> ${tempFile}`);
  const child = spawn(PYTHON_BIN, args, { windowsHide: true, detached: process.platform !== 'win32' });

  const watchdog = setTimeout(() => {
    console.warn(`[Trimmer Watchdog] Terminating timed-out trim: ${url}`);
    killProcessTree(child);
    cleanup();
  }, 5 * 60 * 1000);

  const cleanup = () => {
    clearTimeout(watchdog);
    try {
      if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
    } catch (_) {}
  };

  res.on('close', () => {
    clearTimeout(watchdog);
    if (!res.writableFinished) killProcessTree(child);
    cleanup();
  });

  child.on('close', code => {
    clearTimeout(watchdog);
    let actualFile = tempFile;
    if (!fs.existsSync(actualFile)) {
      const dir = path.dirname(tempFile);
      const base = path.basename(tempFile, path.extname(tempFile));
      try {
        const found = fs.readdirSync(dir).find(f => f.startsWith(base) && !f.endsWith('.part'));
        if (found) actualFile = path.join(dir, found);
      } catch (_) {}
    }

    if (code !== 0 || !fs.existsSync(actualFile)) {
      console.error(`[Trimmer Error] yt-dlp section download exited with code: ${code}`);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Trim processing failed. Please try a different range.' });
      }
      cleanup();
      return;
    }

    try {
      const stats = fs.statSync(actualFile);
      if (!res.headersSent) {
        res.setHeader('Content-Length', stats.size);
      }
      const stream = fs.createReadStream(actualFile);
      stream.pipe(res);
      stream.on('close', cleanup);
    } catch (_) {
      cleanup();
    }
  });
}

/**
 * Handle Range-enabled video preview streaming for Trimmer player
 * Serves cached lightweight preview with full audio & video, zero lag seeking
 */
function serveRangeStream(filePath, req, res) {
  const stat = fs.statSync(filePath);
  const fileSize = stat.size;
  const range = req.headers.range;

  if (range) {
    const parts = range.replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
    const chunksize = (end - start) + 1;
    const fileStream = fs.createReadStream(filePath, { start, end });

    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunksize,
      'Content-Type': 'video/mp4',
    });
    fileStream.pipe(res);
  } else {
    res.writeHead(200, {
      'Content-Length': fileSize,
      'Accept-Ranges': 'bytes',
      'Content-Type': 'video/mp4',
    });
    fs.createReadStream(filePath).pipe(res);
  }
}

/**
 * High-speed 240p/360p Preview Generator & Streamer for non-YouTube platforms
 * (Facebook, TikTok, Twitter, Instagram, Pinterest)
 * Generates an audio+video combined MP4 cached on server disk with HTTP Range support.
 */
export async function handlePreviewStream(url, req, res) {
  const hash = crypto.createHash('md5').update(url).digest('hex').substring(0, 16);
  const previewFile = path.join(os.tmpdir(), `vidsave_prev_${hash}.mp4`);

  // 1. If already cached, serve immediately with 0 latency
  if (fs.existsSync(previewFile) && fs.statSync(previewFile).size > 10000) {
    return serveRangeStream(previewFile, req, res);
  }

  // 2. If another request is currently generating this preview, wait for it
  if (ACTIVE_PREVIEW_JOBS.has(hash)) {
    const jobPromise = ACTIVE_PREVIEW_JOBS.get(hash);
    try {
      await jobPromise;
      if (fs.existsSync(previewFile)) {
        return serveRangeStream(previewFile, req, res);
      }
    } catch (_) {}
  }

  // 3. Generate lightweight preview (~240p/360p, max 480p) with both Audio & Video
  const job = new Promise((resolve, reject) => {
    // Format prioritizes low-res combined MP4, or fast merge
    const previewFormat = 'best[height<=360][ext=mp4]/bestvideo[height<=360]+bestaudio/best[height<=480]/best';
    const args = [
      '-m', 'yt_dlp',
      '-f', previewFormat,
      '--merge-output-format', 'mp4',
      '--postprocessor-args', 'ffmpeg:-c:v copy -c:a aac',
      '-o', previewFile,
      ...buildYtdlpArgs(url),
      '--',
      url
    ];

    console.log(`[Preview Engine] Generating lightweight preview for ${url} -> ${previewFile}`);
    const proc = spawn(PYTHON_BIN, args, { windowsHide: true });

    const timeout = setTimeout(() => {
      killProcessTree(proc);
      reject(new Error('Preview generation timed out'));
    }, 45000);

    proc.on('close', code => {
      clearTimeout(timeout);
      if (code === 0 && fs.existsSync(previewFile) && fs.statSync(previewFile).size > 10000) {
        resolve(previewFile);
      } else {
        reject(new Error(`Preview generator exited with code ${code}`));
      }
    });

    proc.on('error', err => {
      clearTimeout(timeout);
      reject(err);
    });
  });

  ACTIVE_PREVIEW_JOBS.set(hash, job);

  try {
    await job;
    ACTIVE_PREVIEW_JOBS.delete(hash);
    if (!res.headersSent && fs.existsSync(previewFile)) {
      return serveRangeStream(previewFile, req, res);
    }
  } catch (err) {
    ACTIVE_PREVIEW_JOBS.delete(hash);
    console.error(`[Preview Engine Error]:`, err.message);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Preview generation failed.' });
    }
  }
}
