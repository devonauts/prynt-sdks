// Prynt Replay recorder (docs/replay/README.md). Lives in its OWN bundle (src/replay_entry.ts →
// dist/prynt-replay.*, rrweb inside) so the core agent stays small: `Prynt.replay()` in the core
// bundle only injects /cdn/prynt-replay.umd.js on demand (replay_loader.ts).
//
// Privacy by design (the server enforces the same again before anything is stored):
//  * every input / textarea / select value is masked (rrweb maskAllInputs); passwords and card fields too;
//  * `data-prynt-mask` / class `prynt-mask` → text masked; `data-prynt-block` / class `prynt-block` → not
//    recorded; per-site extra selectors, "mask all text" with an allow-list, URL allow / deny rules;
//  * nothing is recorded without consent: GPC → never; consent resolved like Prynt.analytics() (setConsent,
//    the `consent` option, a detected CMP, else the EU/UK/CH default); site level `explicit` also refuses
//    the regional default; per-site sampling decided by the server per session id.
// Chunks: rrweb events buffered, gzip with the browser's CompressionStream (plain JSON where it is missing, and
// for the small last chunk on pagehide, when async work may not finish), POST /v1/replay/chunk every flushMs or
// ~512 kB, and on pagehide (sendBeacon / keepalive). Same session id as Analytics (`prynt_rvs`).
import { watchCmp } from './consent_cmp';
import type { ReplayClient, ReplayDiagnostics, ReplayOptions } from './index';

type RRRecord = ((o: Record<string, unknown>) => (() => void) | undefined) & {
  addCustomEvent: (tag: string, payload: unknown) => void;
  takeFullSnapshot: (isCheckout?: boolean) => void;
};
export interface ReplayDeps { record: RRRecord }
type Src = ReplayDiagnostics['consentSource'];
interface Cfg {
  record: boolean; reason: string | null; consentLevel: 'standard' | 'explicit'; maskAllText: boolean;
  maskSelector: string | null; unmaskSelector: string | null; blockSelector: string | null;
  urlAllow: string[]; urlDeny: string[]; captureErrors: boolean; maxChunkBytes: number; flushMs: number;
  // Developer tools (site settings, all off by default): console levels, every request (allow-listed), app state.
  devConsole?: string[]; devNetwork?: boolean; devNetworkAllow?: string[]; devState?: boolean;
  feedback?: object | null;   // the feedback widget's config when the site turned it on
  consoleUrl?: string;        // where the console lives (Sentry link)
  recordCanvas?: boolean;     // record <canvas> (site setting, off by default)
}
interface Ev { type: number; timestamp: number; data?: unknown }

const SKEY = 'prynt_rvs', QKEY = 'prynt_rps';
const SESSION_TTL = 30 * 60 * 1000;
const RAW_FLUSH_AT = 512 * 1024, BEACON_MAX = 60 * 1024, MAX_RETRIES = 3;
const EU_TZ = /^Europe\/|^Atlantic\/(Canary|Madeira|Azores|Reykjavik|Faroe)$|^Indian\/(Reunion|Mayotte)$|^America\/(Martinique|Guadeloupe|Cayenne|Marigot|St_Barthelemy)$/;
const EU_LANG = /^(de|fr|it|nl|pl|sv|da|fi|el|cs|hu|ro|bg|hr|sk|sl|et|lv|lt|mt|ga|is|nb|nn|no|lb)([-_]|$)|[-_](AT|BE|BG|HR|CY|CZ|DK|EE|FI|FR|DE|GR|HU|IE|IT|LV|LT|LU|MT|NL|PL|PT|RO|SK|SI|ES|SE|GB|UK|CH|NO|IS|LI)$/i;
const NET_MAX = 50, REQ_MAX = 300;   // failed requests reported per page (a broken polling endpoint must not flood the replay)
export const MASK_SELECTOR = '[data-prynt-mask],.prynt-mask';

export interface NetFail { method: string; url: string; status: number; durationMs: number; kind: 'fetch' | 'xhr' }

