import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { 
  assertSafeUrl, 
  sanitizeFilename 
} from './services/security.js';
import { 
  getVideoInfo, 
  streamVideoDownload, 
  streamTrimmedDownload, 
  convertVttToSrt,
  isYouTubeUrl 
} from './services/downloader.js';

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

// Concurrency Guard for 0.1 vCPU / 512MB RAM protection
let activeHeavyProcesses = 0;
const MAX_CONCURRENT_HEAVY = 5;

const heavyConcurrencyGuard = (req, res, next) => {
  if (activeHeavyProcesses >= MAX_CONCURRENT_HEAVY) {
    return res.status(503).json({
      error: 'Server capacity is temporarily busy. Please try again in a few seconds!'
    });
  }
  activeHeavyProcesses++;
  let decremented = false;
  const release = () => {
    if (!decremented) {
      decremented = true;
      activeHeavyProcesses = Math.max(0, activeHeavyProcesses - 1);
    }
  };
  res.on('finish', release);
  res.on('close', release);
  next();
};

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
app.get('/api/download', downloadLimiter, heavyConcurrencyGuard, async (req, res) => {
  const { url, format = 'best', title = 'video' } = req.query;
  try {
    const safeUrl = await assertSafeUrl(url);
    const isAudio = format === 'audio_best' || format === 'mp3';
    const ext = isAudio ? 'mp3' : 'mp4';
    const mimeType = isAudio ? 'audio/mpeg' : 'video/mp4';

    const { contentDisposition } = sanitizeFilename(title, ext);
    res.setHeader('Content-Disposition', contentDisposition);
    res.setHeader('Content-Type', mimeType);

    streamVideoDownload(safeUrl, format, res);
  } catch (err) {
    console.error('[API /api/download Error]:', err.message);
    if (!res.headersSent) {
      res.status(400).json({ error: err.message });
    }
  }
});

// 4. Video & Audio Segment Trimmer Download Stream Endpoint
app.get('/api/trim', downloadLimiter, heavyConcurrencyGuard, async (req, res) => {
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
    const validFormats = ['best', '1080', '720', '480', '360', 'audio', 'mp3'];
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

// 6. Zero-Load Media Proxy Stream with HTTP Range for Trimmer HTML5 preview (SSRF Protected)
app.get('/api/proxy-stream', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).send('URL required');
  try {
    const safeStreamUrl = await assertSafeUrl(url);

    const { default: https } = await import('https');
    const { default: http } = await import('http');
    const client = safeStreamUrl.startsWith('https') ? https : http;
    const headers = { 'User-Agent': 'Mozilla/5.0', 'Accept': '*/*' };
    if (req.headers.range) headers['Range'] = req.headers.range;

    const proxyReq = client.get(safeStreamUrl, { headers }, proxyRes => {
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(res);
    });

    proxyReq.on('error', () => {
      if (!res.headersSent) res.status(500).end();
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
