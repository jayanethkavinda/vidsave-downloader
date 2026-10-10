import express from 'express';
import cors from 'cors';
import { getVideoInfo, streamVideoDownload } from './services/downloader.js';

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
    const fs = await import('fs');
    const path = await import('path');
    const hasCookieFile = fs.existsSync(path.resolve('ytdlp_session_cookies.txt'));
    const hasLegacy = fs.existsSync(path.resolve('cookies.txt'));
    const cookieSize = hasCookieFile ? fs.statSync(path.resolve('ytdlp_session_cookies.txt')).size : 0;
    
    res.json({
      pyVer,
      ytdlpVer,
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

  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(sanitizedTitle)}.${ext}"`);
  res.setHeader('Content-Type', mimeType);

  streamVideoDownload(url, format, res);
});

app.listen(PORT, () => {
  console.log(`🚀 Video Downloader Backend running at http://localhost:${PORT}`);
});
