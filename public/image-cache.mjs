export const IMAGE_CACHE_LIMIT = 100 * 1024 * 1024;

export function localDay(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function timeoutError() {
  return new DOMException('image storage timed out', 'TimeoutError');
}

function openDatabase(provider, name, timeoutMs) {
  if (!provider) return Promise.resolve(null);
  return new Promise(resolve => {
    let request;
    try { request = provider.open(name, 1); } catch { resolve(null); return; }
    let settled = false;
    const timeout = setTimeout(() => finish(null), timeoutMs);
    const finish = db => { if (settled) { db?.close(); return; } settled = true; clearTimeout(timeout); resolve(db); };
    request.onupgradeneeded = () => {
      const db = request.result;
      db.createObjectStore('images');
      db.createObjectStore('metadata', { keyPath: 'key' });
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => db.close();
      finish(db);
    };
    request.onerror = request.onblocked = () => finish(null);
  });
}

function transaction(db, operation, timeoutMs) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['images', 'metadata'], 'readwrite');
    let result;
    const timeout = setTimeout(() => {
      reject(timeoutError());
      try { tx.abort(); } catch { /* Already completed or disconnected. */ }
    }, timeoutMs);
    tx.oncomplete = () => { clearTimeout(timeout); resolve(result); };
    tx.onabort = tx.onerror = () => { clearTimeout(timeout); reject(tx.error || new Error('image cache unavailable')); };
    operation(tx.objectStore('images'), tx.objectStore('metadata'), value => { result = value; });
  });
}

// Metadata is kept apart from blobs: expiration and capacity checks never read
// all image bytes into memory. A single transaction serializes competing tabs.
export function createImageCache(options = {}) {
  const { maxBytes = IMAGE_CACHE_LIMIT, now = () => new Date(), dbName = 'jlpt-image-cards:images', timeoutMs = 1500 } = options;
  let provider;
  try { provider = Object.hasOwn(options, 'indexedDB') ? options.indexedDB : globalThis.indexedDB; } catch { provider = null; }
  const database = openDatabase(provider, dbName, timeoutMs);
  let disabled = false;
  async function run(operation, fallback) {
    if (disabled) return fallback;
    try {
      const db = await database;
      return db ? await transaction(db, operation, timeoutMs) : fallback;
    } catch (error) {
      if (error.name === 'TimeoutError') disabled = true;
      return fallback; // Private mode, quota errors or stalled storage must not block reading.
    }
  }
  function prune(records, images, metadata, day) {
    return records.filter(record => {
      if (record.day === day) return true;
      images.delete(record.key); metadata.delete(record.key);
      return false;
    });
  }
  const api = {
    get(key) {
      return run((images, metadata, finish) => {
        const request = metadata.getAll();
        request.onsuccess = () => {
          const date = now();
          const entries = prune(request.result, images, metadata, localDay(date));
          const entry = entries.find(record => record.key === key);
          if (!entry) { finish(null); return; }
          const image = images.get(key);
          image.onsuccess = () => {
            metadata.put({ ...entry, used: date.getTime() });
            finish(image.result ? new Blob([image.result], { type: entry.type }) : null);
          };
        };
      }, null);
    },
    async put(key, blob) {
      // ArrayBuffer storage also works in WebKit environments that cannot
      // persist Blob backing files. Reconstruct the MIME type when reading.
      let data;
      try { data = await blob.arrayBuffer(); } catch { return false; }
      return run((images, metadata, finish) => {
        const request = metadata.getAll();
        request.onsuccess = () => {
          const date = now(); const day = localDay(date);
          const entries = prune(request.result, images, metadata, day);
          if (blob.size > maxBytes) { finish(false); return; }
          const other = entries.filter(record => record.key !== key).sort((a, b) => a.used - b.used);
          let bytes = other.reduce((sum, record) => sum + record.bytes, 0) + blob.size;
          for (const entry of other) {
            if (bytes <= maxBytes) break;
            images.delete(entry.key); metadata.delete(entry.key); bytes -= entry.bytes;
          }
          images.put(data, key);
          metadata.put({ key, bytes: blob.size, type: blob.type, used: date.getTime(), day });
          finish(true);
        };
      }, false);
    },
    clearExpired() {
      return run((images, metadata, finish) => {
        const request = metadata.getAll();
        request.onsuccess = () => {
          const entries = prune(request.result, images, metadata, localDay(now()));
          finish({ entries: entries.length, bytes: entries.reduce((sum, record) => sum + record.bytes, 0) });
        };
      }, { entries: 0, bytes: 0 });
    },
    stats() { return api.clearExpired(); },
  };
  return api;
}
