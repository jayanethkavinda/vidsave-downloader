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
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import {
  assertSafeUrl,
  safeFetch,
  isMediaContentType,
  heavyConcurrencyGuard,
  killProcessTree
} from './services/security.js';

const app = express();
const PORT = process.env.PORT || 5000;

// Trust reverse proxy (Render cloud load balancer)
app.set('trust proxy', 1);

// Standard HTTP Security Headers (Clickjacking protection, MIME-sniffing prevention, remove X-Powered-By)
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  contentSecurityPolicy: false,
}));

// Authorized frontend domains whitelist
const allowedOrigins = new Set([
  'https://vidsave-downloader.web.app',
  'https://vidsave-hd.web.app',
  'https://videsave.web.app',
  'https://vidsave-downloader.firebaseapp.com',
  'https://vidsave-hd.firebaseapp.com',
  'https://videsave.firebaseapp.com',
  'https://videodownloader-37389.web.app',
  'https://videodownloader-37389.firebaseapp.com',
  'http://localhost:5173',
  'http://localhost:3000',
  'http://127.0.0.1:5173'
]);

app.use(cors({
  origin: (origin, callback) => {
    // Allow non-browser requests (e.g. mobile apps, curl, or direct browser address bar navigations without Origin header)
    if (!origin || allowedOrigins.has(origin)) {
      return callback(null, true);
    }
    console.warn(`[CORS Blocked] Unauthorized request from origin: "${origin}"`);
    return callback(new Error('CORS policy: Request from this origin is not allowed.'));
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  credentials: true
}));

app.use(express.json());

// Concurrency Cap: Prevent simultaneous heavy FFmpeg / yt-dlp tasks from exhausting Render 512MB RAM
app.use(['/api/download', '/api/trim', '/api/preview', '/api/proxy-stream'], heavyConcurrencyGuard);

// Rate Limiter for Video Search & Info: Strictly 8 searches per 1 minute per IP
const searchLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute (60 seconds)
  max: 8, // Maximum 8 searches per minute per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: 'Too many search requests. Please wait a minute before searching again.'
  }
});

// Rate Limiter for Video Downloads & Trims: 8 downloads per 1 minute per IP
const downloadLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 8,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: 'Too many download requests. Please wait a minute before starting another download.'
  }
});

// Health Check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', engine: 'yt-dlp + python3', timestamp: new Date() });
});

// Admin Authorization Guard for diagnostic endpoints
const adminAuthGuard = (req, res, next) => {
  const adminSecret = process.env.ADMIN_SECRET_KEY;
  if (!adminSecret || req.headers['x-admin-key'] !== adminSecret) {
    return res.status(403).json({ error: 'Forbidden: Admin authorization required' });
  }
  next();
};

