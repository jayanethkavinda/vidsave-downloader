import { spawn } from 'child_process';
import { 
  PYTHON_BIN, 
  buildYtdlpArgs, 
  isYouTubeUrl, 
  isScraperSupportedUrl, 
  formatDuration 
} from './coreEngine.js';
import { 
  MAX_FILESIZE_BYTES_YOUTUBE, 
  MAX_FILESIZE_BYTES_OTHER 
} from './security.js';
import { buildResolutionPresets, formatBytes } from './sizeCalculator.js';
import { extractSubtitles } from './subtitleService.js';
import { setMediaCache, getMediaCache } from './mediaCache.js';

/**
 * Dedicated Ultra-HD TikTok Cloud Resolver (TikWM HD Engine)
 */
export async function resolveTikTokDedicated(url) {
  try {
    const res = await fetch(`https://www.tikwm.com/api/?url=${encodeURIComponent(url)}&hd=1`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36'
      }
    });
    const json = await res.json();
    if (json?.code === 0 && json?.data) {
      const d = json.data;
      const hdUrl = d.hdplay || d.play;
      const sdUrl = d.play;
      const audioUrl = d.music;
      const title = d.title || 'TikTok Video';
      const uploader = d.author?.unique_id || d.author?.nickname || 'TikTok Creator';
      const thumbnail = d.cover || d.origin_cover || null;
      const duration = d.duration || 15;

      const hdSize = d.hd_size || d.size || (12 * 1024 * 1024);
      const sdSize = d.size || (6 * 1024 * 1024);
      const audioSize = 3 * 1024 * 1024;

      const hasTrue1080p = Boolean(d.hdplay && d.hd_size && d.hd_size > d.size);
      const maxQualityLabel = hasTrue1080p ? '1080p Full HD' : '720p HD';
      const maxHeight = hasTrue1080p ? 1080 : 720;

      const bestPreset = {
        id: 'best_with_audio',
        label: `Download Best Quality (${maxQualityLabel})`,
        shortLabel: maxQualityLabel,
        ext: 'mp4',
        type: 'video',
        filesize: hdSize,
        filesizeFormatted: formatBytes(hdSize),
        isRecommended: true,
        directUrl: hdUrl
      };

      const presets = [bestPreset];
      if (hasTrue1080p) {
        presets.push({
          id: '1080',
          label: '1080p Full HD',
          shortLabel: '1080p Full HD',
          badge: 'fhd',
          height: 1080,
          ext: 'mp4',
          type: 'video',
          filesize: hdSize,
          filesizeFormatted: formatBytes(hdSize),
          directUrl: hdUrl
        });
      }
      presets.push({
        id: '720',
        label: '720p HD',
        shortLabel: '720p HD',
        badge: 'hd',
        height: 720,
        ext: 'mp4',
        type: 'video',
        filesize: hasTrue1080p ? sdSize : hdSize,
        filesizeFormatted: formatBytes(hasTrue1080p ? sdSize : hdSize),
        directUrl: hasTrue1080p ? sdUrl : hdUrl
      });
      if (hasTrue1080p || d.size) {
        presets.push({
          id: '480',
          label: '480p SD',
          shortLabel: '480p SD',
          badge: 'sd',
          height: 480,
          ext: 'mp4',
          type: 'video',
          filesize: Math.round(sdSize * 0.7),
          filesizeFormatted: formatBytes(Math.round(sdSize * 0.7)),
          directUrl: sdUrl
        });
      }
      presets.push({
        id: 'audio_best',
        label: 'MP3 Audio (High Quality)',
        shortLabel: 'MP3 Audio',
        ext: 'mp3',
        type: 'audio',
        filesize: audioSize,
        filesizeFormatted: formatBytes(audioSize),
        directUrl: audioUrl
      });

      const tiktokResult = {
        id: `tiktok_${d.id || Date.now()}`,
        title,
        description: `${title} (Resolved via TikTok Dedicated Engine)`,
        thumbnail,
        duration,
        durationFormatted: formatDuration(duration),
        uploader,
        webpageUrl: url,
        extractor: 'TikTok',
        maxQualityLabel,
        maxHeight,
        bestPreset,
        presets,
        formats: [],
        subtitles: [],
        subtitlesCount: 0,
        directStreamUrl: hdUrl,
        previewStreamUrl: `/api/preview?url=${encodeURIComponent(url)}`
      };
      setMediaCache(url, tiktokResult);
      return tiktokResult;
    }
  } catch (err) {
    console.warn('[Dedicated TikTok Resolver Error]:', err.message);
  }
  return null;
}

/**
 * Free Instant Multi-Platform Cloud Scraper Fallback Resolver
 * (Instagram, Facebook, TikTok, Twitter/X)
 */
