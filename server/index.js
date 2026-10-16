import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { 
  assertSafeUrl, 
  sanitizeFilename 
} from './services/security.js';
import { getVideoInfo } from './services/infoExtractor.js';
import { streamVideoDownload } from './services/streamDownloader.js';
import { streamTrimmedDownload } from './services/trimService.js';
import { convertVttToSrt } from './services/subtitleService.js';
import { streamVideoPreview } from './services/previewService.js';
import { isYouTubeUrl } from './services/coreEngine.js';
import { 
  registerDownloadToken, 
  markDownloadStarted, 
  markDownloadError, 
  getDownloadStatus 
} from './services/tokenManager.js';

const app = express();
const PORT = process.env.PORT || 5000;

// Trust reverse proxy (Required by Render / Cloudflare for rate-limit & client IP detection)
app.set('trust proxy', 1);

// Security Middleware
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  contentSecurityPolicy: false
}));

// Allowed Frontend Origins Whitelist
const ALLOWED_ORIGINS = [
  'https://vidsave-downloader.web.app',
  'https://videsave.web.app',
  'https://vidsave-hd.web.app',
  'http://localhost:5173',
  'http://localhost:3000'
];

app.use(cors({
  origin: function (origin, callback) {
    // Allow requests with no origin (like mobile apps, curl, or direct browser downloads)
    if (!origin) return callback(null, true);
    if (ALLOWED_ORIGINS.includes(origin)) {
      return callback(null, true);
    }
    return callback(new Error('CORS policy: Access from this origin is unauthorized.'));
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Range']
}));

app.use(express.json());

// Smart Multi-Tier Concurrency Controller (Optimized for 0.1 vCPU & 512MB RAM)
let activeSocialDownloads = 0;
const MAX_CONCURRENT_SOCIAL = 15; // TikTok, Instagram, Twitter/X, Facebook, Pinterest, Threads, Reddit

let activeYtHeavyDownloads = 0;
const MAX_CONCURRENT_YT_HEAVY = 1; // YouTube > 720p: 1080p, 1440p, 4K, 8K (Heavy FFmpeg muxing)

let activeYtLightDownloads = 0;
const MAX_CONCURRENT_YT_LIGHT = 4; // YouTube <= 720p: 720p, 480p, 360p, MP3 Audio (Lightweight streams)

let activeTrimmerJobs = 0;
const MAX_CONCURRENT_TRIM = 3; // Trimmer clipping jobs

// 🛡️ Guard for /api/download
const smartDownloadConcurrencyGuard = (req, res, next) => {
  const url = (req.query.url || '').trim();
  const format = (req.query.format || 'best').trim();
  const isYt = isYouTubeUrl(url);

  // 1. 🌐 Social Platforms (TikTok, IG, Twitter/X, FB, Pinterest, Threads, Reddit)
  if (!isYt) {
    if (activeSocialDownloads >= MAX_CONCURRENT_SOCIAL) {
      return res.status(503).json({
        error: `Social downloads are currently at peak capacity (${MAX_CONCURRENT_SOCIAL} active). Please retry in a few moments!`
      });
    }
    activeSocialDownloads++;
    let released = false;
    const release = () => {
      if (!released) {
        released = true;
        activeSocialDownloads = Math.max(0, activeSocialDownloads - 1);
      }
    };
    res.on('finish', release);
    res.on('close', release);
    return next();
  }

  // 2. ▶️ YouTube Downloads
  const isHeavy = ['4320', '2160', '1440', '1080', 'best', 'best_with_audio'].includes(format);

  if (isHeavy) {
    // 🔴 YouTube Heavy (> 720p)
    if (activeYtHeavyDownloads >= MAX_CONCURRENT_YT_HEAVY) {
      return res.status(503).json({
        error: 'YouTube HD (1080p / 4K) processing is currently busy with another download. Please try again in a few seconds!'
      });
    }
    activeYtHeavyDownloads++;
    let released = false;
    const release = () => {
      if (!released) {
        released = true;
        activeYtHeavyDownloads = Math.max(0, activeYtHeavyDownloads - 1);
      }
    };
    res.on('finish', release);
    res.on('close', release);
    return next();
  }

  // 🟢 YouTube Standard (<= 720p: 720p, 480p, 360p, MP3)
  if (activeYtLightDownloads >= MAX_CONCURRENT_YT_LIGHT) {
    return res.status(503).json({
      error: 'YouTube standard downloads are currently busy. Please wait a few seconds!'
    });
  }
  activeYtLightDownloads++;
  let released = false;
  const release = () => {
    if (!released) {
      released = true;
      activeYtLightDownloads = Math.max(0, activeYtLightDownloads - 1);
    }
  };
  res.on('finish', release);
  res.on('close', release);
  return next();
};

// 🛡️ Guard for /api/trim
const smartTrimConcurrencyGuard = (req, res, next) => {
  if (activeTrimmerJobs >= MAX_CONCURRENT_TRIM) {
    return res.status(503).json({
      error: 'Video trimmer is currently busy with other clips. Please try again in a few seconds!'
    });
  }
  activeTrimmerJobs++;
  let released = false;
  const release = () => {
    if (!released) {
      released = true;
      activeTrimmerJobs = Math.max(0, activeTrimmerJobs - 1);
    }
  };
  res.on('finish', release);
  res.on('close', release);
  next();
};

// 🛡️ Guard for /api/preview
let activePreviewJobs = 0;
const MAX_CONCURRENT_PREVIEW = 3;

const smartPreviewConcurrencyGuard = (req, res, next) => {
  if (activePreviewJobs >= MAX_CONCURRENT_PREVIEW) {
    return res.status(503).json({
      error: 'Preview service is currently busy. Please try again in a few seconds!'
    });
  }
  activePreviewJobs++;
  let released = false;
  const release = () => {
    if (!released) {
      released = true;
      activePreviewJobs = Math.max(0, activePreviewJobs - 1);
    }
  };
  res.on('finish', release);
  res.on('close', release);
  next();
};

// Backwards compatibility alias
const heavyConcurrencyGuard = smartPreviewConcurrencyGuard;

// Rate Limiters
const searchLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 8,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many search requests. Please wait a minute before searching again.' }
});

const downloadLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 8,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many download requests. Please wait a minute before downloading again.' }
});

// 1. Health Check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', engine: 'yt-dlp + FFmpeg', timestamp: new Date() });
});

// 2. Video Info Endpoint
app.get('/api/info', searchLimiter, async (req, res) => {
  const { url } = req.query;
  try {
    const safeUrl = await assertSafeUrl(url);
    const info = await getVideoInfo(safeUrl);
    res.json(info);
  } catch (err) {
    console.error('[API /api/info Error]:', err.message);
    res.status(500).json({ error: err.message || 'Failed to extract video details.' });
  }
});

// 3. Full Video Download Stream Endpoint
app.get('/api/download', downloadLimiter, smartDownloadConcurrencyGuard, async (req, res) => {
  const { url, format = 'best', title = 'video', directUrl, token } = req.query;
  if (token) registerDownloadToken(token);

  try {
    const safeUrl = await assertSafeUrl(url);
    const isAudio = format === 'audio_best' || format === 'mp3';
    const ext = isAudio ? 'mp3' : 'mp4';
    const mimeType = isAudio ? 'audio/mpeg' : 'video/mp4';

    const { contentDisposition } = sanitizeFilename(title, ext);
    res.setHeader('Content-Disposition', contentDisposition);
    res.setHeader('Content-Type', mimeType);

    streamVideoDownload(safeUrl, format, res, directUrl, token);
  } catch (err) {
    if (token) markDownloadError(token, err.message);
    console.error('[API /api/download Error]:', err.message);
    if (!res.headersSent) {
      res.status(400).json({ error: err.message });
    }
  }
});

