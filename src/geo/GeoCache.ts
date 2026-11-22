import type { TileData } from '../world/types';

/**
 * Persistent tile cache on IndexedDB. Stores processed tiles (already
 * projected and split into chunks), so a revisit costs neither a network
 * request nor a re-parse.
 *
 * Bounded: when the store grows past MAX_TILES the least recently written
 * records are evicted. All failures degrade to "no cache" rather than errors.
 */

const DB_NAME = 'citywalk';
const STORE = 'tiles';
/** Bump when the stored tile format or the OSM query changes. */
export const CACHE_VERSION = 4;
const MAX_TILES = 240;
const MAX_AGE_MS = 30 * 24 * 3600 * 1000;

interface CacheRecord {
  key: string;
  v: number;
  t: number;
  tile: TileData;
}

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') return resolve(null);
    try {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const store = req.result.createObjectStore(STORE, { keyPath: 'key' });
        store.createIndex('t', 't');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbPromise;
}

export async function cacheGet(key: string): Promise<TileData | null> {
  const db = await openDb();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
      req.onsuccess = () => {
        const rec = req.result as CacheRecord | undefined;
        if (!rec || rec.v !== CACHE_VERSION || Date.now() - rec.t > MAX_AGE_MS) return resolve(null);
        resolve(rec.tile);
      };
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

export async function cachePut(tile: TileData): Promise<void> {
  const db = await openDb();
  if (!db) return;
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(STORE, 'readwrite');
      const rec: CacheRecord = { key: tile.key, v: CACHE_VERSION, t: Date.now(), tile };
      tx.objectStore(STORE).put(rec);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    } catch {
      resolve();
    }
  });
  if (Math.random() < 0.1) void evict(db);
}

/** Delete the oldest records beyond MAX_TILES. */
function evict(db: IDBDatabase): Promise<void> {
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      const count = store.count();
      count.onsuccess = () => {
        let excess = count.result - MAX_TILES;
        if (excess <= 0) return;
        const cursor = store.index('t').openCursor();
        cursor.onsuccess = () => {
          const c = cursor.result;
          if (!c || excess <= 0) return;
          c.delete();
          excess--;
          c.continue();
        };
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    } catch {
      resolve();
    }
  });
}

export async function cacheClear(): Promise<void> {
  const db = await openDb();
  if (!db) return;
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    } catch {
      resolve();
    }
  });
}
