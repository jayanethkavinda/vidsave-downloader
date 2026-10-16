/**
 * VidSave In-Memory Media Cache Service
 * Configured with 20-Minute TTL (1,200,000 ms) as requested.
 * Stores extracted direct CDN links and resolution presets for instant (1-2s) streaming.
 * Memory footprint: ~1-2 KB per entry (negligible on 512MB RAM).
 */

const CACHE_TTL_MS = 20 * 60 * 1000; // 20 minutes
const MAX_CACHE_ENTRIES = 1000;

// Internal Map storage: key -> { data, timestamp }
const cache = new Map();

/**
 * Normalizes URL to build a robust, unique cache key
 */
export function normalizeUrlKey(url) {
  if (!url || typeof url !== 'string') return '';
  try {
    let clean = url.trim();
    // Strip ephemeral tracking parameters (utm_*, igsh, fbclid, feature, etc.)
    clean = clean.replace(/[?&](utm_[^&]+|igsh=[^&]+|fbclid=[^&]+|feature=[^&]+|si=[^&]+)/gi, '');
    clean = clean.replace(/([?&])$/, '');
    // Normalize trailing slash and lower-case scheme/host
    return clean.replace(/\/+$/, '');
  } catch (_) {
    return (url || '').trim();
  }
}

/**
 * Save extracted media metadata and direct stream presets to cache
 */
export function setMediaCache(url, mediaInfo) {
  if (!url || !mediaInfo) return;

  // Enforce memory bounds
  if (cache.size >= MAX_CACHE_ENTRIES) {
    const oldestKey = cache.keys().next().value;
    cache.delete(oldestKey);
  }

  const entry = {
    data: mediaInfo,
    timestamp: Date.now()
  };

  const primaryKey = normalizeUrlKey(url);
  cache.set(primaryKey, entry);

  // Also index by canonical webpageUrl if different
  if (mediaInfo.webpageUrl && normalizeUrlKey(mediaInfo.webpageUrl) !== primaryKey) {
    cache.set(normalizeUrlKey(mediaInfo.webpageUrl), entry);
  }

  // Also index by ID
  if (mediaInfo.id) {
    cache.set(`id:${mediaInfo.id}`, entry);
  }
}

/**
 * Retrieve cached media info (auto-evicts if expired past 20 minutes)
 */
export function getMediaCache(url) {
  if (!url) return null;
  const key = normalizeUrlKey(url);
  const entry = cache.get(key);
  if (!entry) return null;

  if (Date.now() - entry.timestamp > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return entry.data;
}

/**
 * Find direct CDN stream info for a requested format preset
 */
export function getCachedDirectStream(url, formatPreset) {
  const mediaInfo = getMediaCache(url);
  if (!mediaInfo) return null;

  const presets = mediaInfo.presets || [];
  const targetId = formatPreset || 'best_with_audio';

  // 1. Exact preset match
  let matchedPreset = presets.find(p => p.id === targetId);

  // 2. Fallbacks
  if (!matchedPreset) {
    if (targetId === 'best' || targetId === 'best_with_audio') {
      matchedPreset = mediaInfo.bestPreset || presets[0];
    } else if (targetId === 'audio_best' || targetId === 'mp3') {
      matchedPreset = presets.find(p => p.type === 'audio');
    }
  }

  if (matchedPreset && matchedPreset.directUrl) {
    return {
      directUrl: matchedPreset.directUrl,
      ext: matchedPreset.ext || 'mp4',
      type: matchedPreset.type || 'video',
      hasAudio: matchedPreset.hasAudio !== false, // Default to true unless explicitly flagged
      title: mediaInfo.title || 'media',
      mediaInfo
    };
  }

  // 3. Fallback to directStreamUrl from cloud scraper
  if (mediaInfo.directStreamUrl) {
    return {
      directUrl: mediaInfo.directStreamUrl,
      ext: 'mp4',
      type: 'video',
      hasAudio: true,
      title: mediaInfo.title || 'media',
      mediaInfo
    };
  }

  return null;
}

// Periodic cleanup timer every 5 minutes
const cleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of cache.entries()) {
    if (now - entry.timestamp > CACHE_TTL_MS) {
      cache.delete(key);
    }
  }
}, 5 * 60 * 1000);

if (cleanupTimer.unref) {
  cleanupTimer.unref();
}
