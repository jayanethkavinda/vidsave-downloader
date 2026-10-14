import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  ArrowLeft,
  Play,
  Pause,
  RotateCcw,
  Download,
  Scissors,
  Music,
  Film,
  Zap,
  Clock,
  Sparkles,
  Maximize2,
  CheckCircle,
  AlertCircle,
  Link as LinkIcon,
  Clipboard,
  ChevronDown,
  Layers
} from 'lucide-react';
import TaslAttributionCard from './TaslAttributionCard.jsx';

const BACKEND_URL = 'https://vidsave-downloader.onrender.com';

export default function VideoTrimmer({ videoInfo: initialVideoInfo, onBack, onVideoExtracted }) {
  const [videoInfo, setVideoInfo] = useState(initialVideoInfo || null);
  const [inputUrl, setInputUrl] = useState(initialVideoInfo?.webpageUrl || '');
  const [extracting, setExtracting] = useState(false);
  const [extractError, setExtractError] = useState('');

  const duration = Math.max(1, parseFloat(videoInfo?.duration) || 60);

  // Initial cut range: 0 to min(15, duration)
  const initialEnd = Math.min(15, duration);
  const [startTime, setStartTime] = useState(0);
  const [endTime, setEndTime] = useState(initialEnd);
  const [currentTime, setCurrentTime] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);

  // Download state with in-button percentage animation
  const [downloadingType, setDownloadingType] = useState(null); // 'video' | 'audio' | null
  const [downloadProgress, setDownloadProgress] = useState(0);
  const [downloadSuccess, setDownloadSuccess] = useState(false);
  const [downloadError, setDownloadError] = useState('');
  const [selectedQuality, setSelectedQuality] = useState('best'); // 'best' | '1080' | '720' | '480' | 'audio'

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
      setEndTime(Math.min(15, d));
      setCurrentTime(0);
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

  // High-speed lightweight 220p / 240p preview stream with Range support
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

  // Handle URL extraction from inside Trimmer view
  const handleExtractInsideTrimmer = async (e) => {
    if (e) e.preventDefault();
    const cleanUrl = inputUrl.trim();
    if (!cleanUrl) return;

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
      setEndTime(Math.min(15, newDuration));
      setCurrentTime(0);
      setIsPlaying(false);
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

  const handlePasteUrl = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) {
        setInputUrl(text);
      }
    } catch (e) {
      console.warn('Clipboard read error:', e);
    }
  };

  // Initialize YouTube Iframe Player API
  useEffect(() => {
    if (!ytVideoId) return;

    const initYT = () => {
      if (window.YT && window.YT.Player) {
        try {
          ytPlayerRef.current = new window.YT.Player('trimmer-yt-player', {
            videoId: ytVideoId,
            playerVars: {
              autoplay: 0,
              controls: 0,
              rel: 0,
              modestbranding: 1,
              disablekb: 1,
              fs: 0,
              playsinline: 1,
            },
            events: {
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
          setCurrentTime(t);
          if (t >= endTime) {
            ytPlayerRef.current.seekTo(startTime, true);
          }
        }
      }, 100);
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

  // Seek video to specific time
  const seekTo = useCallback((t) => {
    const clamped = Math.max(0, Math.min(duration, t));
    setCurrentTime(clamped);
    if (ytPlayerRef.current && typeof ytPlayerRef.current.seekTo === 'function') {
      ytPlayerRef.current.seekTo(clamped, true);
    } else if (videoElementRef.current && !streamError) {
      videoElementRef.current.currentTime = clamped;
    }
  }, [duration, streamError]);

  // Handle timeline dragging (mouse & touch)
  const handleTimelineMove = useCallback((clientX) => {
    if (!draggingHandle.current || !timelineRef.current) return;
    const rect = timelineRef.current.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    const targetSeconds = parseFloat((ratio * duration).toFixed(1));

    if (draggingHandle.current === 'left') {
      const newStart = Math.min(targetSeconds, endTime - 0.5);
      setStartTime(newStart);
      seekTo(newStart);
    } else if (draggingHandle.current === 'right') {
      const newEnd = Math.max(targetSeconds, startTime + 0.5);
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
    seekTo(clickedSec);
  };

  // Fine tune adjustments
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

      // Trigger Native Browser Download immediately
      const link = document.createElement('a');
      link.href = trimApiUrl;
      link.setAttribute('download', filename);
      link.style.display = 'none';
      document.body.appendChild(link);
      link.click();

      setTimeout(() => {
        try {
          document.body.removeChild(link);
        } catch (_) {}
      }, 2000);

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

  const selectedLength = (endTime - startTime).toFixed(1);
  const leftPercent = (startTime / duration) * 100;
  const rightPercent = (endTime / duration) * 100;
  const widthPercent = rightPercent - leftPercent;
  const playheadPercent = Math.min(100, Math.max(0, (currentTime / duration) * 100));

  return (
    <div className="trimmer-view-container">
      {/* 🔝 Sticky Top Nav inside Trimmer */}
      <div className="trimmer-top-nav">
        <button type="button" onClick={onBack} className="btn-trim-back">
          <ArrowLeft size={18} />
          <span>Full Downloader</span>
        </button>
        <div className="trimmer-media-title" title={videoInfo?.title}>
          <Scissors size={15} color="#f59e0b" style={{ flexShrink: 0 }} />
          <span>{videoInfo?.title ? videoInfo.title : 'Clip & Trim Video'}</span>
        </div>
        <button
          type="button"
          onClick={() => handleDownloadTrim('video', selectedQuality)}
          disabled={downloadingType !== null || !videoInfo}
          className="btn-trim-save-top"
        >
          {downloadingType === 'video' ? <Zap size={15} className="spin" /> : <Download size={15} />}
          <span>{downloadingType === 'video' ? `${downloadProgress}%` : 'Save Clip'}</span>
        </button>
      </div>

      {/* 🔗 Dedicated URL Input Bar at the Top of Trimmer */}
      <div className="trimmer-url-bar-card">
        <form onSubmit={handleExtractInsideTrimmer} className="trimmer-url-form">
          <div className="trimmer-input-wrapper">
            <LinkIcon size={18} className="trimmer-input-icon" />
            <input
              type="text"
              placeholder="Paste any video link to clip & trim (YouTube, TikTok, Instagram, FB, X)..."
              value={inputUrl}
              onChange={(e) => setInputUrl(e.target.value)}
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
            <Scissors size={38} color="#f59e0b" />
          </div>
          <h3 className="trimmer-empty-title">Paste a Video Link Above to Start Trimming</h3>
          <p className="trimmer-empty-desc">
            Instantly set custom start and end points with our visual timeline slider, preview playback in real-time, and download only the exact clip you need in Full HD or MP3.
          </p>
        </div>
      ) : (
        /* Main Trimming Workspace */
        <div className="trimmer-workspace">
          {/* Video Player Display Frame with Yellow Crop Border */}
          <div className="trimmer-player-wrapper">
            <div className="trimmer-player-frame">
              {ytVideoId ? (
                <div id="trimmer-yt-player" className="trimmer-yt-iframe"></div>
              ) : (previewVideoUrl && !streamError) ? (
                <>
                  {videoLoading && (
                    <div className="trimmer-video-loader">
                      <Zap size={22} className="spin" color="#f59e0b" />
                      <span>Loading Fast Preview Stream...</span>
                    </div>
                  )}
                  <video
                    ref={videoElementRef}
                    src={previewVideoUrl}
                    className="trimmer-html5-video"
                    playsInline
                    preload="metadata"
                    referrerPolicy="no-referrer"
                    onLoadedData={() => setVideoLoading(false)}
                    onCanPlay={() => setVideoLoading(false)}
                    onWaiting={() => setVideoLoading(true)}
                    onPlaying={() => setVideoLoading(false)}
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
                        setCurrentTime(t);
                        if (t >= endTime) {
                          videoElementRef.current.currentTime = startTime;
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

          {/* 🎬 Visual Timeline Filmstrip with Draggable Yellow Handles */}
          <div className="trimmer-timeline-section">
            <div className="trimmer-timeline-header">
              <span className="timeline-hint">
                <Sparkles size={14} color="#f59e0b" />
                Drag yellow handles to adjust start and end cut points
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

              {/* Draggable Yellow Crop Selection Box */}
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

              {/* Playhead Needle Indicator */}
              <div
                className="trimmer-playhead"
                style={{ left: `${playheadPercent}%` }}
              >
                <div className="playhead-top-notch"></div>
                <div className="playhead-line"></div>
              </div>
            </div>
          </div>

          {/* 🎛️ Manual Cut Controls & Reset to Full Video (Replaced Quick Clicks) */}
          <div className="trimmer-manual-controls-panel">
            {/* Start Cut Time Card */}
            <div className="manual-cut-card">
              <div className="manual-cut-header">
                <Clock size={14} color="#f59e0b" />
                <span>Start Cut Time</span>
              </div>
              <div className="manual-cut-display">{formatTime(startTime, true)}</div>
              <div className="manual-cut-steppers">
                <button type="button" onClick={() => adjustStart(-1)} className="btn-manual-step" title="Subtract 1 second">-1s</button>
                <button type="button" onClick={() => adjustStart(-0.1)} className="btn-manual-step" title="Subtract 0.1 second">-0.1s</button>
                <button type="button" onClick={() => adjustStart(+0.1)} className="btn-manual-step" title="Add 0.1 second">+0.1s</button>
                <button type="button" onClick={() => adjustStart(+1)} className="btn-manual-step" title="Add 1 second">+1s</button>
              </div>
            </div>

            {/* 🔄 Reset to Full Video Duration (Hero Button) */}
            <div className="manual-reset-center-card">
              <button
                type="button"
                onClick={handleResetFullVideo}
                className="btn-reset-full-video"
                title="Select complete video duration without cutting"
              >
                <Maximize2 size={18} />
                <div className="reset-full-text">
                  <strong>Select Entire Video</strong>
                  <span>Reset to Full Length (00:00 → {formatTime(duration, false)})</span>
                </div>
              </button>
            </div>

            {/* End Cut Time Card */}
            <div className="manual-cut-card">
              <div className="manual-cut-header">
                <Clock size={14} color="#f59e0b" />
                <span>End Cut Time</span>
              </div>
              <div className="manual-cut-display">{formatTime(endTime, true)}</div>
              <div className="manual-cut-steppers">
                <button type="button" onClick={() => adjustEnd(-1)} className="btn-manual-step" title="Subtract 1 second">-1s</button>
                <button type="button" onClick={() => adjustEnd(-0.1)} className="btn-manual-step" title="Subtract 0.1 second">-0.1s</button>
                <button type="button" onClick={() => adjustEnd(+0.1)} className="btn-manual-step" title="Add 0.1 second">+0.1s</button>
                <button type="button" onClick={() => adjustEnd(+1)} className="btn-manual-step" title="Add 1 second">+1s</button>
              </div>
            </div>
          </div>

          {/* 📥 Download Action Area with Quality Selector Dropdown */}
          <div className="trimmer-export-container">
            <div className="trimmer-export-bar">
              {/* Quality Dropdown Selector */}
              <div className="trimmer-quality-select-wrap">
                <label className="trimmer-quality-label" htmlFor="trim-quality-select">
                  <Layers size={14} /> Quality:
                </label>
                <div className="trimmer-select-wrapper">
                  <select
                    id="trim-quality-select"
                    value={selectedQuality}
                    onChange={(e) => setSelectedQuality(e.target.value)}
                    className="trimmer-quality-select"
                  >
                    <option value="best">Original Upload Quality (Max HD)</option>
                    <option value="1080">1080p Full HD</option>
                    <option value="720">720p HD</option>
                    <option value="480">480p SD</option>
                    <option value="audio">MP3 Audio Only (320kbps)</option>
                  </select>
                  <ChevronDown size={14} className="select-chevron" />
                </div>
              </div>

              {/* Main Download Button with In-Button Loading Percentage */}
              <button
                type="button"
                onClick={() => handleDownloadTrim('video', selectedQuality)}
                disabled={downloadingType !== null}
                className="btn-trim-download-primary"
              >
                {downloadingType === 'video' ? (
                  <>
                    <Zap size={20} className="spin text-cyan" />
                    <span>Preparing Download... {downloadProgress}%</span>
                  </>
                ) : (
                  <>
                    <Film size={20} />
                    <span>Download Trimmed Video (MP4)</span>
                    <span className="btn-sub-text">
                      {selectedQuality === 'best' ? 'Original Quality' : `${selectedQuality}p`} • {selectedLength}s
                    </span>
                  </>
                )}
              </button>

              {/* Secondary MP3 Audio Button */}
              <button
                type="button"
                onClick={() => handleDownloadTrim('audio', 'audio')}
                disabled={downloadingType !== null}
                className="btn-trim-download-secondary"
              >
                {downloadingType === 'audio' ? (
                  <>
                    <Zap size={20} className="spin text-cyan" />
                    <span>Extracting Audio... {downloadProgress}%</span>
                  </>
                ) : (
                  <>
                    <Music size={20} />
                    <span>Download Audio (MP3)</span>
                    <span className="btn-sub-text">Crystal Clear 320kbps • {selectedLength}s</span>
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
                  <span style={{ fontSize: '0.84rem' }}>Your {selectedLength}s clip is now saving to your device through your browser.</span>
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

          {/* Trimmer Info Footer Note */}
          <div className="trimmer-info-note">
            <Sparkles size={14} color="#06b6d4" />
            <span>
              <strong>Zero Server Storage & High Speed:</strong> Cut sections are directly streamed to your browser via native stream cutting, so you get exact clips with zero storage wait!
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
