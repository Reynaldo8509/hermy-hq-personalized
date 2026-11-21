export function createAsyncTtlCache(ttlMs, maxEntries = 4) {
  const entries = new Map();
  const ttl = Math.max(1, Number(ttlMs) || 1);
  const capacity = Math.max(1, Number(maxEntries) || 1);

  return async function get(key, loader, now = Date.now()) {
    const cached = entries.get(key);
    if (cached && cached.expiresAt > now) {
      entries.delete(key);
      entries.set(key, cached);
      return cached.promise;
    }
    if (cached) entries.delete(key);

    const entry = { expiresAt: now + ttl, promise: Promise.resolve().then(loader) };
    entries.set(key, entry);
    while (entries.size > capacity) entries.delete(entries.keys().next().value);

    try {
      return await entry.promise;
    } catch (error) {
      if (entries.get(key) === entry) entries.delete(key);
      throw error;
    }
  };
}
