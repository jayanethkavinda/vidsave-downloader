import { spawn, execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import ffmpegStatic from 'ffmpeg-static';
import { fileURLToPath } from 'url';
import { 
  MAX_FILESIZE_BYTES_YOUTUBE, 
  MAX_FILESIZE_BYTES_OTHER, 
  killProcessTree 
} from './security.js';
import { 
  formatBytes, 
  buildResolutionPresets, 
  probeUrlExactBytes 
} from './sizeCalculator.js';

// Automatically detect Python executable
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
console.log(`[Downloader Engine] Python binary: "${PYTHON_BIN}"`);

// Robust FFmpeg binary detection
let ffmpegPath = '';
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
console.log(`[Downloader Engine] FFmpeg binary: "${ffmpegPath || 'system PATH'}"`);

// Session cookies path and sync from Render Environment Variable
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const COOKIE_FILE = path.resolve(__dirname, '../ytdlp_session_cookies.txt');

function syncCookiesFromEnv() {
  const envCookies = process.env.YTDLP_COOKIES;
  if (!envCookies) {
    if (fs.existsSync(COOKIE_FILE)) {
      console.log(`[Downloader Engine] Using existing cookie file at: ${COOKIE_FILE}`);
    } else {
      console.log(`[Downloader Engine] No YTDLP_COOKIES env var and no local cookie file found.`);
    }
    return;
  }

  try {
    let content = envCookies.trim();
    if (content.includes('\\n')) {
      content = content.replace(/\\n/g, '\n').replace(/\\t/g, '\t');
    }
    if (!content.includes('\t') && content.length > 50) {
      try {
        const decoded = Buffer.from(content, 'base64').toString('utf8');
        if (decoded.includes('\t')) content = decoded;
      } catch (_) {}
    }

    if (!content.startsWith('# Netscape HTTP Cookie File')) {
      content = `# Netscape HTTP Cookie File\n# Automatically synced from YTDLP_COOKIES\n\n${content}`;
    }

    fs.writeFileSync(COOKIE_FILE, content, 'utf8');
    console.log(`[Downloader Engine] Synchronized YTDLP_COOKIES to ${COOKIE_FILE} (${fs.statSync(COOKIE_FILE).size} bytes)`);
  } catch (err) {
    console.error(`[Downloader Engine] Failed to sync YTDLP_COOKIES:`, err.message);
  }
}

syncCookiesFromEnv();

// Helper to detect if URL belongs to YouTube
export function isYouTubeUrl(rawUrl) {
  if (!rawUrl) return false;
  return /(?:youtube\.com|youtu\.be)/i.test(rawUrl);
}

// Format duration in seconds to M:SS or H:MM:SS
function formatDuration(seconds) {
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


/**
 * Common yt-dlp arguments for anti-bot bypass & headers
 */
export function buildYtdlpArgs(url = '', useCookies = true) {
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

  // Proxy routing strictly for YouTube
  if (process.env.YTDLP_PROXY && isYouTubeUrl(url)) {
    args.push('--proxy', process.env.YTDLP_PROXY);
  }

  return args;
}

/**
 * Extract subtitles from yt-dlp metadata
 */
function extractSubtitles(rawInfo) {
  const subtitles = [];
  const seenLanguages = new Set();
  const subSources = [
    { dict: rawInfo.subtitles || {}, isAuto: false },
    { dict: rawInfo.automatic_captions || {}, isAuto: true }
  ];

  for (const { dict, isAuto } of subSources) {
    for (const [code, formats] of Object.entries(dict)) {
      if (seenLanguages.has(code)) continue;
      const vttFmt = (formats || []).find(f => f.ext === 'vtt') || formats?.[0];
      if (vttFmt && vttFmt.url) {
        seenLanguages.add(code);
        const languageName = vttFmt.name || code.toUpperCase();
        subtitles.push({
          id: `${isAuto ? 'auto' : 'sub'}_${code}`,
          code,
          language: languageName,
          isAuto,
          url: vttFmt.url,
          exts: ['srt', 'vtt']
        });
      }
    }
  }
  return subtitles;
}

/**
 * SnapSave Cloud Fallback Resolver for social media
 */
async function resolveCloudScraperFallback(url) {
  try {
    const { default: snapsaveModule, snapsave } = await import('snapsave-media-downloader');
    const fn = snapsave || snapsaveModule;
    const result = await fn(url);
    if (!result || !result.success || !result.data?.media?.length) {
      throw new Error('No media returned by Cloud Scraper');
    }
    const media = result.data.media.find(m => m.type === 'video' || (m.url && m.url.includes('.mp4'))) || result.data.media[0];
    const directStreamUrl = media.url;
    const thumbnail = media.thumbnail || (result.data.thumbnail || null);

    let platform = 'Social';
    if (/(?:instagram\.com|instagr\.am)/i.test(url)) platform = 'Instagram';
    else if (/(?:facebook\.com|fb\.watch)/i.test(url)) platform = 'Facebook';
    else if (/tiktok\.com/i.test(url)) platform = 'TikTok';
    else if (/(?:twitter\.com|x\.com)/i.test(url)) platform = 'Twitter';

    const title = result.data?.title || result.data?.description || `${platform} Video`;
    const uploader = result.data?.author || `${platform} Creator`;

    let exactFallbackBytes = 12 * 1024 * 1024;
    if (directStreamUrl) {
      const probed = await probeUrlExactBytes(directStreamUrl, url, 1500);
      if (probed && probed > 0) exactFallbackBytes = probed;
    }

    const bestPreset = {
      id: 'best_with_audio',
      label: 'Download Best Quality (Original Upload Quality)',
      shortLabel: 'Original Quality',
      ext: 'mp4',
      type: 'video',
      filesize: exactFallbackBytes,
      filesizeFormatted: formatBytes(exactFallbackBytes),
      isRecommended: true
    };

    const hdPreset = {
      id: '720',
      label: '720p HD',
      shortLabel: '720p HD',
      badge: 'hd',
      height: 720,
      ext: 'mp4',
      type: 'video',
      filesize: exactFallbackBytes,
      filesizeFormatted: formatBytes(exactFallbackBytes)
    };

    const audioBytes = Math.round(exactFallbackBytes * 0.15) || (2 * 1024 * 1024);
    const audioPreset = {
      id: 'audio_best',
      label: 'MP3 Audio (High Quality)',
      shortLabel: 'MP3 Audio',
      ext: 'mp3',
      type: 'audio',
      filesize: audioBytes,
      filesizeFormatted: formatBytes(audioBytes)
    };

    return {
      id: `${platform.toLowerCase()}_${Date.now()}`,
      title,
      description: `${title} (Resolved via ${platform} Cloud Fallback)`,
      thumbnail,
      duration: 30,
      durationFormatted: '0:30',
      uploader,
      webpageUrl: url,
      extractor: platform,
      maxQualityLabel: 'Original Quality',
      maxHeight: 1080,
      bestPreset,
      presets: [bestPreset, hdPreset, audioPreset],
      formats: [],
      subtitles: [],
      subtitlesCount: 0,
      directStreamUrl,
      previewStreamUrl: `/api/proxy-stream?url=${encodeURIComponent(directStreamUrl)}`
    };
  } catch (err) {
    throw new Error(`Cloud fallback extraction failed: ${err.message}`);
  }
}

/**
 * Universal Video Information Extractor (Preserves 100% Original Upload Quality)
 */
export async function getVideoInfo(url) {
  const isYt = isYouTubeUrl(url);

  const runDump = (extraArgs = []) => {
    return new Promise((resolve, reject) => {
      const args = [
        '-m', 'yt_dlp',
        '--dump-single-json',
        ...buildYtdlpArgs(url),
        ...extraArgs,
        '--',
        url
      ];

      const child = spawn(PYTHON_BIN, args, { windowsHide: true, maxBuffer: 1024 * 1024 * 35 });
      let stdout = '';
      let stderr = '';

      child.stdout.on('data', d => { stdout += d.toString(); });
      child.stderr.on('data', d => { stderr += d.toString(); });

      const timer = setTimeout(() => {
        killProcessTree(child);
        reject(new Error('Extraction timed out.'));
      }, 25000);

      child.on('close', code => {
        clearTimeout(timer);
        if (code === 0 && stdout) {
          try {
            resolve(JSON.parse(stdout));
          } catch (e) {
            reject(new Error('Failed to parse metadata JSON'));
          }
        } else {
          reject(new Error(stderr.slice(-300) || `Process exited with code ${code}`));
        }
      });
    });
  };

  let rawInfo;
  try {
    rawInfo = await runDump();
  } catch (err1) {
    // Client impersonation fallback
    try {
      rawInfo = await runDump(['--extractor-args', 'youtube:player_client=android,web']);
    } catch (err2) {
      if (!isYt) {
        return await resolveCloudScraperFallback(url);
      }
      throw err1;
    }
  }

  const duration = rawInfo.duration || 0;
  const rawFormats = rawInfo.formats || [];

  // Filter video formats
  const videoFormats = rawFormats.filter(f => f.vcodec && f.vcodec !== 'none');
  const audioFormats = rawFormats.filter(f => f.acodec && f.acodec !== 'none' && (!f.vcodec || f.vcodec === 'none'));

  // Apply maximum filesize limits
  const maxAllowedSize = isYt ? MAX_FILESIZE_BYTES_YOUTUBE : MAX_FILESIZE_BYTES_OTHER;
  const maxLimitLabel = isYt ? '1.5 GB' : '3.0 GB';

  // Build 100% accurate presets using dedicated sizeCalculator engine
  const {
    presets,
    bestPreset,
    maxQualityLabel,
    maxHeight
  } = await buildResolutionPresets({
    videoFormats,
    audioFormats,
    duration,
    rawInfo,
    isYt,
    referer: url,
    maxAllowedSize,
    maxLimitLabel
  });

  const subtitles = extractSubtitles(rawInfo);

  // Dedicated preview stream for Trimmer HTML5 player (Audio + Video with Range support)
  let previewStreamUrl = null;
  if (!isYt) {
    previewStreamUrl = `/api/preview?url=${encodeURIComponent(url)}`;
  }

  return {
    id: rawInfo.id,
    title: rawInfo.title || 'Extracted Media',
    description: rawInfo.description ? rawInfo.description.slice(0, 300) : '',
    thumbnail: rawInfo.thumbnail || (rawInfo.thumbnails?.length ? rawInfo.thumbnails[rawInfo.thumbnails.length - 1].url : null),
    duration,
    durationFormatted: formatDuration(duration),
    uploader: rawInfo.uploader || rawInfo.channel || rawInfo.extractor || 'Creator',
    webpageUrl: rawInfo.webpage_url || url,
    extractor: rawInfo.extractor_key || rawInfo.extractor || 'Web Media',
    maxQualityLabel,
    maxHeight,
    bestPreset,
    presets,
    subtitles,
    subtitlesCount: subtitles.length,
    previewStreamUrl
  };
}

/**
 * Universal Streaming Downloader Engine
 */
export function streamVideoDownload(url, formatPreset, res) {
  const isYt = isYouTubeUrl(url);
  const isAudio = formatPreset === 'audio_best' || formatPreset === 'mp3';

  // Build strict tier format selector for both Landscape and Portrait (Reels/Shorts)
  const buildTierFormat = (target) => {
    const num = parseInt(target, 10);
    if (num >= 3800) {
      return `bestvideo[height>=3800]+bestaudio/bestvideo[width>=3800]+bestaudio/bestvideo+bestaudio/best`;
    }
    if (num >= 2000) {
      return `bestvideo[height>=2000][height<=2160]+bestaudio/bestvideo[width>=2000][width<=2160]+bestaudio/bestvideo[height>=2000]+bestaudio/bestvideo[width>=2000]+bestaudio/best`;
    }
    if (num >= 1400) {
      return `bestvideo[height>=1400][height<=1440]+bestaudio/bestvideo[width>=1400][width<=1440]+bestaudio/bestvideo[height>=1400]+bestaudio/bestvideo[width>=1400]+bestaudio/best`;
    }
    if (num >= 900) {
      return `bestvideo[height>=900][height<=1080]+bestaudio/bestvideo[width>=900][width<=1080]+bestaudio/bestvideo[height<=1080]+bestaudio/bestvideo[width<=1080]+bestaudio/best`;
    }
    if (num >= 650) {
      return `bestvideo[height>=650][height<=720]+bestaudio/bestvideo[width>=650][width<=720]+bestaudio/bestvideo[height<=720]+bestaudio/bestvideo[width<=720]+bestaudio/best[height<=720]/best`;
    }
    if (num >= 400) {
      return `bestvideo[height>=400][height<=480]+bestaudio/bestvideo[width>=400][width<=480]+bestaudio/bestvideo[height<=480]+bestaudio/bestvideo[width<=480]+bestaudio/best[height<=480]/best`;
    }
    return `bestvideo[height<=360]+bestaudio/bestvideo[width<=360]+bestaudio/best[height<=360]/best`;
  };

  let formatArg;
  if (isAudio) {
    formatArg = 'bestaudio/best';
  } else if (/^\d{3,4}$/.test(formatPreset)) {
    formatArg = buildTierFormat(formatPreset);
  } else {
    formatArg = 'bestvideo+bestaudio/best';
  }

  // Fallback / Heavy Temp Download Pipeline (YouTube 1080p+ Lossless Merge)
  const runTempDownload = () => {
    const ext = isAudio ? 'mp3' : 'mp4';
    const tempFile = path.join(os.tmpdir(), `vidsave_${Date.now()}_${Math.random().toString(36).substring(7)}.${ext}`);
    const maxLimit = isYt ? '1536M' : '3072M';

    const args = [
      '-m', 'yt_dlp',
      '-f', formatArg,
      '--max-filesize', maxLimit
    ];

    if (isAudio) {
      args.push('-x', '--audio-format', 'mp3', '--audio-quality', '0');
    } else {
      args.push('--merge-output-format', 'mp4', '--postprocessor-args', 'ffmpeg:-c:v copy -c:a aac');
    }

    args.push('-o', tempFile, ...buildYtdlpArgs(url), '--', url);
    console.log(`[Downloader Stream] Running temp container: ${tempFile}`);

    const child = spawn(PYTHON_BIN, args, { windowsHide: true, detached: process.platform !== 'win32' });

    const watchdog = setTimeout(() => {
      console.warn(`[Watchdog] Terminating timed-out download: ${url}`);
      killProcessTree(child);
      cleanup();
    }, 10 * 60 * 1000);

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
        console.error(`[Download Error] yt-dlp exit code: ${code}`);
        if (!res.headersSent) {
          res.status(500).json({ error: 'Download failed. Please check the video link.' });
        }
        cleanup();
        return;
      }

      try {
        const stat = fs.statSync(actualFile);
        if (!res.headersSent) res.setHeader('Content-Length', stat.size);
        const stream = fs.createReadStream(actualFile);
        stream.pipe(res);
        stream.on('close', cleanup);
      } catch (err) {
        cleanup();
      }
    });
  };

  // Zero-Disk Direct Proxy Streaming for Social Platforms (Facebook, TikTok, Pinterest, Instagram, X, Threads)
  if (!isYt && !isAudio) {
    const singleFormat = (formatPreset === 'best' || formatPreset === 'best_with_audio' || !formatPreset)
      ? 'bestvideo+bestaudio/best[ext=mp4]/best'
      : buildTierFormat(formatPreset);

    const gArgs = ['-m', 'yt_dlp', '-g', '-f', singleFormat, ...buildYtdlpArgs(url, true), '--', url];
    console.log(`[Zero-Disk Stream] Resolving CDN URL for ${url}`);
    const resolver = spawn(PYTHON_BIN, gArgs, { windowsHide: true });
    let resolvedUrl = '';

    resolver.stdout.on('data', d => { resolvedUrl += d.toString(); });

    resolver.on('close', async code => {
      const urls = resolvedUrl.trim().split(/\r?\n/).filter(Boolean);

      // Separate audio/video requires merging
      if (urls.length > 1) {
        return runTempDownload();
      }

      const targetUrl = urls[0];
      const isHls = targetUrl && (targetUrl.includes('.m3u8') || targetUrl.includes('.mpd'));

      if (code === 0 && targetUrl && targetUrl.startsWith('http') && !isHls) {
        console.log(`[Zero-Disk Stream] Directly piping CDN stream to browser`);
        try {
          const { default: https } = await import('https');
          const { default: http } = await import('http');
          const client = targetUrl.startsWith('https') ? https : http;
          const headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
            'Accept': '*/*'
          };

          if (url.includes('tiktok.com')) headers['Referer'] = 'https://www.tiktok.com/';
          else if (url.includes('instagram.com')) headers['Referer'] = 'https://www.instagram.com/';
          else if (url.includes('facebook.com') || url.includes('fb.watch')) headers['Referer'] = 'https://www.facebook.com/';
          else if (url.includes('pinterest.com') || url.includes('pin.it')) headers['Referer'] = 'https://www.pinterest.com/';
          else if (url.includes('twitter.com') || url.includes('x.com')) headers['Referer'] = 'https://twitter.com/';
          else if (url.includes('threads.net')) headers['Referer'] = 'https://www.threads.net/';

          const upstreamReq = client.get(targetUrl, { headers }, (upstreamRes) => {
            if ([301, 302, 307, 308].includes(upstreamRes.statusCode) && upstreamRes.headers.location) {
              return res.redirect(upstreamRes.statusCode, upstreamRes.headers.location);
            }
            if (upstreamRes.statusCode >= 400) {
              return runTempDownload();
            }
            if (upstreamRes.headers['content-length'] && !res.headersSent) {
              res.setHeader('Content-Length', upstreamRes.headers['content-length']);
            }
            upstreamRes.pipe(res);
          });

          upstreamReq.on('error', () => {
            if (!res.headersSent) runTempDownload();
          });

          res.on('close', () => {
            upstreamReq.destroy();
          });
          return;
        } catch (_) {
          return runTempDownload();
        }
      } else {
        runTempDownload();
      }
    });

    resolver.on('error', () => { runTempDownload(); });
    return;
  }

  // YouTube / Audio
  runTempDownload();
}



/**
 * Subtitle format converter (VTT to SRT)
 */
export function convertVttToSrt(vttContent) {
  if (!vttContent) return '';
  const lines = vttContent.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const srt = [];
  let counter = 1;
  let inHeader = true;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (inHeader) {
      if (line === '' || line.includes('-->')) inHeader = false;
      if (inHeader) continue;
    }
    if (line.includes('-->')) {
      srt.push(counter.toString());
      counter++;
      const timeLine = line.replace(/(\d{2}:\d{2}:\d{2})\.(\d{3})/g, '$1,$2').replace(/(\d{2}:\d{2})\.(\d{3})/g, '00:$1,$2').replace(/\s+align:\S+/g, '').replace(/\s+position:\S+/g, '');
      srt.push(timeLine);
      i++;
      while (i < lines.length && lines[i].trim() !== '') {
        const textLine = lines[i].replace(/<[^>]+>/g, '').trim();
        if (textLine) srt.push(textLine);
        i++;
      }
      srt.push('');
    }
  }
  return srt.join('\n');
}
