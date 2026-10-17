import 'dotenv/config';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import ffmpegStatic from 'ffmpeg-static';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 1. Automatically detect Python binary
function getPythonCommand() {
  const candidates = ['python3', 'python', 'py'];
  for (const cmd of candidates) {
    try {
      execSync(`${cmd} --version`, { stdio: 'ignore' });
      return cmd;
    } catch (_) {}
  }
  return 'python3';
}
export const PYTHON_BIN = getPythonCommand();
console.log(`[Core Engine] Python binary: "${PYTHON_BIN}"`);

// 2. Robust FFmpeg binary detection
export let ffmpegPath = '';
if (process.platform === 'linux') {
  if (fs.existsSync('/usr/bin/ffmpeg')) {
    ffmpegPath = '/usr/bin/ffmpeg';
  } else {
    try {
      const candidate = execSync('which ffmpeg', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }).trim();
      if (candidate && fs.existsSync(candidate)) ffmpegPath = candidate;
    } catch (_) {}
  }
}
if (!ffmpegPath && ffmpegStatic && fs.existsSync(ffmpegStatic)) {
  ffmpegPath = ffmpegStatic;
}
console.log(`[Core Engine] FFmpeg binary: "${ffmpegPath || 'system PATH'}"`);

// 3. Session Cookies Sync & Normalization
export const COOKIE_FILE = path.resolve(__dirname, '../ytdlp_session_cookies.txt');

export function syncCookiesFromEnv() {
  const envCookies = process.env.YTDLP_COOKIES;
  
  // If a valid cookies file already exists (> 200 bytes) and no substantial env override is provided, preserve it
  if (fs.existsSync(COOKIE_FILE)) {
    try {
      const stats = fs.statSync(COOKIE_FILE);
      if (stats.size > 200 && (!envCookies || envCookies.trim().length < 200)) {
        console.log(`[Core Engine] Preserved existing cookie file: ${COOKIE_FILE} (${stats.size} bytes)`);
        return;
      }
    } catch (_) {}
  }

  if (!envCookies) return;

  try {
    let content = envCookies.trim();
    if (content.startsWith('base64:')) {
      content = Buffer.from(content.slice(7), 'base64').toString('utf8');
    }
    if (content.includes('\\n')) {
      content = content.replace(/\\n/g, '\n').replace(/\\t/g, '\t');
    }
    if (!content.includes('\t') && content.length > 50) {
      try {
        const parsed = JSON.parse(content);
        if (Array.isArray(parsed)) {
          const lines = ['# Netscape HTTP Cookie File'];
          for (const c of parsed) {
            const domain = c.domain || '.youtube.com';
            const flag = domain.startsWith('.') ? 'TRUE' : 'FALSE';
            const cpath = c.path || '/';
            const secure = c.secure ? 'TRUE' : 'FALSE';
            const expires = c.expirationDate ? Math.floor(c.expirationDate) : Math.floor(Date.now() / 1000) + 86400 * 365;
            lines.push(`${domain}\t${flag}\t${cpath}\t${secure}\t${expires}\t${c.name}\t${c.value}`);
          }
          content = lines.join('\n');
        }
      } catch (_) {}
    }

    if (!content.startsWith('# Netscape HTTP Cookie File')) {
      content = `# Netscape HTTP Cookie File\n${content}`;
    }

    fs.writeFileSync(COOKIE_FILE, content, 'utf8');
    console.log(`[Core Engine] Synchronized YTDLP_COOKIES to ${COOKIE_FILE} (${content.length} bytes)`);
  } catch (err) {
    console.error(`[Core Engine] Failed to write YTDLP_COOKIES:`, err.message);
  }
}

// Initial sync on startup
syncCookiesFromEnv();

// 4. Platform URL Detectors
export function isYouTubeUrl(rawUrl) {
  if (!rawUrl) return false;
  return /(?:youtube\.com|youtu\.be)/i.test(rawUrl);
}

export function isScraperSupportedUrl(rawUrl) {
  if (!rawUrl) return false;
  return /(?:instagram\.com|instagr\.am|facebook\.com|fb\.watch|tiktok\.com|twitter\.com|x\.com)/i.test(rawUrl);
}

// 5. Common Anti-Bot yt-dlp arguments
export function buildYtdlpArgs(url = '', useCookies = true, allowProxy = false) {
  const args = [
    '--ignore-config',
    '--no-exec',
    '--no-warnings',
    '--no-playlist',
    '--no-check-formats',
    '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
    '--add-header', 'Accept-Language:en-US,en;q=0.9',
    '--retries', '2',
    '--socket-timeout', '20',
    '--force-ipv4',
  ];

  if (ffmpegPath) {
    args.push('--ffmpeg-location', ffmpegPath);
  }

  if (useCookies && fs.existsSync(COOKIE_FILE)) {
    args.push('--cookies', COOKIE_FILE);
  }

  // Proxy routing strictly when allowProxy is requested (e.g. smart fallback on block)
  if (allowProxy && process.env.YTDLP_PROXY && isYouTubeUrl(url)) {
    args.push('--proxy', process.env.YTDLP_PROXY);
  }

  // Fast API hostname for TikTok to prevent 403 Forbidden
  if (/(?:tiktok\.com|vt\.tiktok\.com)/i.test(url)) {
    args.push('--extractor-args', 'tiktok:api_hostname=api16-normal-c-useast1a.tiktokv.com');
  }

  return args;
}

// 6. Format duration in seconds to M:SS or H:MM:SS
export function formatDuration(seconds) {
  if (!seconds) return '0:00';
  const sec = Math.floor(seconds);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) {
    return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  }
  return `${m}:${s.toString().padStart(2, '0')}`;
}
