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
  ffmpegPath = execSync(`${PYTHON_BIN} -c "import imageio_ffmpeg; print(imageio_ffmpeg.get_ffmpeg_exe())"`, { encoding: 'utf8' }).trim();
} catch (e) {
  ffmpegPath = 'ffmpeg';
}

/**
 * Common yt-dlp arguments for anti-bot bypass & headers
 */
function buildYtdlpArgs() {
  const args = [
    '--no-warnings',
    '--no-check-certificates',
    '--geo-bypass',
    '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
    '--extractor-args', 'youtube:player_client=android,web;po_token=web+dummy',
    '--add-header', 'Accept-Language:en-US,en;q=0.9',
  ];

  if (ffmpegPath) {
    args.push('--ffmpeg-location', ffmpegPath);
  }

  // If a cookies.txt file exists in the server directory, use it automatically to bypass age restrictions & logins
  const cookiePath = path.resolve('cookies.txt');
  if (fs.existsSync(cookiePath)) {
    args.push('--cookies', cookiePath);
  }

  return args;
}

/**
 * Get video metadata (title, thumbnail, available formats/qualities) for ANY website
 */
export async function getVideoInfo(url) {
  return new Promise((resolve, reject) => {
    const args = [
      '-m', 'yt_dlp',
      '--dump-single-json',
      ...buildYtdlpArgs(),
      url,
    ];

    const child = spawn(PYTHON_BIN, args, {
      windowsHide: true,
      maxBuffer: 1024 * 1024 * 35, // 35MB buffer for rich metadata
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
        let cleanErr = stderrData || `Failed with exit code ${code}`;
        if (cleanErr.includes('HTTP Error 410') || cleanErr.includes('This video is unavailable')) {
          cleanErr = 'This video is unavailable, deleted, or removed by the host platform.';
        } else if (cleanErr.includes('HTTP Error 404')) {
          cleanErr = 'Video not found. Please verify the URL.';
        } else if (cleanErr.includes('Sign in to confirm your age') || cleanErr.includes('Private video')) {
          cleanErr = 'This video is age-restricted or private.';
        } else if (cleanErr.includes('Sign in to confirm you\'re not a bot')) {
          cleanErr = 'YouTube security check triggered. Please try again or try another video.';
        }
        return reject(new Error(cleanErr));
      }

      try {
        const rawInfo = JSON.parse(stdoutData);
        
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

        resolve(cleanInfo);
      } catch (err) {
        reject(new Error(`Failed to parse video info: ${err.message}`));
      }
    });

    child.on('error', (err) => {
      reject(err);
    });
  });
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
    ...buildYtdlpArgs(),
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