/** Failed network requests of the page (HTTP >= 400 or no response; aborts are not failures), reported as
    method + origin/path (no query, no fragment) + status + duration. Bodies and headers are never read. Requests
    to `skip` (the Prynt API itself) are ignored. Returns the undo function. */
export function watchNetwork(skip: string, report: (n: NetFail) => void, ok?: (n: NetFail) => void): () => void {
  const g = globalThis as unknown as { fetch?: typeof fetch; XMLHttpRequest?: { prototype: XMLHttpRequest } };
  const undo: Array<() => void> = [];
  const abs = (u: string): string => { try { return stripUrl(new URL(u, location.href).href); } catch { return ''; } };
  const out = (method: string, raw: string, status: number, t0: number, kind: NetFail['kind']): void => {
    const url = abs(raw);
    if (!url || url.indexOf(skip) === 0) return;
    const n: NetFail = { method: String(method || 'GET').toUpperCase().slice(0, 10), url, status, durationMs: Date.now() - t0, kind };
    try { if (status === 0 || status >= 400) report(n); else if (ok) ok(n); } catch { /* ignore */ }
  };
  const of = g.fetch;
  if (typeof of === 'function') {
    const wrapped = function (this: unknown, input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
      const t0 = Date.now();
      let raw = '', method = 'GET';
      try {
        const req = input as Request;
        raw = typeof input === 'string' ? input : (input as URL).href || req.url || '';
        method = (init && init.method) || req.method || 'GET';
      } catch { /* unknown input */ }
      const p = of.call(this, input as RequestInfo, init);
      return p.then((r) => { if (r) out(method, raw, r.status, t0, 'fetch'); return r; },
        (e: unknown) => { if (!(e && (e as { name?: string }).name === 'AbortError')) out(method, raw, 0, t0, 'fetch'); throw e; });
    };
    g.fetch = wrapped as typeof fetch;
    undo.push(() => { if (g.fetch === wrapped) g.fetch = of; });
  }
  const proto = g.XMLHttpRequest && g.XMLHttpRequest.prototype;
  if (proto && typeof proto.open === 'function' && typeof proto.send === 'function') {
    type X = XMLHttpRequest & { __prynt?: { m: string; u: string; t: number; aborted: boolean } };
    const open = proto.open, send = proto.send;
    const pOpen = function (this: X, ...a: unknown[]): void {
      this.__prynt = { m: String(a[0] || 'GET'), u: String(a[1] || ''), t: 0, aborted: false };
      return (open as (...x: unknown[]) => void).apply(this, a);
    };
    const pSend = function (this: X, ...a: unknown[]): void {
      const meta = this.__prynt;
      if (meta) {
        meta.t = Date.now();
        try {
          this.addEventListener('abort', () => { meta.aborted = true; });
          this.addEventListener('loadend', () => { if (!meta.aborted) out(meta.m, meta.u, this.status, meta.t, 'xhr'); });
        } catch { /* no events */ }
      }
      return (send as (...x: unknown[]) => void).apply(this, a);
    };
    proto.open = pOpen as XMLHttpRequest['open'];
    proto.send = pSend as XMLHttpRequest['send'];
    undo.push(() => { if (proto.open === pOpen) proto.open = open; if (proto.send === pSend) proto.send = send; });
  }
  return () => { for (const fn of undo.splice(0)) { try { fn(); } catch { /* ignore */ } } };
}
/** Developer-tools text scrub (browser side; the server scrubs again): emails, long digit runs, long tokens. */
export function devScrub(v: unknown, max = 300): string {
  let t: string;
  try { t = typeof v === 'string' ? v : JSON.stringify(v); } catch { t = String(v); }
  return String(t ?? '').replace(/[^\s@]+@[^\s@]+\.[^\s@]{2,}/g, '[email]').replace(/\d{6,}/g, '[number]')
    .replace(/[A-Za-z0-9_-]{24,}/g, '[token]').slice(0, max);
}
const CONSOLE_MAX = 100;   // console lines per page
/** Console lines of the allowed levels (site setting), scrubbed, max CONSOLE_MAX per page. Returns the undo function. */
export function watchConsole(levels: string[], report: (level: string, args: string[]) => void): () => void {
  const c = (globalThis as unknown as { console?: Record<string, (...a: unknown[]) => void> }).console;
  if (!c) return () => undefined;
  const undo: Array<() => void> = [];
  let n = 0;
  for (const lv of levels) {
    const orig = c[lv];
    if (typeof orig !== 'function') continue;
    const wrapped = function (this: unknown, ...a: unknown[]): void {
      if (n < CONSOLE_MAX) { n++; try { report(lv, a.slice(0, 5).map((x) => devScrub(x))); } catch { /* ignore */ } }
      return orig.apply(this, a);
    };
    c[lv] = wrapped;
    undo.push(() => { if (c[lv] === wrapped) c[lv] = orig; });
  }
  return () => { for (const fn of undo.splice(0)) { try { fn(); } catch { /* ignore */ } } };
}
export const BLOCK_SELECTOR = '[data-prynt-block],.prynt-block';

