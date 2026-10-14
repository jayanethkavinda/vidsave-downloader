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
  Volume2,
  CheckCircle,
  AlertCircle
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
  const [downloadElapsed, setDownloadElapsed] = useState(0);
  const [downloadStep, setDownloadStep] = useState(1);
  const [downloadSuccess, setDownloadSuccess] = useState(false);
  const [downloadError, setDownloadError] = useState('');

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
  
  // High-speed lightweight 360p/480p preview for in-browser video playback (TikTok, Instagram, Facebook, etc.)
  const previewVideoUrl = !ytVideoId && videoInfo?.webpageUrl
    ? (videoInfo?.previewStreamUrl 
        ? `${BACKEND_URL}${videoInfo.previewStreamUrl}` 
        : `${BACKEND_URL}/api/preview?url=${encodeURIComponent(videoInfo.webpageUrl)}`)
    : null;
  const [streamError, setStreamError] = useState(false);

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
      // Simulated preview playback
      setIsPlaying(!isPlaying);
    }
  };

  // Simulated playback ticker for static preview
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

  // Quick preset lengths
  const applyPresetLength = (secs) => {
    const end = Math.min(duration, startTime + secs);
    setEndTime(end);
    seekTo(startTime);
  };

  // Trigger server-side stream cut download
  const handleDownloadTrim = async (type = 'video') => {
    if (downloading) return; // Prevent duplicate requests
    setDownloading(type);
    setDownloadSuccess(false);
    setDownloadError('');
    setDownloadElapsed(0);
    setDownloadStep(1);

    const timer = setInterval(() => {
      setDownloadElapsed((prev) => prev + 1);
    }, 1000);

    const step2Timer = setTimeout(() => {
      setDownloadStep(2);
    }, 2500);

    try {
      const cleanUrl = videoInfo?.webpageUrl;
      const cleanTitle = (videoInfo?.title || 'clip').replace(/[^\w\s-]/gi, '').trim() || 'clip';
      const trimApiUrl = `${BACKEND_URL}/api/trim?url=${encodeURIComponent(cleanUrl)}&start=${startTime}&end=${endTime}&type=${type}&title=${encodeURIComponent(cleanTitle)}`;

      const res = await fetch(trimApiUrl);
      if (!res.ok) {
        let errMessage = 'Server failed to process trim section';
        try {
          const errData = await res.json();
          if (errData.error) errMessage = errData.error;
        } catch (_) {}
        throw new Error(errMessage);
      }

      setDownloadStep(3);
      const blob = await res.blob();
      const ext = (type === 'audio' || type === 'mp3') ? 'mp3' : 'mp4';
      const filename = `${cleanTitle}_cut_${Math.round(startTime)}s-${Math.round(endTime)}s.${ext}`;

      // Instant download trigger via ObjectURL
      const blobUrl = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = blobUrl;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      window.URL.revokeObjectURL(blobUrl);

      setDownloadSuccess(true);
      setTimeout(() => {
        setDownloadSuccess(false);
      }, 6000);
    } catch (err) {
      console.error('Trim download error:', err);
      setDownloadError(err.message || 'Download failed. Please check network and try again.');
    } finally {
      clearInterval(timer);
      clearTimeout(step2Timer);
      setDownloading(null);
      setDownloadStep(0);
    }
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
            ) : (previewVideoUrl && !streamError) ? (
              <video
                ref={videoElementRef}
                src={previewVideoUrl}
                className="trimmer-html5-video"
                playsInline
                preload="metadata"
                referrerPolicy="no-referrer"
                onError={() => {
                  console.warn('Proxy video stream failed, falling back to simulated preview');
                  setStreamError(true);
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

        {/* ⏳ Live Processing Progress Card (Active while downloading) */}
        {downloading !== null && (
          <div className="trim-progress-card">
            <div className="trim-progress-header">
              <div className="trim-pulse-icon-box">
                <Zap size={22} className="spin text-cyan" />
              </div>
              <div className="trim-progress-header-text">
                <h4 className="trim-progress-title">
                  {downloading === 'video' ? 'Processing & Stream-Cutting MP4 Video...' : 'Extracting High-Quality MP3 Audio Clip...'}
                </h4>
                <p className="trim-progress-time">
                  Elapsed Time: <strong>{downloadElapsed}s</strong> • Please wait, download will trigger automatically
                </p>
              </div>
            </div>

            <div className="trim-stages-row">
              <div className={`trim-stage-item ${downloadStep >= 1 ? 'active' : ''}`}>
                <span className="stage-dot"></span>
                <span>1. Cloud Extractor</span>
              </div>
              <div className={`trim-stage-item ${downloadStep >= 2 ? 'active' : ''}`}>
                <span className="stage-dot"></span>
                <span>2. Stream-Cutting ({selectedLength}s)</span>
              </div>
              <div className={`trim-stage-item ${downloadStep >= 3 ? 'active' : ''}`}>
                <span className="stage-dot"></span>
                <span>3. Direct File Save</span>
              </div>
            </div>

            <div className="trim-progress-bar-track">
              <div className="trim-progress-bar-fill"></div>
            </div>
          </div>
        )}

        {/* 🎉 Success Notification */}
        {downloadSuccess && (
          <div className="trim-success-card">
            <CheckCircle size={22} color="#10b981" style={{ flexShrink: 0 }} />
            <div>
              <strong style={{ color: '#10b981', display: 'block', marginBottom: '2px' }}>Download Complete!</strong>
              <span style={{ fontSize: '0.88rem' }}>Your {selectedLength}s clip has been downloaded to your device.</span>
            </div>
          </div>
        )}

        {/* ❌ Error Notification */}
        {downloadError && (
          <div className="trim-error-card">
            <AlertCircle size={22} color="#ef4444" style={{ flexShrink: 0 }} />
            <div>
              <strong style={{ color: '#ef4444', display: 'block', marginBottom: '2px' }}>Processing Issue</strong>
              <span style={{ fontSize: '0.88rem' }}>{downloadError}</span>
            </div>
          </div>
        )}

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