// Diagnostic Endpoint (Protected)
app.get('/api/diagnose', adminAuthGuard, async (req, res) => {
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

// Server IP Check Endpoint (Protected)
app.get('/api/check-ip', adminAuthGuard, async (req, res) => {
  try {
    const ipRes = await fetch('https://api.ipify.org?format=json').then(r => r.json()).catch(() => ({ ip: 'Unknown' }));
    res.json({
      serverIp: ipRes.ip,
      isDatacenter: true,
      timestamp: new Date()
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Diagnostic endpoint to test Fallback directly (Protected)
app.get('/api/test-snap', adminAuthGuard, async (req, res) => {
  const testUrl = req.query.url || 'https://www.instagram.com/reel/DeQ3rBVSU8Q/';
  try {
    const safeUrl = await assertSafeUrl(testUrl);
    const { snapsave } = await import('snapsave-media-downloader');
    const out = await snapsave(safeUrl);
    res.json({ success: true, out });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Video Metadata Endpoint (Rate limited to 8 searches per minute per IP)
app.get('/api/info', searchLimiter, async (req, res) => {
  const { url } = req.query;
  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'Valid URL is required' });
  }

  let safeUrl;
  try {
    safeUrl = await assertSafeUrl(url);
  } catch (urlErr) {
    return res.status(400).json({ error: urlErr.message });
  }

  try {
    const info = await getVideoInfo(safeUrl);
    res.json(info);
  } catch (error) {
    console.error('Info extraction error:', error.message);
    res.status(500).json({ 
      error: error.message || 'Failed to extract video information. Please ensure the link is public.' 
    });
  }
});

// Direct Download Stream Endpoint (Zero Disk Storage - Rate limited to 8 per minute per IP)
app.get('/api/download', downloadLimiter, async (req, res) => {
  const { url, format = 'best', title = 'video' } = req.query;
  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'Valid URL is required' });
  }

  let safeUrl;
  try {
    safeUrl = await assertSafeUrl(url);
  } catch (urlErr) {
    return res.status(400).json({ error: urlErr.message });
  }

  const rawFormat = typeof format === 'string' ? format : 'best';
  const cleanFormat = /^[a-zA-Z0-9_+\-.:]{1,50}$/.test(rawFormat) ? rawFormat : 'best';

  // Clean filename for HTTP Content-Disposition
  const rawTitle = typeof title === 'string' ? title : 'video';
  const sanitizedTitle = rawTitle
    .replace(/[^\w\s\u0D80-\u0DFF.-]/gi, '')
    .trim()
    .substring(0, 80) || 'media';

  const isAudio = cleanFormat === 'audio_best' || cleanFormat === 'mp3' || (cleanFormat.includes('audio') && !cleanFormat.includes('best_with_audio'));
  const ext = isAudio ? 'mp3' : 'mp4';
  const mimeType = isAudio ? 'audio/mpeg' : 'video/mp4';

  const asciiTitle = sanitizedTitle.replace(/[^\w\s.-]/g, '_').replace(/\s+/g, ' ').trim() || 'media';
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${asciiTitle}.${ext}"; filename*=UTF-8''${encodeURIComponent(sanitizedTitle)}.${ext}`
  );
  res.setHeader('Content-Type', mimeType);

  streamVideoDownload(safeUrl, cleanFormat, res);
});

// Dedicated Subtitle Download Stream Endpoint (.SRT & .VTT)
app.get('/api/subtitle', async (req, res) => {
  const { url, lang = 'en', ext = 'srt', title = 'subtitles' } = req.query;
  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'Subtitle URL is required' });
  }

  const cleanLang = (typeof lang === 'string' ? lang : 'en').replace(/[^a-zA-Z0-9_-]/g, '').substring(0, 10) || 'en';
  const cleanExt = (ext === 'vtt') ? 'vtt' : 'srt';
  const rawTitle = typeof title === 'string' ? title : 'video';
  const sanitizedTitle = rawTitle
    .replace(/[^\w\s\u0D80-\u0DFF.-]/gi, '')
    .trim()
    .substring(0, 80) || 'media';

  const filename = `${sanitizedTitle}_${cleanLang}.${cleanExt}`;

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
    // SSRF-Safe fetch with redirect validation
    const upstreamRes = await safeFetch(subUrl, { headers });
    
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

// Video & Audio Segment Trimmer Download Stream (Zero Disk Storage - Rate limited to 8 per minute per IP)
app.get('/api/trim', downloadLimiter, async (req, res) => {
  const { url, start = 0, end = 10, type = 'video', title = 'clip', format = 'best' } = req.query;
  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'Valid URL is required' });
  }

  let safeUrl;
  try {
    safeUrl = await assertSafeUrl(url);
  } catch (urlErr) {
    return res.status(400).json({ error: urlErr.message });
  }

  const isAudio = type === 'audio' || type === 'mp3';
  const ext = isAudio ? 'mp3' : 'mp4';
  const mimeType = isAudio ? 'audio/mpeg' : 'video/mp4';

  const rawFormat = typeof format === 'string' ? format : 'best';
  const cleanFormat = /^[a-zA-Z0-9_+\-.:]{1,50}$/.test(rawFormat) ? rawFormat : 'best';

  const rawTitle = typeof title === 'string' ? title : 'clip';
  const sanitizedTitle = rawTitle
    .replace(/[^\w\s\u0D80-\u0DFF.-]/gi, '')
    .trim()
    .substring(0, 70) || 'trimmed_clip';

  const filename = `${sanitizedTitle}_cut_${Math.round(start)}s-${Math.round(end)}s.${ext}`;

  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"; filename*=UTF-8''${encodeURIComponent(filename)}`);
  res.setHeader('Content-Type', mimeType);

  streamTrimmedDownload(safeUrl, start, end, type, cleanFormat, res);
});

