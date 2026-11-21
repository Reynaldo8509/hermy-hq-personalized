export function createAsyncTtlCache<T>(
  ttlMs: number,
  maxEntries?: number,
): (key: string, loader: () => Promise<T> | T, now?: number) => Promise<T>;
