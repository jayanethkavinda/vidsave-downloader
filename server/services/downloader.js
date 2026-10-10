import { spawn, execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

// Automatically detect Python command (python3 on Linux/Render, python on Windows)
function getPythonCommand() {
  const candidates = ['python3', 'python', 'py'];
  for (const cmd of candidates) {
    try {
      execSync(`${cmd} --version`, { stdio: 'ignore' });
      return cmd;
    } catch (e) {
      // continue to next candidate
    }
  }
  return 'python3';
}

const PYTHON_BIN = getPythonCommand();
console.log(`[Downloader Engine] Using Python binary: "${PYTHON_BIN}"`);

// Automatically detect ffmpeg path from imageio_ffmpeg or system
let ffmpegPath = '';
try {
  ffmpegPath = execSync(`${PYTHON_BIN} -c "import imageio_ffmpeg; print(imageio_ffmpeg.get_ffmpeg_exe())"`, { 
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'ignore']
  }).trim();
} catch (e) {
  ffmpegPath = 'ffmpeg';
}

const COOKIE_FILE = path.resolve('ytdlp_session_cookies.txt');

// Remove legacy root cookies.txt to prevent yt-dlp from implicitly auto-loading it
try {
  const legacyCookie = path.resolve('cookies.txt');
  if (fs.existsSync(legacyCookie)) {
    fs.unlinkSync(legacyCookie);
  }
} catch (e) {}

if (process.env.YTDLP_COOKIES && process.env.YTDLP_COOKIES.trim().length > 0) {
  try {
    const raw = process.env.YTDLP_COOKIES.trim();
    const unescaped = raw.replace(/\\r\\n/g, '\n').replace(/\\n/g, '\n');
    let lines = unescaped.split(/\r?\n/).map(line => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return line;
      const parts = trimmed.split(/\s+/);
      if (parts.length >= 7) {
        return parts.slice(0, 6).concat(parts.slice(6).join(' ')).join('\t');
      }
      return line;
    });
    if (!lines[0] || !lines[0].includes('Netscape')) {
      lines.unshift('# Netscape HTTP Cookie File');
    }
    fs.writeFileSync(COOKIE_FILE, lines.join('\n'), 'utf8');
    console.log('[Downloader Engine] Initialized and normalized session cookies.');
  } catch (e) {
    console.error('[Downloader Engine] Failed to write cookies from env:', e.message);
  }
}

if (fs.existsSync(COOKIE_FILE)) {
  const content = fs.readFileSync(COOKIE_FILE, 'utf8');
  const cookieLines = content.split('\n').filter(l => l.trim() && !l.startsWith('#'));
  console.log(`[Downloader Engine] Cookie file lines: ${cookieLines.length}`);
  console.log(`[Downloader Engine] Has tabs: ${content.includes('\t')}`);
  console.log(`[Downloader Engine] First line starts with: ${content.split('\n')[0]}`);
} else {
  console.log('[Downloader Engine] Cookie file NOT found');
}

// Helper to detect if URL belongs to YouTube
function isYouTubeUrl(rawUrl) {
  if (!rawUrl) return false;
  return /(?:youtube\.com|youtu\.be)/i.test(rawUrl);
}

/**
 * Common yt-dlp arguments for anti-bot bypass & headers
 */