// Zero-Load Media Proxy Stream with HTTP Range pass-through for in-browser Trimmer preview (TikTok, Instagram, Facebook, etc.)
app.get('/api/proxy-stream', async (req, res) => {
  const { url, referer } = req.query;
  if (!url || typeof url !== 'string') {
    return res.status(400).send('Valid URL is required');
  }

  let safeTargetUrl;
  try {
    safeTargetUrl = await assertSafeUrl(decodeURIComponent(url));
  } catch (urlErr) {
    return res.status(400).send(`Invalid URL: ${urlErr.message}`);
  }

  try {
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
      'Accept': '*/*',
      'Accept-Encoding': 'identity;q=1, *;q=0',
    };

    if (referer && typeof referer === 'string') {
      headers['Referer'] = decodeURIComponent(referer);
    }
    if (req.headers.range) {
      headers['Range'] = req.headers.range;
    }

    const { default: https } = await import('https');
    const { default: http } = await import('http');
    const client = safeTargetUrl.startsWith('https') ? https : http;

    const upstreamReq = client.get(safeTargetUrl, { headers }, async (upstreamRes) => {
      // Follow redirects with SSRF re-validation
      if ([301, 302, 307, 308].includes(upstreamRes.statusCode) && upstreamRes.headers.location) {
        try {
          const redirectTarget = await assertSafeUrl(new URL(upstreamRes.headers.location, safeTargetUrl).href);
          return res.redirect(upstreamRes.statusCode, redirectTarget);
        } catch (_) {
          return res.status(403).send('Redirect to restricted network address blocked');
        }
      }

      // Enforce Content-Type allowlist (block Reflected XSS)
      const ct = upstreamRes.headers['content-type'] || '';
      if (!isMediaContentType(ct)) {
        upstreamReq.destroy();
        return res.status(415).send('Unsupported media content-type');
      }

      // Standard media security headers
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox;");

      // Forward status code (200 OK or 206 Partial Content)
      res.status(upstreamRes.statusCode || 200);

      // Forward headers required for smooth video seeking & playback in browser
      const forwardHeaders = ['content-type', 'content-length', 'content-range', 'accept-ranges'];
      forwardHeaders.forEach((h) => {
        if (upstreamRes.headers[h]) {
          res.setHeader(h, upstreamRes.headers[h]);
        }
      });

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
  if (!url || typeof url !== 'string') {
    return res.status(400).send('Valid URL is required');
  }

  let safeTargetUrl;
  try {
    safeTargetUrl = await assertSafeUrl(url);
  } catch (urlErr) {
    return res.status(400).send(`Invalid URL: ${urlErr.message}`);
  }

  const hash = crypto.createHash('md5').update(safeTargetUrl).digest('hex');
  const tempFile = path.join(os.tmpdir(), `vidsave_prev_${hash}.mp4`);

  // If already cached on disk, send instantly!
  if (fs.existsSync(tempFile) && fs.statSync(tempFile).size > 10000) {
    return res.sendFile(tempFile);
  }

  // Quickly download lightweight 360p/480p preview stream (takes 1-3 seconds, ~1-2 MB, zero transcoding)
  const args = [
    '-m', 'yt_dlp',
    '-f', 'worst[height<=240][ext=mp4]/worst[width<=240][ext=mp4]/worstvideo[height<=240]+worstaudio/worstvideo[width<=240]+worstaudio/worst[height<=360][ext=mp4]/worst[width<=360][ext=mp4]/worst[height<=480]/worst',
    '--no-playlist',
    '--no-warnings',
    '--no-part',
    '--socket-timeout', '15',
    ...buildYtdlpArgs(safeTargetUrl, true),
    '-o', tempFile,
    '--',
    safeTargetUrl
  ];

  console.log(`[Preview Generator] Generating lightweight in-browser preview for: ${safeTargetUrl}`);
  const child = spawn(PYTHON_BIN, args, {
    windowsHide: true,
    detached: process.platform !== 'win32'
  });

  const watchdog = setTimeout(() => {
    killProcessTree(child);
    try { if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile); } catch (_) {}
  }, 45 * 1000);
  if (watchdog.unref) watchdog.unref();

  child.on('close', (code) => {
    clearTimeout(watchdog);
    if (code === 0 && fs.existsSync(tempFile) && fs.statSync(tempFile).size > 5000) {
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
    clearTimeout(watchdog);
    if (!res.headersSent && child && !child.killed) {
      killProcessTree(child);
    }
  });
});

app.listen(PORT, () => {
  console.log(`🚀 Video Downloader Backend running at http://localhost:${PORT}`);
});
