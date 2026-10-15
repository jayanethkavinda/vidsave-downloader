import dns from 'dns/promises';
import { exec } from 'child_process';

// File Size Quotas: 1.5 GB for YouTube, 3.0 GB for other social media platforms
export const MAX_FILESIZE_BYTES_YOUTUBE = 1.5 * 1024 * 1024 * 1024; // 1.5 GB
export const MAX_FILESIZE_BYTES_OTHER = 3.0 * 1024 * 1024 * 1024;   // 3.0 GB

// Allowed Social Media & Video Platforms Regex
const ALLOWED_PLATFORM_DOMAINS = [
  /^(?:[a-zA-Z0-9-]+\.)*youtube\.com$/i,
  /^youtu\.be$/i,
  /^(?:[a-zA-Z0-9-]+\.)*facebook\.com$/i,
  /^fb\.watch$/i,
  /^(?:[a-zA-Z0-9-]+\.)*instagram\.com$/i,
  /^instagr\.am$/i,
  /^(?:[a-zA-Z0-9-]+\.)*tiktok\.com$/i,
  /^vt\.tiktok\.com$/i,
  /^(?:[a-zA-Z0-9-]+\.)*tt\.site$/i,
  /^(?:[a-zA-Z0-9-]+\.)*pinterest\.com$/i,
  /^pin\.it$/i,
  /^(?:[a-zA-Z0-9-]+\.)*twitter\.com$/i,
  /^(?:[a-zA-Z0-9-]+\.)*x\.com$/i,
  /^(?:[a-zA-Z0-9-]+\.)*threads\.net$/i,
  /^(?:[a-zA-Z0-9-]+\.)*reddit\.com$/i,
  /^(?:[a-zA-Z0-9-]+\.)*vimeo\.com$/i,
  /^(?:[a-zA-Z0-9-]+\.)*dailymotion\.com$/i,
  /^dai\.ly$/i,
  /^(?:[a-zA-Z0-9-]+\.)*linkedin\.com$/i,
];

// Private / Local IPv4 and IPv6 patterns for SSRF prevention
const PRIVATE_IP_PATTERNS = [
  /^127\./,
  /^10\./,
  /^172\.(1[6-9]|2[0-9]|3[0-1])\./,
  /^192\.168\./,
  /^169\.254\./, // AWS / Cloud metadata endpoint
  /^0\./,
  /^::1$/,
  /^fc00:/i,
  /^fe80:/i,
];

/**
 * Validates URL against Domain Allowlist and blocks SSRF / Localhost exploitation.
 */
export async function assertSafeUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') {
    throw new Error('Valid video URL is required.');
  }

  let parsed;
  try {
    parsed = new URL(rawUrl.trim());
  } catch (_) {
    throw new Error('Malformed URL provided.');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Only HTTP and HTTPS URLs are supported.');
  }

  const hostname = parsed.hostname.toLowerCase();

  // 1. Strict Domain Allowlist verification
  const isAllowedDomain = ALLOWED_PLATFORM_DOMAINS.some(pattern => pattern.test(hostname));
  if (!isAllowedDomain) {
    throw new Error('Unsupported platform. Only YouTube, Facebook, Instagram, TikTok, Pinterest, Twitter/X, Threads, Reddit, and Vimeo are supported.');
  }

  // 2. Resolve DNS to ensure destination IP is not a private/internal network (Anti-SSRF)
  try {
    const addresses = await dns.lookup(hostname, { all: true });
    for (const addr of addresses) {
      const isPrivate = PRIVATE_IP_PATTERNS.some(pat => pat.test(addr.address));
      if (isPrivate) {
        throw new Error('Access to private or local network resources is strictly forbidden.');
      }
    }
  } catch (dnsErr) {
    if (dnsErr.message.includes('strictly forbidden')) throw dnsErr;
    // Allow pass-through if DNS lookup is temporarily constrained in certain proxy runtimes
  }

  return parsed.toString();
}

/**
 * Sanitizes file title string to prevent HTTP Header Injection (CRLF) and invalid filename characters.
 */
export function sanitizeFilename(rawTitle = 'media', ext = 'mp4') {
  const safeExt = /^[a-zA-Z0-9]{1,6}$/.test(ext) ? ext : 'mp4';
  const sanitized = String(rawTitle)
    .replace(/[\r\n\0]/g, '') // Strip CRLF / null bytes
    .replace(/[^\w\s\u0D80-\u0DFF.-]/gi, '') // Support English, numbers, Sinhala Unicode
    .trim()
    .substring(0, 80) || 'media';

  const asciiName = sanitized.replace(/[^\w\s.-]/g, '_').replace(/\s+/g, ' ').trim() || 'media';
  return {
    filename: `${sanitized}.${safeExt}`,
    contentDisposition: `attachment; filename="${asciiName}.${safeExt}"; filename*=UTF-8''${encodeURIComponent(sanitized)}.${safeExt}`
  };
}

/**
 * Robust, cross-platform process tree killer to release RAM & CPU immediately on client disconnect.
 */
export function killProcessTree(childProcess) {
  if (!childProcess || !childProcess.pid) return;
  const pid = childProcess.pid;

  if (process.platform === 'win32') {
    exec(`taskkill /PID ${pid} /T /F`, () => {});
  } else {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch (_) {
      try {
        childProcess.kill('SIGKILL');
      } catch (_) {}
    }
  }
}
