import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { spawn } from 'child_process';
import { 
  getVideoInfo, 
  streamVideoDownload, 
  streamTrimmedDownload, 
  convertVttToSrt, 
  convertSrv1ToVtt,
  buildYtdlpArgs,
  PYTHON_BIN
} from './services/downloader.js';

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
}));

app.use(express.json());

// Health Check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', engine: 'yt-dlp + python3', timestamp: new Date() });
});

// Diagnostic Endpoint
app.get('/api/diagnose', async (req, res) => {
  try {
    const { execSync } = await import('child_process');
    const pyVer = execSync('python3 --version || python --version', { encoding: 'utf8' }).trim();
    const ytdlpVer = execSync('python3 -m yt_dlp --version || python -m yt_dlp --version', { encoding: 'utf8' }).trim();
    let ffmpegVer = 'unknown';
    try {
      ffmpegVer = execSync('/usr/bin/ffmpeg -version || ffmpeg -version', { encoding: 'utf8' }).split('\n')[0];
    } catch (_) {}
    const fs = await import('fs');
    const path = await import('path');
    const hasCookieFile = fs.existsSync(path.resolve('ytdlp_session_cookies.txt'));
    const hasLegacy = fs.existsSync(path.resolve('cookies.txt'));
    const cookieSize = hasCookieFile ? fs.statSync(path.resolve('ytdlp_session_cookies.txt')).size : 0;
    
    res.json({
      pyVer,
      ytdlpVer,
      ffmpegVer,
      hasCookieFile,
      cookieSize,
      hasLegacy,
      hasEnvCookie: !!process.env.YTDLP_COOKIES,
      envCookieLen: process.env.YTDLP_COOKIES ? process.env.YTDLP_COOKIES.length : 0
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Server IP & YouTube Status Check Endpoint
app.get('/api/check-ip', async (req, res) => {
  try {
    const ipRes = await fetch('https://api.ipify.org?format=json').then(r => r.json()).catch(() => ({ ip: 'Unknown' }));
    let ytStatus = 'Unknown';
    try {
      const ytRes = await fetch('https://www.youtube.com', {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
      });
      ytStatus = `HTTP ${ytRes.status} ${ytRes.statusText}`;
    } catch (e) {
      ytStatus = `Error: ${e.message}`;
    }

    res.json({
      serverIp: ipRes.ip,
      youtubeStatus: ytStatus,
      isDatacenter: true,
      timestamp: new Date()
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Video Metadata Endpoint
app.get('/api/info', async (req, res) => {
  const { url } = req.query;
  if (!url) {
    return res.status(400).json({ error: 'URL is required' });
  }

  try {
    const info = await getVideoInfo(url);
    res.json(info);
  } catch (error) {
    console.error('Info extraction error:', error.message);
    res.status(500).json({ 
      error: error.message || 'Failed to extract video information. Please ensure the link is public.' 
    });
  }
});

// Direct Download Stream Endpoint (Zero Disk Storage)
app.get('/api/download', (req, res) => {
  const { url, format = 'best', title = 'video' } = req.query;
  if (!url) {
    return res.status(400).json({ error: 'URL is required' });
  }

  // Clean filename for HTTP Content-Disposition
  const sanitizedTitle = (title || 'video')
    .replace(/[^\w\s\u0D80-\u0DFF.-]/gi, '')
    .trim()
    .substring(0, 80) || 'media';

  const isAudio = format === 'audio_best' || format === 'mp3' || (format.includes('audio') && !format.includes('best_with_audio'));
  const ext = isAudio ? 'mp3' : 'mp4';
  const mimeType = isAudio ? 'audio/mpeg' : 'video/mp4';

  const asciiTitle = sanitizedTitle.replace(/[^\w\s.-]/g, '_').replace(/\s+/g, ' ').trim() || 'media';
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${asciiTitle}.${ext}"; filename*=UTF-8''${encodeURIComponent(sanitizedTitle)}.${ext}`
  );
  res.setHeader('Content-Type', mimeType);

  streamVideoDownload(url, format, res);
});

// Dedicated Subtitle Download Stream Endpoint (.SRT & .VTT)
app.get('/api/subtitle', async (req, res) => {
  const { url, lang = 'en', ext = 'srt', title = 'subtitles' } = req.query;
  if (!url) {
    return res.status(400).json({ error: 'Subtitle URL is required' });
  }

  const cleanExt = (ext === 'vtt') ? 'vtt' : 'srt';
  const sanitizedTitle = (title || 'video')
    .replace(/[^\w\s\u0D80-\u0DFF.-]/gi, '')
    .trim()
    .substring(0, 80) || 'media';

  const filename = `${sanitizedTitle}_${lang}.${cleanExt}`;

  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"; filename*=UTF-8''${encodeURIComponent(filename)}`);
  res.setHeader('Content-Type', cleanExt === 'vtt' ? 'text/vtt; charset=utf-8' : 'text/plain; charset=utf-8');

  try {
    let subUrl = url;
    if (subUrl.includes('timedtext') && !subUrl.includes('fmt=')) {
      subUrl += '&fmt=vtt';
    }

    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
      'Accept-Language': 'en-US,en;q=0.9',
    };

    let rawText = '';
    const upstreamRes = await fetch(subUrl, { headers });
    
    if (upstreamRes.ok) {
      rawText = await upstreamRes.text();
    } else {
      // Fallback: If direct fetch failed, try fetching with python & configured proxy
      const { spawnSync } = await import('child_process');
      const pyArgs = ['-c', `
import urllib.request, os, sys
proxy = os.environ.get('YTDLP_PROXY')
handlers = [urllib.request.ProxyHandler({'http': proxy, 'https': proxy})] if proxy else []
opener = urllib.request.build_opener(*handlers)
req = urllib.request.Request(sys.argv[1], headers={'User-Agent': 'Mozilla/5.0'})
try:
    with opener.open(req, timeout=15) as r:
        sys.stdout.write(r.read().decode('utf-8', errors='ignore'))
except Exception as e:
    sys.stderr.write(str(e))
    sys.exit(1)
`, subUrl];
      
      const pyProc = spawnSync(process.platform === 'win32' ? 'python' : 'python3', pyArgs, {
        encoding: 'utf8',
        env: process.env,
        timeout: 20000
      });

      if (pyProc.status === 0 && pyProc.stdout) {
        rawText = pyProc.stdout;
      } else {
        throw new Error(`Upstream fetch returned HTTP ${upstreamRes.status} (proxy fallback failed)`);
      }
    }

    // If source is SRV1 XML, convert to WEBVTT first
    if (rawText.trim().startsWith('<?xml') || rawText.includes('<transcript>')) {
      rawText = convertSrv1ToVtt(rawText);
    }

    // If requested ext is srt, convert VTT to SRT
    let finalOutput = rawText;
    if (cleanExt === 'srt') {
      finalOutput = convertVttToSrt(rawText);
    }

    res.send(finalOutput);
  } catch (err) {
    console.error('Subtitle download error:', err.message);
    if (!res.headersSent) {
      res.status(500).json({ error: `Subtitle download failed: ${err.message}` });
    } else {
      res.end();
    }
  }
});

// Video & Audio Segment Trimmer Download Stream (Zero Disk Storage)
app.get('/api/trim', (req, res) => {
  const { url, start = 0, end = 10, type = 'video', title = 'clip' } = req.query;
  if (!url) {
    return res.status(400).json({ error: 'URL is required' });
  }

  const isAudio = type === 'audio' || type === 'mp3';
  const ext = isAudio ? 'mp3' : 'mp4';
  const mimeType = isAudio ? 'audio/mpeg' : 'video/mp4';

  const sanitizedTitle = (title || 'clip')
    .replace(/[^\w\s\u0D80-\u0DFF.-]/gi, '')
    .trim()
    .substring(0, 70) || 'trimmed_clip';

  const filename = `${sanitizedTitle}_cut_${Math.round(start)}s-${Math.round(end)}s.${ext}`;

  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"; filename*=UTF-8''${encodeURIComponent(filename)}`);
  res.setHeader('Content-Type', mimeType);

  streamTrimmedDownload(url, start, end, type, res);
});

// Zero-Load Media Proxy Stream with HTTP Range pass-through for in-browser Trimmer preview (TikTok, Instagram, Facebook, etc.)
app.get('/api/proxy-stream', async (req, res) => {
  const { url, referer } = req.query;
  if (!url) {
    return res.status(400).send('URL is required');
  }

  try {
    const targetUrl = decodeURIComponent(url);
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
      'Accept': '*/*',
      'Accept-Encoding': 'identity;q=1, *;q=0',
    };

    if (referer) {
      headers['Referer'] = decodeURIComponent(referer);
    }
    if (req.headers.range) {
      headers['Range'] = req.headers.range;
    }

    const { default: https } = await import('https');
    const { default: http } = await import('http');
    const client = targetUrl.startsWith('https') ? https : http;

    const upstreamReq = client.get(targetUrl, { headers }, (upstreamRes) => {
      // If upstream issues a redirect, follow it cleanly
      if ([301, 302, 307, 308].includes(upstreamRes.statusCode) && upstreamRes.headers.location) {
        return res.redirect(upstreamRes.statusCode, upstreamRes.headers.location);
      }

      // Forward status code (200 OK or 206 Partial Content)
      res.status(upstreamRes.statusCode || 200);

      // Forward headers required for smooth video seeking & playback in browser
      const forwardHeaders = ['content-type', 'content-length', 'content-range', 'accept-ranges'];
      forwardHeaders.forEach((h) => {
        if (upstreamRes.headers[h]) {
          res.setHeader(h, upstreamRes.headers[h]);
        }
      });

      res.setHeader('Access-Control-Allow-Origin', '*');
      upstreamRes.pipe(res);
    });

    upstreamReq.on('error', (err) => {
      console.warn('Proxy-stream error:', err.message);
      if (!res.headersSent) res.status(502).send('Upstream stream error');
    });

    req.on('close', () => {
      upstreamReq.destroy();
    });
  } catch (err) {
    console.error('Proxy stream failed:', err.message);
    if (!res.headersSent) res.status(500).send('Proxy stream failed');
  }
});

// High-Speed Lightweight Video Preview Endpoint (Serves 1-2 MB low-res MP4 with full Range/seeking support)
app.get('/api/preview', async (req, res) => {
  const { url } = req.query;
  if (!url) {
    return res.status(400).send('URL is required');
  }

  const hash = crypto.createHash('md5').update(url).digest('hex');
  const tempFile = path.join(os.tmpdir(), `vidsave_prev_${hash}.mp4`);

  // If already cached on disk, send instantly!
  if (fs.existsSync(tempFile) && fs.statSync(tempFile).size > 10000) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.sendFile(tempFile);
  }

  // Quickly download lightweight 360p/480p preview stream (takes 1-3 seconds, ~1-2 MB, zero transcoding)
  const args = [
    '-m', 'yt_dlp',
    '-f', 'best[height<=480][ext=mp4]/best[width<=480][ext=mp4]/best[height<=480]/best[width<=480]/best',
    '--no-playlist',
    '--no-warnings',
    '--no-part',
    '--socket-timeout', '15',
    ...buildYtdlpArgs(url, true),
    '-o', tempFile,
    url
  ];

  console.log(`[Preview Generator] Generating lightweight in-browser preview for: ${url}`);
  const child = spawn(PYTHON_BIN, args, { windowsHide: true });

  child.on('close', (code) => {
    if (code === 0 && fs.existsSync(tempFile) && fs.statSync(tempFile).size > 5000) {
      res.setHeader('Access-Control-Allow-Origin', '*');
      // Auto-cleanup after 20 minutes
      setTimeout(() => {
        try { if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile); } catch (_) {}
      }, 20 * 60 * 1000);

      return res.sendFile(tempFile);
    } else {
      if (!res.headersSent) {
        res.status(502).send('Failed to generate video preview');
      }
    }
  });

  req.on('close', () => {
    if (!res.headersSent && child && !child.killed) {
      try { child.kill('SIGTERM'); } catch (_) {}
    }
  });
});

app.listen(PORT, () => {
  console.log(`🚀 Video Downloader Backend running at http://localhost:${PORT}`);
});
