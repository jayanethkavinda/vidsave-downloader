import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import {
  ArrowLeft,
  Play,
  Pause,
  RotateCcw,
  Scissors,
  Music,
  Film,
  Zap,
  Clock,
  Sparkles,
  CheckCircle,
  AlertCircle,
  Link as LinkIcon,
  Clipboard,
  ChevronDown,
  Plus,
  Minus,
  Volume2,
  VolumeX,
  Download,
  Headphones
} from 'lucide-react';
import TaslAttributionCard from './TaslAttributionCard.jsx';

const BACKEND_URL = 'https://162.35.187.196.sslip.io';

export default function VideoTrimmer({ videoInfo: initialVideoInfo, onBack, onVideoExtracted }) {
  const [videoInfo, setVideoInfo] = useState(initialVideoInfo || null);
  const [inputUrl, setInputUrl] = useState(initialVideoInfo?.webpageUrl || '');
  const [extracting, setExtracting] = useState(false);
  const [extractError, setExtractError] = useState('');

  const duration = Math.max(3, parseFloat(videoInfo?.duration) || 60);

  // Initial cut range: 0 to min(10, duration), at least 3 seconds
  const initialEnd = Math.max(3, Math.min(10, duration));
  const [startTime, setStartTime] = useState(0);
  const [endTime, setEndTime] = useState(initialEnd);
  const [currentTime, setCurrentTime] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isMuted, setIsMuted] = useState(false);

  const startTimeRef = useRef(0);
  const endTimeRef = useRef(initialEnd);
  useEffect(() => { startTimeRef.current = startTime; }, [startTime]);
  useEffect(() => { endTimeRef.current = endTime; }, [endTime]);

  // Download state with in-button percentage animation
  const [downloadingType, setDownloadingType] = useState(null); // 'video' | 'audio' | null
  const [downloadProgress, setDownloadProgress] = useState(0);
  const [downloadSuccess, setDownloadSuccess] = useState(false);
  const [downloadError, setDownloadError] = useState('');

  // Default quality: 'best' (100% original upload quality)
  const [selectedQuality, setSelectedQuality] = useState('best');
  const [isQualityDropdownOpen, setIsQualityDropdownOpen] = useState(false);
  const trimmerDropdownRef = useRef(null);

  const timelineRef = useRef(null);
  const draggingHandle = useRef(null); // 'left' | 'right' | null
  const videoElementRef = useRef(null);
  const ytPlayerRef = useRef(null);
  const ytIntervalRef = useRef(null);
  const progressTimerRef = useRef(null);

  // Close custom dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (e) => {
      if (trimmerDropdownRef.current && !trimmerDropdownRef.current.contains(e.target)) {
        setIsQualityDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Sync state if initialVideoInfo changes from outside
  useEffect(() => {
    if (initialVideoInfo) {
      setVideoInfo(initialVideoInfo);
      setInputUrl(initialVideoInfo.webpageUrl || '');
      const d = Math.max(1, parseFloat(initialVideoInfo.duration) || 60);
      setStartTime(0);
      setEndTime(Math.min(10, d));
      setCurrentTime(0);
      setSelectedQuality('best');
      setIsPlaying(true);
    }
  }, [initialVideoInfo]);

  // Extract YouTube ID if applicable
  const extractYouTubeId = (rawUrl) => {
    if (!rawUrl) return null;
    const match = rawUrl.match(/(?:youtu\.be\/|youtube\.com\/(?:embed\/|v\/|watch\?v=|watch\?.+&v=|shorts\/|live\/))([\w-]{11})/i);
    return match ? match[1] : null;
  };

  const ytVideoId = videoInfo?.videoId || extractYouTubeId(videoInfo?.webpageUrl);
  const [useFallbackPreview, setUseFallbackPreview] = useState(false);
  const [streamError, setStreamError] = useState(false);
  const [videoLoading, setVideoLoading] = useState(!ytVideoId && Boolean(videoInfo));

  // High-speed lightweight 240p/360p progressive preview stream with sound
  const previewVideoUrl = !ytVideoId && videoInfo?.webpageUrl
    ? (useFallbackPreview 
        ? `${BACKEND_URL}/api/preview?url=${encodeURIComponent(videoInfo.webpageUrl)}`
        : (videoInfo?.previewStreamUrl 
            ? `${BACKEND_URL}${videoInfo.previewStreamUrl}` 
            : `${BACKEND_URL}/api/preview?url=${encodeURIComponent(videoInfo.webpageUrl)}`))
    : null;

  // Format seconds to mm:ss.s or mm:ss
  const formatTime = (seconds, includeDecimals = true) => {
    const s = Math.max(0, parseFloat(seconds) || 0);
    const mins = Math.floor(s / 60);
    const secs = (s % 60);
    const minsStr = mins.toString().padStart(2, '0');
    if (includeDecimals) {
      const secsStr = secs.toFixed(1).padStart(4, '0');
      return `${minsStr}:${secsStr}`;
    }
    const secsStr = Math.floor(secs).toString().padStart(2, '0');
    return `${minsStr}:${secsStr}`;
  };

  // Automated trigger to load and autoplay video immediately
  const triggerAutoExtract = async (rawUrl) => {
    const cleanUrl = (rawUrl || '').trim();
    if (!cleanUrl) return;

    setInputUrl(cleanUrl);
    setExtracting(true);
    setExtractError('');
    try {
      const res = await fetch(`${BACKEND_URL}/api/info?url=${encodeURIComponent(cleanUrl)}`);
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Failed to extract video information');
      }

      setVideoInfo(data);
      const newDuration = Math.max(1, parseFloat(data.duration) || 60);
      setStartTime(0);
      setEndTime(Math.min(10, newDuration));
      setCurrentTime(0);
      setSelectedQuality('best');
      setIsPlaying(true); // Automatically play on load!
      setUseFallbackPreview(false);
      setStreamError(false);
      setVideoLoading(true);

      if (typeof onVideoExtracted === 'function') {
        onVideoExtracted(data);
      }
    } catch (err) {
      console.error('[Trimmer Extractor Error]', err);
      setExtractError(err.message || 'Unable to fetch video. Please check the URL.');
    } finally {
      setExtracting(false);
    }
  };

  // Handle URL extraction from inside Trimmer view
  const handleExtractInsideTrimmer = (e) => {
    if (e) e.preventDefault();
    triggerAutoExtract(inputUrl);
  };

  // Immediate paste & extract
  const handlePasteUrl = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) {
        setInputUrl(text);
        triggerAutoExtract(text);
      }
    } catch (e) {
      console.warn('Clipboard read error:', e);
    }
  };

  // Handle clipboard paste directly inside text box
  const handleInputPaste = (e) => {
    const pasted = e.clipboardData.getData('text');
    if (pasted) {
      setInputUrl(pasted);
      triggerAutoExtract(pasted);
    }
  };

  // Autoplay handler for HTML5 video
  const handleVideoCanPlay = () => {
    setVideoLoading(false);
    if (videoElementRef.current) {
      if (videoElementRef.current.currentTime < startTime || videoElementRef.current.currentTime >= endTime) {
        videoElementRef.current.currentTime = startTime;
        setCurrentTime(startTime);
      }
      const playPromise = videoElementRef.current.play();
      if (playPromise !== undefined) {
        playPromise
          .then(() => {
            setIsPlaying(true);
          })
          .catch(() => {
            // If browser blocks unmuted autoplay, mute and autoplay seamlessly
            if (videoElementRef.current) {
              videoElementRef.current.muted = true;
              setIsMuted(true);
              videoElementRef.current.play().then(() => setIsPlaying(true)).catch(() => {});
            }
          });
      }
    }
  };

  // Initialize YouTube Iframe Player API with Autoplay
  useEffect(() => {
    if (!ytVideoId) return;

    const initYT = () => {
      if (window.YT && window.YT.Player) {
        try {
          ytPlayerRef.current = new window.YT.Player('trimmer-yt-player', {
            videoId: ytVideoId,
            playerVars: {
              autoplay: 1,
              controls: 0,
              rel: 0,
              modestbranding: 1,
              disablekb: 1,
              fs: 0,
              playsinline: 1,
            },
            events: {
              onReady: (e) => {
                try {
                  e.target.seekTo(startTime, true);
                  e.target.playVideo();
                  setIsPlaying(true);
                } catch (_) {}
              },
              onStateChange: (e) => {
                if (e.data === window.YT.PlayerState.PLAYING) {
                  setIsPlaying(true);
                } else if (e.data === window.YT.PlayerState.PAUSED || e.data === window.YT.PlayerState.ENDED) {
                  setIsPlaying(false);
                }
              }
            }
          });
        } catch (e) {
          console.warn('YT Player init issue:', e);
        }
      }
    };

    if (!window.YT) {
      const tag = document.createElement('script');
      tag.src = 'https://www.youtube.com/iframe_api';
      window.onYouTubeIframeAPIReady = initYT;
      document.body.appendChild(tag);
    } else {
      initYT();
    }

    return () => {
      if (ytIntervalRef.current) clearInterval(ytIntervalRef.current);
      if (ytPlayerRef.current && typeof ytPlayerRef.current.destroy === 'function') {
        try { ytPlayerRef.current.destroy(); } catch (e) {}
      }
    };
  }, [ytVideoId]);

  // Sync playhead for YouTube preview
  useEffect(() => {
    if (isPlaying) {
      ytIntervalRef.current = setInterval(() => {
        if (ytPlayerRef.current && typeof ytPlayerRef.current.getCurrentTime === 'function') {
          const t = ytPlayerRef.current.getCurrentTime();
          if (t < startTime || t >= endTime) {
            ytPlayerRef.current.seekTo(startTime, true);
            setCurrentTime(startTime);
          } else {
            setCurrentTime(t);
          }
        }
      }, 50);
    } else {
      if (ytIntervalRef.current) clearInterval(ytIntervalRef.current);
    }
    return () => {
      if (ytIntervalRef.current) clearInterval(ytIntervalRef.current);
    };
  }, [isPlaying, startTime, endTime]);

  // Play / Pause toggle
  const togglePlay = () => {
    if (ytPlayerRef.current && typeof ytPlayerRef.current.playVideo === 'function') {
      if (isPlaying) {
        ytPlayerRef.current.pauseVideo();
        setIsPlaying(false);
      } else {
        if (currentTime < startTime || currentTime >= endTime) {
          ytPlayerRef.current.seekTo(startTime, true);
          setCurrentTime(startTime);
        }
        ytPlayerRef.current.playVideo();
        setIsPlaying(true);
      }
    } else if (videoElementRef.current && !streamError) {
      const vid = videoElementRef.current;
      if (vid.paused) {
        if (vid.currentTime < startTime || vid.currentTime >= endTime) {
          vid.currentTime = startTime;
        }
        vid.play().catch(() => {
          setIsPlaying(true);
        });
        setIsPlaying(true);
      } else {
        vid.pause();
        setIsPlaying(false);
      }
    } else {
      setIsPlaying(!isPlaying);
    }
  };

  // Sound Mute / Unmute toggle for both YouTube iframe and HTML5 video
  const toggleMute = () => {
    if (ytPlayerRef.current && typeof ytPlayerRef.current.isMuted === 'function') {
      try {
        if (ytPlayerRef.current.isMuted()) {
          ytPlayerRef.current.unMute();
          setIsMuted(false);
        } else {
          ytPlayerRef.current.mute();
          setIsMuted(true);
        }
      } catch (e) {
        console.warn('YT toggle mute error:', e);
      }
    } else if (videoElementRef.current) {
      const nextMuted = !videoElementRef.current.muted;
      videoElementRef.current.muted = nextMuted;
      setIsMuted(nextMuted);
    } else {
      setIsMuted(prev => !prev);
    }
  };

  // Simulated ticker for fallback
  useEffect(() => {
    if ((!ytVideoId && (!previewVideoUrl || streamError)) && isPlaying) {
      const timer = setInterval(() => {
        setCurrentTime((prev) => {
          if (prev >= endTime) return startTime;
          return parseFloat((prev + 0.1).toFixed(1));
        });
      }, 100);
      return () => clearInterval(timer);
    }
  }, [isPlaying, ytVideoId, previewVideoUrl, streamError, startTime, endTime]);

  const selectedLength = (endTime - startTime).toFixed(1);
  const leftPercent = (startTime / duration) * 100;
  const rightPercent = (endTime / duration) * 100;
  const widthPercent = Math.max(0.1, rightPercent - leftPercent);
  const clipDuration = Math.max(0.1, endTime - startTime);
  const cropProgress = Math.max(0, Math.min(1, (currentTime - startTime) / clipDuration));

  // Clean quality tag without "Ultra HD", "Full HD", etc. - strictly 8K, 4K, 2K, 1080p, 720p, 480p, 420p, 360p
  const getCleanQualityTag = (optOrId) => {
    let str = typeof optOrId === 'string' ? optOrId : (optOrId?.shortLabel || optOrId?.badge || optOrId?.id || '');
    if (str === 'best' || str === 'Original' || !str) {
      const maxQ = videoInfo?.maxQualityLabel || videoInfo?.maxQuality || '';
      const m = maxQ.match(/(8K|4K|2K|1080p|720p|480p|420p|360p)/i);
      if (m) {
        const u = m[1].toUpperCase();
        return u.includes('P') ? u.toLowerCase() : u;
      }
      if (videoInfo?.maxHeight >= 3800) return '8K';
      if (videoInfo?.maxHeight >= 2000) return '4K';
      if (videoInfo?.maxHeight >= 1400) return '2K';
      if (videoInfo?.maxHeight >= 1000) return '1080p';
      if (videoInfo?.maxHeight >= 700) return '720p';
      if (videoInfo?.maxHeight >= 450) return '480p';
      if (videoInfo?.maxHeight >= 400) return '420p';
      return '1080p';
    }
    const m = str.match(/(8K|4K|2K|1080p|720p|480p|420p|360p)/i);
    if (m) {
      const u = m[1].toUpperCase();
      return u.includes('P') ? u.toLowerCase() : u;
    }
    str = str.replace(/(Ultra HD|Full HD|HD|SD|Audio|Fastest|Original)/gi, '').trim();
    if (str.endsWith('p')) return str;
    return str ? str + 'p' : '1080p';
  };

  // Dynamic File Size calculation in clean MB without brackets/parentheses, never in KB
  const getCleanClipSizeMb = (formatId) => {
    const totalDur = Math.max(1, duration || videoInfo?.duration || 60);
    const ratio = Math.min(1, clipDuration / totalDur);

    // 1. Match with real probed preset size from backend sizeCalculator
    const matchedPreset = videoInfo?.presets?.find(p => 
      String(p.id) === String(formatId) || 
      (formatId === 'best' && (p.id === 'best_with_audio' || p === videoInfo?.bestPreset)) ||
      p.resolution === formatId || 
      (formatId === 'audio' && (p.type === 'audio' || p.ext === 'mp3')) ||
      p.shortLabel?.toLowerCase().includes(String(formatId).toLowerCase())
    );

    const presetBytes = matchedPreset?.filesize || matchedPreset?.filesizeBytes;
    let bytes = 0;
    if (presetBytes && presetBytes > 0) {
      bytes = Math.round(presetBytes * ratio);
    } else {
      // 2. Calibrated bitrate fallback
      const bitrates = {
        '4320': 20000,
        '2160': 10000,
        '1440': 5000,
        '1080': 2200,
        '720': 1200,
        '480': 650,
        '360': 380,
        'best': (videoInfo?.maxHeight >= 2000 ? 10000 : (videoInfo?.maxHeight >= 1000 ? 2200 : 1200)),
        'audio': 192,
        'mp3': 192
      };
      const kbps = bitrates[formatId] || 1500;
      bytes = Math.round((kbps * 1000 * clipDuration) / 8);
    }

    const mb = bytes / (1024 * 1024);
    if (mb >= 10) return `${mb.toFixed(1)} MB`;
    if (mb >= 1) return `${mb.toFixed(1)} MB`;
    const dec = mb.toFixed(2);
    return `${parseFloat(dec) > 0 ? dec : '0.01'} MB`;
  };

  // Dynamic available resolutions list for the trimmer floating menu
  const availableVideoOptions = useMemo(() => {
    const rawPresets = videoInfo?.presets || [];
    const seen = new Set();
    const options = [];

    // 1. Original Upload Quality
    options.push({
      id: 'best',
      badge: 'Original',
      label: 'Original',
      shortLabel: 'Original'
    });
    seen.add('best');

    // 2. Available tiers from videoInfo.presets (excluding audio)
    for (const p of rawPresets) {
      if (p.type === 'audio' || p.id === 'best_with_audio' || p.id === 'audio_best') continue;
      const qId = String(p.id);
      if (!seen.has(qId)) {
        seen.add(qId);
        options.push({
          id: qId,
          badge: p.shortLabel || (qId + 'p'),
          label: p.shortLabel || (qId + 'p'),
          shortLabel: p.shortLabel || (qId + 'p'),
          exceedsLimit: p.exceedsLimit
        });
      }
    }

    // 3. Fallback standard tiers if no tiers found
    if (options.length === 1) {
      ['1080', '720', '480', '360'].forEach(id => {
        if (!seen.has(id)) {
          options.push({
            id,
            badge: `${id}p`,
            label: `${id}p`,
            shortLabel: `${id}p`
          });
        }
      });
    }

    return options;
  }, [videoInfo]);

  const isYouTube = /(?:youtube\.com|youtu\.be)/i.test(videoInfo?.webpageUrl || '');
  const quotaBytes = isYouTube ? 1.5 * 1024 * 1024 * 1024 : 3.0 * 1024 * 1024 * 1024;
  const isOverQuota = (format) => {
    const bitrates = { '1080': 3500, '720': 1800, '480': 900, 'best': 3500, 'audio': 192 };
    const kbps = bitrates[format] || 2500;
    const bytes = Math.round((kbps * 1000 * clipDuration) / 8);
    return bytes > quotaBytes;
  };

  // Seek video strictly within start and end cut points
  const seekTo = useCallback((t) => {
    const clamped = Math.max(startTime, Math.min(endTime, t));
    setCurrentTime(clamped);
    if (ytPlayerRef.current && typeof ytPlayerRef.current.seekTo === 'function') {
      ytPlayerRef.current.seekTo(clamped, true);
    } else if (videoElementRef.current && !streamError) {
      videoElementRef.current.currentTime = clamped;
    }
  }, [startTime, endTime, streamError]);

  // Handle timeline dragging (mouse & touch) with strictly enforced 3-second minimum gap
  const handleTimelineMove = useCallback((clientX) => {
    if (!draggingHandle.current || !timelineRef.current) return;
    const rect = timelineRef.current.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    const targetSeconds = parseFloat((ratio * duration).toFixed(1));

    if (draggingHandle.current === 'left') {
      const maxAllowedStart = Math.max(0, parseFloat((endTime - 3.0).toFixed(1)));
      const newStart = Math.max(0, Math.min(targetSeconds, maxAllowedStart));
      setStartTime(newStart);
      seekTo(newStart);
    } else if (draggingHandle.current === 'right') {
      const minAllowedEnd = Math.min(duration, parseFloat((startTime + 3.0).toFixed(1)));
      const newEnd = Math.min(duration, Math.max(targetSeconds, minAllowedEnd));
      setEndTime(newEnd);
      seekTo(newEnd);
    }
  }, [duration, startTime, endTime, seekTo]);

  const handlePointerUp = useCallback(() => {
    draggingHandle.current = null;
    window.removeEventListener('mousemove', onMouseMove);
    window.removeEventListener('mouseup', handlePointerUp);
    window.removeEventListener('touchmove', onTouchMove);
    window.removeEventListener('touchend', handlePointerUp);
  }, []);

  const onMouseMove = useCallback((e) => {
    handleTimelineMove(e.clientX);
  }, [handleTimelineMove]);

  const onTouchMove = useCallback((e) => {
    if (e.touches && e.touches[0]) {
      handleTimelineMove(e.touches[0].clientX);
    }
  }, [handleTimelineMove]);

  const startDrag = (handle, e) => {
    e.stopPropagation();
    e.preventDefault();
    draggingHandle.current = handle;
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', handlePointerUp);
    window.addEventListener('touchmove', onTouchMove, { passive: false });
    window.addEventListener('touchend', handlePointerUp);
  };

  const handleTimelineClick = (e) => {
    if (!timelineRef.current) return;
    const rect = timelineRef.current.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const clickedSec = parseFloat((ratio * duration).toFixed(1));
    // Playhead strictly remains inside start and end boundaries
    const clamped = Math.max(startTime, Math.min(endTime, clickedSec));
    seekTo(clamped);
  };

  const MIN_CLIP_SECONDS = 3.0;

  // Fine tune adjustments by 0.1s with 3-second minimum gap
  const adjustStart = useCallback((delta) => {
    const curEnd = endTimeRef.current;
    let newStart = parseFloat((startTimeRef.current + delta).toFixed(1));
    const maxStart = Math.max(0, parseFloat((duration - MIN_CLIP_SECONDS).toFixed(1)));
    newStart = Math.max(0, Math.min(maxStart, newStart));

    let newEnd = curEnd;
    // When moving start forward, if gap drops to or below 3.0s, push end forward!
    if (delta > 0 && parseFloat((newStart + MIN_CLIP_SECONDS).toFixed(1)) >= curEnd) {
      newEnd = Math.min(duration, parseFloat((newStart + MIN_CLIP_SECONDS).toFixed(1)));
      if (parseFloat((newEnd - newStart).toFixed(1)) < MIN_CLIP_SECONDS) {
        newStart = Math.max(0, parseFloat((newEnd - MIN_CLIP_SECONDS).toFixed(1)));
      }
    }
    // When delta < 0 (moving start backward), end does NOT move backward at all!

    setStartTime(newStart);
    if (newEnd !== curEnd) {
      setEndTime(newEnd);
    }
    seekTo(newStart);
  }, [duration, seekTo]);

  const adjustEnd = useCallback((delta) => {
    const curStart = startTimeRef.current;
    const minAllowedEnd = parseFloat((curStart + MIN_CLIP_SECONDS).toFixed(1));
    let newEnd = parseFloat((endTimeRef.current + delta).toFixed(1));
    // End can only go as low as curStart + 3.0s, and cannot exceed duration!
    // Start NEVER moves backward when moving end backward!
    newEnd = Math.min(duration, Math.max(minAllowedEnd, newEnd));

    setEndTime(newEnd);
    seekTo(newEnd);
  }, [duration, seekTo]);

  // Press & hold (touch / click) continuous stepper handler
  const holdIntervalRef = useRef(null);
  const holdTimeoutRef = useRef(null);

  const stopHold = useCallback(() => {
    if (holdTimeoutRef.current) {
      clearTimeout(holdTimeoutRef.current);
      holdTimeoutRef.current = null;
    }
    if (holdIntervalRef.current) {
      clearInterval(holdIntervalRef.current);
      holdIntervalRef.current = null;
    }
  }, []);

  const startHold = useCallback((actionFn) => {
    // 1. Immediate step on press
    actionFn();
    stopHold();
    // 2. Continuous repeating steps after 300ms hold delay
    holdTimeoutRef.current = setTimeout(() => {
      holdIntervalRef.current = setInterval(() => {
        actionFn();
      }, 70);
    }, 300);
  }, [stopHold]);

  useEffect(() => {
    return () => stopHold();
  }, [stopHold]);

  // Reset to full video duration (0 to total duration)
  const handleResetFullVideo = () => {
    setStartTime(0);
    setEndTime(duration);
    seekTo(0);
  };

  // Trigger direct native browser download with smooth in-button percentage increments
  const handleDownloadTrim = (type = 'video', format = selectedQuality) => {
    if (downloadingType) return;
    setDownloadingType(type);
    setDownloadSuccess(false);
    setDownloadError('');
    setDownloadProgress(20);

    // Smooth percentage ticker 20% -> 45% -> 75% -> 99% -> 100%
    if (progressTimerRef.current) clearInterval(progressTimerRef.current);
    progressTimerRef.current = setInterval(() => {
      setDownloadProgress((prev) => {
        if (prev >= 95) return prev;
        const jump = Math.floor(Math.random() * 8) + 4;
        return Math.min(96, prev + jump);
      });
    }, 140);

    try {
      const cleanUrl = videoInfo?.webpageUrl || inputUrl;
      const cleanTitle = (videoInfo?.title || 'clip').replace(/[^\w\s-]/gi, '').trim() || 'clip';
      const actualType = (type === 'audio' || format === 'audio') ? 'audio' : 'video';
      const ext = actualType === 'audio' ? 'mp3' : 'mp4';
      const filename = `${cleanTitle}_cut_${Math.round(startTime)}s-${Math.round(endTime)}s.${ext}`;
      const trimApiUrl = `${BACKEND_URL}/api/trim?url=${encodeURIComponent(cleanUrl)}&start=${startTime}&end=${endTime}&type=${actualType}&format=${format}&title=${encodeURIComponent(cleanTitle)}`;

      // Trigger Native Browser Download via Hidden Iframe (No tab spinner / reload)
      const iframe = document.createElement('iframe');
      iframe.style.position = 'fixed';
      iframe.style.top = '-9999px';
      iframe.style.left = '-9999px';
      iframe.style.width = '1px';
      iframe.style.height = '1px';
      iframe.style.opacity = '0';
      iframe.style.border = 'none';
      iframe.src = trimApiUrl;
      document.body.appendChild(iframe);

      setTimeout(() => {
        try {
          if (iframe && iframe.parentNode) {
            iframe.parentNode.removeChild(iframe);
          }
        } catch (_) {}
      }, 60000);

      // Once browser starts streaming, wrap up percentage to 100% and show quick confirmation
      setTimeout(() => {
        if (progressTimerRef.current) clearInterval(progressTimerRef.current);
        setDownloadProgress(100);
        setDownloadSuccess(true);
        setTimeout(() => {
          setDownloadingType(null);
          setDownloadProgress(0);
        }, 1600);
      }, 1100);
    } catch (err) {
      if (progressTimerRef.current) clearInterval(progressTimerRef.current);
      console.error('Trim download error:', err);
      setDownloadError(err.message || 'Download failed. Please try again.');
      setDownloadingType(null);
      setDownloadProgress(0);
    }
  };

  useEffect(() => {
    return () => {
      if (progressTimerRef.current) clearInterval(progressTimerRef.current);
    };
  }, []);



  return (
    <div className="trimmer-view-container">
      {/* 🔝 Sticky Top Nav inside Trimmer */}
      <div className="trimmer-top-nav">
        <button type="button" onClick={onBack} className="btn-trim-back">
          <ArrowLeft size={18} />
          <span>Full Downloader</span>
        </button>
      </div>

      {/* 🔗 Dedicated URL Input Bar at the Top of Trimmer (Auto-extracts on paste!) */}
      <div className="trimmer-url-bar-card">
        <form onSubmit={handleExtractInsideTrimmer} className="trimmer-url-form">
          <div className="trimmer-input-wrapper">
            <LinkIcon size={18} className="trimmer-input-icon" />
            <input
              type="text"
              placeholder="Paste any video link to clip & trim (YouTube, TikTok, Instagram, FB, X)..."
              value={inputUrl}
              onChange={(e) => setInputUrl(e.target.value)}
              onPaste={handleInputPaste}
              className="trimmer-url-input"
            />
            {inputUrl.trim() ? (
              <button
                type="button"
                onClick={() => {
                  setInputUrl('');
                  setExtractError('');
                }}
                className="btn-clear"
                title="Clear input"
                aria-label="Clear input"
              >
                ✕
              </button>
            ) : (
              <button type="button" onClick={handlePasteUrl} className="btn-trimmer-paste">
                <Clipboard size={14} /> Paste
              </button>
            )}
          </div>
          <button
            type="submit"
            disabled={extracting || !inputUrl.trim()}
            className="btn-trimmer-load"
          >
            {extracting ? <Zap size={16} className="spin" /> : <Scissors size={16} />}
            <span>{extracting ? 'Extracting Clip...' : 'Load Video'}</span>
          </button>
        </form>

        {extractError && (
          <div className="trim-error-card" style={{ marginTop: '0.75rem' }}>
            <AlertCircle size={18} color="#ef4444" style={{ flexShrink: 0 }} />
            <span style={{ fontSize: '0.85rem' }}>{extractError}</span>
          </div>
        )}
      </div>

      {/* Empty State if no video is loaded yet */}
      {!videoInfo ? (
        <div className="trimmer-empty-state">
          <div className="trimmer-empty-icon-wrap">
            <Scissors size={38} color="#06b6d4" />
          </div>
          <h3 className="trimmer-empty-title">Paste a Video Link Above to Start Trimming</h3>
          <p className="trimmer-empty-desc">
            Instantly set custom start and end points with our visual timeline slider, preview playback in real-time, and download only the exact clip you need in Full HD or MP3.
          </p>
        </div>
      ) : (
        /* Main Trimming Workspace */
        <div className="trimmer-workspace">
          {/* Video Player Display Frame with Cyan Crop Border */}
          <div className="trimmer-player-wrapper">
            <div className="trimmer-player-frame">
              {ytVideoId ? (
                <div id="trimmer-yt-player" className="trimmer-yt-iframe"></div>
              ) : (previewVideoUrl && !streamError) ? (
                <>
                  {videoLoading && (
                    <div className="trimmer-video-loader">
                      <Zap size={22} className="spin" color="#06b6d4" />
                      <span>Loading Fast Preview Stream...</span>
                    </div>
                  )}
                  <video
                    ref={videoElementRef}
                    src={previewVideoUrl}
                    className="trimmer-html5-video"
                    playsInline
                    autoPlay
                    muted={isMuted}
                    preload="auto"
                    referrerPolicy="no-referrer"
                    onVolumeChange={() => {
                      if (videoElementRef.current) {
                        setIsMuted(videoElementRef.current.muted);
                      }
                    }}
                    onLoadedData={handleVideoCanPlay}
                    onCanPlay={handleVideoCanPlay}
                    onWaiting={() => setVideoLoading(true)}
                    onPlaying={() => {
                      setVideoLoading(false);
                      setIsPlaying(true);
                    }}
                    onError={() => {
                      setVideoLoading(false);
                      if (!useFallbackPreview && videoInfo?.previewStreamUrl?.includes('/api/proxy-stream')) {
                        console.warn('Proxy stream error, seamlessly falling back to /api/preview');
                        setUseFallbackPreview(true);
                      } else {
                        console.warn('Video preview failed, falling back to visual range card');
                        setStreamError(true);
                      }
                    }}
                    onTimeUpdate={() => {
                      if (videoElementRef.current) {
                        const t = videoElementRef.current.currentTime;
                        if (t < startTime || t >= endTime) {
                          videoElementRef.current.currentTime = startTime;
                          setCurrentTime(startTime);
                        } else {
                          setCurrentTime(t);
                        }
                      }
                    }}
                  />
                </>
              ) : (
                <div className="trimmer-static-thumb">
                  <img src={videoInfo?.thumbnail} alt={videoInfo?.title} />
                  <div className="trimmer-static-badge">Live Visual Range Preview</div>
                </div>
              )}
            </div>
          </div>

          {/* Playback Controls & Timestamp Header */}
          <div className="trimmer-playback-bar">
            <button
              type="button"
              onClick={togglePlay}
              className="btn-trim-play"
              title={isPlaying ? "Pause Preview" : "Play Preview"}
              aria-label={isPlaying ? "Pause" : "Play"}
            >
              {isPlaying ? <Pause size={20} fill="currentColor" /> : <Play size={20} fill="currentColor" style={{ marginLeft: '2px' }} />}
            </button>

            <div className="trimmer-time-display">
              <span className="current-t">{formatTime(currentTime, true)}</span>
              <span className="divider">|</span>
              <span className="total-t">{formatTime(duration, false)}</span>
            </div>

            <button
              type="button"
              onClick={toggleMute}
              className={`btn-trim-volume ${isMuted ? 'muted' : ''}`}
              title={isMuted ? "Unmute Audio" : "Mute Audio"}
              aria-label={isMuted ? "Unmute Audio" : "Mute Audio"}
            >
              {isMuted ? <VolumeX size={18} /> : <Volume2 size={18} />}
            </button>
          </div>

          {/* 🎬 Visual Timeline Filmstrip with Draggable Cyan Handles */}
          <div className="trimmer-timeline-section">
            <div className="trimmer-timeline-header">
              <span className="timeline-hint">
                <Sparkles size={14} color="#06b6d4" />
                Drag handles to adjust start and end cut points
              </span>
              <span className="timeline-selected-duration">
                Selected Clip: <strong>{selectedLength}s</strong>
              </span>
            </div>

            <div
              ref={timelineRef}
              className="trimmer-timeline-track"
              onClick={handleTimelineClick}
            >
              {/* Filmstrip Background tiles */}
              <div className="trimmer-filmstrip-bg">
                {Array.from({ length: 12 }).map((_, i) => (
                  <div
                    key={i}
                    className="filmstrip-tile"
                    style={{
                      backgroundImage: videoInfo?.thumbnail ? `url(${videoInfo.thumbnail})` : 'none',
                    }}
                  />
                ))}
              </div>

              {/* Draggable Cyan Crop Selection Box */}
              <div
                className="trimmer-crop-box"
                style={{
                  left: `${leftPercent}%`,
                  width: `${widthPercent}%`,
                }}
              >
                {/* Left Handle */}
                <div
                  className="trimmer-handle trimmer-handle-left"
                  onMouseDown={(e) => startDrag('left', e)}
                  onTouchStart={(e) => startDrag('left', e)}
                  title="Drag to adjust Start Time"
                >
                  <div className="handle-grip-bar"></div>
                </div>

                {/* Inside Duration Badge */}
                <div className="trimmer-box-label">
                  {selectedLength}s
                </div>

                {/* Playhead Needle Indicator strictly positioned between the inner boundaries of both handles */}
                <div
                  className="trimmer-playhead"
                  style={{ left: `calc(21px + (100% - 42px) * ${cropProgress})` }}
                >
                  <div className="playhead-top-notch"></div>
                  <div className="playhead-line"></div>
                </div>

                {/* Right Handle */}
                <div
                  className="trimmer-handle trimmer-handle-right"
                  onMouseDown={(e) => startDrag('right', e)}
                  onTouchStart={(e) => startDrag('right', e)}
                  title="Drag to adjust End Time"
                >
                  <div className="handle-grip-bar"></div>
                </div>
              </div>
            </div>
          </div>

          {/* 🎛️ Manual Controls: Full Video Top + Horizontal Row (Start Left, End Right) */}
          <div className="trimmer-manual-controls-panel">
            {/* 🔄 Top Full Video Button */}
            <div className="manual-reset-top-card">
              <button
                type="button"
                onClick={handleResetFullVideo}
                className="btn-full-video-bar"
                title="Reset selection to full video duration"
              >
                <RotateCcw size={16} />
                <span>Full Video</span>
              </button>
            </div>

            {/* ↔️ Horizontal Row: Start Card (Left) & End Card (Right) */}
            <div className="manual-cut-cards-row">
              {/* Start Time Card (Green Theme with Highlighted Word "Start") */}
              <div className="manual-cut-card start-card">
                <div className="manual-cut-header start-header">
                  <Clock size={14} color="#10b981" />
                  <span className="highlight-tag start">START</span>
                  <span className="label-sub">TIME</span>
                </div>
                <div className="manual-cut-display start-display">{formatTime(startTime, true)}</div>
                <div className="manual-cut-steppers">
                  <button
                    type="button"
                    onMouseDown={() => startHold(() => adjustStart(-0.1))}
                    onMouseUp={stopHold}
                    onMouseLeave={stopHold}
                    onTouchStart={(e) => {
                      e.preventDefault();
                      startHold(() => adjustStart(-0.1));
                    }}
                    onTouchEnd={stopHold}
                    onTouchCancel={stopHold}
                    onContextMenu={(e) => e.preventDefault()}
                    className="btn-manual-step btn-start-step"
                    title="Subtract 0.1 second (tap or hold)"
                  >
                    <Minus size={15} strokeWidth={2.8} />
                    <span>0.1s</span>
                  </button>
                  <button
                    type="button"
                    onMouseDown={() => startHold(() => adjustStart(+0.1))}
                    onMouseUp={stopHold}
                    onMouseLeave={stopHold}
                    onTouchStart={(e) => {
                      e.preventDefault();
                      startHold(() => adjustStart(+0.1));
                    }}
                    onTouchEnd={stopHold}
                    onTouchCancel={stopHold}
                    onContextMenu={(e) => e.preventDefault()}
                    className="btn-manual-step btn-start-step"
                    title="Add 0.1 second (tap or hold)"
                  >
                    <Plus size={15} strokeWidth={2.8} />
                    <span>0.1s</span>
                  </button>
                </div>
              </div>

              {/* End Time Card (Rose / Red Theme with Highlighted Word "End") */}
              <div className="manual-cut-card end-card">
                <div className="manual-cut-header end-header">
                  <Clock size={14} color="#f43f5e" />
                  <span className="highlight-tag end">END</span>
                  <span className="label-sub">TIME</span>
                </div>
                <div className="manual-cut-display end-display">{formatTime(endTime, true)}</div>
                <div className="manual-cut-steppers">
                  <button
                    type="button"
                    onMouseDown={() => startHold(() => adjustEnd(-0.1))}
                    onMouseUp={stopHold}
                    onMouseLeave={stopHold}
                    onTouchStart={(e) => {
                      e.preventDefault();
                      startHold(() => adjustEnd(-0.1));
                    }}
                    onTouchEnd={stopHold}
                    onTouchCancel={stopHold}
                    onContextMenu={(e) => e.preventDefault()}
                    className="btn-manual-step btn-end-step"
                    title="Subtract 0.1 second (tap or hold)"
                  >
                    <Minus size={15} strokeWidth={2.8} />
                    <span>0.1s</span>
                  </button>
                  <button
                    type="button"
                    onMouseDown={() => startHold(() => adjustEnd(+0.1))}
                    onMouseUp={stopHold}
                    onMouseLeave={stopHold}
                    onTouchStart={(e) => {
                      e.preventDefault();
                      startHold(() => adjustEnd(+0.1));
                    }}
                    onTouchEnd={stopHold}
                    onTouchCancel={stopHold}
                    onContextMenu={(e) => e.preventDefault()}
                    className="btn-manual-step btn-end-step"
                    title="Add 0.1 second (tap or hold)"
                  >
                    <Plus size={15} strokeWidth={2.8} />
                    <span>0.1s</span>
                  </button>
                </div>
              </div>
            </div>
          </div>

          {/* 📥 Split Dropdown Download Button Container + Right [Download MP3] Button */}
          <div className="trimmer-export-container">
            <div className="trimmer-split-download-group">
              {/* White Dropdown Split Button Container with Floating Dropdown */}
              <div className="split-btn-container trimmer-split-btn-wrap" ref={trimmerDropdownRef} style={{ position: 'relative', margin: 0, maxWidth: 'none', width: 'auto' }}>
                <div className="trimmer-split-btn full-video-split-btn">
                  {/* Left Side: Click to Download Selected Quality */}
                  <button
                    type="button"
                    onClick={() => handleDownloadTrim('video', selectedQuality)}
                    disabled={downloadingType !== null}
                    className="btn-split-action btn-full-split-action"
                    title={`Download trimmed MP4 (${getCleanQualityTag(selectedQuality)})`}
                  >
                    {downloadingType === 'video' ? (
                      <div className="btn-split-content">
                        <div className="btn-split-line1">
                          <Zap size={15} className="spin text-cyan" />
                          <span>MP4...</span>
                        </div>
                        <div className="btn-split-line2">{downloadProgress}%</div>
                      </div>
                    ) : (
                      <div className="btn-split-content">
                        <div className="btn-split-line1">
                          <Download size={20} className="split-action-dl-icon" strokeWidth={2.4} />
                          <span>MP4 · {getCleanQualityTag(selectedQuality)}</span>
                          <Film size={16} className="split-action-film-icon" />
                        </div>
                        <div className="btn-split-line2">
                          {getCleanClipSizeMb(selectedQuality)}
                        </div>
                      </div>
                    )}
                  </button>

                  {/* Right Side: Down Arrow Dropdown Trigger */}
                  <button
                    type="button"
                    onClick={() => setIsQualityDropdownOpen(prev => !prev)}
                    className="split-dropdown-trigger btn-split-arrow"
                    title="Select Video Quality"
                    aria-expanded={isQualityDropdownOpen}
                  >
                    <ChevronDown size={17} className={`split-chevron-icon ${isQualityDropdownOpen ? 'open' : ''}`} style={{ transform: isQualityDropdownOpen ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s ease' }} />
                  </button>
                </div>

                {/* 🌟 Custom Themed Floating Dropdown Menu (Matches Photo 1 & 3 Exactly) */}
                {isQualityDropdownOpen && (
                  <div className="custom-quality-menu" style={{ position: 'absolute', top: 'calc(100% + 6px)', left: 0, minWidth: '260px', zIndex: 100 }}>
                    <div className="custom-quality-menu-header">Available Resolutions</div>
                    {availableVideoOptions.map((opt) => {
                      const isSelected = selectedQuality === opt.id;
                      const optClipSize = getCleanClipSizeMb(opt.id);
                      const cleanBadge = getCleanQualityTag(opt);

                      return (
                        <button
                          key={opt.id}
                          type="button"
                          className={`custom-quality-option ${isSelected ? 'active' : ''}`}
                          onClick={() => {
                            setSelectedQuality(opt.id);
                            setIsQualityDropdownOpen(false);
                          }}
                        >
                          <div className="quality-opt-left">
                            <span className="quality-opt-badge">{cleanBadge}</span>
                            {isSelected && (
                              <span className="quality-opt-active-check">✓ Active</span>
                            )}
                          </div>
                          {optClipSize && (
                            <span className="quality-opt-size">{optClipSize}</span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* Right Side: Quick MP3 Button (Matches Main Downloader Style & CSS) */}
              <button
                type="button"
                onClick={() => handleDownloadTrim('audio', 'audio')}
                disabled={downloadingType !== null || isOverQuota('audio')}
                className="btn-quick-mp3-action trimmer-mp3-btn"
                title={`Download Trimmed MP3 (${getCleanClipSizeMb('audio')})`}
              >
                {downloadingType === 'audio' ? (
                  <div className="btn-mp3-content">
                    {downloadSuccess ? (
                      <div className="btn-mp3-top-row">
                        <CheckCircle size={15} style={{ color: '#10b981' }} />
                        <span className="mp3-title-bold" style={{ color: '#10b981' }}>Saved!</span>
                      </div>
                    ) : (
                      <>
                        <div className="btn-mp3-top-row">
                          <Zap size={14} className="spin text-violet" />
                          <span className="mp3-title-bold">MP3...</span>
                        </div>
                        <span className="mp3-sub-size">{downloadProgress}%</span>
                      </>
                    )}
                  </div>
                ) : (
                  <div className="btn-mp3-content">
                    <div className="btn-mp3-top-row">
                      <Download size={14} className="mp3-download-icon" />
                      <span className="mp3-title-bold">MP3</span>
                      <Headphones size={14} className="mp3-headset-icon" />
                    </div>
                    <span className="mp3-sub-size">{getCleanClipSizeMb('audio')}</span>
                  </div>
                )}
              </button>
            </div>

            {/* Quick Completion Alert */}
            {downloadSuccess && (
              <div className="trim-success-card" style={{ marginTop: '1rem' }}>
                <CheckCircle size={20} color="#10b981" style={{ flexShrink: 0 }} />
                <div>
                  <strong style={{ color: '#10b981', display: 'block', fontSize: '0.92rem' }}>Download Started!</strong>
                  <span style={{ fontSize: '0.84rem' }}>Your {selectedLength}s clip is now downloading through your browser.</span>
                </div>
              </div>
            )}

            {downloadError && (
              <div className="trim-error-card" style={{ marginTop: '1rem' }}>
                <AlertCircle size={20} color="#ef4444" style={{ flexShrink: 0 }} />
                <span style={{ fontSize: '0.85rem' }}>{downloadError}</span>
              </div>
            )}
          </div>

          {/* ⚖️ Auto-Attribution & Fair Use Credit (TASL) Component */}
          <TaslAttributionCard videoInfo={videoInfo} />
        </div>
      )}
    </div>
  );
}
