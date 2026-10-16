/**
 * Extract structured subtitles from raw yt-dlp metadata
 */
export function extractSubtitles(rawInfo) {
  if (!rawInfo) return [];
  const subtitles = [];
  const seenKeys = new Set();

  let dn = null;
  try {
    dn = new Intl.DisplayNames(['en'], { type: 'language' });
  } catch (_) {}

  const getLangName = (code) => {
    try {
      if (dn) {
        const base = code.split('-')[0].toLowerCase();
        return dn.of(code) || dn.of(base) || code.toUpperCase();
      }
    } catch (_) {}
    return code.toUpperCase();
  };

  // 1. Official / Manual Subtitles (higher accuracy)
  if (rawInfo.subtitles && typeof rawInfo.subtitles === 'object') {
    for (const [langCode, formats] of Object.entries(rawInfo.subtitles)) {
      if (!Array.isArray(formats) || formats.length === 0) continue;

      const bestFmt = formats.find(f => f.ext === 'vtt' && !f.url?.includes('m3u8'))
        || formats.find(f => f.ext === 'srt')
        || formats.find(f => f.url && !f.url?.includes('m3u8'))
        || formats[0];

      let subUrl = bestFmt.url || null;
      if (subUrl && subUrl.includes('timedtext') && subUrl.includes('fmt=')) {
        subUrl = subUrl.replace(/fmt=[^&]+/, 'fmt=vtt');
      }

      const langName = formats[0].name || getLangName(langCode);
      const uniqueKey = `manual_${langCode.toLowerCase()}`;
      seenKeys.add(uniqueKey);

      subtitles.push({
        id: uniqueKey,
        code: langCode,
        language: langName,
        isAuto: false,
        url: subUrl,
        exts: ['srt', 'vtt']
      });
    }
  }

  // 2. Auto-Generated Captions (100+ languages including Sinhala)
  if (rawInfo.automatic_captions && typeof rawInfo.automatic_captions === 'object') {
    for (const [langCode, formats] of Object.entries(rawInfo.automatic_captions)) {
      if (!Array.isArray(formats) || formats.length === 0) continue;

      const bestFmt = formats.find(f => f.ext === 'vtt' && !f.url?.includes('m3u8'))
        || formats.find(f => f.url && !f.url?.includes('m3u8'))
        || formats[0];

      let subUrl = bestFmt.url || null;
      if (subUrl && subUrl.includes('timedtext') && subUrl.includes('fmt=')) {
        subUrl = subUrl.replace(/fmt=[^&]+/, 'fmt=vtt');
      }

      const langName = formats[0].name || getLangName(langCode);
      const uniqueKey = `auto_${langCode.toLowerCase()}`;
      if (seenKeys.has(uniqueKey)) continue;
      seenKeys.add(uniqueKey);

      subtitles.push({
        id: uniqueKey,
        code: langCode,
        language: langName,
        isAuto: true,
        url: subUrl,
        exts: ['srt', 'vtt']
      });
    }
  }

  // Prioritize most common languages
  const priorityLangs = ['en', 'si', 'es', 'fr', 'de', 'hi', 'ja', 'zh', 'ar', 'ru', 'pt', 'it', 'id', 'ta'];

  subtitles.sort((a, b) => {
    if (a.isAuto !== b.isAuto) return a.isAuto ? 1 : -1;
    const aBase = a.code.split('-')[0].toLowerCase();
    const bBase = b.code.split('-')[0].toLowerCase();
    const aPriority = priorityLangs.indexOf(aBase);
    const bPriority = priorityLangs.indexOf(bBase);

    if (aPriority !== -1 && bPriority === -1) return -1;
    if (aPriority === -1 && bPriority !== -1) return 1;
    if (aPriority !== -1 && bPriority !== -1) return aPriority - bPriority;

    return a.language.localeCompare(b.language);
  });

  return subtitles;
}

/**
 * Convert standard WEBVTT subtitle text to SRT format
 */
export function convertVttToSrt(vttContent) {
  if (!vttContent) return '';
  const lines = vttContent.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const srt = [];
  let counter = 1;
  let inHeader = true;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (inHeader) {
      if (line === '' || line.includes('-->')) inHeader = false;
      if (inHeader) continue;
    }

    if (line.includes('-->')) {
      srt.push(counter++);
      const timeLine = line
        .replace(/(\d{2}:\d{2}:\d{2})\.(\d{3})/g, '$1,$2')
        .replace(/(\d{2}:\d{2})\.(\d{3})/g, '00:$1,$2')
        .replace(/\s+[a-z]+:[^\s]+/gi, '')
        .trim();
      srt.push(timeLine);
      i++;
      while (i < lines.length && lines[i].trim() !== '') {
        const textLine = lines[i].replace(/<[^>]+>/g, '').trim();
        if (textLine) srt.push(textLine);
        i++;
      }
      srt.push('');
    }
  }
  return srt.join('\r\n');
}

/**
 * Convert YouTube SRV1/XML transcript to clean WEBVTT
 */
export function convertSrv1ToVtt(xmlContent) {
  if (!xmlContent) return 'WEBVTT\n';
  const regex = /<text start="([\d.]+)" dur="([\d.]+)"[^>]*>([\s\S]*?)<\/text>/gi;
  let match;
  const vtt = ['WEBVTT\n'];

  function secToTime(sec) {
    const s = Math.max(0, parseFloat(sec) || 0);
    const hrs = Math.floor(s / 3600).toString().padStart(2, '0');
    const mins = Math.floor((s % 3600) / 60).toString().padStart(2, '0');
    const secs = Math.floor(s % 60).toString().padStart(2, '0');
    const ms = Math.floor((s % 1) * 1000).toString().padStart(3, '0');
    return `${hrs}:${mins}:${secs}.${ms}`;
  }

  while ((match = regex.exec(xmlContent)) !== null) {
    const start = parseFloat(match[1]);
    const dur = parseFloat(match[2]);
    const end = start + dur;
    let text = match[3]
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .trim();
    if (text) {
      vtt.push(`${secToTime(start)} --> ${secToTime(end)}\n${text}\n`);
    }
  }
  return vtt.join('\n');
}
