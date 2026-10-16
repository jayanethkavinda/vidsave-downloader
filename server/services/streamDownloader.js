import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { 
  PYTHON_BIN, 
  ffmpegPath, 
  buildYtdlpArgs, 
  isYouTubeUrl, 
  isScraperSupportedUrl 
} from './coreEngine.js';
import { 
  MAX_FILESIZE_BYTES_YOUTUBE, 
  MAX_FILESIZE_BYTES_OTHER, 
  killProcessTree 
} from './security.js';
import { getCachedDirectUrl } from './cacheService.js';

/**
 * Direct Stream Cloud Scraper Fallback for downloads (Instagram, Facebook, TikTok, Twitter)
 */
export async function streamDirectCloudFallback(url, formatPreset, res, cleanupOld) {
  if (cleanupOld) cleanupOld();
  try {
    const { default: snapsaveModule, snapsave } = await import('snapsave-media-downloader');
    const fn = snapsave || snapsaveModule;
    const result = await fn(url);

    if (!result || !result.success || !result.data?.media?.length) {
      if (!res.headersSent) {
        return res.status(500).json({ error: 'Failed to extract media stream via fallback.' });
      }
      return;
    }

    const media = result.data.media.find(m => m.type === 'video' || (m.url && m.url.includes('.mp4'))) || result.data.media[0];
    const directUrl = media.url;
    const isAudio = formatPreset === 'audio_best' || formatPreset === 'mp3' || (formatPreset && formatPreset.includes('audio'));

    if (isAudio && ffmpegPath) {
      console.log('[Cloud Fallback Stream] Transcoding direct stream to MP3 via FFmpeg...');
      res.setHeader('Content-Type', 'audio/mpeg');
      const ffmpeg = spawn(ffmpegPath, [
        '-reconnect', '1',
        '-reconnect_streamed', '1',
        '-reconnect_delay_max', '5',
        '-headers', 'User-Agent: Mozilla/5.0\r\n',
        '-i', directUrl,
        '-vn',
        '-acodec', 'libmp3lame',
        '-b:a', '192k',
        '-f', 'mp3',
        'pipe:1'
      ], { windowsHide: true });

      ffmpeg.stdout.pipe(res);
      ffmpeg.stderr.on('data', () => {});
      res.on('close', () => {
        try { ffmpeg.kill('SIGKILL'); } catch (_) {}
      });
      return;
    }

    // Direct MP4 Video Stream
    console.log('[Cloud Fallback Stream] Piping direct MP4 video stream to browser...');
    const { default: https } = await import('https');
    const { default: http } = await import('http');
    const client = directUrl.startsWith('https') ? https : http;

    const upstreamReq = client.get(directUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
        'Accept': '*/*'
      }
    }, (upstreamRes) => {
      if ([301, 302, 307, 308].includes(upstreamRes.statusCode) && upstreamRes.headers.location) {
        return res.redirect(upstreamRes.statusCode, upstreamRes.headers.location);
      }
      if (upstreamRes.headers['content-length'] && !res.headersSent) {
        res.setHeader('Content-Length', upstreamRes.headers['content-length']);
      }
      res.setHeader('Content-Type', 'video/mp4');
      upstreamRes.pipe(res);
    });

    upstreamReq.on('error', (err) => {
      console.error('[Cloud Stream Pipe Error]', err.message);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Failed to pipe video stream: ' + err.message });
      }
    });

    res.on('close', () => {
      upstreamReq.destroy();
    });
  } catch (err) {
    console.error('[streamDirectCloudFallback Error]', err.message);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Media streaming fallback failed: ' + err.message });
    }
  }
}

/**
 * Universal Streaming Downloader Engine
 * Uses Zero-Disk Direct CDN Pipe for social platforms, and single-thread muxing for YouTube
 */
