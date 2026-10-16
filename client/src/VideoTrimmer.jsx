import React, { useState, useEffect, useRef, useCallback } from 'react';
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
  Minus
} from 'lucide-react';
import TaslAttributionCard from './TaslAttributionCard.jsx';

const BACKEND_URL = 'https://vidsave-downloader.onrender.com';

export default function VideoTrimmer({ videoInfo: initialVideoInfo, onBack, onVideoExtracted }) {
  const [videoInfo, setVideoInfo] = useState(initialVideoInfo || null);
  const [inputUrl, setInputUrl] = useState(initialVideoInfo?.webpageUrl || '');
  const [extracting, setExtracting] = useState(false);
  const [extractError, setExtractError] = useState('');

  const duration = Math.max(1, parseFloat(videoInfo?.duration) || 60);

  // Initial cut range: 0 to min(10, duration)
  const initialEnd = Math.min(10, duration);
  const [startTime, setStartTime] = useState(0);
  const [endTime, setEndTime] = useState(initialEnd);
  const [currentTime, setCurrentTime] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);

  // Download state with in-button percentage animation
  const [downloadingType, setDownloadingType] = useState(null); // 'video' | 'audio' | null
  const [downloadProgress, setDownloadProgress] = useState(0);
  const [downloadSuccess, setDownloadSuccess] = useState(false);
  const [downloadError, setDownloadError] = useState('');

  // Default quality: 720p (as requested)
  const [selectedQuality, setSelectedQuality] = useState('720'); // 'best' | '1080' | '720' | '480'

  const timelineRef = useRef(null);
  const draggingHandle = useRef(null); // 'left' | 'right' | null
  const videoElementRef = useRef(null);
  const ytPlayerRef = useRef(null);
  const ytIntervalRef = useRef(null);
  const progressTimerRef = useRef(null);

  // Sync state if initialVideoInfo changes from outside
  useEffect(() => {
    if (initialVideoInfo) {
      setVideoInfo(initialVideoInfo);
      setInputUrl(initialVideoInfo.webpageUrl || '');
      const d = Math.max(1, parseFloat(initialVideoInfo.duration) || 60);
      setStartTime(0);
      setEndTime(Math.min(10, d));
      setCurrentTime(0);
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

  // Dynamic File Size calculation: Prioritize real video filesize probed by sizeCalculator
  const getEstimatedClipSize = (format) => {
    const totalDur = Math.max(1, duration || videoInfo?.duration || 60);
    const ratio = Math.min(1, clipDuration / totalDur);

    // 1. Try matching with real probed preset size from backend sizeCalculator
    const matchedPreset = videoInfo?.presets?.find(p => 
      p.resolution === format || 
      (format === 'best' && p === videoInfo?.bestPreset) ||
      p.label?.toLowerCase().includes(format)
    );

    if (matchedPreset?.filesizeBytes && matchedPreset.filesizeBytes > 0) {
      const bytes = Math.round(matchedPreset.filesizeBytes * ratio);
      if (bytes < 1024 * 1024) {
        return `~${Math.round(bytes / 1024)} KB`;
      }
      return `~${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    }

    // 2. Fallback to calibrated bitrate calculation
    const bitrates = {
      '1080': 2000,
      '720': 1200,
      '480': 700,
      '360': 400,
      'best': 2000,
      'audio': 192,
      'mp3': 192
    };
    const kbps = bitrates[format] || 1500;
    const bytes = Math.round((kbps * 1000 * clipDuration) / 8);
    if (bytes < 1024 * 1024) {
      return `~${Math.round(bytes / 1024)} KB`;
    }
    return `~${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

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

  // Handle timeline dragging (mouse & touch)
  const handleTimelineMove = useCallback((clientX) => {
    if (!draggingHandle.current || !timelineRef.current) return;
    const rect = timelineRef.current.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    const targetSeconds = parseFloat((ratio * duration).toFixed(1));

    if (draggingHandle.current === 'left') {
      const newStart = Math.max(0, Math.min(targetSeconds, endTime - 0.5));
      setStartTime(newStart);
      seekTo(newStart);
    } else if (draggingHandle.current === 'right') {
      const newEnd = Math.min(duration, Math.max(targetSeconds, startTime + 0.5));
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

  // Fine tune adjustments by 0.1s only
  const adjustStart = (delta) => {
    setStartTime((prev) => {
      const next = Math.max(0, Math.min(endTime - 0.5, parseFloat((prev + delta).toFixed(1))));
      seekTo(next);
      return next;
    });
  };

  const adjustEnd = (delta) => {
    setEndTime((prev) => {
      const next = Math.max(startTime + 0.5, Math.min(duration, parseFloat((prev + delta).toFixed(1))));
      seekTo(next);
      return next;
    });
  };

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
        <div className="trimmer-media-title" title={videoInfo?.title}>
          <Scissors size={15} color="#06b6d4" style={{ flexShrink: 0 }} />
          <span>{videoInfo?.title ? videoInfo.title : 'Clip & Trim Video'}</span>
        </div>
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
            {!inputUrl.trim() && (
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
                    preload="auto"
                    referrerPolicy="no-referrer"
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
            <button type="button" onClick={togglePlay} className="btn-trim-play">
              {isPlaying ? <Pause size={22} fill="currentColor" /> : <Play size={22} fill="currentColor" style={{ marginLeft: '2px' }} />}
            </button>

            <div className="trimmer-time-display">
              <span className="current-t">{formatTime(currentTime, true)}</span>
              <span className="divider">|</span>
              <span className="total-t">{formatTime(duration, false)}</span>
            </div>

            <button
              type="button"
              onClick={handleResetFullVideo}
              className="btn-trim-reset"
              title="Reset to full video length"
            >
              <RotateCcw size={15} />
              <span>Full Video</span>
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

          {/* 🎛️ Manual Controls: START TIME & END TIME (0.1s Only) + Center "Full Video" Button */}
          <div className="trimmer-manual-controls-panel">
            {/* Start Time Card (Green Theme with Highlighted Word "Start") */}
            <div className="manual-cut-card start-card">
              <div className="manual-cut-header start-header">
                <Clock size={15} color="#10b981" />
                <span className="highlight-tag start">START</span>
                <span className="label-sub">TIME</span>
              </div>
              <div className="manual-cut-display start-display">{formatTime(startTime, true)}</div>
              <div className="manual-cut-steppers">
                <button
                  type="button"
                  onClick={() => adjustStart(-0.1)}
                  className="btn-manual-step btn-start-step"
                  title="Subtract 0.1 second"
                >
                  <Minus size={18} strokeWidth={2.6} />
                  <span>0.1s</span>
                </button>
                <button
                  type="button"
                  onClick={() => adjustStart(+0.1)}
                  className="btn-manual-step btn-start-step"
                  title="Add 0.1 second"
                >
                  <Plus size={18} strokeWidth={2.6} />
                  <span>0.1s</span>
                </button>
              </div>
            </div>

            {/* 🔄 Center "Full Video" Button (From Photo 3 - Replaces "Select Entire Video") */}
            <div className="manual-reset-center-card">
              <button
                type="button"
                onClick={handleResetFullVideo}
                className="btn-full-video-center"
                title="Reset selection to full video duration"
              >
                <RotateCcw size={18} />
                <span>Full Video</span>
              </button>
            </div>

            {/* End Time Card (Rose/Red-Orange Theme with Highlighted Word "End") */}
            <div className="manual-cut-card end-card">
              <div className="manual-cut-header end-header">
                <Clock size={15} color="#f43f5e" />
                <span className="highlight-tag end">END</span>
                <span className="label-sub">TIME</span>
              </div>
              <div className="manual-cut-display end-display">{formatTime(endTime, true)}</div>
              <div className="manual-cut-steppers">
                <button
                  type="button"
                  onClick={() => adjustEnd(-0.1)}
                  className="btn-manual-step btn-end-step"
                  title="Subtract 0.1 second"
                >
                  <Minus size={18} strokeWidth={2.6} />
                  <span>0.1s</span>
                </button>
                <button
                  type="button"
                  onClick={() => adjustEnd(+0.1)}
                  className="btn-manual-step btn-end-step"
                  title="Add 0.1 second"
                >
                  <Plus size={18} strokeWidth={2.6} />
                  <span>0.1s</span>
                </button>
              </div>
            </div>
          </div>

          {/* 📥 Split Dropdown Download Button (White Box) + Right [Download MP3] Button */}
          <div className="trimmer-export-container">
            <div className="trimmer-split-download-group">
              {/* White Dropdown Split Button */}
              <div className="trimmer-split-btn">
                {/* Left Side: Click to Download Selected Quality */}
                <button
                  type="button"
                  onClick={() => handleDownloadTrim('video', selectedQuality)}
                  disabled={downloadingType !== null}
                  className="btn-split-action"
                  title={`Download trimmed clip in ${selectedQuality === 'best' ? (videoInfo?.maxQualityLabel || 'Original Quality') : selectedQuality + 'p'}`}
                >
                  {downloadingType === 'video' ? (
                    <>
                      <Zap size={18} className="spin text-cyan" />
                      <span>Downloading... {downloadProgress}%</span>
                    </>
                  ) : (
                    <>
                      <Film size={18} className="split-action-icon" />
                      <span className="split-action-text">
                        {selectedQuality === 'best'
                          ? `Download Clip (${getEstimatedClipSize('best')})`
                          : selectedQuality === '1080'
                          ? `1080p Full HD (${getEstimatedClipSize('1080')})`
                          : selectedQuality === '720'
                          ? `720p HD (${getEstimatedClipSize('720')})`
                          : `${selectedQuality}p SD (${getEstimatedClipSize(selectedQuality)})`}
                      </span>
                    </>
                  )}
                </button>

                {/* Right Side: Down Arrow Dropdown Trigger */}
                <div className="split-dropdown-trigger" title="Select Video Quality">
                  <select
                    value={selectedQuality}
                    onChange={(e) => setSelectedQuality(e.target.value)}
                    className="split-select-native"
                    aria-label="Select Video Quality"
                  >
                    <option value="best">Original Upload Quality ({getEstimatedClipSize('best')})</option>
                    <option value="1080" disabled={isOverQuota('1080')}>
                      1080p Full HD ({getEstimatedClipSize('1080')}) {isOverQuota('1080') ? '— Exceeds Limit' : ''}
                    </option>
                    <option value="720" disabled={isOverQuota('720')}>
                      720p HD ({getEstimatedClipSize('720')}) {isOverQuota('720') ? '— Exceeds Limit' : ''}
                    </option>
                    <option value="480" disabled={isOverQuota('480')}>
                      480p SD ({getEstimatedClipSize('480')})
                    </option>
                  </select>
                  <ChevronDown size={16} className="split-chevron-icon" />
                </div>
              </div>

              {/* Right Side: Download MP3 Button (Clean, only this name!) */}
              <button
                type="button"
                onClick={() => handleDownloadTrim('audio', 'audio')}
                disabled={downloadingType !== null || isOverQuota('audio')}
                className="btn-download-mp3-pure"
                title="Download MP3"
              >
                {downloadingType === 'audio' ? (
                  <>
                    <Zap size={18} className="spin text-cyan" />
                    <span>Extracting... {downloadProgress}%</span>
                  </>
                ) : (
                  <>
                    <Music size={18} />
                    <span>Download MP3 ({getEstimatedClipSize('audio')})</span>
                  </>
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
