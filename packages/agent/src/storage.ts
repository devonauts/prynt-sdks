// Redundant client persistence: first-party cookie + localStorage + IndexedDB.
// A visitor who clears ONE store usually keeps another; the server reconciles all three
// with the fingerprint match. These are HINTS — the server never trusts them blindly.

const KEY = '__prynt_id';
const DB = '__prynt';
const STORE = 'kv';

function readCookie(): string | null {
  try {
    const m = document.cookie.match(new RegExp('(?:^|; )' + KEY + '=([^;]*)'));
    return m ? decodeURIComponent(m[1]) : null;
  } catch { return null; }
}
function writeCookie(v: string): void {
  try {
    const secure = location.protocol === 'https:' ? '; Secure' : '';
    // 1 year, first-party, lax so it survives top-level navigations
    document.cookie = `${KEY}=${encodeURIComponent(v)}; Max-Age=31536000; Path=/; SameSite=Lax${secure}`;
  } catch { /* blocked */ }
}
function readLocal(): string | null { try { return localStorage.getItem(KEY); } catch { return null; } }
function writeLocal(v: string): void { try { localStorage.setItem(KEY, v); } catch { /* blocked */ } }

function idbGet(): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => { try { req.result.createObjectStore(STORE); } catch { /* exists */ } };
      req.onerror = () => resolve(null);
      req.onsuccess = () => {
        try {
          const db = req.result;
          if (!db.objectStoreNames.contains(STORE)) { db.close(); return resolve(null); }
          const tx = db.transaction(STORE, 'readonly');
          const g = tx.objectStore(STORE).get(KEY);
          g.onsuccess = () => { resolve((g.result as string) || null); db.close(); };
          g.onerror = () => { resolve(null); db.close(); };
        } catch { resolve(null); }
      };
    } catch { resolve(null); }
  });
}
function idbSet(v: string): Promise<void> {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => { try { req.result.createObjectStore(STORE); } catch { /* exists */ } };
      req.onerror = () => resolve();
      req.onsuccess = () => {
        try {
          const db = req.result;
          if (!db.objectStoreNames.contains(STORE)) { db.close(); return resolve(); }
          const tx = db.transaction(STORE, 'readwrite');
          tx.objectStore(STORE).put(v, KEY);
          tx.oncomplete = () => { resolve(); db.close(); };
          tx.onerror = () => { resolve(); db.close(); };
        } catch { resolve(); }
      };
    } catch { resolve(); }
  });
}

export interface IdentityHints { cookie: string | null; local: string | null; indexeddb: string | null; }

export async function readHints(): Promise<IdentityHints> {
  const [indexeddb] = await Promise.all([idbGet()]);
  return { cookie: readCookie(), local: readLocal(), indexeddb };
}

// Persist the server-authoritative token to every available store.
export async function persist(token: string): Promise<void> {
  writeCookie(token);
  writeLocal(token);
  await idbSet(token);
}
