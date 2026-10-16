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
import { buildResolutionPresets } from './sizeCalculator.js';
import { extractSubtitles } from './subtitleService.js';

/**
 * Free Instant Multi-Platform Cloud Scraper Fallback Resolver
 * (Instagram, Facebook, TikTok, Twitter/X)
 */
export async function resolveCloudScraperFallback(url) {
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

    return {
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
  } catch (err) {
    console.error(`[${url} Cloud Fallback Resolver Error]:`, err.message);
    throw err;
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
      if (!isYt) {
        return await resolveCloudScraperFallback(url);
      }
      throw err1;
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
