import React, { useState } from 'react';
import { ShieldCheck, Clipboard, CheckCircle, Download } from 'lucide-react';

export default function TaslAttributionCard({ videoInfo }) {
  const [copied, setCopied] = useState(false);

  if (!videoInfo) return null;

  const generateAttributionText = (info) => {
    const title = info.title || 'Untitled Media';
    const author = info.uploader || 'Creator';
    const sourceUrl = info.webpageUrl || '';
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

  const text = generateAttributionText(videoInfo);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (e) {
      console.warn('Clipboard copy error:', e);
    }
  };

  const handleDownload = () => {
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

  return (
    <div className="attribution-card">
      <div className="attribution-header">
        <div className="attribution-title-wrap">
          <ShieldCheck size={20} className="attribution-badge-icon" />
          <div>
            <h4 className="attribution-heading">Creator Attribution & Fair Use Credit (TASL)</h4>
            <p className="attribution-subheading">
              Please kindly credit and support the original creator when sharing or using this media on social media, YouTube, or blogs.
            </p>
          </div>
        </div>
        <div className="attribution-actions">
          <button
            type="button"
            onClick={handleCopy}
            className="btn-attribution-action"
            title="Copy attribution text to clipboard"
          >
            {copied ? <CheckCircle size={15} color="#10b981" /> : <Clipboard size={15} />}
            {copied ? 'Copied!' : 'Copy Attribution'}
          </button>
          <button
            type="button"
            onClick={handleDownload}
            className="btn-attribution-action btn-attribution-download"
            title="Download attribution as .TXT file"
          >
            <Download size={15} /> Download .TXT
          </button>
        </div>
      </div>
      <div className="attribution-snippet-box">
        <code>{text}</code>
      </div>
    </div>
  );
}