function buildYtdlpArgs(url = '', useCookies = true) {
  const args = [
    '--ignore-config',
    '--no-warnings',
    '--no-playlist',
    '--no-check-formats',
    '--js-runtimes', 'node',
    '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
    '--add-header', 'Accept-Language:en-US,en;q=0.9',
    '--extractor-args', 'youtube:player_client=android,ios,web',
    '--retries', '2',
    '--socket-timeout', '20',
    '--force-ipv4',
  ];

  if (ffmpegPath) {
    args.push('--ffmpeg-location', ffmpegPath);
  }

  if (useCookies) {
    const cookiePath = process.env.YTDLP_COOKIES_PATH
      ? path.resolve(process.env.YTDLP_COOKIES_PATH)
      : (fs.existsSync(COOKIE_FILE) ? COOKIE_FILE : null);

    if (cookiePath && fs.existsSync(cookiePath)) {
      args.push('--cookies', cookiePath);
    }
  }

  // Optimize proxy bandwidth: Apply proxy ONLY for YouTube to protect proxy data limits!
  // TikTok, Instagram, Facebook, Twitter, Pinterest download directly on unlimited server network.
  if (process.env.YTDLP_PROXY && (!url || isYouTubeUrl(url))) {
    args.push('--proxy', process.env.YTDLP_PROXY);
  }

  return args;
}

/**
 * Helper to run yt-dlp metadata extraction
 */
function execYtdlpJson(url, extraArgs = [], useCookies = true) {
  return new Promise((resolve, reject) => {
    const args = [
      '-m', 'yt_dlp',
      '--dump-single-json',
      ...buildYtdlpArgs(url, useCookies),
      ...extraArgs,
      url,
    ];

    const child = spawn(PYTHON_BIN, args, {
      windowsHide: true,
      maxBuffer: 1024 * 1024 * 35,
    });

    let stdoutData = '';
    let stderrData = '';

    child.stdout.on('data', (chunk) => {
      stdoutData += chunk.toString();
    });

    child.stderr.on('data', (chunk) => {
      stderrData += chunk.toString();
    });

    child.on('close', (code) => {
      if (code !== 0) {
        return reject({ code, stderr: stderrData });
      }
      try {
        resolve(JSON.parse(stdoutData));
      } catch (err) {
        reject({ code: -1, stderr: `JSON parse error: ${err.message}` });
      }
    });

    child.on('error', (err) => {
      reject({ code: -1, stderr: err.message });
    });
  });
}

/**
 * Get video metadata with automatic multi-tier fallback
 */
export async function getVideoInfo(url) {
  let rawInfo = null;

  // Attempt 1: Standard extraction (with normalized cookies + node JS runtime)
  try {
    rawInfo = await execYtdlpJson(url, [], true);
  } catch (err1) {
    console.warn('[Downloader Engine] Primary extraction attempt failed, trying fallback client...', err1.stderr || err1);

    // Attempt 2: Fallback extraction (multi-client bypass without session conflict)
    try {
      rawInfo = await execYtdlpJson(url, ['--extractor-args', 'youtube:player_client=ios,android,tv,web'], false);
    } catch (err2) {
      console.error('[Downloader Engine] Fallback extraction failed:', err2.stderr || err2);
      const cleanErr = (err2.stderr || err1.stderr || 'Failed to extract video information').trim();
      throw new Error(cleanErr);
    }
  }

  try {
        
        // Formats with sound prioritized
        const formats = [];
        const seenHeights = new Set();

        if (Array.isArray(rawInfo.formats)) {
          const sortedFormats = rawInfo.formats
            .filter(f => f.vcodec !== 'none' || f.acodec !== 'none')
            .sort((a, b) => (b.height || 0) - (a.height || 0));

          for (const f of sortedFormats) {
            const isVideo = f.vcodec !== 'none';
            const isAudio = f.acodec !== 'none';
            const height = f.height || (f.format_note && f.format_note.match(/\d+p/) ? parseInt(f.format_note) : null);
            const qualityLabel = height ? `${height}p` : (f.format_note || (isVideo ? 'Video' : 'Audio'));
            
            if (isVideo && height && seenHeights.has(qualityLabel)) {
              continue;
            }
            if (isVideo && height) {
              seenHeights.add(qualityLabel);
            }

            formats.push({
              formatId: f.format_id,
              ext: f.ext || 'mp4',
              resolution: qualityLabel,
              filesize: f.filesize || f.filesize_approx || null,
              hasVideo: isVideo,
              hasAudio: isAudio,
              isDirectUrl: !!f.url && f.protocol && !f.protocol.includes('m3u8'),
              directUrl: f.url || null,
              note: f.format_note || ''
            });
          }
        }

        const presets = [
          { id: 'best_with_audio', label: 'Highest Quality HD (Video + Audio)', ext: 'mp4', type: 'video' },
          { id: '720', label: 'HD 720p (with Audio)', ext: 'mp4', type: 'video' },
          { id: '480', label: 'SD 480p (with Audio)', ext: 'mp4', type: 'video' },
          { id: '360', label: 'Fast 360p (with Audio)', ext: 'mp4', type: 'video' },
          { id: 'audio_best', label: 'MP3 / Audio Only', ext: 'mp3', type: 'audio' }
        ];

        const cleanInfo = {
          id: rawInfo.id,
          title: rawInfo.title || 'Extracted Media',
          description: rawInfo.description ? rawInfo.description.slice(0, 300) : '',
          thumbnail: rawInfo.thumbnail || (rawInfo.thumbnails && rawInfo.thumbnails.length ? rawInfo.thumbnails[rawInfo.thumbnails.length - 1].url : null),
          duration: rawInfo.duration || 0,
          durationFormatted: formatDuration(rawInfo.duration || 0),
          uploader: rawInfo.uploader || rawInfo.channel || rawInfo.extractor || 'Web Media',
          webpageUrl: rawInfo.webpage_url || url,
          extractor: rawInfo.extractor_key || rawInfo.extractor || 'Universal Web',
          presets,
          formats: formats.slice(0, 15),
        };

    return cleanInfo;
  } catch (err) {
    throw new Error(`Failed to parse video info: ${err.message}`);
  }
}