export async function resolveCloudScraperFallback(url) {
  if (/(?:tiktok\.com|vt\.tiktok\.com)/i.test(url)) {
    const dedicated = await resolveTikTokDedicated(url);
    if (dedicated) return dedicated;
  }

  try {
    const { default: snapsaveModule, snapsave } = await import('snapsave-media-downloader');
    const fn = snapsave || snapsaveModule;
    const result = await fn(url);

    if (!result || !result.success || !result.data?.media?.length) {
      throw new Error('No media returned by Cloud Scraper Resolver');
    }

    const media = result.data.media.find(m => m.type === 'video' || (m.url && m.url.includes('.mp4'))) || result.data.media[0];
    const directStreamUrl = media.url;
    const thumbnail = media.thumbnail || (result.data.thumbnail || null);

    let platform = 'Social';
    let defaultTitle = 'Social Media Video';
    if (/(?:instagram\.com|instagr\.am)/i.test(url)) {
      platform = 'Instagram';
      defaultTitle = 'Instagram Reel';
    } else if (/(?:facebook\.com|fb\.watch)/i.test(url)) {
      platform = 'Facebook';
      defaultTitle = 'Facebook Video';
    } else if (/tiktok\.com/i.test(url)) {
      platform = 'TikTok';
      defaultTitle = 'TikTok Video';
    } else if (/(?:twitter\.com|x\.com)/i.test(url)) {
      platform = 'Twitter';
      defaultTitle = 'Twitter (X) Video';
    }

    const title = result.data?.title || result.data?.description || defaultTitle;
    const uploader = result.data?.author || `${platform} Creator`;

    const bestPreset = {
      id: 'best_with_audio',
      label: 'Download Best Quality (1080p / 720p HD)',
      shortLabel: 'Best HD',
      ext: 'mp4',
      type: 'video',
      filesize: 17 * 1024 * 1024,
      filesizeFormatted: '17.2 MB',
      isRecommended: true,
      directUrl: directStreamUrl || null
    };

    const hdPreset = {
      id: '720',
      label: '720p HD',
      shortLabel: '720p HD',
      badge: 'hd',
      height: 720,
      ext: 'mp4',
      type: 'video',
      filesize: 12 * 1024 * 1024,
      filesizeFormatted: '12.0 MB',
      directUrl: directStreamUrl || null
    };

    const audioPreset = {
      id: 'audio_best',
      label: 'MP3 Audio (High Quality)',
      shortLabel: 'MP3 Audio',
      ext: 'mp3',
      type: 'audio',
      filesize: 3 * 1024 * 1024,
      filesizeFormatted: '3.0 MB'
    };

    const fallbackResult = {
      id: `${platform.toLowerCase()}_${Date.now()}`,
      title,
      description: `${title} (Resolved via ${platform} Cloud Fallback Engine)`,
      thumbnail,
      duration: 30,
      durationFormatted: '0:30',
      uploader,
      webpageUrl: url,
      extractor: `${platform} (Cloud Fallback)`,
      maxQualityLabel: 'Best HD',
      maxHeight: 1080,
      bestPreset,
      presets: [bestPreset, hdPreset, audioPreset],
      formats: [],
      subtitles: [],
      subtitlesCount: 0,
      directStreamUrl,
      previewStreamUrl: `/api/preview?url=${encodeURIComponent(url)}`
    };
    setMediaCache(url, fallbackResult);
    return fallbackResult;
  } catch (err) {
    console.error(`[${url} Cloud Fallback Resolver Error]:`, err.message);
    throw err;
  }
}

/**
 * Universal Video Information Extractor (Preserves 100% Original Upload Quality)
 */
export async function getVideoInfo(url) {
  // 1. Check in-memory cache (20 min TTL)
  const cached = getMediaCache(url);
  if (cached) {
    console.log(`[MediaCache Hit] Returning cached info for: ${url}`);
    return cached;
  }

  // 2. Fast-path: Dedicated TikTok HD Engine (sub-second extraction, 100% audio+video)
  if (/(?:tiktok\.com|vt\.tiktok\.com)/i.test(url)) {
    const dedicated = await resolveTikTokDedicated(url);
    if (dedicated) {
      setMediaCache(url, dedicated);
      return dedicated;
    }
  }

  const isYt = isYouTubeUrl(url);

  const runDump = (extraArgs = []) => {
    return new Promise((resolve, reject) => {
      const args = [
        '-m', 'yt_dlp',
        '--dump-single-json',
        '--no-playlist',
        '--no-warnings',
        ...buildYtdlpArgs(url, true),
        ...extraArgs,
        '--',
        url
      ];

      const child = spawn(PYTHON_BIN, args, { windowsHide: true });
      let stdout = '';
      let stderr = '';

      child.stdout.on('data', d => { stdout += d.toString(); });
      child.stderr.on('data', d => { stderr += d.toString(); });

      child.on('close', code => {
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
      if (isYt && process.env.YTDLP_PROXY) {
        try {
          console.log(`[YouTube Engine] Direct extraction failed, attempting smart proxy fallback for: ${url}`);
          rawInfo = await runDump(['--proxy', process.env.YTDLP_PROXY]);
        } catch (err3) {
          throw err1;
        }
      } else if (!isYt) {
        return await resolveCloudScraperFallback(url);
      } else {
        throw err1;
      }
    }
  }

  const duration = rawInfo.duration || 0;
  const rawFormats = rawInfo.formats || [];

  // Filter video & audio formats
  const videoFormats = rawFormats.filter(f => f.vcodec && f.vcodec !== 'none');
  const audioFormats = rawFormats.filter(f => f.acodec && f.acodec !== 'none');
  const maxAllowedSize = isYt ? MAX_FILESIZE_BYTES_YOUTUBE : MAX_FILESIZE_BYTES_OTHER;
  const maxLimitLabel = isYt ? '1.5 GB' : '3.0 GB';

  // Build 100% accurate presets using sizeCalculator engine
  const {
    presets,
    bestPreset,
    maxQualityLabel,
    maxHeight
  } = await buildResolutionPresets({
    rawFormats,
    videoFormats,
    audioFormats,
    rawInfo,
    duration,
    isYt,
    referer: url,
    maxAllowedSize,
    maxLimitLabel
  });

  const subtitles = extractSubtitles(rawInfo);

  // Dedicated lightweight 240p/360p progressive preview stream with sound (Video + Audio)
  let previewStreamUrl = null;
  if (!isYt) {
    previewStreamUrl = `/api/preview?url=${encodeURIComponent(rawInfo.webpage_url || url)}`;
  }

  const finalResult = {
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

  setMediaCache(url, finalResult);
  return finalResult;
}
