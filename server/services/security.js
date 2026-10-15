import dns from 'dns/promises';
import { exec } from 'child_process';

// File Size Quotas (Protects Render 512MB RAM and disk limits)
export const MAX_FILESIZE_BYTES_YOUTUBE = 1.5 * 1024 * 1024 * 1024; // 1.5 GB
export const MAX_FILESIZE_BYTES_OTHER = 3.0 * 1024 * 1024 * 1024;   // 3.0 GB

// Private & Internal Network IP patterns for anti-SSRF defense
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
 * Universal URL Validator:
 * Supports 1,000+ video platforms and all short domains (tt.site, pin.it, youtu.be, etc.)
 * Strictly blocks Localhost & Internal Cloud IP attacks (SSRF).
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

  // Block obvious localhost attempts
  if (hostname === 'localhost' || hostname.endsWith('.local') || hostname === '127.0.0.1') {
    throw new Error('Access to local network resources is forbidden.');
  }

  // Prevent SSRF / Internal IP exploitation
  try {
    const addresses = await dns.lookup(hostname, { all: true });
    for (const addr of addresses) {
      if (PRIVATE_IP_PATTERNS.some(pat => pat.test(addr.address))) {
        throw new Error('Access to internal cloud infrastructure is forbidden.');
      }
    }
  } catch (dnsErr) {
    if (dnsErr.message.includes('forbidden')) throw dnsErr;
  }

  return parsed.toString();
}

/**
 * Sanitizes filename to prevent HTTP Header Injection (CRLF) and support international Unicode characters.
 */
export function sanitizeFilename(rawTitle = 'media', ext = 'mp4') {
  const safeExt = /^[a-zA-Z0-9]{1,6}$/.test(ext) ? ext : 'mp4';
  const sanitized = String(rawTitle)
    .replace(/[\r\n\0]/g, '')
    .replace(/[^\w\s\u0D80-\u0DFF.-]/gi, '')
    .trim()
    .substring(0, 80) || 'media';

  const asciiName = sanitized.replace(/[^\w\s.-]/g, '_').replace(/\s+/g, ' ').trim() || 'media';
  return {
    filename: `${sanitized}.${safeExt}`,
    contentDisposition: `attachment; filename="${asciiName}.${safeExt}"; filename*=UTF-8''${encodeURIComponent(sanitized)}.${safeExt}`
  };
}

/**
 * Cross-platform child process tree killer to release RAM & CPU immediately.
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
