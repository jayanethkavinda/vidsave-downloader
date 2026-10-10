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

  const ext = format.includes('audio') || format === 'mp3' ? 'mp3' : 'mp4';
  const mimeType = ext === 'mp3' ? 'audio/mpeg' : 'video/mp4';

  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(sanitizedTitle)}.${ext}"`);
  res.setHeader('Content-Type', mimeType);

  streamVideoDownload(url, format, res);
});

app.listen(PORT, () => {
  console.log(`🚀 Video Downloader Backend running at http://localhost:${PORT}`);
});
