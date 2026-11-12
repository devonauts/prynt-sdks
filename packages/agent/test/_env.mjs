// Shared fake browser for the Reveal tests (reveal.test.mjs, consent_cmp.test.mjs). Not a test
// file itself (`node --test test/*.test.mjs` skips it). The modules are bundled in-memory with
// esbuild (already a devDependency) and imported from a data: URL; the browser surface they touch
// (window/document/location/history/navigator/localStorage/fetch/timers) is the tiny shim below.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSync } from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
export async function load(file = '_all.ts') {
  const built = buildSync({
    entryPoints: [path.join(here, file)],
    bundle: true, format: 'esm', write: false, target: 'es2019', logLevel: 'silent',
  });
  return import('data:text/javascript;base64,' + Buffer.from(built.outputFiles[0].text).toString('base64'));
}

export const ENDPOINT = 'https://api.pryntid.test';
export const COLLECT = ENDPOINT + '/v1/reveal/collect';

export class Target {
  constructor() { this.ls = {}; }
  addEventListener(t, fn) { (this.ls[t] = this.ls[t] || []).push(fn); }
  removeEventListener(t, fn) { this.ls[t] = (this.ls[t] || []).filter((f) => f !== fn); }
  emit(t, ev = {}) { for (const fn of [...(this.ls[t] || [])]) fn({ type: t, ...ev }); }
  count() { return Object.values(this.ls).reduce((a, b) => a + b.length, 0); }
}

export const def = (k, v) => Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });

const realSetInterval = globalThis.setInterval, realClearInterval = globalThis.clearInterval;

// Fresh fake browser for each test. Returns handles to drive it and to read what was sent.
// `createReveal` is the function under test, passed in by the test file.
export function setup(createReveal, { href = 'https://www.acme.com/pricing?utm_source=linkedin&utm_medium=social&gclid=abc123', lang = '', tz = 'America/New_York', cookie = '', ua = '' } = {}) {
  const env = { now: 1_760_000_000_000, calls: [], beacons: [], status: 202, fail: 0, storageThrows: false, store: {}, intervals: [], mounted: [] };
  const win = new Target(); const doc = new Target();
  const loc = { href, hostname: new URL(href).hostname, search: new URL(href).search };
  const nav = (u) => { loc.href = new URL(u, loc.href).href; loc.hostname = new URL(loc.href).hostname; loc.search = new URL(loc.href).search; };
  const hist = { pushState: (s, t, u) => nav(u), replaceState: (s, t, u) => nav(u) };
  const origPush = hist.pushState;
  win.scrollY = 0; win.innerHeight = 800; win.history = hist;
  doc.documentElement = { lang, scrollHeight: 2000 }; doc.title = 'Pricing'; doc.hidden = false; doc.referrer = 'https://www.google.com/';
  doc.cookie = cookie;
  // Minimal element factory for the debug panel.
  doc.createElement = () => { const el = new Target(); el.style = {}; el.innerHTML = ''; el.getAttribute = () => null; el.remove = () => { env.mounted = env.mounted.filter((m) => m !== el); }; return el; };
  doc.body = { appendChild: (el) => { env.mounted.push(el); } };
  def('window', win); def('document', doc); def('location', loc); def('history', hist);
  def('navigator', { userAgent: ua, sendBeacon: (u, b) => { env.beacons.push({ url: u, body: JSON.parse(b) }); return true; } });
  def('localStorage', {
    getItem: (k) => { if (env.storageThrows) throw new Error('blocked'); return k in env.store ? env.store[k] : null; },
    setItem: (k, v) => { if (env.storageThrows) throw new Error('blocked'); env.store[k] = String(v); },
  });
  def('fetch', (u, init) => {
    env.calls.push({ url: u, init, body: JSON.parse(init.body) });
    if (env.fail > 0) { env.fail--; return Promise.reject(new TypeError('Failed to fetch')); }
    const status = env.status;
    return Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve({ accepted: env.accepted ?? JSON.parse(init.body).events.length, duplicates: 0 }) });
  });
  // Intervals are captured (never scheduled) so tests can run a tick on demand with s.tick().
  globalThis.setInterval = (fn) => { const id = { fn }; env.intervals.push(id); return id; };
  globalThis.clearInterval = (id) => { env.intervals = env.intervals.filter((i) => i !== id); };
  Date.now = () => env.now;
  Intl.DateTimeFormat = () => ({ resolvedOptions: () => ({ timeZone: tz }) });
  let vid = 'vst_abc';
  const make = (opts = {}) => createReveal({ publicKey: 'pk_test_x', endpoint: ENDPOINT, consent: true, ...opts }, 'https://unused', () => vid, '1.0.0');
  const events = () => env.calls.flatMap((c) => c.body.events);
  const tick = () => { for (const i of env.intervals.slice()) i.fn(); };
  return { env, win, doc, loc, hist, origPush, nav, make, events, tick, setVid: (v) => { vid = v; } };
}

export function restoreTimers() { globalThis.setInterval = realSetInterval; globalThis.clearInterval = realClearInterval; }