export const maskText = (t: string): string => t.replace(/\S/g, '*');

function rid(n: number): string {
  let s = '';
  try {
    const b = new Uint8Array(n);
    crypto.getRandomValues(b);
    for (let i = 0; i < n; i++) s += (b[i] % 36).toString(36);
    return s;
  } catch { /* no WebCrypto */ }
  while (s.length < n) s += Math.random().toString(36).slice(2);
  return s.slice(0, n);
}

const gpc = (): boolean => { try { return (navigator as { globalPrivacyControl?: boolean }).globalPrivacyControl === true; } catch { return false; } };

function regionDefault(): boolean {
  try { if (EU_TZ.test(Intl.DateTimeFormat().resolvedOptions().timeZone || '')) return false; } catch { /* no Intl */ }
  try { if (EU_LANG.test(document.documentElement.lang || '')) return false; } catch { /* no DOM */ }
  return true;
}

/** fnmatch-like glob (`*`, `?`) against the path, or the full URL when the pattern has `://`. */
export function globMatch(pattern: string, path: string, url: string): boolean {
  const target = (pattern.indexOf('://') >= 0 ? url : path).toLowerCase();
  const rx = new RegExp('^' + pattern.toLowerCase().replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
  return !!target && rx.test(target);
}

export function urlAllowed(cfg: Pick<Cfg, 'urlAllow' | 'urlDeny'>, path: string, url: string): boolean {
  if ((cfg.urlDeny || []).some((p) => globMatch(p, path, url))) return false;
  const allow = cfg.urlAllow || [];
  return !allow.length || allow.some((p) => globMatch(p, path, url));
}

/** The rrweb masking options of a site policy (exported for tests). Inputs are always masked. */
export function recordOptions(cfg: Pick<Cfg, 'maskAllText' | 'maskSelector' | 'unmaskSelector' | 'blockSelector' | 'recordCanvas'>, opts: ReplayOptions): Record<string, unknown> {
  const extraMask = [cfg.maskSelector, opts.maskSelector].filter(Boolean).join(',');
  const extraBlock = [cfg.blockSelector, opts.blockSelector].filter(Boolean).join(',');
  const allMask = !!(cfg.maskAllText || opts.maskAllText);
  const unmask = cfg.unmaskSelector || null;
  const o: Record<string, unknown> = {
    maskAllInputs: true,
    maskInputOptions: { password: true, email: true, tel: true, text: true, textarea: true, select: true, number: true,
                        search: true, url: true, date: true, color: true, range: true, month: true, week: true,
                        time: true, 'datetime-local': true },
    maskInputFn: (t: string): string => maskText(t || ''),
    maskTextClass: 'prynt-mask',
    maskTextSelector: allMask ? '*' : [MASK_SELECTOR, extraMask].filter(Boolean).join(','),
    maskTextFn: (t: string, el: HTMLElement | null): string => {
      if (allMask && unmask && el && typeof el.closest === 'function') {
        try { if (el.closest(MASK_SELECTOR)) return maskText(t); if (el.closest(unmask)) return t; } catch { /* bad selector */ }
      }
      return maskText(t);
    },
    blockClass: 'prynt-block',
    blockSelector: [BLOCK_SELECTOR, extraBlock].filter(Boolean).join(','),
    slimDOMOptions: 'all',
    inlineStylesheet: true,
    recordCanvas: !!cfg.recordCanvas,   // opt-in per site (charts, maps, games); 2 frames / s
    collectFonts: false,
    inlineImages: false,
    sampling: { mousemove: 50, scroll: 150, media: 800, input: 'last', canvas: 2 },
    checkoutEveryNms: 10 * 60 * 1000,
  };
  return o;
}

function stripUrl(href: string): string {
  try { const u = new URL(href, location.href); return u.origin + u.pathname; } catch { return ''; }
}

/** gzip bytes, or null when the browser has no CompressionStream (the server also takes plain JSON). */
export async function gzip(s: string): Promise<Blob | null> {
  const CS = (globalThis as { CompressionStream?: new (f: string) => TransformStream<Uint8Array, Uint8Array> }).CompressionStream;
  if (!CS || typeof Response === 'undefined') return null;
  try {
    const stream = new Blob([s]).stream().pipeThrough(new CS('gzip'));
    return new Blob([await new Response(stream).arrayBuffer()], { type: 'text/plain' });
  } catch { return null; }
}

const NOOP: ReplayClient = {
  identify: () => undefined, setConsent: () => undefined, state: () => undefined, stop: () => undefined, flush: () => Promise.resolve(),
  diagnose: () => ({ state: 'off', reason: 'no_dom', sessionId: null, seq: 0, chunksSent: 0, bytesSent: 0,
                     lastStatus: null, consent: false, consentSource: 'default', gpc: false, endpoint: '' }),
  ready: Promise.resolve(false),
};

export function createReplay(opts: ReplayOptions, defaultEndpoint: string, visitorId: () => string | null,
                             deps: ReplayDeps): ReplayClient {
  if (!opts || !opts.publicKey) throw new Error('[Prynt] replay: publicKey is required');
  if (typeof window === 'undefined' || typeof document === 'undefined') return NOOP;
  const base = (opts.endpoint || defaultEndpoint).replace(/\/$/, '');
  const website = opts.website || (() => { try { return location.hostname.replace(/^www\./, ''); } catch { return ''; } })();
  const chunkUrl = base + '/v1/replay/chunk?pk=' + encodeURIComponent(opts.publicKey);
  let state: ReplayDiagnostics['state'] = 'loading', reason: string | null = null;
  let cfg: Cfg | null = null, consentSet: boolean | null = null, regionOk: boolean | null = null;
  let stopRec: (() => void) | undefined, stopped = false, recording = false;
  let sid = '', seq = 0, buf: Ev[] = [], rawSize = 0, lastEmit = 0, chunksSent = 0, bytesSent = 0, retries = 0;
  let lastStatus: number | null = null, timer: ReturnType<typeof setInterval> | null = null;
  let lastPath = '', scrollMax = 0, scrollAt = 0;
  const pending: Array<[string, unknown]> = [];
  const cleanups: Array<() => void> = [];
  let readyResolve: (v: boolean) => void = () => undefined;
  const ready = new Promise<boolean>((r) => { readyResolve = r; });

  const cmp = watchCmp(() => { if (!stopped) recheck(); });
  cleanups.push(() => cmp.stop());

  const resolve = (): [boolean, Src] => {
    if (gpc()) return [false, 'gpc'];
    if (consentSet !== null) return [consentSet, 'override'];
    const co = opts.consent;
    if (typeof co === 'function') { try { return [!!co(), 'config']; } catch { return [false, 'config']; } }
    if (typeof co === 'boolean') return [co, 'config'];
    const s = cmp.read();
    if (s.cmp) return [!!s.consent, s.cmp as Src];
    if (regionOk === null) regionOk = regionDefault();
    return [regionOk, 'default'];
  };
  const allowedNow = (): boolean => {
    const [c, src] = resolve();
    if (!c) return false;
    return !(cfg && cfg.consentLevel === 'explicit' && src === 'default');
  };

  // --- session id (shared with Analytics/Reveal) + per-session chunk sequence ---------------------------------
  const session = (): string => {
    const now = Date.now();
    let s: { id: string; last: number } | null = null;
    try { const raw = localStorage.getItem(SKEY); if (raw) { const p = JSON.parse(raw); if (typeof p.id === 'string' && typeof p.last === 'number') s = p; } } catch { /* memory */ }
    if (!s && sid) s = { id: sid, last: lastEmit || now };
    if (!s || now - s.last > SESSION_TTL) s = { id: 'rvs_' + rid(24), last: now };
    s.last = now;
    try { localStorage.setItem(SKEY, JSON.stringify(s)); } catch { /* memory only */ }
    return s.id;
  };
  const nextSeq = (): number => {
    try {
      const raw = localStorage.getItem(QKEY);
      const p = raw ? JSON.parse(raw) : null;
      const n = p && p.s === sid && typeof p.n === 'number' ? p.n : 0;
      localStorage.setItem(QKEY, JSON.stringify({ s: sid, n: n + 1 }));
      return n;
    } catch {
      if (!seq) seq = 10000 + Math.floor(Math.random() * 80000);   // no storage: unlikely to collide
      return seq++;
    }
  };

  // --- upload ------------------------------------------------------------------------------------------------
  const send = async (events: Ev[], final: boolean, unloading: boolean): Promise<void> => {
    if (!events.length || !sid) return;
    const [c, src] = resolve();
    const n = nextSeq();
    seq = n + 1;
    const json = JSON.stringify({ publicKey: opts.publicKey, website, sessionId: sid, seq: n, consent: c,
                                  consentSource: src, visitorId: c ? visitorId() : null, final, events });
    const plain = (): Blob => new Blob([json], { type: 'text/plain' });
    const blob = unloading && json.length <= BEACON_MAX ? plain() : (await gzip(json)) || plain();
    const size = blob.size;
    const max = (cfg && cfg.maxChunkBytes) || 1024 * 1024;
    if (size > max) {
      if (events.length > 1) {   // split and retry with fresh sequence numbers
        const half = Math.ceil(events.length / 2);
        await send(events.slice(0, half), false, unloading);
        await send(events.slice(half), final, unloading);
      }
      return;
    }
    if (unloading && size <= BEACON_MAX && typeof navigator.sendBeacon === 'function') {
      try { if (navigator.sendBeacon(chunkUrl, blob)) { chunksSent++; bytesSent += size; return; } } catch { /* fetch */ }
    }
    try {
      const r = await fetch(chunkUrl, { method: 'POST', body: blob, credentials: 'omit', mode: 'cors',
                                        keepalive: size <= BEACON_MAX, headers: { 'Content-Type': 'text/plain' } });
      lastStatus = r.status;
      if (r.status === 202) { chunksSent++; bytesSent += size; retries = 0; return; }
      if (r.status >= 500) {   // e.g. 503 storage_unavailable: nothing was stored, keep the events for the next flush
        if (!unloading && retries < MAX_RETRIES) { retries++; buf = events.concat(buf); rawSize += json.length; }
        return;
      }
      if (r.status === 429) {
        let code = '';
        try { code = ((await r.json()) as { error?: { code?: string } }).error?.code || ''; } catch { /* none */ }
        if (code !== 'quota_exceeded') return;     // rate limited: this chunk is dropped, recording goes on
      }
      if (r.status >= 400 && r.status < 500) halt('server_' + r.status);   // consent / product / limits: stop
    } catch { lastStatus = null; }
  };
  const flush = (final = false, unloading = false): Promise<void> => {
    const events = buf;
    buf = []; rawSize = 0;
    return send(events, final, unloading);
  };

  // --- recording ---------------------------------------------------------------------------------------------
  const custom = (tag: string, payload: unknown): void => {
    if (!recording) { if (tag === 'prynt.identify') pending.push([tag, payload]); return; }
    try { deps.record.addCustomEvent(tag, payload); } catch { /* recorder stopped */ }
  };
  const emit = (e: Ev): void => {
    const now = Date.now();
    if (lastEmit && now - lastEmit > SESSION_TTL) {     // idle past the session window: new session, new replay
      void flush(true);
      sid = session(); seq = 0; lastEmit = now;
      buf.push(e);
      try { deps.record.takeFullSnapshot(true); } catch { /* ignore */ }
      return;
    }
    lastEmit = now;
    if (e.type === 4 && e.data && typeof (e.data as { href?: string }).href === 'string') {
      (e.data as { href: string }).href = stripUrl((e.data as { href: string }).href);   // no query / fragment
    }
    buf.push(e);
    try { rawSize += JSON.stringify(e).length; } catch { /* circular: ignore */ }
    if (rawSize > RAW_FLUSH_AT) void flush();
  };
  const path = (): [string, string] => { try { return [location.pathname, location.origin + location.pathname]; } catch { return ['', '']; } };

  let fbLoaded = false;
  const startRec = (): void => {
    if (recording || stopped || !cfg) return;
    const [p, u] = path();
    if (!urlAllowed(cfg, p, u)) { state = 'paused'; reason = 'url_excluded'; return; }
    try {
      stopRec = deps.record({ ...recordOptions(cfg, opts), emit, errorHandler: () => true });
    } catch { halt('recorder_failed'); return; }
    recording = true; state = 'recording'; reason = null; lastPath = p; scrollMax = 0;
    for (const [tag, payload] of pending.splice(0)) custom(tag, payload);
    readyResolve(true);
    try {   // Sentry on the page: every event carries a link to this replay at that second
      const S = (window as unknown as { Sentry?: { setTag?: (k: string, v: string) => void; addEventProcessor?: (f: (e: { tags?: Record<string, string> }) => unknown) => void } }).Sentry;
      if (S && cfg.consoleUrl) {
        const link = cfg.consoleUrl + '/replay/session/' + sid;
        if (S.setTag) S.setTag('prynt_replay', link);
        if (S.addEventProcessor) S.addEventProcessor((e) => { e.tags = { ...(e.tags || {}), prynt_replay: link + '?ts=' + Date.now() }; return e; });
      }
    } catch { /* never break the page */ }
    if (cfg.feedback && !fbLoaded) {   // feedback widget: a separate file, loaded once, only where it is on
      fbLoaded = true;
      try {
        const s = document.createElement('script');
        s.src = base + '/cdn/prynt-feedback.umd.js'; s.async = true; s.crossOrigin = 'anonymous';
        s.onload = (): void => {
          const g = (window as unknown as { PryntFeedback?: { mount: (o: object) => () => void } }).PryntFeedback;
          if (g && cfg && cfg.feedback) cleanups.push(g.mount({ endpoint: base, publicKey: opts.publicKey, website, sessionId: sid, cfg: cfg.feedback }));
        };
        (document.head || document.documentElement).appendChild(s);
      } catch { /* ignore */ }
    }
  };
  const stopRecording = (why: string, st: ReplayDiagnostics['state']): void => {
    if (recording) { try { if (stopRec) stopRec(); } catch { /* ignore */ } }
    recording = false; state = st; reason = why;
    void flush();
  };
  function halt(why: string): void {   // final: nothing more is recorded or sent for this page
    stopped = true;
    if (recording) { try { if (stopRec) stopRec(); } catch { /* ignore */ } }
    recording = false; state = 'off'; reason = why; buf = []; rawSize = 0;
    if (timer) clearInterval(timer);
    for (const fn of cleanups.splice(0)) { try { fn(); } catch { /* ignore */ } }
    readyResolve(false);
  }
  function recheck(): void {
    if (stopped || !cfg) return;
    if (gpc()) { halt('gpc'); return; }
    if (allowedNow()) { if (!recording) startRec(); }
    else if (recording) stopRecording('no_consent', 'waiting_consent');
    else { state = 'waiting_consent'; reason = cfg.consentLevel === 'explicit' ? 'explicit_consent_required' : 'no_consent'; }
  }

  // page changes (SPA): navigation marker, URL rules, a fresh snapshot for the player and the heatmaps
  const onRoute = (): void => {
    const [p, u] = path();
    if (p === lastPath || stopped || !cfg) return;
    lastPath = p; scrollMax = 0;
    if (!urlAllowed(cfg, p, u)) { if (recording) stopRecording('url_excluded', 'paused'); return; }
    if (!recording) { recheck(); return; }
    sendVitals();   // the previous route's interactions and layout shifts
    custom('prynt.nav', { href: stripUrl(location.href) });
    try { deps.record.takeFullSnapshot(true); } catch { /* ignore */ }
  };
  const onScroll = (): void => {
    if (!recording) return;
    const now = Date.now();
    if (now - scrollAt < 500) return;
    scrollAt = now;
    try {
      const de = document.documentElement;
      const docH = Math.max(de.scrollHeight, document.body ? document.body.scrollHeight : 0);
      if (!docH) return;
      const pct = Math.min(100, Math.round(((window.scrollY || de.scrollTop || 0) + window.innerHeight) / docH * 100));
      if (pct >= scrollMax + 5 || (pct === 100 && scrollMax < 100)) { scrollMax = pct; custom('prynt.scroll', { pct, docH }); }
    } catch { /* ignore */ }
  };
  const onError = (e: ErrorEvent): void => {
    if (!recording || !cfg || !cfg.captureErrors) return;
    const err = e && (e.error as Error | undefined);
    custom('prynt.error', { message: String((e && e.message) || (err && err.message) || 'Error').slice(0, 500),
                            stack: err && err.stack ? String(err.stack).slice(0, 4000) : null,
                            source: e && e.filename ? stripUrl(e.filename) : null, line: e && e.lineno, col: e && e.colno, kind: 'error' });
  };
  const onRejection = (e: PromiseRejectionEvent): void => {
    if (!recording || !cfg || !cfg.captureErrors) return;
    const r = e && (e.reason as { message?: string; stack?: string } | string | undefined);
    const message = typeof r === 'string' ? r : (r && r.message) || 'Unhandled promise rejection';
    custom('prynt.error', { message: String(message).slice(0, 500), stack: r && typeof r === 'object' && r.stack ? String(r.stack).slice(0, 4000) : null,
                            kind: 'unhandledrejection' });
  };
  // page performance (Core Web Vitals + FCP / TTFB), sent once per page as prynt.vitals
  let vit: Record<string, number> = {};
  const observe = (type: string, fn: (e: PerformanceEntry & Record<string, number>) => void, extra?: object): void => {
    try {
      const o = new PerformanceObserver((l) => l.getEntries().forEach((e) => fn(e as never)));
      o.observe({ type, buffered: true, ...extra } as PerformanceObserverInit);
      cleanups.push(() => o.disconnect());
    } catch { /* not supported */ }
  };
  const watchVitals = (): void => {
    observe('largest-contentful-paint', (e) => { vit.lcp = e.startTime; });
    observe('paint', (e) => { if (e.name === 'first-contentful-paint') vit.fcp = e.startTime; });
    observe('layout-shift', (e) => { if (!e.hadRecentInput) vit.cls = (vit.cls || 0) + e.value; });
    observe('event', (e) => { if (e.interactionId) vit.inp = Math.max(vit.inp || 0, e.duration); }, { durationThreshold: 40 });
    try { const n = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming; if (n) vit.ttfb = n.responseStart; } catch { /* ignore */ }
  };
  const sendVitals = (): void => {
    if (!recording || !Object.keys(vit).length) return;
    const o: Record<string, number> = {};
    for (const k in vit) o[k] = k === 'cls' ? Math.round(vit[k] * 1000) / 1000 : Math.round(vit[k]);
    custom('prynt.vitals', o); vit = {};
  };
  const onHide = (): void => { if (document.visibilityState === 'hidden') { sendVitals(); void flush(false, true); } };
  const onPageHide = (): void => { sendVitals(); void flush(true, true); };

  const listen = (t: EventTarget, type: string, fn: EventListener, o?: AddEventListenerOptions): void => {
    t.addEventListener(type, fn, o);
    cleanups.push(() => t.removeEventListener(type, fn, o));
  };

/** A browser driven by automation (WebDriver / Playwright / Puppeteer set navigator.webdriver). */
function automated(): boolean {
  try { return typeof navigator !== 'undefined' && navigator.webdriver === true; } catch { return false; }
}

  const boot = async (): Promise<void> => {
    if (gpc()) { halt('gpc'); return; }
    if (automated()) { halt('bot'); return; }   // a driven browser is never recorded nor billed
    sid = session();
    lastEmit = Date.now();
    try {
      const q = '?publicKey=' + encodeURIComponent(opts.publicKey) + '&website=' + encodeURIComponent(website) +
        '&sessionId=' + encodeURIComponent(sid) + (automated() ? '&automation=1' : '');
      const r = await fetch(base + '/v1/replay/config' + q, { credentials: 'omit', mode: 'cors' });
      lastStatus = r.status;
      if (!r.ok) { halt('config_' + r.status); return; }
      cfg = (await r.json()) as Cfg;
    } catch { halt('config_unreachable'); return; }
    if (stopped) return;
    if (!cfg.record) { halt(cfg.reason || 'not_recorded'); return; }
    listen(window, 'error', onError as EventListener);
    listen(window, 'unhandledrejection', onRejection as EventListener);
    if (cfg.captureErrors || cfg.devNetwork) {   // failed fetch / XHR (capture errors); every request (dev tools)
      let netCount = 0, reqCount = 0;
      const allow = cfg.devNetworkAllow || [];
      const reqOk = (u: string): boolean => {
        try { const x = new URL(u); return allow.length ? allow.some((p) => globMatch(p, x.pathname, u)) : x.host === location.host; } catch { return false; }
      };
      cleanups.push(watchNetwork(base,
        (n) => { if (recording && cfg && cfg.captureErrors && netCount < NET_MAX) { netCount++; custom('prynt.net', n); } },
        cfg.devNetwork ? (n) => { if (recording && reqCount < REQ_MAX && reqOk(n.url)) { reqCount++; custom('prynt.req', n); } } : undefined));
    }
    if (cfg.devConsole && cfg.devConsole.length) {
      cleanups.push(watchConsole(cfg.devConsole, (level, args) => { if (recording) custom('prynt.console', { level, args }); }));
    }
    listen(window, 'scroll', onScroll, { passive: true });
    listen(window, 'popstate', onRoute);
    watchVitals();
    listen(window, 'pagehide', onPageHide);
    listen(document, 'visibilitychange', onHide);
    for (const m of ['pushState', 'replaceState'] as const) {
      try {
        const orig = history[m];
        const patched = function (this: History, ...a: Parameters<History['pushState']>): void {
          orig.apply(this, a); setTimeout(onRoute, 0);
        };
        history[m] = patched as History['pushState'];
        cleanups.push(() => { if (history[m] === patched) history[m] = orig; });
      } catch { /* frozen history */ }
    }
    timer = setInterval(() => { if (buf.length) void flush(); }, Math.max(2000, cfg.flushMs || 10000));
    recheck();
    if (!recording && state === 'waiting_consent') readyResolve(false);
  };
  void boot();

  return {
    identify(userId: string, traits?: { accountId?: string | number }): void {
      if (typeof userId !== 'string' || !userId.trim() || /@/.test(userId)) return;   // never an email
      const a = traits && traits.accountId != null ? String(traits.accountId).trim().slice(0, 190) : '';
      custom('prynt.identify', a && !/@/.test(a) ? { userId: userId.trim().slice(0, 190), accountId: a } : { userId: userId.trim().slice(0, 190) });
    },
    setConsent(given: boolean): void { consentSet = !!given; recheck(); },
    state(label: string, value?: unknown): void {   // app state / actions (dev tools «state», site setting)
      if (!recording || !cfg || !cfg.devState || typeof label !== 'string') return;
      custom('prynt.state', { label: devScrub(label, 80), value: value === undefined ? null : devScrub(value, 2000) });
    },
    stop(): void { if (!stopped) { void flush(true); halt('stopped'); } },
    flush: (): Promise<void> => flush(),
    diagnose: (): ReplayDiagnostics => {
      const [c, src] = resolve();
      return { state, reason, sessionId: sid || null, seq, chunksSent, bytesSent, lastStatus, consent: c,
               consentSource: src, gpc: gpc(), endpoint: base };
    },
    ready,
  };
}
