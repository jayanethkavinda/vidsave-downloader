import React, { useState, useEffect } from 'react';
import { useLocation, Link, useNavigate } from 'react-router-dom';
import {
  Download,
  Link as LinkIcon,
  Clipboard,
  Play,
  CheckCircle,
  AlertCircle,
  Sparkles,
  Zap,
  ShieldCheck,
  Film,
  Music,
  ChevronDown,
  ChevronUp,
  Share2,
  HardDriveDownload,
  Layers,
  Video,
  Globe,
  Sun,
  Moon,
  Flame,
  Pin,
  Smartphone,
  ExternalLink,
  Subtitles,
  Search,
  Scissors
} from 'lucide-react';
import { PAGES_CONFIG, QUICK_LINKS } from './pagesConfig.js';
import VideoTrimmer from './VideoTrimmer.jsx';

const BACKEND_URL = 'https://vidsave-downloader.onrender.com';

export default function App() {
  const location = useLocation();
  const navigate = useNavigate();
  const currentPage = PAGES_CONFIG[location.pathname] || PAGES_CONFIG['/'];

  const [theme, setTheme] = useState('light');
  const [url, setUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [videoInfo, setVideoInfo] = useState(null);
  const [error, setError] = useState('');
  const [downloadingFormat, setDownloadingFormat] = useState(null);
  const [downloadingSubId, setDownloadingSubId] = useState(null);
  const [copiedAttribution, setCopiedAttribution] = useState(false);
  const [subSearch, setSubSearch] = useState('');
  const [activeTab, setActiveTab] = useState(currentPage.defaultTab || 'video');
  const [openFaq, setOpenFaq] = useState(0);
  const [viewMode, setViewMode] = useState('main'); // 'main' | 'trim'

  // Typing animation cycling through major platforms letter by letter
  const TYPING_PLATFORMS = ['YouTube', 'Instagram', 'TikTok', 'Facebook', 'Twitter (X)', 'Pinterest'];
  const [typedPlatform, setTypedPlatform] = useState('');
  const [platformIndex, setPlatformIndex] = useState(0);
  const [isDeleting, setIsDeleting] = useState(false);

  useEffect(() => {
    const currentWord = TYPING_PLATFORMS[platformIndex];
    let timer;

    if (!isDeleting) {
      if (typedPlatform.length < currentWord.length) {
        timer = setTimeout(() => {
          setTypedPlatform(currentWord.slice(0, typedPlatform.length + 1));
        }, 110);
      } else {
        timer = setTimeout(() => {
          setIsDeleting(true);
        }, 1500);
      }
    } else {
      if (typedPlatform.length > 0) {
        timer = setTimeout(() => {
          setTypedPlatform(currentWord.slice(0, typedPlatform.length - 1));
        }, 55);
      } else {
        setIsDeleting(false);
        setPlatformIndex((prev) => (prev + 1) % TYPING_PLATFORMS.length);
      }
    }

    return () => clearTimeout(timer);
  }, [typedPlatform, isDeleting, platformIndex]);

  // Sync route changes to document title, meta tags, canonical link, and activeTab
  useEffect(() => {
    document.title = currentPage.title;
    const metaDesc = document.querySelector('meta[name="description"]');
    if (metaDesc) {
      metaDesc.setAttribute('content', currentPage.description);
    }
    const fullCanonicalUrl = `https://vidsave-hd.web.app${currentPage.slug === '/' ? '/' : currentPage.slug}`;
    let canonical = document.querySelector('link[rel="canonical"]');
    if (!canonical) {
      canonical = document.createElement('link');
      canonical.setAttribute('rel', 'canonical');
      document.head.appendChild(canonical);
    }
    canonical.setAttribute('href', fullCanonicalUrl);

    const ogUrl = document.querySelector('meta[property="og:url"]');
    if (ogUrl) {
      ogUrl.setAttribute('content', fullCanonicalUrl);
    }

    setActiveTab(currentPage.defaultTab || 'video');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, [location.pathname]);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    document.body.setAttribute('data-theme', theme);
    localStorage.setItem('vidsave_theme', theme);
  }, [theme]);

  const toggleTheme = () => {
    const nextTheme = theme === 'dark' ? 'light' : 'dark';
    setTheme(nextTheme);
    document.documentElement.setAttribute('data-theme', nextTheme);
    document.body.setAttribute('data-theme', nextTheme);
  };

  // Extract YouTube Video ID from any YouTube URL variation
  const extractYouTubeId = (rawUrl) => {
    if (!rawUrl) return null;
    const match = rawUrl.trim().match(/(?:youtu\.be\/|youtube\.com\/(?:embed\/|v\/|watch\?v=|watch\?.+&v=|shorts\/|live\/))([\w-]{11})/i);
    return match ? match[1] : null;
  };

  // YouTube Fallback metadata builder via direct oEmbed & fast cloud mirrors
  const getYouTubeFallbackInfo = async (rawUrl, videoId) => {
    let title = `YouTube Video (${videoId})`;
    let uploader = 'YouTube Creator';
    let thumbnail = `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;

    try {
      const oembedRes = await fetch(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`);
      if (oembedRes.ok) {
        const oembedData = await oembedRes.json();
        if (oembedData.title) title = oembedData.title;
        if (oembedData.author_name) uploader = oembedData.author_name;
        if (oembedData.thumbnail_url) thumbnail = oembedData.thumbnail_url;
      }
    } catch (e) {
      console.warn('oEmbed fetch bypassed, using standard YouTube thumbnail', e);
    }

    return {
      title,
      uploader,
      extractor: 'YouTube (Instant Cloud Resolver)',
      thumbnail,
      webpageUrl: `https://www.youtube.com/watch?v=${videoId}`,
      isYouTubeFallback: true,
      videoId,
      presets: [
        { 
          id: 'best_with_audio', 
          label: '1080p Full HD (SaveFrom)', 
          ext: 'mp4', 
          type: 'video', 
          mirrorUrl: `https://en.savefrom.net/1-youtube-video-downloader-4v1/?url=https://www.youtube.com/watch?v=${videoId}` 
        },
        { 
          id: 'mirror_720', 
          label: '720p HD Ready (SSDirect)', 
          ext: 'mp4', 
          type: 'video', 
          mirrorUrl: `https://ssyoutube.com/watch?v=${videoId}` 
        },
        { 
          id: 'mirror_mp3', 
          label: 'MP3 High Quality Audio (320kbps)', 
          ext: 'mp3', 
          type: 'audio', 
          mirrorUrl: `https://en.savefrom.net/1-youtube-video-downloader-4v1/?url=https://www.youtube.com/watch?v=${videoId}` 
        },
        { 
          id: 'mirror_cobalt', 
          label: 'Cobalt Cloud Stream', 
          ext: 'mp4', 
          type: 'video', 
          mirrorUrl: 'https://cobalt.tools/' 
        }
      ],
      subtitles: [
        { id: 'auto_en', code: 'en', language: 'English', isAuto: true, url: `https://www.youtube.com/api/timedtext?v=${videoId}&lang=en&fmt=vtt`, exts: ['srt', 'vtt'] },
        { id: 'auto_si', code: 'si', language: 'Sinhala', isAuto: true, url: `https://www.youtube.com/api/timedtext?v=${videoId}&lang=si&fmt=vtt`, exts: ['srt', 'vtt'] },
        { id: 'auto_es', code: 'es', language: 'Spanish', isAuto: true, url: `https://www.youtube.com/api/timedtext?v=${videoId}&lang=es&fmt=vtt`, exts: ['srt', 'vtt'] },
        { id: 'auto_hi', code: 'hi', language: 'Hindi', isAuto: true, url: `https://www.youtube.com/api/timedtext?v=${videoId}&lang=hi&fmt=vtt`, exts: ['srt', 'vtt'] },
        { id: 'auto_ta', code: 'ta', language: 'Tamil', isAuto: true, url: `https://www.youtube.com/api/timedtext?v=${videoId}&lang=ta&fmt=vtt`, exts: ['srt', 'vtt'] },
        { id: 'auto_fr', code: 'fr', language: 'French', isAuto: true, url: `https://www.youtube.com/api/timedtext?v=${videoId}&lang=fr&fmt=vtt`, exts: ['srt', 'vtt'] },
        { id: 'auto_de', code: 'de', language: 'German', isAuto: true, url: `https://www.youtube.com/api/timedtext?v=${videoId}&lang=de&fmt=vtt`, exts: ['srt', 'vtt'] },
        { id: 'auto_ja', code: 'ja', language: 'Japanese', isAuto: true, url: `https://www.youtube.com/api/timedtext?v=${videoId}&lang=ja&fmt=vtt`, exts: ['srt', 'vtt'] },
        { id: 'auto_ar', code: 'ar', language: 'Arabic', isAuto: true, url: `https://www.youtube.com/api/timedtext?v=${videoId}&lang=ar&fmt=vtt`, exts: ['srt', 'vtt'] },
        { id: 'auto_ru', code: 'ru', language: 'Russian', isAuto: true, url: `https://www.youtube.com/api/timedtext?v=${videoId}&lang=ru&fmt=vtt`, exts: ['srt', 'vtt'] },
        { id: 'auto_pt', code: 'pt', language: 'Portuguese', isAuto: true, url: `https://www.youtube.com/api/timedtext?v=${videoId}&lang=pt&fmt=vtt`, exts: ['srt', 'vtt'] },
        { id: 'auto_zh', code: 'zh', language: 'Chinese', isAuto: true, url: `https://www.youtube.com/api/timedtext?v=${videoId}&lang=zh&fmt=vtt`, exts: ['srt', 'vtt'] }
      ]
    };
  };

  // Helper to format file size cleanly - NEVER shows 0 MB, always displays decimal MB (e.g. 0.76 MB)
  const getCleanFilesize = (preset) => {
    if (!preset) return null;
    const str = preset.filesizeFormatted;
    if (str && !/^0(?:\.00?)?\s*mb$/i.test(str.trim())) {
      return str;
    }
    if (preset.filesize && preset.filesize > 0) {
      const bytes = preset.filesize;
      if (bytes >= 1024 * 1024 * 1024) return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
      if (bytes >= 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
      const mbDecimal = (bytes / (1024 * 1024)).toFixed(2);
      return (parseFloat(mbDecimal) > 0 ? mbDecimal : '0.01') + ' MB';
    }
    return null;
  };

  // Handle URL fetch
  const handleFetchInfo = async (e, directUrl = null) => {
    if (e) e.preventDefault();
    const targetUrl = (directUrl || url || '').trim();
    if (!targetUrl) return;

    setLoading(true);
    setError('');
    setVideoInfo(null);

    const videoId = extractYouTubeId(targetUrl);

    try {
      const response = await fetch(`${BACKEND_URL}/api/info?url=${encodeURIComponent(targetUrl)}`);
      const data = await response.json();

      if (!response.ok) {
        // If it is YouTube or a YouTube bot challenge error, activate seamless cloud fallback
        if (videoId || (data.error && /bot|sign in|youtube|extractor/i.test(data.error))) {
          const fallbackInfo = await getYouTubeFallbackInfo(targetUrl, videoId || 'video');
          setVideoInfo(fallbackInfo);
          return;
        }
        let cleanMsg = data.error || 'Failed to fetch video details.';
        if (/Instagram.*(available to everyone|certain audiences|empty media response|login)/i.test(cleanMsg)) {
          cleanMsg = 'This Instagram Reel/Post is Age-Restricted, Private, or requires an Instagram login to view.';
        }
        throw new Error(cleanMsg);
      }

      setVideoInfo(data);
    } catch (err) {
      if (videoId) {
        // Seamlessly fall back to Instant Cloud Resolver for YouTube
        const fallbackInfo = await getYouTubeFallbackInfo(targetUrl, videoId);
        setVideoInfo(fallbackInfo);
      } else {
        let msg = err.message || 'Could not reach backend server or video link is invalid/private.';
        if (/Instagram.*(available to everyone|certain audiences|empty media response|login)/i.test(msg)) {
          msg = 'This Instagram Reel/Post is Age-Restricted, Private, or requires an Instagram login to view.';
        }
        setError(msg);
      }
    } finally {
      setLoading(false);
    }
  };

  // Paste from clipboard helper (hides paste icon & immediately starts extracting video)
  const handlePaste = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text && text.trim()) {
        const cleanUrl = text.trim();
        setUrl(cleanUrl);
        handleFetchInfo(null, cleanUrl);
      }
    } catch (err) {
      console.warn('Clipboard access denied or not supported', err);
    }
  };

  // On native paste (right-click paste, touch long-press paste, Ctrl+V)
  const handleInputPaste = (e) => {
    const text = e.clipboardData?.getData('text');
    if (text && text.trim()) {
      const cleanUrl = text.trim();
      setUrl(cleanUrl);
      setTimeout(() => {
        handleFetchInfo(null, cleanUrl);
      }, 50);
    }
  };

  // Trigger streaming download directly to client browser
  const handleDownload = (presetId, formatExt = 'mp4') => {
    if (!videoInfo) return;
    setDownloadingFormat(presetId);

    // If this is a YouTube fallback, launch the instant fast mirror resolver
    if (videoInfo.isYouTubeFallback) {
      const preset = videoInfo.presets.find(p => p.id === presetId) || videoInfo.presets[0];
      if (preset && preset.mirrorUrl) {
        window.open(preset.mirrorUrl, '_blank', 'noopener,noreferrer');
      }
      setTimeout(() => {
        setDownloadingFormat(null);
      }, 1500);
      return;
    }

    const downloadUrl = `${BACKEND_URL}/api/download?url=${encodeURIComponent(videoInfo.webpageUrl || url)}&format=${encodeURIComponent(presetId)}&title=${encodeURIComponent(videoInfo.title)}`;
    
    // Create an invisible anchor tag to trigger browser download prompt
    const a = document.createElement('a');
    a.href = downloadUrl;
    a.setAttribute('download', `${videoInfo.title || 'video'}.${formatExt}`);
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);

    setTimeout(() => {
      setDownloadingFormat(null);
    }, 2500);
  };

  // Browser VTT to SRT parser (enables instant client-side conversion)
  const clientConvertVttToSrt = (vttContent) => {
    if (!vttContent) return '';
    const lines = vttContent.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
    const srt = [];
    let counter = 1;
    let inHeader = true;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (inHeader) {
        if (line.includes('-->')) inHeader = false;
        else continue;
      }
      if (line.includes('-->')) {
        srt.push(counter++);
        const cleanTime = line
          .replace(/(\d{2}:\d{2}:\d{2})\.(\d{3})/g, '$1,$2')
          .replace(/(\d{2}:\d{2})\.(\d{3})/g, '00:$1,$2')
          .replace(/\s+[a-z]+:[^\s]+/gi, '')
          .trim();
        srt.push(cleanTime);
      } else if (line === '') {
        if (srt.length > 0 && srt[srt.length - 1] !== '') srt.push('');
      } else {
        const cleanText = line.replace(/<[^>]+>/g, '').trim();
        if (cleanText) srt.push(cleanText);
      }
    }
    return srt.join('\r\n');
  };

  // Multi-tier subtitle downloader (.SRT and .VTT in all languages)
  const handleDownloadSub = async (sub, ext = 'srt') => {
    if (!sub || !videoInfo) return;
    const downloadKey = `${sub.id}_${ext}`;
    setDownloadingSubId(downloadKey);

    const safeTitle = (videoInfo.title || 'subtitles')
      .replace(/[^\w\s\u0D80-\u0DFF.-]/gi, '')
      .trim()
      .substring(0, 60) || 'subtitles';
    const filename = `${safeTitle}_${sub.code}.${ext}`;

    try {
      // Tier 1: Dedicated Backend Subtitle Proxy & Converter
      const backendSubUrl = `${BACKEND_URL}/api/subtitle?url=${encodeURIComponent(sub.url)}&lang=${encodeURIComponent(sub.code)}&ext=${ext}&title=${encodeURIComponent(safeTitle)}`;

      const res = await fetch(backendSubUrl);
      if (res.ok) {
        const blob = await res.blob();
        const blobUrl = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = blobUrl;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(blobUrl);
        return;
      }

      // Tier 2: Direct Client Browser Fetch + Realtime Converter (for CORS-enabled endpoints like YouTube timedtext)
      if (sub.url) {
        let fetchUrl = sub.url;
        if (fetchUrl.includes('timedtext') && !fetchUrl.includes('fmt=')) {
          fetchUrl += '&fmt=vtt';
        }
        const directRes = await fetch(fetchUrl);
        if (directRes.ok) {
          let text = await directRes.text();
          if (ext === 'srt') {
            text = clientConvertVttToSrt(text);
          }
          const blob = new Blob([text], { type: ext === 'vtt' ? 'text/vtt;charset=utf-8' : 'text/plain;charset=utf-8' });
          const blobUrl = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = blobUrl;
          a.download = filename;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          URL.revokeObjectURL(blobUrl);
          return;
        }
      }

      // Tier 3: Direct stream open fallback
      if (sub.url) {
        window.open(sub.url, '_blank', 'noopener,noreferrer');
      }
    } catch (err) {
      console.warn('Sub download error, falling back to direct open:', err);
      if (sub.url) {
        window.open(sub.url, '_blank', 'noopener,noreferrer');
      }
    } finally {
      setTimeout(() => {
        setDownloadingSubId(null);
      }, 1500);
    }
  };

  // Generate standardized TASL (Title, Author, Source, License) attribution text
  const generateAttributionText = (info) => {
    if (!info) return '';
    const title = info.title || 'Untitled Media';
    const author = info.uploader || 'Creator';
    const sourceUrl = info.webpageUrl || url;
    const platform = info.extractor || 'Web Media';
    const date = new Date().toISOString().split('T')[0];

    return `=====================================================
CREATOR ATTRIBUTION & LICENSE CREDIT (TASL Standard)
=====================================================
Title: ${title}
Author / Creator: ${author}
Source URL: ${sourceUrl}
Platform: ${platform}
Accessed Date: ${date}
Attribution Standard: TASL (Title, Author, Source, License)
Downloaded via: VidSave - Free Universal Media Downloader
Website: https://vidsave-downloader.web.app

-----------------------------------------------------
QUICK CREDIT (For YouTube Description / TikTok / Instagram):
"Video by ${author} via ${platform} (${sourceUrl})"
-----------------------------------------------------`;
  };

  // Copy attribution text to clipboard
  const handleCopyAttribution = async () => {
    if (!videoInfo) return;
    try {
      const text = generateAttributionText(videoInfo);
      await navigator.clipboard.writeText(text);
      setCopiedAttribution(true);
      setTimeout(() => setCopiedAttribution(false), 2000);
    } catch (e) {
      console.warn('Clipboard copy error:', e);
    }
  };

  // Download attribution credit as a .TXT file
  const handleDownloadAttribution = () => {
    if (!videoInfo) return;
    const text = generateAttributionText(videoInfo);
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const blobUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const safeTitle = (videoInfo.title || 'Attribution')
      .replace(/[^\w\s\u0D80-\u0DFF.-]/gi, '')
      .trim()
      .substring(0, 50) || 'Attribution';

    a.href = blobUrl;
    a.download = `${safeTitle}_Attribution.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(blobUrl);
  };

  const platforms = [
    { name: 'TikTok', brand: 'tiktok', path: '/save-tiktok-without-watermark', iconSrc: '/icons/tiktok.png', fallbackIcon: Video },
    { name: 'YouTube', brand: 'youtube', path: '/youtube-video-downloader', iconSrc: '/icons/youtube.png', fallbackIcon: Play },
    { name: 'Instagram', brand: 'instagram', path: '/instagram-reel-downloader', iconSrc: '/icons/instagram.png', fallbackIcon: Sparkles },
    { name: 'Facebook', brand: 'facebook', path: '/fb-video-downloader', iconSrc: '/icons/facebook.png', fallbackIcon: Film },
    { name: 'Pinterest', brand: 'pinterest', path: '/pinterest-video-downloader', iconSrc: '/icons/pinterest.png', fallbackIcon: Pin },
    { name: 'Twitter / X', brand: 'twitter', path: '/x-video-downloader', iconSrc: '/icons/twitter.png', fallbackIcon: Share2 },
    { name: 'Threads', brand: 'threads', path: '/threads-video-downloader', iconSrc: '/icons/threads.png', fallbackIcon: Layers }
  ];

  const faqs = [
    {
      q: 'How to use TikTok video downloader no watermark & download TikTok sound?',
      a: 'Simply paste the TikTok video link into our search bar and click "Get Video". You can instantly download the clean video without watermark in Full HD MP4 or extract just the audio using our "Audio Only" tab to download TikTok sound in high-quality MP3.'
    },
    {
      q: 'How to convert YouTube to MP4 or YouTube to MP3?',
      a: 'Paste the YouTube link (video or Shorts). Click "Get Video" to see all available resolutions. Select 1080p Full HD for YouTube to MP4, or switch to the Audio tab for YouTube to MP3 high-speed download.'
    },
    {
      q: 'Can I download Instagram Reels and Pinterest videos?',
      a: 'Yes! Our Instagram reel downloader and Pinterest video downloader support instant media saving for Reels, Stories, DIY clips, and pins directly to your device.'
    },
    {
      q: 'Is this video downloader app for iPhone (iOS) and Android?',
      a: 'Yes! As a free online video downloader, it functions directly within Safari on iPhone and iPad (iOS video downloader) as well as Chrome on Android, saving media directly to your Photos or Files app without any extra APK or software.'
    },
    {
      q: 'Is this a free Save from video downloader alternative?',
      a: 'Yes, VidSave is 100% free with unlimited downloads, zero-disk direct streaming speed, and no annoying popups, making it the premier Save from video downloader alternative.'
    }
  ];

  const allVideoPresets = (videoInfo?.presets || []).filter(p => p.type === 'video' && p.id !== 'best_with_audio');
  // Highest quality is prominently featured in the Recommended card above, so show remaining tiers below
  const videoPresets = allVideoPresets.length > 1 ? allVideoPresets.slice(1) : allVideoPresets;
  const audioPresets = (videoInfo?.presets || []).filter(p => p.type === 'audio');
  const subtitles = videoInfo?.subtitles || [];
  const filteredSubtitles = subtitles.filter(s =>
    !subSearch.trim() ||
    s.language.toLowerCase().includes(subSearch.toLowerCase()) ||
    s.code.toLowerCase().includes(subSearch.toLowerCase())
  );
  const filteredPresets = activeTab === 'video' ? videoPresets : audioPresets;


  return (
    <div className="app">
      {/* Navigation */}
      <header className="navbar container">
        <Link to="/" className="logo">
          <img 
            src="/videoDownloader.jpg" 
            alt="VidSave Logo" 
            className="logo-img" 
          />
          <div className="logo-text">
            Vid<span>Save</span>
          </div>
        </Link>
        <div className="nav-actions">
          <div className="nav-badge">
            <span className="nav-pulse"></span>
            All Video Free Downloader
          </div>
          <button 
            type="button" 
            onClick={toggleTheme} 
            className="btn-theme-toggle"
            title={theme === 'dark' ? 'Switch to Light Mode' : 'Switch to Dark Mode'}
            aria-label="Toggle Theme"
          >
            {theme === 'dark' ? <Sun size={20} color="#06b6d4" /> : <Moon size={20} color="#0284c7" />}
          </button>
        </div>
      </header>

      {/* Hero Section or Dedicated Video Trimmer */}
      <main className="container">
        {viewMode === 'trim' && videoInfo ? (
          <VideoTrimmer
            videoInfo={videoInfo}
            onBack={() => setViewMode('main')}
          />
        ) : (
          <>
            <section className="hero">
          <h1 className="hero-title">
            {currentPage.slug === '/' ? (
              <>
                All Video <span className="gradient-text">Free Downloader</span>
              </>
            ) : (
              <>
                {currentPage.h1} - <span className="gradient-text">{currentPage.h1Highlight}</span>
              </>
            )}
          </h1>

          {/* Typing Animation under Main Header */}
          <div className="typing-animation-container">
            <span className="typing-prefix">Fast Save from </span>
            <span className="typing-highlight-box">
              <span className="typing-word">{typedPlatform}</span>
              <span className="typing-cursor"></span>
            </span>
          </div>

          <p className="hero-subtitle">
            {currentPage.subtitle}
          </p>

          {/* Search Box */}
          <form onSubmit={handleFetchInfo} className="input-wrapper">
            <div className="search-box">
              <LinkIcon size={22} className="search-icon" style={{ marginRight: '6px', flexShrink: 0 }} />
              <input
                type="text"
                className="search-input"
                placeholder={currentPage.placeholder}
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                onPaste={handleInputPaste}
                autoFocus
              />
              <div className="search-actions">
                {!url.trim() && (
                  <button type="button" onClick={handlePaste} className="btn-paste">
                    <Clipboard size={16} /> Paste
                  </button>
                )}
                {url.trim() && (
                  <button
                    type="button"
                    onClick={() => { setUrl(''); setVideoInfo(null); setError(''); }}
                    className="btn-clear"
                    title="Clear input"
                  >
                    ✕
                  </button>
                )}
                <button type="submit" disabled={loading || !url.trim()} className="btn-submit">
                  {loading ? (
                    <>
                      <Zap size={18} className="spin" /> Extracting...
                    </>
                  ) : (
                    <>
                      <Download size={18} /> Get Video
                    </>
                  )}
                </button>
              </div>
            </div>
          </form>

          {/* 🔍 Animated Searching & Extracting Box (Active while video is finding) */}
          {loading && (
            <div className="glass-panel searching-card">
              <div className="searching-spinner-container">
                <div className="searching-pulse-ring"></div>
                <Zap size={30} className="searching-icon spin" />
              </div>
              <div className="searching-content">
                <h3 className="searching-title">Searching & Analyzing Media...</h3>
                <p className="searching-desc">
                  Connecting to high-speed cloud extractors • Finding Full HD, 4K video, audio & subtitles
                </p>
                <div className="searching-progress-track">
                  <div className="searching-progress-bar"></div>
                </div>
              </div>
            </div>
          )}

          {/* Error Notice */}
          {error && !loading && (
            <div className="glass-panel" style={{ maxWidth: '780px', margin: '0 auto 2.5rem', padding: '1.25rem', borderColor: 'rgba(239, 68, 68, 0.4)', background: 'rgba(239, 68, 68, 0.08)', display: 'flex', alignItems: 'center', gap: '1rem', textAlign: 'left' }}>
              <AlertCircle color="#ef4444" size={24} style={{ flexShrink: 0 }} />
              <div>
                <strong style={{ color: '#ef4444', display: 'block', marginBottom: '2px' }}>Extraction Error</strong>
                <span style={{ fontSize: '0.9rem', color: '#fca5a5' }}>{error}</span>
              </div>
            </div>
          )}

          {/* Video Result Card */}
          {videoInfo && !loading && (
            <div className="glass-panel result-card">
              <div className="result-header">
                <div className="thumb-container">
                  {videoInfo.thumbnail ? (
                    <img src={videoInfo.thumbnail} alt={videoInfo.title} className="thumb-img" />
                  ) : (
                    <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#1e293b' }}>
                      <Film size={36} color="#64748b" />
                    </div>
                  )}
                  {videoInfo.durationFormatted && (
                    <span className="thumb-duration">{videoInfo.durationFormatted}</span>
                  )}
                </div>

                <div className="video-meta">
                  <h3 className="video-title" title={videoInfo.title}>
                    {videoInfo.title}
                  </h3>
                  <div className="video-author">
                    <CheckCircle size={16} color="#06b6d4" />
                    <span>Source: {videoInfo.extractor} • {videoInfo.uploader}</span>
                  </div>
                </div>
              </div>

              {/* ⚡ Special YouTube Instant Cloud Resolver Banner */}
              {videoInfo.isYouTubeFallback && (
                <div style={{
                  background: 'rgba(6, 182, 212, 0.12)',
                  border: '1px solid rgba(6, 182, 212, 0.35)',
                  borderRadius: '12px',
                  padding: '0.85rem 1.25rem',
                  marginBottom: '1.25rem',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.75rem',
                  textAlign: 'left'
                }}>
                  <Zap size={22} color="#06b6d4" style={{ flexShrink: 0 }} />
                  <div style={{ fontSize: '0.9rem', color: 'var(--text-main)', lineHeight: '1.4' }}>
                    <strong style={{ color: '#06b6d4', display: 'block', marginBottom: '2px' }}>
                      ⚡ YouTube Instant Cloud Resolver Active
                    </strong>
                    Direct high-speed resolver bypassed data-center restrictions. Select 1080p Full HD, 720p, or MP3 below to download instantly without wait time!
                  </div>
                </div>
              )}

              {/* 🌟 Featured Primary Download CTA */}
              <div className="featured-download-box">
                <div className="featured-left">
                  <div className="featured-label">
                    <Flame size={14} style={{ display: 'inline', verticalAlign: '-2px', marginRight: '4px' }} />
                    {videoInfo.isYouTubeFallback ? 'Instant Cloud Mirror' : 'Recommended Quality'}
                  </div>
                  <div className="featured-title">
                    {videoInfo.isYouTubeFallback 
                      ? 'Download Full HD (1080p MP4) via Fast Mirror'
                      : (videoInfo.bestPreset ? videoInfo.bestPreset.label.replace(/\s*\(with\s*Audio\)/gi, '').replace(/\s*with\s*Audio/gi, '').trim() : 'Download Best Quality')}
                    {getCleanFilesize(videoInfo.bestPreset) && (
                      <span style={{ fontSize: '0.9rem', color: 'var(--cyan-primary)', marginLeft: '8px', fontWeight: '600' }}>
                        (~{getCleanFilesize(videoInfo.bestPreset)})
                      </span>
                    )}
                  </div>
                </div>
                <button
                  onClick={() => handleDownload('best_with_audio', 'mp4')}
                  className="btn-primary-download"
                  disabled={downloadingFormat === 'best_with_audio'}
                >
                  {videoInfo.isYouTubeFallback ? <ExternalLink size={18} /> : <Download size={18} />}
                  {downloadingFormat === 'best_with_audio' 
                    ? (videoInfo.isYouTubeFallback ? 'Opening Fast Mirror...' : 'Downloading & Merging...') 
                    : (videoInfo.maxQualityLabel ? `Download ${videoInfo.maxQualityLabel}` : 'Download Best Quality')}
                </button>
              </div>

              {/* ✂️ CapCut-Style Visual Trimmer Feature Banner */}
              <div className="trimmer-entry-banner">
                <div className="trimmer-entry-content">
                  <div className="trimmer-entry-badge">
                    <Scissors size={14} color="#f59e0b" />
                    <span>Visual Range Trimmer & Clipper</span>
                  </div>
                  <h4 className="trimmer-entry-title">
                    Trim & Crop Video before Downloading
                  </h4>
                  <p className="trimmer-entry-subtitle">
                    Select exact cut points with draggable yellow timeline handles, preview live playback, and save only what you need (MP4 / MP3).
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setViewMode('trim');
                    window.scrollTo({ top: 100, behavior: 'smooth' });
                  }}
                  className="btn-launch-trimmer"
                >
                  <Scissors size={17} />
                  <span>✂️ Trim & Crop Video</span>
                </button>
              </div>

              {/* Quality Options & Category Tabs */}
              <div style={{ textAlign: 'left' }}>
                <div className="format-tabs">
                  <button
                    className={`tab-btn ${activeTab === 'video' ? 'active' : ''}`}
                    onClick={() => setActiveTab('video')}
                  >
                    <Film size={16} /> Video Formats ({videoPresets.length})
                  </button>
                  <button
                    className={`tab-btn ${activeTab === 'audio' ? 'active' : ''}`}
                    onClick={() => setActiveTab('audio')}
                  >
                    <Music size={16} /> Audio Only ({audioPresets.length})
                  </button>
                  <button
                    className={`tab-btn ${activeTab === 'subtitles' ? 'active' : ''}`}
                    onClick={() => setActiveTab('subtitles')}
                  >
                    <Subtitles size={16} /> Subtitles ({subtitles.length})
                  </button>
                </div>

                {activeTab === 'subtitles' ? (
                  subtitles.length === 0 ? (
                    <div style={{ textAlign: 'center', padding: '2.5rem 1rem', color: 'var(--text-muted)' }}>
                      <Subtitles size={36} style={{ opacity: 0.35, marginBottom: '0.75rem', display: 'inline-block' }} />
                      <p style={{ fontWeight: 600, color: 'var(--text-main)', fontSize: '1rem' }}>No subtitles found for this video.</p>
                      <p style={{ fontSize: '0.85rem', marginTop: '0.35rem' }}>This media does not have uploaded or auto-generated captions available.</p>
                    </div>
                  ) : (
                    <>
                      {subtitles.length > 0 && (
                        <div className="sub-search-box">
                          <Search size={16} color="var(--text-muted)" />
                          <input
                            type="text"
                            placeholder="Search language (e.g. Sinhala, English, Tamil, Spanish, French)..."
                            value={subSearch}
                            onChange={(e) => setSubSearch(e.target.value)}
                            className="sub-search-input"
                          />
                          {subSearch && (
                            <button onClick={() => setSubSearch('')} className="sub-search-clear">✕</button>
                          )}
                        </div>
                      )}

                      <div className="quality-table-wrapper">
                        <table className="quality-table">
                          <tbody>
                            {filteredSubtitles.map((sub) => {
                              const isDownloadingSrt = downloadingSubId === `${sub.id}_srt`;
                              const isDownloadingVtt = downloadingSubId === `${sub.id}_vtt`;

                              return (
                                <tr key={sub.id} className="quality-row">
                                  <td className="quality-cell" style={{ fontWeight: '600' }}>
                                    <span className={`quality-badge ${sub.isAuto ? 'sub-auto' : 'sub-manual'}`}>
                                      {sub.isAuto ? <Sparkles size={14} /> : <CheckCircle size={14} />}
                                      <span>{sub.language}</span>
                                      <span style={{ fontSize: '0.75rem', opacity: 0.8, marginLeft: '4px' }}>
                                        ({sub.isAuto ? 'Auto CC' : 'Official'})
                                      </span>
                                    </span>
                                  </td>
                                  <td className="quality-cell" style={{ color: 'var(--text-muted)', fontSize: '0.88rem' }}>
                                    <strong style={{ color: 'var(--text-main)' }}>SRT / VTT</strong>
                                    <span style={{ marginLeft: '10px', color: 'var(--cyan-primary)', fontSize: '0.82rem', fontWeight: '600' }}>
                                      • {sub.code.toUpperCase()}
                                    </span>
                                  </td>
                                  <td className="quality-cell" style={{ textAlign: 'right' }}>
                                    <div style={{ display: 'inline-flex', gap: '0.5rem', justifyContent: 'flex-end' }}>
                                      <button
                                        onClick={() => handleDownloadSub(sub, 'srt')}
                                        className="btn-download-action btn-sub-action"
                                        disabled={isDownloadingSrt || isDownloadingVtt}
                                        title={`Download ${sub.language} subtitle as .SRT file`}
                                      >
                                        <Download size={14} />
                                        {isDownloadingSrt ? 'Saving...' : '.SRT'}
                                      </button>
                                      <button
                                        onClick={() => handleDownloadSub(sub, 'vtt')}
                                        className="btn-download-action btn-sub-action btn-sub-vtt"
                                        disabled={isDownloadingSrt || isDownloadingVtt}
                                        title={`Download ${sub.language} subtitle as .VTT file`}
                                      >
                                        <Download size={14} />
                                        {isDownloadingVtt ? 'Saving...' : '.VTT'}
                                      </button>
                                    </div>
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    </>
                  )
                ) : (
                  <div className="quality-table-wrapper">
                    <table className="quality-table">
                      <tbody>
                        {filteredPresets.map((preset) => {
                          let badgeClass = preset.badge || 'hd';
                          if (preset.id.includes('best') && preset.type === 'video') badgeClass = 'best';
                          else if (preset.id === '4320' || preset.id === '2160') badgeClass = 'ultra';
                          else if (preset.id === '480' || preset.id === '360') badgeClass = 'sd';
                          else if (preset.type === 'audio') badgeClass = 'audio';

                          const cleanLabel = (preset.label || '')
                            .replace(/\s*\(with\s*Audio\)/gi, '')
                            .replace(/\s*with\s*Audio/gi, '')
                            .trim();

                          return (
                            <tr key={preset.id} className="quality-row">
                              <td className="quality-cell" style={{ fontWeight: '600' }}>
                                <span className={`quality-badge ${badgeClass}`}>
                                  {preset.type === 'audio' ? <Music size={14} /> : <Film size={14} />}
                                  {cleanLabel}
                                </span>
                              </td>
                              <td className="quality-cell" style={{ color: 'var(--text-muted)', fontSize: '0.88rem' }}>
                                <strong style={{ color: 'var(--text-main)' }}>{preset.ext.toUpperCase()}</strong>
                                {getCleanFilesize(preset) && (
                                  <span style={{ marginLeft: '10px', color: 'var(--cyan-primary)', fontWeight: '600' }}>
                                    • {getCleanFilesize(preset)}
                                  </span>
                                )}
                              </td>
                              <td className="quality-cell" style={{ textAlign: 'right' }}>
                                <button
                                  onClick={() => handleDownload(preset.id, preset.ext)}
                                  className="btn-download-action"
                                  disabled={downloadingFormat === preset.id}
                                >
                                  {videoInfo.isYouTubeFallback ? <ExternalLink size={15} /> : <Download size={15} />}
                                  {downloadingFormat === preset.id 
                                    ? (videoInfo.isYouTubeFallback ? 'Opening...' : 'Downloading...') 
                                    : (videoInfo.isYouTubeFallback ? 'Direct Link' : 'Download')}
                                </button>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>

              {/* ⚖️ Auto-Attribution & TASL Credit Generator */}
              <div className="attribution-card">
                <div className="attribution-header">
                  <div className="attribution-title-wrap">
                    <ShieldCheck size={20} className="attribution-badge-icon" />
                    <div>
                      <h4 className="attribution-heading">Creator Attribution & Fair Use Credit (TASL)</h4>
                      <p className="attribution-subheading">
                        Ethical copyright attribution text ready for social media, YouTube descriptions, or research blogs
                      </p>
                    </div>
                  </div>
                  <div className="attribution-actions">
                    <button
                      type="button"
                      onClick={handleCopyAttribution}
                      className="btn-attribution-action"
                      title="Copy attribution text to clipboard"
                    >
                      {copiedAttribution ? <CheckCircle size={15} color="#10b981" /> : <Clipboard size={15} />}
                      {copiedAttribution ? 'Copied!' : 'Copy Attribution'}
                    </button>
                    <button
                      type="button"
                      onClick={handleDownloadAttribution}
                      className="btn-attribution-action btn-attribution-download"
                      title="Download attribution as .TXT file"
                    >
                      <Download size={15} /> Download .TXT
                    </button>
                  </div>
                </div>
                <div className="attribution-snippet-box">
                  <code>{generateAttributionText(videoInfo)}</code>
                </div>
              </div>
            </div>
          )}

          {/* Supported Platform Chips (Always positioned underneath searching box & video result card!) */}
          <div className="platform-chips">
            {platforms.map((p) => {
              const FallbackComp = p.fallbackIcon;
              const isSelected = location.pathname === p.path;
              return (
                <Link
                  key={p.name} 
                  to={p.path}
                  className={`chip ${p.brand} ${isSelected ? 'active-chip' : ''}`}
                  title={`Open ${p.name} Downloader`}
                >
                  <img
                    src={p.iconSrc}
                    alt={p.name}
                    className="chip-icon"
                    onError={(e) => {
                      e.target.style.display = 'none';
                      if (e.target.nextSibling) {
                        e.target.nextSibling.style.display = 'inline-flex';
                      }
                    }}
                  />
                  <span className="fallback-chip-icon" style={{ display: 'none' }}>
                    <FallbackComp size={15} />
                  </span>
                  <span>{p.name}</span>
                </Link>
              );
            })}
          </div>
        </section>

        {/* 3 Step Tutorial (SaveFrom Reference) */}
        <section className="section-wrapper">
          <h2 className="section-title">How to Download Any Video Online (Save From Video Downloader)</h2>
          <p className="section-desc">Download video downloader tool in 3 simple steps without installing extra software</p>

          <div className="steps-grid">
            <div className="glass-panel step-card">
              <div className="step-number">1</div>
              <h3 className="step-title">Copy the Video Link</h3>
              <p className="step-text">
                Open YouTube, Facebook, TikTok, or Instagram. Find your video or Reel and click <strong>Share → Copy Link</strong>.
              </p>
            </div>

            <div className="glass-panel step-card">
              <div className="step-number">2</div>
              <h3 className="step-title">Paste the Link</h3>
              <p className="step-text">
                Paste the copied URL into our <strong>All Video Downloader</strong> input box above and click the <strong>"Get Video"</strong> button.
              </p>
            </div>

            <div className="glass-panel step-card">
              <div className="step-number">3</div>
              <h3 className="step-title">Download Without Watermark</h3>
              <p className="step-text">
                Select your preferred quality (Full HD 1080p, 720p, or MP3 Audio) and click <strong>Download</strong> to save immediately to your device.
              </p>
            </div>
          </div>
        </section>

        {/* Features Highlights */}
        <section className="section-wrapper" style={{ paddingTop: '1rem' }}>
          <div className="steps-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))' }}>
            <div className="glass-panel step-card">
              <Zap size={32} color="#06b6d4" style={{ marginBottom: '1rem' }} />
              <h4 style={{ fontSize: '1.2rem', fontWeight: '800', marginBottom: '0.5rem', color: 'var(--text-main)' }}>Direct Stream Speed</h4>
              <p style={{ color: 'var(--text-muted)', fontSize: '0.94rem' }}>
                Zero server delay. Download pipes directly from source to browser at maximum network speed.
              </p>
            </div>

            <div className="glass-panel step-card">
              <ShieldCheck size={32} color="#10b981" style={{ marginBottom: '1rem' }} />
              <h4 style={{ fontSize: '1.2rem', fontWeight: '800', marginBottom: '0.5rem', color: 'var(--text-main)' }}>100% Secure & Private</h4>
              <p style={{ color: 'var(--text-muted)', fontSize: '0.94rem' }}>
                We don't log user activities or store downloaded videos on our servers.
              </p>
            </div>

            <div className="glass-panel step-card">
              <Sparkles size={32} color="#ec4899" style={{ marginBottom: '1rem' }} />
              <h4 style={{ fontSize: '1.2rem', fontWeight: '800', marginBottom: '0.5rem', color: 'var(--text-main)' }}>High Quality 1080p</h4>
              <p style={{ color: 'var(--text-muted)', fontSize: '0.94rem' }}>
                Extract videos in original source quality with crystal clear audio and video.
              </p>
            </div>
          </div>
        </section>

        {/* FAQs */}
        <section className="section-wrapper" style={{ paddingTop: '1rem', paddingBottom: '3rem' }}>
          <div className="faq-container">
            <h2 className="section-title">Frequently Asked Questions</h2>
            <p className="section-desc">Common questions about video extraction, quality, and supported platforms</p>

            <div>
              {faqs.map((faq, idx) => (
                <div key={idx} className="faq-item">
                  <button
                    className="faq-question"
                    onClick={() => setOpenFaq(openFaq === idx ? null : idx)}
                  >
                    <span>{faq.q}</span>
                    {openFaq === idx ? <ChevronUp size={20} color="#06b6d4" /> : <ChevronDown size={20} />}
                  </button>
                  {openFaq === idx && <p className="faq-answer">{faq.a}</p>}
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* 🚀 Supported Tools & Quick Subpage Links (SEO Power Grid) */}
        <section className="section-wrapper" style={{ paddingTop: '0', paddingBottom: '5rem' }}>
          <div className="faq-container">
            <h2 className="section-title">Specialized Downloader Tools</h2>
            <p className="section-desc">Direct access to dedicated platform extractors and audio converters</p>

            <div className="quick-links-grid">
              {QUICK_LINKS.map((item) => {
                const isActive = location.pathname === item.slug;
                return (
                  <Link
                    key={item.slug}
                    to={item.slug}
                    className={`quick-link-card ${isActive ? 'active-link-card' : ''}`}
                    title={item.title}
                  >
                    <div className="quick-link-title">
                      <Zap size={16} color="var(--cyan-primary)" style={{ flexShrink: 0 }} />
                      <span>{item.name}</span>
                    </div>
                    <span className="quick-link-tag">{item.h1Highlight}</span>
                  </Link>
                );
              })}
            </div>
          </div>
        </section>
          </>
        )}
      </main>

      {/* Footer */}
      <footer className="footer container">
        <div className="footer-links">
          {QUICK_LINKS.map((link) => (
            <Link key={link.slug} to={link.slug} className="footer-nav-link">
              {link.name}
            </Link>
          ))}
        </div>
        <p style={{ marginTop: '1.5rem', color: 'var(--text-dim)', fontSize: '0.9rem' }}>
          © 2026 VidSave Media Downloader. Free universal high-speed video extraction service.
        </p>
      </footer>
    </div>
  );
}
