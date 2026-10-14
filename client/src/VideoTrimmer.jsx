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
  Volume2
} from 'lucide-react';

const BACKEND_URL = 'https://vidsave-downloader.onrender.com';

export default function VideoTrimmer({ videoInfo, onBack }) {
  const duration = Math.max(1, parseFloat(videoInfo?.duration) || 60);

  // Initial range: 0 to min(15, duration)
  const initialEnd = Math.min(15, duration);
  const [startTime, setStartTime] = useState(0);
  const [endTime, setEndTime] = useState(initialEnd);
  const [currentTime, setCurrentTime] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [downloading, setDownloading] = useState(null); // 'video' | 'audio' | null

  const timelineRef = useRef(null);
  const draggingHandle = useRef(null); // 'left' | 'right' | null
  const videoElementRef = useRef(null);
  const ytPlayerRef = useRef(null);
  const ytIntervalRef = useRef(null);

  // Extract YouTube ID if applicable
  const extractYouTubeId = (rawUrl) => {
    if (!rawUrl) return null;
    const match = rawUrl.match(/(?:youtu\.be\/|youtube\.com\/(?:embed\/|v\/|watch\?v=|watch\?.+&v=|shorts\/|live\/))([\w-]{11})/i);
    return match ? match[1] : null;
  };

  const ytVideoId = videoInfo?.videoId || extractYouTubeId(videoInfo?.webpageUrl);
  
  // Find direct stream URL if available from videoInfo.formats
  const directVideoUrl = videoInfo?.formats?.find(f => f.directUrl && f.hasVideo)?.directUrl || null;

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

  // Initialize YouTube Iframe Player API if applicable
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
    } else if (videoElementRef.current) {
      const vid = videoElementRef.current;
      if (vid.paused) {
        if (vid.currentTime < startTime || vid.currentTime >= endTime) {
          vid.currentTime = startTime;
        }
        vid.play();
        setIsPlaying(true);
      } else {
        vid.pause();
        setIsPlaying(false);
      }
    } else {
      // Simulated preview playback
      setIsPlaying(!isPlaying);
    }
  };

  // Simulated playback ticker for static preview
  useEffect(() => {
    if (!ytVideoId && !directVideoUrl && isPlaying) {
      const timer = setInterval(() => {
        setCurrentTime((prev) => {
          if (prev >= endTime) return startTime;
          return prev + 0.1;
        });
      }, 100);
      return () => clearInterval(timer);
    }
  }, [isPlaying, ytVideoId, directVideoUrl, startTime, endTime]);

  // Seek video to specific time
  const seekTo = useCallback((t) => {
    const clamped = Math.max(0, Math.min(duration, t));
    setCurrentTime(clamped);
    if (ytPlayerRef.current && typeof ytPlayerRef.current.seekTo === 'function') {
      ytPlayerRef.current.seekTo(clamped, true);
    } else if (videoElementRef.current) {
      videoElementRef.current.currentTime = clamped;
    }
  }, [duration]);

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

  // Quick preset lengths
  const applyPresetLength = (secs) => {
    const end = Math.min(duration, startTime + secs);
    setEndTime(end);
    seekTo(startTime);
  };

  // Trigger server-side stream cut download
  const handleDownloadTrim = (type = 'video') => {
    setDownloading(type);
    const cleanUrl = videoInfo?.webpageUrl;
    const cleanTitle = (videoInfo?.title || 'clip').replace(/[^\w\s-]/gi, '').trim();
    const trimApiUrl = `${BACKEND_URL}/api/trim?url=${encodeURIComponent(cleanUrl)}&start=${startTime}&end=${endTime}&type=${type}&title=${encodeURIComponent(cleanTitle)}`;

    // Create invisible anchor to trigger browser save dialog
    const link = document.createElement('a');
    link.href = trimApiUrl;
    link.target = '_blank';
    link.rel = 'noopener,noreferrer';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);

    setTimeout(() => {
      setDownloading(null);
    }, 4000);
  };

  const selectedLength = (endTime - startTime).toFixed(1);
  const leftPercent = (startTime / duration) * 100;
  const rightPercent = (endTime / duration) * 100;
  const widthPercent = rightPercent - leftPercent;
  const playheadPercent = Math.min(100, Math.max(0, (currentTime / duration) * 100));

  return (
    <div className="trimmer-view-container">
      {/* Top Bar (CapCut Style) */}
      <div className="trimmer-top-nav">
        <button type="button" onClick={onBack} className="btn-trim-back">
          <ArrowLeft size={18} />
          <span>Back to Downloader</span>
        </button>
        <div className="trimmer-media-title" title={videoInfo?.title}>
          <Scissors size={15} color="#f59e0b" style={{ flexShrink: 0 }} />
          <span>{videoInfo?.title || 'Visual Video Trimmer'}</span>
        </div>
        <button
          type="button"
          onClick={() => handleDownloadTrim('video')}
          disabled={downloading !== null}
          className="btn-trim-save-top"
        >
          {downloading === 'video' ? <Zap size={15} className="spin" /> : <Download size={15} />}
          <span>{downloading === 'video' ? 'Saving...' : 'Save Clip'}</span>
        </button>
      </div>

      {/* Main Trimming Workspace */}
      <div className="trimmer-workspace">
        {/* Video Player Display Frame with Yellow Crop Border */}
        <div className="trimmer-player-wrapper">
          <div className="trimmer-player-frame">
            {ytVideoId ? (
              <div id="trimmer-yt-player" className="trimmer-yt-iframe"></div>
            ) : directVideoUrl ? (
              <video
                ref={videoElementRef}
                src={directVideoUrl}
                className="trimmer-html5-video"
                playsInline
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
            onClick={() => {
              setStartTime(0);
              setEndTime(initialEnd);
              seekTo(0);
            }}
            className="btn-trim-reset"
            title="Reset to initial cut range"
          >
            <RotateCcw size={16} />
            <span>Reset</span>
          </button>
        </div>

        {/* 🎬 CapCut-Style Horizontal Timeline Filmstrip with Draggable Yellow Handles */}
        <div className="trimmer-timeline-section">
          <div className="trimmer-timeline-header">
            <span className="timeline-hint">
              <Sparkles size={14} color="#f59e0b" />
              Drag the yellow handles to select video section
            </span>
            <span className="timeline-selected-duration">
              Clip Duration: <strong>{selectedLength}s</strong>
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

        {/* Precision Numeric Inputs & Fine Tune Adjustments */}
        <div className="trimmer-precision-panel">
          {/* Start Time Box */}
          <div className="precision-group">
            <label className="precision-label">
              <Clock size={13} />
              <span>Start Cut Time</span>
            </label>
            <div className="precision-control-row">
              <button type="button" onClick={() => adjustStart(-1)} className="btn-tune" title="-1s">-1s</button>
              <button type="button" onClick={() => adjustStart(-0.1)} className="btn-tune" title="-0.1s">-0.1s</button>
              <div className="precision-time-val">{formatTime(startTime, true)}</div>
              <button type="button" onClick={() => adjustStart(+0.1)} className="btn-tune" title="+0.1s">+0.1s</button>
              <button type="button" onClick={() => adjustStart(+1)} className="btn-tune" title="+1s">+1s</button>
            </div>
          </div>

          {/* Quick Presets */}
          <div className="trimmer-presets-group">
            <span className="preset-label">Quick Clips:</span>
            <button type="button" onClick={() => applyPresetLength(15)} className="btn-preset-chip">
              ⚡ 15s Shorts
            </button>
            <button type="button" onClick={() => applyPresetLength(30)} className="btn-preset-chip">
              🔥 30s Status
            </button>
            <button type="button" onClick={() => applyPresetLength(60)} className="btn-preset-chip">
              ✨ 60s Reel
            </button>
          </div>

          {/* End Time Box */}
          <div className="precision-group">
            <label className="precision-label">
              <Clock size={13} />
              <span>End Cut Time</span>
            </label>
            <div className="precision-control-row">
              <button type="button" onClick={() => adjustEnd(-1)} className="btn-tune" title="-1s">-1s</button>
              <button type="button" onClick={() => adjustEnd(-0.1)} className="btn-tune" title="-0.1s">-0.1s</button>
              <div className="precision-time-val">{formatTime(endTime, true)}</div>
              <button type="button" onClick={() => adjustEnd(+0.1)} className="btn-tune" title="+0.1s">+0.1s</button>
              <button type="button" onClick={() => adjustEnd(+1)} className="btn-tune" title="+1s">+1s</button>
            </div>
          </div>
        </div>

        {/* Download Action Area */}
        <div className="trimmer-download-actions">
          <button
            type="button"
            onClick={() => handleDownloadTrim('video')}
            disabled={downloading !== null}
            className="btn-trim-download-primary"
          >
            {downloading === 'video' ? (
              <>
                <Zap size={20} className="spin" />
                <span>Trimming & Multiplexing MP4...</span>
              </>
            ) : (
              <>
                <Film size={20} />
                <span>Download Trimmed Video (MP4)</span>
                <span className="btn-sub-text">Full HD Clip • {selectedLength}s</span>
              </>
            )}
          </button>

          <button
            type="button"
            onClick={() => handleDownloadTrim('audio')}
            disabled={downloading !== null}
            className="btn-trim-download-secondary"
          >
            {downloading === 'audio' ? (
              <>
                <Zap size={20} className="spin" />
                <span>Extracting MP3 Audio Clip...</span>
              </>
            ) : (
              <>
                <Music size={20} />
                <span>Download Trimmed Audio (MP3)</span>
                <span className="btn-sub-text">Crystal Clear 320kbps • {selectedLength}s</span>
              </>
            )}
          </button>
        </div>

        {/* Trimmer Info Footer Note */}
        <div className="trimmer-info-note">
          <Sparkles size={14} color="#06b6d4" />
          <span>
            <strong>Zero Server Storage & High Speed:</strong> The selected section is directly extracted with FFmpeg stream cutting so you don't waste bandwidth downloading the entire long video!
          </span>
        </div>
      </div>
    </div>
  );
}
