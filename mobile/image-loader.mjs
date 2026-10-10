import { createImageCache, localDay } from './image-cache.mjs';

async function checkImage(blob) {
  const url = URL.createObjectURL(blob);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
  } finally { URL.revokeObjectURL(url); }
}

export function createImageLoader({ cache = createImageCache(), now = () => new Date() } = {}) {
  const pending = new Map();
  function clearExpired() {
    const day = localDay(now());
    for (const entry of pending.values()) if (entry.day !== day) entry.controller.abort();
    return cache.clearExpired();
  }
  function load(source, revision, { retry = false, priority = 'high' } = {}) {
    const url = new URL(source, location.href).href;
    const day = localDay(now());
    const key = `${revision}|${url}`;
    const requestKey = `${day}|${key}`;
    if (pending.has(requestKey)) {
      if (!retry) return pending.get(requestKey).promise;
      pending.get(requestKey).controller.abort();
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);
    const promise = (async () => {
      try {
        if (!retry) {
          const blob = await cache.get(key);
          if (blob) return blob;
        }
        const response = await fetch(url, { cache: 'no-store', signal: controller.signal, priority });
        if (!response.ok) throw new Error('image unavailable');
        const blob = await response.blob();
        await checkImage(blob);
        if (controller.signal.aborted) throw new DOMException('image request timed out', 'AbortError');
        if (day === localDay(now())) await cache.put(key, blob);
        return blob;
      } finally {
        clearTimeout(timeout);
        if (pending.get(requestKey)?.controller === controller) pending.delete(requestKey);
      }
    })();
    pending.set(requestKey, { promise, controller, day });
    return promise;
  }
  return { load, clearExpired };
}
