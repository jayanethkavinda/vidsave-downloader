/**
 * VidSave Downloader Service - Unified Module Facade
 * Cleanly re-exports from modular services:
 * - coreEngine.js       (Python/FFmpeg Paths, Cookies, Anti-Bot Args)
 * - infoExtractor.js    (Video Info, Presets, Preview Generator)
 * - streamDownloader.js (Zero-Disk Direct Social Streaming & YouTube Muxing)
 * - trimService.js      (Segment Trimming & Fallback)
 * - subtitleService.js  (Subtitle Extraction, VTT to SRT)
 */

export { 
  PYTHON_BIN, 
  ffmpegPath, 
  COOKIE_FILE, 
  syncCookiesFromEnv, 
  isYouTubeUrl, 
  isScraperSupportedUrl, 
  buildYtdlpArgs, 
  formatDuration 
} from './coreEngine.js';

export { 
  getVideoInfo, 
  resolveCloudScraperFallback 
} from './infoExtractor.js';

export { 
  streamVideoDownload, 
  streamDirectCloudFallback 
} from './streamDownloader.js';

export { 
  streamTrimmedDownload, 
  trimDirectCloudFallback 
} from './trimService.js';

export { 
  extractSubtitles, 
  convertVttToSrt, 
  convertSrv1ToVtt 
} from './subtitleService.js';

export {
  streamVideoPreview
} from './previewService.js';