// 3.1 Download Handshake Status Endpoint (Zero-overhead, cross-origin)
app.get('/api/download-status', (req, res) => {
  const { token } = req.query;
  const status = getDownloadStatus(token);
  res.json(status);
});

// 4. Video & Audio Segment Trimmer Download Stream Endpoint
app.get('/api/trim', downloadLimiter, smartTrimConcurrencyGuard, async (req, res) => {
  const { url, start = 0, end = 10, type = 'video', title = 'clip', format = 'best' } = req.query;
  try {
    const safeUrl = await assertSafeUrl(url);

    // Enforce trimmer duration safety limits (Prevents long freezing jobs on 0.1 CPU)
    const numStart = Math.max(0, parseFloat(start) || 0);
    const numEnd = Math.max(numStart + 0.1, parseFloat(end) || 10);
    const clipDuration = numEnd - numStart;
    const MAX_TRIM_DURATION_SEC = 600; // Max 10 minutes per clip

    if (clipDuration > MAX_TRIM_DURATION_SEC) {
      return res.status(400).json({ error: `Clip duration exceeds maximum limit of 10 minutes (${MAX_TRIM_DURATION_SEC}s).` });
    }

    // Format parameter allowlist
    const validFormats = ['best', '4320', '2160', '1440', '1080', '720', '480', '360', 'audio', 'mp3'];
    const safeFormat = validFormats.includes(format) ? format : 'best';

    const isAudio = type === 'audio' || type === 'mp3' || safeFormat === 'audio' || safeFormat === 'mp3';
    const ext = isAudio ? 'mp3' : 'mp4';
    const mimeType = isAudio ? 'audio/mpeg' : 'video/mp4';

    const cleanTitle = `${title}_cut_${Math.round(numStart)}s-${Math.round(numEnd)}s`;
    const { contentDisposition } = sanitizeFilename(cleanTitle, ext);

    res.setHeader('Content-Disposition', contentDisposition);
    res.setHeader('Content-Type', mimeType);

    streamTrimmedDownload(safeUrl, numStart, numEnd, type, safeFormat, res);
  } catch (err) {
    console.error('[API /api/trim Error]:', err.message);
    if (!res.headersSent) {
      res.status(400).json({ error: err.message });
    }
  }
});

// 5. Dedicated Subtitle Download Stream Endpoint (.SRT & .VTT)
app.get('/api/subtitle', async (req, res) => {
  const { url, lang = 'en', ext = 'srt', title = 'subtitles' } = req.query;
  try {
    if (!url) throw new Error('Subtitle URL is required.');
    const safeSubUrl = await assertSafeUrl(url);

    const cleanExt = (ext === 'vtt') ? 'vtt' : 'srt';
    const cleanTitle = `${title}_${lang}`;
    const { contentDisposition } = sanitizeFilename(cleanTitle, cleanExt);

    res.setHeader('Content-Disposition', contentDisposition);
    res.setHeader('Content-Type', cleanExt === 'vtt' ? 'text/vtt; charset=utf-8' : 'text/plain; charset=utf-8');

    let subUrl = safeSubUrl;
    if (subUrl.includes('timedtext') && !subUrl.includes('fmt=')) {
      subUrl += '&fmt=vtt';
    }

    const { default: https } = await import('https');
    const { default: http } = await import('http');
    const client = subUrl.startsWith('https') ? https : http;

    client.get(subUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } }, upstreamRes => {
      let rawText = '';
      upstreamRes.on('data', chunk => { rawText += chunk; });
      upstreamRes.on('end', () => {
        let finalOutput = rawText;
        if (cleanExt === 'srt') {
          finalOutput = convertVttToSrt(rawText);
        }
        res.send(finalOutput);
      });
    }).on('error', err => {
      if (!res.headersSent) res.status(500).json({ error: 'Subtitle download failed: ' + err.message });
    });
  } catch (err) {
    if (!res.headersSent) res.status(400).json({ error: err.message });
  }
});

