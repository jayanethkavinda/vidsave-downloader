import crypto from 'crypto';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { spawn } from 'child_process';
import { PYTHON_BIN, buildYtdlpArgs } from './coreEngine.js';
import { killProcessTree } from './security.js';

// Map of in-flight preview generation jobs to prevent duplicate yt-dlp spawns
const pendingJobs = new Map();

/**
 * High-Speed Lightweight Video Preview Service (Serves 1-2 MB low-res MP4 with full Range/seeking support)
 * Supports TikTok, Instagram, Facebook, Twitter (X), Threads, Pinterest, etc. with audio + video.
 */
export async function streamVideoPreview(safeTargetUrl, req, res) {
  const hash = crypto.createHash('md5').update(safeTargetUrl).digest('hex');
  const tempFile = path.join(os.tmpdir(), `vidsave_prev_${hash}.mp4`);

  // 1. Instant Cache Hit (0.001s, 0% CPU, 0% RAM)
  try {
    if (fs.existsSync(tempFile) && fs.statSync(tempFile).size > 10000) {
      return res.sendFile(tempFile);
    }
  } catch (_) {}

  // 2. If already being downloaded, join the waiting queue
  if (pendingJobs.has(hash)) {
    const job = pendingJobs.get(hash);
    job.clients.push({ req, res });
    
    req.on('close', () => {
      const idx = job.clients.findIndex(c => c.res === res);
      if (idx !== -1) job.clients.splice(idx, 1);
      if (job.clients.length === 0 && job.child && !job.child.killed) {
        killProcessTree(job.child);
        pendingJobs.delete(hash);
      }
    });
    return;
  }

  // 3. Initiate single lightweight download
  const clients = [{ req, res }];
  const jobState = { clients, child: null };
  pendingJobs.set(hash, jobState);

  const isTikTok = /tiktok\.com/i.test(safeTargetUrl);

  // Format preference: Clean H.264 no-watermark stream for TikTok, lightweight 240p/360p with audio for others
  const formatFilter = isTikTok
    ? 'best[vcodec^=avc][format_id!*=watermark][ext=mp4]/best[vcodec^=avc][format_id!*=watermark]/best[vcodec^=avc]/best[ext=mp4]/best'
    : 'best[height<=360][acodec!=none][ext=mp4]/bestvideo[height<=360]+bestaudio/worstvideo[height<=360]+worstaudio/best[acodec!=none]/best';

  const args = [
    '-m', 'yt_dlp',
    '-f', formatFilter,
    '--merge-output-format', 'mp4',
    '--no-playlist',
    '--no-warnings',
    '--no-part',
    '--socket-timeout', '15',
    ...buildYtdlpArgs(safeTargetUrl, true),
    '-o', tempFile,
    '--',
    safeTargetUrl
  ];

  console.log(`[Preview Service] Generating fast 240p/360p preview for: ${safeTargetUrl}`);
  
  const child = spawn(PYTHON_BIN, args, {
    windowsHide: true,
    detached: process.platform !== 'win32'
  });
  jobState.child = child;

  const watchdog = setTimeout(() => {
    killProcessTree(child);
    pendingJobs.delete(hash);
    try { if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile); } catch (_) {}
    for (const c of clients) {
      if (!c.res.headersSent) {
        c.res.status(504).json({ error: 'Preview generation timed out.' });
      }
    }
  }, 35 * 1000);
  if (watchdog.unref) watchdog.unref();

  child.on('close', (code) => {
    clearTimeout(watchdog);
    pendingJobs.delete(hash);

    const isValid = (code === 0 && fs.existsSync(tempFile) && fs.statSync(tempFile).size > 5000);

    if (isValid) {
      // Auto-cleanup after 20 minutes to keep disk clean
      const cleanupTimer = setTimeout(() => {
        try { if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile); } catch (_) {}
      }, 20 * 60 * 1000);
      if (cleanupTimer.unref) cleanupTimer.unref();

      // Dispatch to all waiting clients
      for (const c of clients) {
        if (!c.res.headersSent) {
          c.res.sendFile(tempFile);
        }
      }
    } else {
      try { if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile); } catch (_) {}
      for (const c of clients) {
        if (!c.res.headersSent) {
          c.res.status(502).json({ error: 'Failed to generate video preview.' });
        }
      }
    }
  });

  req.on('close', () => {
    const idx = clients.findIndex(c => c.res === res);
    if (idx !== -1) clients.splice(idx, 1);
    if (clients.length === 0 && child && !child.killed) {
      clearTimeout(watchdog);
      killProcessTree(child);
      pendingJobs.delete(hash);
      try { if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile); } catch (_) {}
    }
  });
}