export function streamVideoDownload(url, formatPreset, res, directUrl = null) {
  const isYt = isYouTubeUrl(url);
  const isAudio = formatPreset === 'audio_best' || formatPreset === 'mp3';

  // Build strict tier format selector
  const buildTierFormat = (target) => {
    const num = parseInt(target, 10);
    if (num >= 3800) {
      return `bestvideo[height>=3800]+bestaudio/bestvideo[width>=3800]+bestaudio/bestvideo+bestaudio/best`;
    }
    if (num >= 2000) {
      return `bestvideo[height>=2000]+bestaudio/bestvideo[width>=2000]+bestaudio/bestvideo+bestaudio/best`;
    }
    if (num >= 1300) {
      return `bestvideo[height>=1300]+bestaudio/bestvideo[width>=1300]+bestaudio/bestvideo+bestaudio/best`;
    }
    if (num >= 1000) {
      return `bestvideo[height>=1000][height<=1080]+bestaudio/bestvideo[width>=1000][width<=1080]+bestaudio/bestvideo[height<=1080]+bestaudio/bestvideo[width<=1080]+bestaudio/best[height<=1080]/best`;
    }
    if (num >= 650) {
      return `bestvideo[height<=720][height>=650]+bestaudio/bestvideo[width<=720][width>=650]+bestaudio/bestvideo[height<=720]+bestaudio/bestvideo[width<=720]+bestaudio/best[height<=720]/best[width<=720]/best`;
    }
    if (num >= 400) {
      return `bestvideo[height<=480][height>=400]+bestaudio/bestvideo[width<=480][width>=400]+bestaudio/bestvideo[height<=480]+bestaudio/bestvideo[width<=480]+bestaudio/best[height<=480]/best[width<=480]/best`;
    }
    return `bestvideo[height<=360]+bestaudio/bestvideo[width<=360]+bestaudio/best[height<=360]/best[width<=360]/best`;
  };

  let formatArg;
  if (isAudio) {
    formatArg = 'bestaudio/best';
  } else if (formatPreset && formatPreset !== 'best' && formatPreset !== 'best_with_audio') {
    formatArg = buildTierFormat(formatPreset);
  } else {
    formatArg = 'bestvideo+bestaudio/best';
  }

  // Standard temp file download pipeline for YouTube / separate streams
  const runTempDownload = () => {
    const ext = isAudio ? 'mp3' : 'mp4';
    const tempFile = path.join(os.tmpdir(), `vidsave_${Date.now()}_${Math.random().toString(36).substring(7)}.${ext}`);
    const maxLimitArg = isYt ? '1536M' : '3072M';

    const args = [
      '-m', 'yt_dlp',
      '-f', formatArg,
      '--max-filesize', maxLimitArg,
      '--downloader-args', 'ffmpeg:-threads 1',
    ];

    if (isAudio) {
      args.push('-x', '--audio-format', 'mp3', '--audio-quality', '0');
    } else {
      args.push('--merge-output-format', 'mp4', '--postprocessor-args', 'ffmpeg:-c:v copy -c:a aac -threads 1');
    }

    args.push('-o', tempFile, ...buildYtdlpArgs(url), '--', url);

    console.log(`[Stream Pipeline] Downloading ${formatPreset} into temp file: ${tempFile}`);

    const child = spawn(PYTHON_BIN, args, {
      windowsHide: true,
      detached: process.platform !== 'win32'
    });

    const watchdog = setTimeout(() => {
      console.warn(`[Download Watchdog] Timed out: ${url}`);
      killProcessTree(child);
      cleanup();
    }, 10 * 60 * 1000);
    if (watchdog.unref) watchdog.unref();

    const cleanup = () => {
      clearTimeout(watchdog);
      try {
        if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
        const dir = path.dirname(tempFile);
        const baseNoExt = path.basename(tempFile, path.extname(tempFile));
        const remnants = fs.readdirSync(dir).filter(f => f.startsWith(baseNoExt));
        for (const r of remnants) {
          try { fs.unlinkSync(path.join(dir, r)); } catch (_) {}
        }
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
        const baseNoExt = path.basename(tempFile, path.extname(tempFile));
        try {
          const found = fs.readdirSync(dir).find(f => f.startsWith(baseNoExt) && !f.endsWith('.part') && !f.endsWith('.ytdl'));
          if (found) actualFile = path.join(dir, found);
        } catch (_) {}
      }

      if (code !== 0 || !fs.existsSync(actualFile)) {
        console.error(`[Download Stream] yt-dlp failed (code ${code})`);
        if (isScraperSupportedUrl(url)) {
          console.log(`[Download Stream] Falling back to direct cloud stream: ${url}`);
          return streamDirectCloudFallback(url, formatPreset, res, cleanup);
        }
        if (!res.headersSent) {
          res.status(500).json({ error: 'Download processing failed. Please check the video link.' });
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

  // ⚡ Fast Zero-Disk Direct Proxy Streaming Helper
  const pipeDirectCdnStream = async (targetUrl, originalUrl, ext = 'mp4') => {
    const isMp3 = ext === 'mp3' || isAudio;
    try {
      const { default: https } = await import('https');
      const { default: http } = await import('http');
      const client = targetUrl.startsWith('https') ? https : http;

      const headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
        'Accept': '*/*'
      };

      if (originalUrl.includes('tiktok.com')) headers['Referer'] = 'https://www.tiktok.com/';
      else if (originalUrl.includes('instagram.com')) headers['Referer'] = 'https://www.instagram.com/';
      else if (originalUrl.includes('facebook.com') || originalUrl.includes('fb.watch')) headers['Referer'] = 'https://www.facebook.com/';
      else if (originalUrl.includes('pinterest.com') || originalUrl.includes('pin.it')) headers['Referer'] = 'https://www.pinterest.com/';
      else if (originalUrl.includes('twitter.com') || originalUrl.includes('x.com')) headers['Referer'] = 'https://twitter.com/';
      else if (originalUrl.includes('threads.net')) headers['Referer'] = 'https://www.threads.net/';

      // If MP3 requested from video source, transcode on-the-fly via FFmpeg
      if (isMp3 && !targetUrl.includes('.mp3') && ffmpegPath) {
        console.log(`[Direct Stream] Transcoding direct stream to MP3 via FFmpeg: ${targetUrl.slice(0, 80)}...`);
        res.setHeader('Content-Type', 'audio/mpeg');
        const ffmpeg = spawn(ffmpegPath, [
          '-reconnect', '1',
          '-reconnect_streamed', '1',
          '-reconnect_delay_max', '5',
          '-headers', 'User-Agent: Mozilla/5.0\r\n',
          '-i', targetUrl,
          '-vn',
          '-acodec', 'libmp3lame',
          '-b:a', '192k',
          '-f', 'mp3',
          'pipe:1'
        ], { windowsHide: true });

        ffmpeg.stdout.pipe(res);
        ffmpeg.stderr.on('data', () => {});
        res.on('close', () => {
          try { ffmpeg.kill('SIGKILL'); } catch (_) {}
        });
        return;
      }

      console.log(`[Direct Stream] Piping CDN stream directly to browser: ${targetUrl.slice(0, 80)}...`);
      const upstreamReq = client.get(targetUrl, { headers }, (upstreamRes) => {
        if ([301, 302, 307, 308].includes(upstreamRes.statusCode) && upstreamRes.headers.location) {
          return pipeDirectCdnStream(upstreamRes.headers.location, originalUrl, ext);
        }
        if (upstreamRes.statusCode >= 400) {
          console.warn(`[Direct Stream] Upstream status ${upstreamRes.statusCode}, falling back to temp download...`);
          return runTempDownload();
        }
        if (upstreamRes.headers['content-length'] && !res.headersSent) {
          res.setHeader('Content-Length', upstreamRes.headers['content-length']);
        }
        if (!res.headersSent) {
          res.setHeader('Content-Type', isMp3 ? 'audio/mpeg' : 'video/mp4');
        }
        upstreamRes.pipe(res);
      });

      upstreamReq.on('error', (err) => {
        console.error('[Direct Stream Pipe Error]:', err.message);
        if (!res.headersSent) runTempDownload();
      });

      res.on('close', () => {
        upstreamReq.destroy();
      });
    } catch (err) {
      console.error('[Direct Stream Pipe Exception]:', err.message);
      runTempDownload();
    }
  };

  // ⚡ 1. Direct URL Parameter or 30-Minute In-Memory Media Cache for Instant Direct CDN Streaming (<1s)
  const isHeavyYt = isYt && ['4320', '2160', '1440', '1080'].includes(String(formatPreset));
  if (!isHeavyYt) {
    if (directUrl && typeof directUrl === 'string' && directUrl.startsWith('http') && !directUrl.includes('.m3u8')) {
      console.log(`[Direct URL] Instant streaming direct CDN URL from client for ${url}`);
      return pipeDirectCdnStream(directUrl, url, isAudio ? 'mp3' : 'mp4');
    }

    const cached = getCachedDirectUrl(url, formatPreset);
    if (cached && cached.directUrl && cached.directUrl.startsWith('http') && !cached.directUrl.includes('.m3u8')) {
      console.log(`[Cache Hit] Instant streaming direct CDN URL for ${url} (preset: ${formatPreset})`);
      return pipeDirectCdnStream(cached.directUrl, url, cached.ext || (isAudio ? 'mp3' : 'mp4'));
    }
  }

  // 2. Zero-Disk Direct Proxy Streaming for Social Platforms (Facebook, TikTok, Pinterest, Instagram, X, Threads)
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
        return pipeDirectCdnStream(targetUrl, url, 'mp4');
      } else {
        runTempDownload();
      }
    });

    resolver.on('error', () => { runTempDownload(); });
    return;
  }

  // 3. YouTube Heavy / Separate Streams Fallback
  runTempDownload();
}
