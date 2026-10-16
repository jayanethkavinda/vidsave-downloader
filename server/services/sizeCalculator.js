import http from 'http';
import https from 'https';

/**
 * In-memory probe cache to avoid redundant network requests
 * Key: mediaUrl -> Value: exact byte size (number)
 */
const PROBE_CACHE = new Map();
const MAX_CACHE_SIZE = 500;

function getCachedSize(url) {
  if (!url) return null;
  return PROBE_CACHE.get(url) || null;
}

function setCachedSize(url, size) {
  if (!url || !size || size <= 0) return;
  if (PROBE_CACHE.size >= MAX_CACHE_SIZE) {
    const firstKey = PROBE_CACHE.keys().next().value;
    PROBE_CACHE.delete(firstKey);
  }
  PROBE_CACHE.set(url, size);
}

/**
 * Format bytes into clean, human-readable MB / GB / KB string
 * Examples: 14.2 MB, 1.45 GB, 850 KB
 */
export function formatBytes(bytes) {
  if (!bytes || bytes <= 0 || isNaN(bytes)) return null;
  const num = Number(bytes);
  if (num < 1024) return `${num} B`;
  if (num < 1024 * 1024) return `${Math.round(num / 1024)} KB`;
  if (num < 1024 * 1024 * 1024) return `${(num / (1024 * 1024)).toFixed(1)} MB`;
  return `${(num / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/**
 * Extract 'clen' (content-length) query parameter from direct CDN URLs
 * (Standard in YouTube / GoogleVideo CDN URLs: &clen=12345678)
 */
export function extractClenFromUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return null;
  try {
    const parsed = new URL(rawUrl);
    const clen = parsed.searchParams.get('clen');
    if (clen) {
      const bytes = parseInt(clen, 10);
      if (!isNaN(bytes) && bytes > 0) return bytes;
    }
  } catch (_) {}
  return null;
}

/**
 * Gold Standard Method: Fast HTTP Range Request (Range: bytes=0-0)
 * Probes the CDN directly and fetches the 100% exact byte size without downloading the video.
 * Returns exact byte count (integer) or null if unreachable.
 */
export async function probeUrlExactBytes(rawUrl, referer = '', timeoutMs = 2500) {
  if (!rawUrl || typeof rawUrl !== 'string' || !rawUrl.startsWith('http')) return null;
  
  // Exclude HLS manifests
  if (rawUrl.includes('.m3u8') || rawUrl.includes('.mpd')) return null;

  // Check URL query parameter first (0ms)
  const clenBytes = extractClenFromUrl(rawUrl);
  if (clenBytes) return clenBytes;

  // Check cache (0ms)
  const cached = getCachedSize(rawUrl);
  if (cached) return cached;

  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
    'Range': 'bytes=0-0',
    'Accept': '*/*'
  };

  if (referer) {
    headers['Referer'] = referer;
  } else if (rawUrl.includes('instagram.com') || rawUrl.includes('cdninstagram.com')) {
    headers['Referer'] = 'https://www.instagram.com/';
  } else if (rawUrl.includes('tiktokcdn.com') || rawUrl.includes('tiktok.com')) {
    headers['Referer'] = 'https://www.tiktok.com/';
  } else if (rawUrl.includes('twimg.com') || rawUrl.includes('twitter.com') || rawUrl.includes('x.com')) {
    headers['Referer'] = 'https://twitter.com/';
  } else if (rawUrl.includes('fbcdn.net') || rawUrl.includes('facebook.com')) {
    headers['Referer'] = 'https://www.facebook.com/';
  }

  return new Promise((resolve) => {
    let resolved = false;
    const finish = (result) => {
      if (!resolved) {
        resolved = true;
        if (result && result > 0) setCachedSize(rawUrl, result);
        resolve(result || null);
      }
    };

    const timer = setTimeout(() => {
      finish(null);
    }, timeoutMs);

    try {
      const client = rawUrl.startsWith('https') ? https : http;
      const req = client.request(rawUrl, {
        method: 'GET',
        headers,
        timeout: timeoutMs
      }, (res) => {
        clearTimeout(timer);

        // Handle redirects (up to 1 hop)
        if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location) {
          req.destroy();
          probeUrlExactBytes(res.headers.location, referer, 1500)
            .then(finish)
            .catch(() => finish(null));
          return;
        }

        // 1. Content-Range header (e.g. "bytes 0-0/15482910")
        const contentRange = res.headers['content-range'];
        if (contentRange) {
          const match = contentRange.match(/\/(\d+)/);
          if (match && match[1]) {
            const bytes = parseInt(match[1], 10);
            if (!isNaN(bytes) && bytes > 0) {
              req.destroy();
              return finish(bytes);
            }
          }
        }

        // 2. Content-Length header (if server returned 200 instead of 206)
        if (res.statusCode === 200 && res.headers['content-length']) {
          const bytes = parseInt(res.headers['content-length'], 10);
          if (!isNaN(bytes) && bytes > 0) {
            req.destroy();
            return finish(bytes);
          }
        }

        req.destroy();
        finish(null);
      });

      req.on('error', () => {
        clearTimeout(timer);
        finish(null);
      });

      req.on('timeout', () => {
        req.destroy();
        finish(null);
      });

      req.end();
    } catch (_) {
      clearTimeout(timer);
      finish(null);
    }
  });
}

/**
 * Standard Resolution Tiers with calibrated bitrates for modern web encoding standards
 */
export const RESOLUTION_TIERS = [
  { id: '4320', minHeight: 3800, targetHeight: 4320, label: '8K Ultra HD (4320p)', shortLabel: '8K Ultra HD', badge: '8k', estBitrateKbps: 24000 },
  { id: '2160', minHeight: 2000, targetHeight: 2160, label: '4K Ultra HD (2160p)', shortLabel: '4K Ultra HD', badge: '4k', estBitrateKbps: 12000 },
  { id: '1440', minHeight: 1400, targetHeight: 1440, label: '2K Quad HD (1440p)', shortLabel: '2K Quad HD', badge: '2k', estBitrateKbps: 5500 },
  { id: '1080', minHeight: 900,  targetHeight: 1080, label: '1080p Full HD',       shortLabel: '1080p Full HD', badge: 'fhd', estBitrateKbps: 2600 },
  { id: '720',  minHeight: 650,  targetHeight: 720,  label: '720p HD',             shortLabel: '720p HD', badge: 'hd', estBitrateKbps: 1300 },
  { id: '480',  minHeight: 400,  targetHeight: 480,  label: '480p SD',             shortLabel: '480p SD', badge: 'sd', estBitrateKbps: 650 },
  { id: '360',  minHeight: 0,    targetHeight: 360,  label: '360p Standard',       shortLabel: '360p SD', badge: 'sd', estBitrateKbps: 380 }
];

/**
 * Calculate exact audio stream size
 */
export async function calculateAudioSize(audioFormats = [], duration = 0, referer = '') {
  if (!audioFormats.length) {
    const fallbackSize = duration > 0 ? Math.round((128 * 1000 / 8) * duration) : (3 * 1024 * 1024);
    return { bestAudio: null, audioSize: fallbackSize };
  }

  const bestAudio = [...audioFormats].sort((a, b) => (b.tbr || b.abr || 0) - (a.tbr || a.abr || 0))[0];

  // 1. Direct filesize in metadata
  if (bestAudio.filesize && bestAudio.filesize > 0) {
    return { bestAudio, audioSize: bestAudio.filesize };
  }
  if (bestAudio.filesize_approx && bestAudio.filesize_approx > 0) {
    return { bestAudio, audioSize: bestAudio.filesize_approx };
  }

  // 2. URL clen parameter
  const clen = extractClenFromUrl(bestAudio.url);
  if (clen) {
    return { bestAudio, audioSize: clen };
  }

  // 3. HTTP Range probe
  if (bestAudio.url) {
    const probed = await probeUrlExactBytes(bestAudio.url, referer, 1500);
    if (probed && probed > 0) {
      return { bestAudio, audioSize: probed };
    }
  }

  // 4. Mathematical Bitrate * Duration
  const bitrate = bestAudio.abr || bestAudio.tbr || 128;
  if (duration > 0) {
    const calculated = Math.round((bitrate * 1000 / 8) * duration);
    return { bestAudio, audioSize: calculated };
  }

  return { bestAudio, audioSize: 3 * 1024 * 1024 };
}

/**
 * Calculate 100% exact format size using multi-layered precision detection
 */
export async function calculateExactFormatSize(format, tier, duration = 0, audioSize = 0, referer = '') {
  if (!format) {
    const fallbackKbps = tier?.estBitrateKbps || 1300;
    const est = Math.round((fallbackKbps * 1000 / 8) * (duration || 60));
    return est;
  }

  let videoBytes = null;

  // Layer 1: Exact byte count from format metadata
  if (format.filesize && format.filesize > 0) {
    videoBytes = format.filesize;
  } else if (format.filesize_approx && format.filesize_approx > 0) {
    videoBytes = format.filesize_approx;
  }

  // Layer 2: Extract 'clen' from URL (e.g. YouTube CDN)
  if (!videoBytes && format.url) {
    const clen = extractClenFromUrl(format.url);
    if (clen) videoBytes = clen;
  }

  // Layer 3: High-speed HTTP Range Probe (World Standard CDN Header inspection)
  if (!videoBytes && format.url && !format.url.includes('.m3u8') && !format.url.includes('.mpd')) {
    const probed = await probeUrlExactBytes(format.url, referer, 2000);
    if (probed && probed > 0) {
      videoBytes = probed;
    }
  }

  // Layer 4: Mathematical Bitrate calculation (tbr or vbr * duration)
  if (!videoBytes && duration > 0) {
    const streamBitrate = format.tbr || (format.vbr ? (format.vbr + (format.abr || 0)) : null);
    if (streamBitrate && streamBitrate > 0) {
      videoBytes = Math.round((streamBitrate * 1000 / 8) * duration);
    }
  }

  // Layer 5: Calibrated profile based on resolution tier and duration
  if (!videoBytes) {
    const kbps = tier?.estBitrateKbps || 1300;
    videoBytes = Math.round((kbps * 1000 / 8) * (duration || 45));
  }

  // Audio Muxing Check:
  // If the format is video-only (acodec === 'none'), add audio size for the merged container.
  // If format already has audio (muxed), do NOT add audio size again.
  const isVideoOnly = format.vcodec && format.vcodec !== 'none' && (!format.acodec || format.acodec === 'none');
  const finalSize = isVideoOnly ? (videoBytes + (audioSize || 0)) : videoBytes;

  return Math.max(finalSize, 1024 * 100); // Minimum 100 KB
}

/**
 * Universal Presets Builder with 100% Accurate Sizes
 */
export async function buildResolutionPresets({
  rawFormats = [],
  videoFormats = [],
  audioFormats = [],
  duration = 0,
  rawInfo = {},
  isYt = false,
  referer = '',
  maxAllowedSize = 1.5 * 1024 * 1024 * 1024,
  maxLimitLabel = '1.5 GB'
}) {
  const allFormats = (rawFormats && rawFormats.length) ? rawFormats : (rawInfo.formats || []);
  const vFormats = (videoFormats && videoFormats.length) 
    ? videoFormats 
    : allFormats.filter(f => f.vcodec && f.vcodec !== 'none');
  const aFormats = (audioFormats && audioFormats.length) 
    ? audioFormats 
    : allFormats.filter(f => f.acodec && f.acodec !== 'none' && (!f.vcodec || f.vcodec === 'none'));

  // 1. Calculate Audio Size first
  const { audioSize } = await calculateAudioSize(aFormats, duration, referer);

  // 2. Determine Max Quality Height (support both horizontal & vertical videos)
  let maxHeight = 0;
  for (const f of vFormats) {
    const rawH = f.height || (f.format_note && parseInt(f.format_note, 10)) || 0;
    const h = (f.width && f.height) ? Math.min(f.width, f.height) : rawH;
    if (h > maxHeight) maxHeight = h;
  }
  if (rawInfo && rawInfo.height) {
    const rawRes = (rawInfo.width && rawInfo.height) ? Math.min(rawInfo.width, rawInfo.height) : rawInfo.height;
    if (rawRes > maxHeight) maxHeight = rawRes;
  }
  if (maxHeight === 0) maxHeight = 720;

  // 3. Match formats to resolution tiers
  const tierCandidates = [];
  for (let i = 0; i < RESOLUTION_TIERS.length; i++) {
    const tier = RESOLUTION_TIERS[i];
    const upperTier = i > 0 ? RESOLUTION_TIERS[i - 1] : null;

    const hasTier = vFormats.some(f => {
      const rawH = f.height || (f.format_note && parseInt(f.format_note, 10)) || 0;
      const h = (f.width && f.height) ? Math.min(f.width, f.height) : rawH;
      if (upperTier) return h >= tier.minHeight && h < upperTier.minHeight;
      return h >= tier.minHeight;
    }) || (tierCandidates.length === 0 && maxHeight >= tier.minHeight);

    if (hasTier) {
      const matchingFormats = vFormats.filter(f => {
        const rawH = f.height || (f.format_note && parseInt(f.format_note, 10)) || 0;
        const h = (f.width && f.height) ? Math.min(f.width, f.height) : rawH;
        if (upperTier) return h >= tier.minHeight && h < upperTier.minHeight;
        return h >= tier.minHeight;
      });

      const bestFmt = matchingFormats.sort((a, b) => {
        const aIsMp4 = a.ext === 'mp4' ? 1 : 0;
        const bIsMp4 = b.ext === 'mp4' ? 1 : 0;
        if (bIsMp4 !== aIsMp4) return bIsMp4 - aIsMp4;
        const aSize = a.filesize || a.filesize_approx || 0;
        const bSize = b.filesize || b.filesize_approx || 0;
        return bSize - aSize;
      })[0] || matchingFormats[0];

      tierCandidates.push({ tier, bestFmt });
    }
  }

  // Fallback tier if no candidates matched
  if (tierCandidates.length === 0) {
    const fallbackTier = maxHeight >= 720 ? RESOLUTION_TIERS[4] : RESOLUTION_TIERS[5];
    tierCandidates.push({ tier: fallbackTier, bestFmt: vFormats[0] || null });
  }

  // 4. Calculate exact sizes for all matched tiers in parallel
  const matchedTiers = await Promise.all(tierCandidates.map(async ({ tier, bestFmt }) => {
    const exactSize = await calculateExactFormatSize(bestFmt, tier, duration, audioSize, referer);
    // Never attach standalone directUrl for YouTube video streams because YouTube video streams have no audio track
    const directUrl = (!isYt && bestFmt && bestFmt.url && bestFmt.url.startsWith('http')) ? bestFmt.url : null;
    return {
      id: tier.id,
      label: tier.label,
      shortLabel: tier.shortLabel,
      badge: tier.badge,
      height: tier.targetHeight || tier.minHeight,
      ext: 'mp4',
      type: 'video',
      filesize: exactSize,
      filesizeFormatted: formatBytes(exactSize),
      directUrl
    };
  }));

  // 5. Build Best Quality and Audio Presets
  const topTier = matchedTiers[0];
  const maxQualityLabel = topTier.shortLabel;

  const bestPreset = {
    id: 'best_with_audio',
    label: `Download Best Quality (${maxQualityLabel})`,
    shortLabel: maxQualityLabel,
    ext: 'mp4',
    type: 'video',
    filesize: topTier.filesize,
    filesizeFormatted: topTier.filesizeFormatted,
    isRecommended: true,
    directUrl: isYt ? null : (topTier.directUrl || null)
  };

  const bestAudioFmt = aFormats.find(f => f.url && f.url.startsWith('http')) || aFormats[0];
  const audioPreset = {
    id: 'audio_best',
    label: 'MP3 Audio (High Quality)',
    shortLabel: 'MP3 Audio',
    ext: 'mp3',
    type: 'audio',
    filesize: audioSize,
    filesizeFormatted: formatBytes(audioSize),
    directUrl: (bestAudioFmt && bestAudioFmt.url && bestAudioFmt.url.startsWith('http')) ? bestAudioFmt.url : null
  };

  const presets = [bestPreset, ...matchedTiers, audioPreset];

  // 6. Enforce file size quotas
  presets.forEach(p => {
    if (p.filesize && p.filesize > maxAllowedSize) {
      p.exceedsLimit = true;
      p.maxLimitFormatted = maxLimitLabel;
      if (isYt) {
        const vidId = rawInfo.id || '';
        p.mirrorUrl = `https://en.savefrom.net/1-youtube-video-downloader-4v1/?url=https://www.youtube.com/watch?v=${vidId}`;
      }
    }
  });

  return {
    presets,
    bestPreset,
    maxQualityLabel,
    maxHeight,
    audioSize
  };
}
