import dns from 'node:dns/promises';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

/**
 * Check if an IPv4 or IPv6 address belongs to private / loopback / link-local / cloud metadata ranges
 */
export function isPrivateIp(ip) {
  if (!ip) return true;

  // Normalize IPv4-mapped IPv6 (e.g. ::ffff:127.0.0.1 -> 127.0.0.1)
  if (ip.startsWith('::ffff:')) {
    ip = ip.replace('::ffff:', '');
  }

  // IPv6 loopback / unique local / link-local
  if (ip === '::1' || ip === '::' || /^fe80:/i.test(ip) || /^fc00:/i.test(ip) || /^fd00:/i.test(ip)) {
    return true;
  }

  // IPv4 checks
  const parts = ip.split('.').map(Number);
  if (parts.length === 4 && parts.every(p => !isNaN(p) && p >= 0 && p <= 255)) {
    const [b0, b1] = parts;
    if (b0 === 0) return true; // 0.0.0.0/8
    if (b0 === 10) return true; // 10.0.0.0/8
    if (b0 === 127) return true; // 127.0.0.0/8
    if (b0 === 169 && b1 === 254) return true; // 169.254.0.0/16 Link-local & Cloud Metadata (AWS/GCP/Render)
    if (b0 === 172 && b1 >= 16 && b1 <= 31) return true; // 172.16.0.0/12
    if (b0 === 192 && b1 === 168) return true; // 192.168.0.0/16
    return false;
  }

  return false;
}

/**
 * Validate URL to prevent SSRF (Server-Side Request Forgery)
 * Verifies protocol is http/https and resolves DNS to ensure target is NOT a local or private address
 */
export async function assertSafeUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') {
    throw new Error('A valid URL string is required.');
  }

  const trimmed = rawUrl.trim();
  if (trimmed.length > 2048) {
    throw new Error('URL exceeds maximum allowable length.');
  }

  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch (err) {
    throw new Error('Invalid URL format.');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Only HTTP and HTTPS protocols are permitted.');
  }

  const hostname = parsed.hostname.toLowerCase();

  // Instant string checks for common local identifiers
  if (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '0.0.0.0' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal')
  ) {
    throw new Error('Access to local address is prohibited.');
  }

  // Check if hostname is direct IP
  if (isPrivateIp(hostname)) {
    throw new Error('Access to private network address is prohibited.');
  }

  // Resolve DNS to verify all underlying IP addresses
  try {
    const records = await dns.lookup(hostname, { all: true });
    for (const record of records) {
      if (isPrivateIp(record.address)) {
        throw new Error(`Resolved address ${record.address} is a restricted private network address.`);
      }
    }
  } catch (dnsErr) {
    if (dnsErr.message.includes('restricted private network address')) {
      throw dnsErr;
    }
    throw new Error(`Unable to resolve hostname "${hostname}": ${dnsErr.message}`);
  }

  return parsed.href;
}

/**
 * SSRF-Safe HTTP fetch with manual redirect loop validation
 */
export async function safeFetch(rawUrl, opts = {}, hops = 3) {
  const safeHref = await assertSafeUrl(rawUrl);
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), opts.timeout || 15000);

  try {
    const res = await fetch(safeHref, {
      ...opts,
      redirect: 'manual',
      signal: controller.signal
    });

    if ([301, 302, 303, 307, 308].includes(res.status) && res.headers.get('location')) {
      if (hops <= 0) {
        throw new Error('Too many redirects');
      }
      const redirectTarget = new URL(res.headers.get('location'), safeHref).href;
      return await safeFetch(redirectTarget, opts, hops - 1);
    }

    return res;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Validate that upstream Content-Type is legitimate media to block Reflected XSS
 */
export function isMediaContentType(contentType = '') {
  const ct = contentType.toLowerCase().trim();
  if (!ct) return true; // empty content-type permitted for raw binary stream fallback
  if (
    ct.includes('text/html') ||
    ct.includes('application/xhtml+xml') ||
    ct.includes('text/javascript') ||
    ct.includes('application/javascript')
  ) {
    return false;
  }
  return (
    ct.startsWith('video/') ||
    ct.startsWith('audio/') ||
    ct.includes('mpegurl') ||
    ct.includes('mp4') ||
    ct.includes('octet-stream')
  );
}

/**
 * Cleanly kill an entire process tree (cross-platform for Windows and Linux)
 */
export function killProcessTree(child) {
  if (!child || child.killed || !child.pid) return;

  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/pid', child.pid.toString(), '/T', '/F'], { windowsHide: true });
    } catch (_) {
      try { child.kill('SIGKILL'); } catch (_) {}
    }
  } else {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch (_) {
      try { child.kill('SIGKILL'); } catch (_) {}
    }
  }
}

/**
 * Concurrency Limiter Middleware for heavy tasks (yt-dlp, FFmpeg, transcode, video streams)
 * Limits total simultaneous jobs to MAX_ACTIVE_HEAVY to prevent Render 512MB RAM OOM crashes.
 */
let activeHeavyCount = 0;
const MAX_ACTIVE_HEAVY = 2; // Render Free Tier has 512MB RAM: limit to 2 simultaneous heavy jobs
const perIpActive = new Map();

export function heavyConcurrencyGuard(req, res, next) {
  const clientIp = req.ip || req.connection?.remoteAddress || 'unknown';
  const ipCurrent = perIpActive.get(clientIp) || 0;

  if (activeHeavyCount >= MAX_ACTIVE_HEAVY || ipCurrent >= 1) {
    res.set('Retry-After', '8');
    return res.status(503).json({
      error: 'Server is currently busy processing video downloads. Please retry in a few seconds.'
    });
  }

  activeHeavyCount++;
  perIpActive.set(clientIp, ipCurrent + 1);

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    activeHeavyCount = Math.max(0, activeHeavyCount - 1);
    const updated = (perIpActive.get(clientIp) || 1) - 1;
    if (updated > 0) perIpActive.set(clientIp, updated);
    else perIpActive.delete(clientIp);
  };

  res.once('close', release);
  res.once('finish', release);
  next();
}

/**
 * Temp directory janitor: periodically removes orphaned vidsave_* temp files older than 20 minutes
 */
export function cleanOldTempFiles() {
  try {
    const tempDir = os.tmpdir();
    const files = fs.readdirSync(tempDir);
    const now = Date.now();
    const maxAge = 20 * 60 * 1000; // 20 minutes

    for (const file of files) {
      if (file.startsWith('vidsave_')) {
        const fullPath = path.join(tempDir, file);
        try {
          const stats = fs.statSync(fullPath);
          if (now - stats.mtimeMs > maxAge) {
            fs.unlinkSync(fullPath);
          }
        } catch (_) {}
      }
    }
  } catch (_) {}
}

// Run janitor on server startup and every 30 minutes
cleanOldTempFiles();
const janitorInterval = setInterval(cleanOldTempFiles, 30 * 60 * 1000);
if (janitorInterval.unref) {
  janitorInterval.unref();
}
