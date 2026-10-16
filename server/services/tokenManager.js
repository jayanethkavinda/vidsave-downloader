/**
 * VidSave Download Handshake Token Manager
 * Tracks real-time arrival of download streams to synchronize button animations
 * with the exact moment the browser download manager starts.
 */
const downloadTokens = new Map();

export function registerDownloadToken(token) {
  if (!token) return;
  downloadTokens.set(token, { status: 'waiting', timestamp: Date.now() });
  // Auto-cleanup after 3 minutes
  const timer = setTimeout(() => {
    downloadTokens.delete(token);
  }, 3 * 60 * 1000);
  if (timer.unref) timer.unref();
}

export function markDownloadStarted(token) {
  if (!token) return;
  const current = downloadTokens.get(token);
  if (current) {
    current.status = 'started';
    current.startedAt = Date.now();
  } else {
    downloadTokens.set(token, { status: 'started', timestamp: Date.now() });
    const timer = setTimeout(() => { downloadTokens.delete(token); }, 60 * 1000);
    if (timer.unref) timer.unref();
  }
}

export function markDownloadError(token, errorMessage) {
  if (!token) return;
  const current = downloadTokens.get(token);
  if (current) {
    current.status = 'error';
    current.error = errorMessage;
  }
}

export function getDownloadStatus(token) {
  if (!token) return { status: 'unknown' };
  const current = downloadTokens.get(token);
  if (!current) return { status: 'unknown' };
  return { status: current.status, error: current.error || null };
}
