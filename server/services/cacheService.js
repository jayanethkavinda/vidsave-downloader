/**
 * VidSave Media Cache Service (30-Minute In-Memory TTL)
 * Stores resolved CDN URLs & format presets to enable instant (<1s) Zero-Disk streaming.
 * Keeps memory footprint minimal (~1-2 KB per video entry).
 */

const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes TTL
const MAX_CACHE_ENTRIES = 1000;      // Hard limit to prevent memory bloat

const mediaCache = new Map();

/**
 * Normalize URL to create a reliable cache key across formats
 */
export function normalizeUrlKey(url) {
  if (!url || typeof url !== 'string') return '';
  return url.trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '').toLowerCase();
}

/**
 * Cache resolved media info for 30 minutes
 */
export function cacheMediaInfo(url, info) {
  if (!url || !info) return;

  // Prune oldest if at maximum capacity
  if (mediaCache.size >= MAX_CACHE_ENTRIES) {
    const oldestKey = mediaCache.keys().next().value;
    mediaCache.delete(oldestKey);
  }

  const entry = {
    timestamp: Date.now(),
    info,
    webpageUrl: info.webpageUrl || url,
    title: info.title || 'video',
    presets: info.presets || [],
    bestPreset: info.bestPreset || null,
    directStreamUrl: info.directStreamUrl || null
  };

  const primaryKey = normalizeUrlKey(url);
  mediaCache.set(primaryKey, entry);

  // Also cross-index with webpageUrl if different
  if (info.webpageUrl && normalizeUrlKey(info.webpageUrl) !== primaryKey) {
    mediaCache.set(normalizeUrlKey(info.webpageUrl), entry);
  }

  console.log(`[Media Cache] Stored 30-min cached links for: ${url} (Total cached: ${mediaCache.size})`);
}

/**
 * Retrieve cached direct CDN URL for a given URL and requested format preset
 */
export function getCachedDirectUrl(url, formatPreset) {
  if (!url) return null;
  const key = normalizeUrlKey(url);
  const entry = mediaCache.get(key);
  if (!entry) return null;

  // Evict if TTL (30 min) has expired
  if (Date.now() - entry.timestamp > CACHE_TTL_MS) {
    mediaCache.delete(key);
    return null;
  }

  const presets = entry.presets || [];
  const fmt = (formatPreset || 'best').trim();

  // 1. Try exact preset ID match
  const match = presets.find(p => String(p.id) === String(fmt));
  if (match && match.directUrl) {
    return {
      directUrl: match.directUrl,
      title: entry.title,
      ext: match.ext || (fmt.includes('audio') || fmt === 'mp3' ? 'mp3' : 'mp4'),
      type: match.type || 'video',
      filesize: match.filesize || null
    };
  }

  // 2. Best video quality request
  if (fmt === 'best' || fmt === 'best_with_audio') {
    const best = entry.bestPreset || presets.find(p => p.type === 'video') || presets[0];
    if (best && best.directUrl) {
      return {
        directUrl: best.directUrl,
        title: entry.title,
        ext: best.ext || 'mp4',
        type: 'video',
        filesize: best.filesize || null
      };
    }
  }

  // 3. Audio request (MP3)
  if (fmt === 'audio_best' || fmt === 'mp3') {
    const audio = presets.find(p => p.type === 'audio' || p.id === 'audio_best' || p.id === 'mp3');
    if (audio && audio.directUrl) {
      return {
        directUrl: audio.directUrl,
        title: entry.title,
        ext: 'mp3',
        type: 'audio',
        filesize: audio.filesize || null
      };
    }
  }

  // 4. Fallback to directStreamUrl if present on entry
  if (entry.directStreamUrl) {
    return {
      directUrl: entry.directStreamUrl,
      title: entry.title,
      ext: fmt.includes('audio') ? 'mp3' : 'mp4',
      type: fmt.includes('audio') ? 'audio' : 'video',
      filesize: null
    };
  }

  return null;
}

// Background cleanup job every 5 minutes to sweep expired entries
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of mediaCache.entries()) {
    if (now - v.timestamp > CACHE_TTL_MS) {
      mediaCache.delete(k);
    }
  }
}, 5 * 60 * 1000).unref();