/**
 * Stream video stdout directly to HTTP response (Zero-disk write)
 * Ensures AUDIO IS ALWAYS INCLUDED in MP4 downloads for all supported websites.
 */
export function streamVideoDownload(url, formatPreset, res) {
  let formatArg = 'best[acodec!=none][vcodec!=none]/best[vcodec!=none]+bestaudio/b/best';

  if (formatPreset === 'audio_best' || formatPreset === 'mp3') {
    formatArg = 'bestaudio/best';
  } else if (formatPreset === '720') {
    formatArg = 'best[height<=720][acodec!=none]/best[height<=720]/best';
  } else if (formatPreset === '480') {
    formatArg = 'best[height<=480][acodec!=none]/best[height<=480]/best';
  } else if (formatPreset === '360') {
    formatArg = 'best[height<=360][acodec!=none]/best[height<=360]/best';
  } else if (formatPreset && formatPreset !== 'best' && formatPreset !== 'best_with_audio') {
    formatArg = formatPreset;
  }

  const args = [
    '-m', 'yt_dlp',
    '-f', formatArg,
    '-o', '-', // Pipe directly to client browser via stdout
    ...buildYtdlpArgs(url),
    url,
  ];

  console.log(`[Download Stream] Starting universal download for: ${url}`);

  const child = spawn(PYTHON_BIN, args, {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  });

  child.stdout.pipe(res);

  child.stderr.on('data', (data) => {
    const msg = data.toString();
    if (msg.includes('ERROR:')) {
      console.error('[yt-dlp error]', msg.trim());
    }
  });

  child.on('error', (err) => {
    console.error('[spawn error]', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Download stream failed: ' + err.message });
    }
  });

  res.on('close', () => {
    if (!child.killed) {
      child.kill('SIGKILL');
    }
  });
}

function formatDuration(seconds) {
  if (!seconds) return '0:00';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  if (mins >= 60) {
    const hrs = Math.floor(mins / 60);
    const remMins = mins % 60;
    return `${hrs}:${remMins < 10 ? '0' : ''}${remMins}:${secs < 10 ? '0' : ''}${secs}`;
  }
  return `${mins}:${secs < 10 ? '0' : ''}${secs}`;
}