// 6. High-Speed Lightweight Video Preview Endpoint (Serves 1-2 MB low-res MP4 with sound and full Range/seeking support)
app.get('/api/preview', smartPreviewConcurrencyGuard, async (req, res) => {
  const { url } = req.query;
  if (!url || typeof url !== 'string') {
    return res.status(400).send('Valid URL is required');
  }

  try {
    const safeTargetUrl = await assertSafeUrl(url);
    await streamVideoPreview(safeTargetUrl, req, res);
  } catch (err) {
    console.error('[API /api/preview Error]:', err.message);
    if (!res.headersSent) {
      res.status(400).send(`Invalid URL: ${err.message}`);
    }
  }
});

// 7. Zero-Load Media Proxy Stream with HTTP Range for Trimmer HTML5 preview (Zero Disk, Zero Memory)
app.get('/api/proxy-stream', async (req, res) => {
  const { url, origin } = req.query;
  if (!url) return res.status(400).send('URL required');
  try {
    const safeStreamUrl = await assertSafeUrl(url);

    const { default: https } = await import('https');
    const { default: http } = await import('http');
    const client = safeStreamUrl.startsWith('https') ? https : http;

    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
      'Accept': '*/*',
      'Accept-Encoding': 'identity;q=1, *;q=0'
    };

    // Forward platform referer to bypass 403 Forbidden (TikTok, Twitter, Instagram, Facebook, Pinterest)
    const checkTarget = `${origin || ''} ${url}`.toLowerCase();
    if (checkTarget.includes('tiktok.com')) headers['Referer'] = 'https://www.tiktok.com/';
    else if (checkTarget.includes('instagram.com')) headers['Referer'] = 'https://www.instagram.com/';
    else if (checkTarget.includes('facebook.com') || checkTarget.includes('fb.watch')) headers['Referer'] = 'https://www.facebook.com/';
    else if (checkTarget.includes('pinterest.com') || checkTarget.includes('pin.it')) headers['Referer'] = 'https://www.pinterest.com/';
    else if (checkTarget.includes('twitter.com') || checkTarget.includes('x.com')) headers['Referer'] = 'https://twitter.com/';
    else if (checkTarget.includes('threads.net')) headers['Referer'] = 'https://www.threads.net/';

    // HTTP Range pass-through for HTML5 <video> seeking in user browser RAM
    if (req.headers.range) {
      headers['Range'] = req.headers.range;
    }

    const proxyReq = client.get(safeStreamUrl, { headers }, (proxyRes) => {
      // Handle redirects (301, 302, 307, 308)
      if ([301, 302, 307, 308].includes(proxyRes.statusCode) && proxyRes.headers.location) {
        return res.redirect(proxyRes.statusCode, `/api/proxy-stream?url=${encodeURIComponent(proxyRes.headers.location)}&origin=${encodeURIComponent(origin || '')}`);
      }

      // Pass essential media streaming headers
      const resHeaders = {};
      if (proxyRes.headers['content-type']) resHeaders['Content-Type'] = proxyRes.headers['content-type'];
      if (proxyRes.headers['content-length']) resHeaders['Content-Length'] = proxyRes.headers['content-length'];
      if (proxyRes.headers['content-range']) resHeaders['Content-Range'] = proxyRes.headers['content-range'];
      if (proxyRes.headers['accept-ranges']) resHeaders['Accept-Ranges'] = proxyRes.headers['accept-ranges'];

      res.writeHead(proxyRes.statusCode, resHeaders);
      proxyRes.pipe(res);
    });

    proxyReq.on('error', (err) => {
      console.warn('[Proxy Stream Error]', err.message);
      if (!res.headersSent) res.status(502).end();
    });

    res.on('close', () => {
      proxyReq.destroy();
    });
  } catch (_) {
    if (!res.headersSent) res.status(400).end();
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 [VidSave Backend] Server running on port ${PORT}`);
});
