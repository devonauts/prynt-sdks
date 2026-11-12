// Reveal — B2B visitor identification events (pageviews, engagement, forms, identify, custom)
// batched to POST /v1/reveal/collect (or the shared /v1/track, analytics.ts). Zero dependencies; every browser touch is wrapped so a
// locked-down page (no storage, no fetch) never throws into the host site.
//
// Privacy model: without consent only `pageview` events are sent, marked `consent:false`, with
// no referrer, query string, utm, visitorId or identity. Form fields are read ONLY when `forms`
// is enabled AND consent is true (or the form itself is the consent, `requireConsent:false`), and
// only email/name inputs — never passwords or anything else.
// Consent resolution (PRD FP-8), first hit wins: GPC → false · setConsent() · the `consent` option
// · an auto-detected CMP (consent_cmp.ts) · the EU/UK/CH heuristic. `consentSource` says which.
// The public types (RevealOptions / RevealClient / RevealDiagnostics) live in index.ts so
// dist/index.d.ts stays self-contained.

import type { RevealOptions, RevealClient, RevealDiagnostics, RevealConsentSource, RevealPidOptions } from './index';
import { watchCmp } from './consent_cmp';
import { onSubmit as subscribeSubmit, isShielded, botHint } from './forms';
import { mountDebug } from './reveal_debug';

type Prim = string | number | boolean;
export type RevealKind = 'pageview' | 'engagement' | 'form' | 'identify' | 'custom';
export interface RevealIdentity { email?: string; name?: string; formId?: string; userId?: string }
export interface RevealUtm {
  source?: string; medium?: string; campaign?: string; term?: string; content?: string;
  gclid?: boolean; fbclid?: boolean;
}
export interface EspToken { provider: string; token: string }
export interface RevealEvent {
  eventId: string;
  kind: RevealKind;
  url: string;
  path: string;
  title: string;
  ts: string;
  referrer?: string;
  utm?: RevealUtm;
  durationMs?: number;
  scrollPct?: number;
  name?: string;
  props?: Record<string, Prim | EspToken>;
  identity?: RevealIdentity;
  shielded?: boolean;       // form events: protectForm() is active on the same form
  consentRef?: string;      // form events sent under requireConsent:false — the form id is the consent record
}
interface Sess { id: string; last: number }
interface Item { ev: RevealEvent; c: boolean }
type Storage = RevealDiagnostics['storage'];

const SKEY = 'prynt_rvs';
const SESSION_TTL = 30 * 60 * 1000;
const BATCH_MS = 2000, BATCH_AT = 10, MAX_PER_REQ = 50, HELD_MAX = 60, TICK_MS = 15000;
// IANA zones of EU/EEA + UK + CH (Europe/* also covers non-EU Europe: conservative on purpose).
const EU_TZ = /^Europe\/|^Atlantic\/(Canary|Madeira|Azores|Reykjavik|Faroe)$|^Indian\/(Reunion|Mayotte)$|^America\/(Martinique|Guadeloupe|Cayenne|Marigot|St_Barthelemy)$/;
// <html lang>: languages near-exclusive to EU/EEA/UK/CH, or any language with an EU/UK/CH region.
const EU_LANG = /^(de|fr|it|nl|pl|sv|da|fi|el|cs|hu|ro|bg|hr|sk|sl|et|lv|lt|mt|ga|is|nb|nn|no|lb)([-_]|$)|[-_](AT|BE|BG|HR|CY|CZ|DK|EE|FI|FR|DE|GR|HU|IE|IT|LV|LT|LU|MT|NL|PL|PT|RO|SK|SI|ES|SE|GB|UK|CH|NO|IS|LI)$/i;
const PII = /mail|phone|name|pass|token|card/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Email-service-provider click parameters (PRD FP-1): captured as props.espToken (consent only) and
// always removed from the url we send. First present wins; `utm_medium=email` alone = provider 'email'.
// Signed email-link person token (FP-3, S3-W2-T3): `?pid=` by default (RevealPidOptions.param).
// Read ONLY after consent/GPC resolved to true; a value that is not token-shaped (a product id…) is
// left alone. Removed from the url we send; sent as `pid` with consented batches; kept in
// localStorage `prynt_pid` only with `store: true`; an explicit opt-out (GPC, setConsent(false),
// CMP/config refusal) deletes it.
const PIDK = 'prynt_pid';
const PID_RX = /^[\w-]{20,400}\.[\w-]{43}$/;
const ESP: [string, string][] = [['mc_eid', 'mailchimp'], ['mc_cid', 'mailchimp'], ['_hsenc', 'hubspot'], ['_hsmi', 'hubspot'],
  ['_kx', 'klaviyo'], ['vgo_ee', 'activecampaign'], ['_cio_id', 'customerio'], ['mkt_tok', 'marketo']];

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

const gpc = (): boolean => { try { return navigator.globalPrivacyControl === true; } catch { return false; } };

// Conservative consent default: false when the page looks European (timezone or <html lang>).
function regionDefault(): boolean {
  try { if (EU_TZ.test(Intl.DateTimeFormat().resolvedOptions().timeZone || '')) return false; } catch { /* no Intl */ }
  try { if (EU_LANG.test(document.documentElement.lang || '')) return false; } catch { /* no DOM */ }
  return true;
}

function cleanProps(p?: Record<string, unknown>): Record<string, Prim> | undefined {
  if (!p || typeof p !== 'object') return undefined;
  const out: Record<string, Prim> = {};
  let n = 0;
  for (const k in p) {
    if (n >= 20) break;
    if (PII.test(k)) continue;
    const v = p[k];
    if (typeof v === 'string') out[k] = v.slice(0, 200);
    else if ((typeof v === 'number' && isFinite(v)) || typeof v === 'boolean') out[k] = v;
    else continue;
    n++;
  }
  return n ? out : undefined;
}

function parseUtm(q: URLSearchParams): RevealUtm | undefined {
  let any = false;
  const g = (k: string): string | undefined => {
    const v = q.get('utm_' + k);
    if (!v) return undefined;
    any = true;
    return v.slice(0, 200);
  };
  const u: RevealUtm = { source: g('source'), medium: g('medium'), campaign: g('campaign'), term: g('term'), content: g('content') };
  // Click ids are never forwarded: only their presence (ad click yes/no).
  if (q.has('gclid')) { u.gclid = true; any = true; }
  if (q.has('fbclid')) { u.fbclid = true; any = true; }
  return any ? u : undefined;
}

// Pulls the ESP token out of the query (mutates q: the params are removed from the sent url).
function takeEsp(q: URLSearchParams): EspToken | undefined {
  let t: EspToken | undefined;
  for (const [k, p] of ESP) {
    const v = q.get(k);
    if (v && !t) t = { provider: p, token: v.slice(0, 300) };
    q.delete(k);
  }
  if (!t && q.get('utm_medium') === 'email') t = { provider: 'email', token: '' };
  return t;
}

// Read ONLY email/name inputs of a submitted form. Password/hidden inputs are skipped before any
// `.value` access; nothing else is read.
function readForm(form: HTMLFormElement): RevealIdentity | null {
  let email = '', name = '';
  const inputs = form.querySelectorAll('input');
  for (let i = 0; i < inputs.length; i++) {
    const el = inputs[i];
    const t = (el.type || '').toLowerCase();
    if (t === 'password' || t === 'hidden') continue;
    const key = (el.name || '') + ' ' + (el.id || '') + ' ' + (el.autocomplete || '');
    if (!email && (t === 'email' || /e-?mail/i.test(key))) {
      const v = (el.value || '').trim();
      if (EMAIL.test(v)) email = v;
    } else if (!name && t !== 'email' && /(^|\s)(full[-_]?)?name(\s|$)/i.test(key)) {
      name = (el.value || '').trim().slice(0, 120);
    }
  }
  if (!email) return null;
  const id: RevealIdentity = { email };
  if (name) id.name = name;
  const fid = form.id || form.name;
  if (fid) id.formId = String(fid).slice(0, 120);
  return id;
}

const mask = (k: string): string => (k.length > 12 ? k.slice(0, 10) + '…' + k.slice(-2) : k);

// `collectPath`: '/v1/reveal/collect' (Reveal) or '/v1/track' (shared pipeline, analytics.ts).
export function createReveal(opts: RevealOptions, defaultEndpoint: string,
                             visitorId: () => string | null, sdkVersion: string,
                             collectPath = '/v1/reveal/collect'): RevealClient {
  if (!opts || !opts.publicKey) throw new Error('[Prynt] reveal: publicKey is required');
  const url = (opts.endpoint || defaultEndpoint).replace(/\/$/, '') + collectPath;
  const website = opts.website || (() => { try { return location.hostname.replace(/^www\./, ''); } catch { return ''; } })();
  let lastSend: RevealDiagnostics['lastSend'] = null;
  let cspBlocked = false, everOk = false, storage: Storage = 'memory', sessId: string | null = null;
  const queue: Item[] = [];                     // ready to send
  const diag = (loaded: boolean, c: boolean, src: RevealConsentSource, cmp: string | null): RevealDiagnostics => ({
    loaded, sdkVersion, publicKey: mask(opts.publicKey), website, endpoint: url.slice(0, -collectPath.length), consent: c, consentSource: src,
    cmpDetected: cmp, storage, gpc: gpc(), cspBlocked, sessionId: sessId, visitorId: c ? visitorId() : null,
    queued: queue.length, lastSend,
  });
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    const no = (): void => { /* no DOM */ };
    return { pageview: no, track: no, identify: no, setConsent: no, flush: () => Promise.resolve(), stop: no,
             diagnose: () => diag(false, false, 'default', null) };
  }

  const spa = opts.spa !== false, engagement = opts.engagement !== false;
  const fo = opts.forms;
  const forms = !!fo, formSels = Array.isArray(fo) ? fo : fo && typeof fo === 'object' ? fo.selectors : undefined;
  const formConsent = !(fo && typeof fo === 'object' && !Array.isArray(fo) && fo.requireConsent === false);
  const consentOpt = opts.consent;
  const po = opts.pid;
  const pidOn = po !== false, pidO: RevealPidOptions = po && typeof po === 'object' ? po : {};
  const pidParam = pidO.param || 'pid';
  let pid: string | null = null;
  let ready = false;                            // listeners may fire before setup ends
  const cmp = watchCmp(() => { if (ready) recheck(); });

  let consentSet: boolean | null = null;        // setConsent() wins over the option
  let memSess: Sess | null = null;              // used when localStorage throws
  const held: RevealEvent[] = [];               // identity/custom events waiting for consent
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false, wasOn = false, regionOk: boolean | null = null;

  // Engagement accounting: active (visible) time only, scroll depth = max seen on this page.
  let lastHref = '', lastUrl = '', referrer = '';   // lastHref: raw, for the SPA same-URL check; lastUrl: as sent
  let activeSince = -1, unsentMs = 0, scrollMax = 0;
  let lastForm: unknown = null, lastFormAt = 0;

  const resolve = (): [boolean, RevealConsentSource] => {
    if (gpc()) return [false, 'gpc'];
    if (consentSet !== null) return [consentSet, 'override'];
    if (typeof consentOpt === 'function') { try { return [!!consentOpt(), 'config']; } catch { return [false, 'config']; } }
    if (typeof consentOpt === 'boolean') return [consentOpt, 'config'];
    const s = cmp.read();
    if (s.cmp) return [!!s.consent, s.cmp];
    if (regionOk === null) regionOk = regionDefault();
    return [regionOk, 'default'];
  };
  const consentNow = (): boolean => resolve()[0];

  // pid helpers — takePid/loadPid are only called once consent resolved to true.
  const takePid = (q: URLSearchParams): void => {
    const v = q.get(pidParam);
    if (!pidOn || !v || !PID_RX.test(v)) return;
    q.delete(pidParam);
    pid = v;
    if (pidO.store) try { localStorage.setItem(PIDK, v); } catch { /* memory only */ }
  };
  const loadPid = (): void => {
    if (pidOn && pidO.store && !pid) try { const v = localStorage.getItem(PIDK); if (v && PID_RX.test(v)) pid = v; } catch { /* none */ }
  };
  const dropPid = (): void => {                 // explicit refusal (GPC, setConsent(false), CMP, config)
    const [c, src] = resolve();
    if (c || src === 'default') return;
    pid = null;
    try { localStorage.removeItem(PIDK); } catch { /* none */ }
  };

  const session = (): string => {
    const now = Date.now();
    let s: Sess | null = memSess;
    try {
      const raw = localStorage.getItem(SKEY);
      storage = 'localStorage';
      if (raw) {
        const p = JSON.parse(raw) as Partial<Sess>;
        if (typeof p.id === 'string' && typeof p.last === 'number') s = { id: p.id, last: p.last };
      }
    } catch { storage = typeof localStorage === 'undefined' ? 'memory' : 'blocked'; }
    if (!s || now - s.last > SESSION_TTL) s = { id: 'rvs_' + rid(24), last: now };
    s.last = now;
    memSess = s;
    try { localStorage.setItem(SKEY, JSON.stringify(s)); } catch { /* memory only */ }
    return (sessId = s.id);
  };

  const base = (kind: RevealKind, u?: string): RevealEvent => {
    let href = '', path = '', title = '';
    try {
      const p = new URL(u || location.href, location.href);
      const v = p.searchParams.get(pidParam);
      if (v && PID_RX.test(v)) p.searchParams.delete(pidParam);   // the token never travels in a url
      href = p.origin + p.pathname + p.search;
      path = p.pathname;
    } catch { /* keep empty */ }
    try { title = (document.title || '').slice(0, 200); } catch { /* no title */ }
    return { eventId: 'evt_' + rid(20), kind, url: href, path, title, ts: new Date(Date.now()).toISOString() };
  };

  const send = (sid: string, c: boolean, src: RevealConsentSource, events: RevealEvent[], beacon: boolean, retry: boolean): Promise<void> => {
    const body = JSON.stringify({ publicKey: opts.publicKey, website, sessionId: sid, visitorId: c ? visitorId() : null,
                                  consent: c, consentSource: src, botHint: botHint() || undefined,
                                  pid: c && pid ? pid : undefined, events });
    const n = events.length;
    const rec = (status: number | null, accepted: number, error: string | null): void => {
      lastSend = { at: new Date(Date.now()).toISOString(), status, accepted, error };
    };
    if (beacon) {
      try { if (navigator.sendBeacon(url, body)) { rec(null, n, null); return Promise.resolve(); } } catch { /* fall back to fetch */ }
    }
    let p: Promise<Response>;
    try {
      // text/plain + no credentials: a CORS "simple request", so no preflight on the hot path.
      p = fetch(url, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body, keepalive: true, credentials: 'omit' });
    } catch (e) { rec(null, 0, String(e)); return Promise.resolve(); }
    const again = (): Promise<void> => retry
      ? new Promise<void>((r) => setTimeout(r, 500)).then(() => send(sid, c, src, events, false, false))
      : Promise.resolve();
    // 2xx done; 4xx dropped (bad key / unverified website — retrying would not help); 5xx and
    // network errors retried once. A TypeError before any response ever arrived is most likely the
    // page's CSP (connect-src) refusing the endpoint; cleared by the first response.
    return p.then((r) => {
      everOk = true; cspBlocked = false;
      rec(r.status, r.status < 300 ? n : 0, r.status >= 300 ? 'http ' + r.status : null);
      if (r.status < 300) { try { void r.json().then((j: { accepted?: number }) => { if (lastSend && typeof j.accepted === 'number') lastSend.accepted = j.accepted; }, () => undefined); } catch { /* no body */ } }
      return r.status >= 500 ? again() : undefined;
    }, (e) => {
      if (!everOk) cspBlocked = true;
      rec(null, 0, String(e && e.message || e));
      return again();
    }).catch(() => undefined);
  };

  const flush = (beacon = false): Promise<void> => {
    if (timer !== null) { clearTimeout(timer); timer = null; }
    const items = queue.splice(0);
    if (!items.length) return Promise.resolve();
    const sid = session();
    const src = resolve()[1];
    const ps: Promise<void>[] = [];
    for (const c of [true, false]) {
      const evs = items.filter((i) => i.c === c).map((i) => i.ev);
      for (let i = 0; i < evs.length; i += MAX_PER_REQ) ps.push(send(sid, c, src, evs.slice(i, i + MAX_PER_REQ), beacon, true));
    }
    return Promise.all(ps).then(() => undefined);
  };

  const enqueue = (ev: RevealEvent, c: boolean): void => {
    if (stopped) return;
    queue.push({ ev, c });
    session();
    if (queue.length >= BATCH_AT) void flush();
    else if (timer === null) timer = setTimeout(() => { timer = null; void flush(); }, BATCH_MS);
  };

  // Full (consent-only) event: sent now, or parked until consent arrives.
  const full = (ev: RevealEvent): void => {
    if (consentNow()) enqueue(ev, true);
    else { if (held.length >= HELD_MAX) held.shift(); held.push(ev); }
  };
  // Consent just turned on (setConsent / CMP decision): release what was parked.
  const recheck = (): void => {
    const on = consentNow();
    if (on && !wasOn) { loadPid(); try { takePid(new URL(location.href).searchParams); } catch { /* no url */ } }
    if (!on) dropPid();
    if (on && !wasOn && !stopped && held.length) {
      for (const ev of held.splice(0)) queue.push({ ev, c: true });
      void flush();
    }
    wasOn = on;
  };

  const visible = (): boolean => { try { return !document.hidden; } catch { return true; } };
  const accrue = (): void => {
    if (activeSince >= 0) { const n = Date.now(); unsentMs += Math.max(0, n - activeSince); activeSince = n; }
  };
  const engage = (): void => {
    accrue();
    if (!engagement || unsentMs <= 0 || !consentNow()) { unsentMs = 0; return; }
    const ev = base('engagement', lastUrl);
    ev.durationMs = unsentMs;
    ev.scrollPct = scrollMax;
    unsentMs = 0;
    enqueue(ev, true);
  };

  const pageview = (u?: string): void => {
    const c = consentNow();
    const ev = base('pageview', u);
    try {
      const p = new URL(ev.url);
      if (c) {
        if (referrer) ev.referrer = referrer.slice(0, 500);
        const q = p.searchParams;
        ev.utm = parseUtm(q);
        const esp = takeEsp(q);
        if (esp) ev.props = { espToken: esp };
        loadPid();
        takePid(new URL(u || location.href, location.href).searchParams);   // ev.url is already pid-free
        const qs = q.toString();
        ev.url = p.origin + p.pathname + (qs ? '?' + qs : '');
      } else {
        // Minimal analytics: path only — no query string, referrer, utm, visitorId.
        ev.url = p.origin + p.pathname;
      }
    } catch { /* keep */ }
    enqueue(ev, c);
    referrer = lastUrl = ev.url;
    try { const p = new URL(u || location.href, location.href); lastHref = p.origin + p.pathname + p.search; } catch { lastHref = ev.url; }
    unsentMs = 0; scrollMax = 0;
    activeSince = visible() ? Date.now() : -1;
  };

  // ---- listeners ----
  const onRoute = (): void => {
    let href = '';
    try { href = location.href; } catch { return; }
    try { const p = new URL(href); href = p.origin + p.pathname + p.search; } catch { /* keep */ }
    if (href === lastHref) return;
    engage();
    pageview();
  };
  const onScroll = (): void => {
    try {
      const h = Math.max(1, document.documentElement.scrollHeight);
      const pct = Math.min(100, Math.round(((window.scrollY || 0) + window.innerHeight) / h * 100));
      if (pct > scrollMax) scrollMax = pct;
    } catch { /* ignore */ }
  };
  const onVisibility = (): void => {
    if (visible()) { if (activeSince < 0) activeSince = Date.now(); }
    else { engage(); activeSince = -1; void flush(); }
  };
  const onHide = (): void => { engage(); activeSince = -1; void flush(true); };
  const onTick = (): void => { if (visible()) engage(); };
  const onSubmit = (e: Event): void => {
    const c = consentNow();
    if (formConsent && !c) return;
    const form = e.target as HTMLFormElement | null;
    if (!form || typeof form.querySelectorAll !== 'function') return;
    if (formSels) {
      let hit = false;
      for (const s of formSels) { try { if (form.matches(s)) { hit = true; break; } } catch { /* bad selector */ } }
      if (!hit) return;
    }
    // protectForm(autoGuard) re-submits the same form after its verdict: count it once.
    const now = Date.now();
    if (form === lastForm && now - lastFormAt < 2000) return;
    lastForm = form; lastFormAt = now;
    let id: RevealIdentity | null = null;
    try { id = readForm(form); } catch { /* unreadable form */ }
    if (!id) return;
    const ev = base('form');
    ev.identity = id;
    ev.shielded = isShielded(form);
    if (!c) ev.consentRef = id.formId || 'form';   // requireConsent:false — the submission is the consent
    enqueue(ev, true);
    void flush();          // keepalive fetch survives the navigation the submit may cause
  };
  const onCsp = (e: Event): void => {
    const v = e as SecurityPolicyViolationEvent;
    try { if (v.blockedURI && url.indexOf(v.blockedURI) === 0) cspBlocked = true; } catch { /* ignore */ }
  };

  const hist = window.history;
  const origPush = hist.pushState, origReplace = hist.replaceState;
  const patch = (orig: typeof origPush) => function (this: History, ...args: Parameters<typeof origPush>): void {
    orig.apply(this, args);
    onRoute();
  };
  let interval: ReturnType<typeof setInterval> | null = null;
  let unsubForm: (() => void) | null = null, unmount: (() => void) | null = null;
  try {
    document.addEventListener('visibilitychange', onVisibility);
    document.addEventListener('securitypolicyviolation', onCsp);
    window.addEventListener('pagehide', onHide);
    if (spa) {
      hist.pushState = patch(origPush);
      hist.replaceState = patch(origReplace);
      window.addEventListener('popstate', onRoute);
    }
    if (engagement) {
      window.addEventListener('scroll', onScroll, { passive: true });
      interval = setInterval(onTick, TICK_MS);
    }
    if (forms) unsubForm = subscribeSubmit(onSubmit);
  } catch { /* partial DOM */ }

  try { referrer = document.referrer || ''; } catch { /* none */ }
  ready = true;
  wasOn = consentNow();
  if (!wasOn) dropPid();
  pageview();
  const diagnose = (): RevealDiagnostics => { const [c, src] = resolve(); return diag(!stopped, c, src, cmp.read().cmp); };
  try { if (opts.debug || /[?&]prynt_debug=1/.test(location.search)) unmount = mountDebug(diagnose); } catch { /* no DOM */ }

  return {
    pageview,
    track(name: string, props?: Record<string, unknown>): void {
      const n = typeof name === 'string' ? name.trim().slice(0, 100) : '';
      if (!n) return;
      const ev = base('custom');
      ev.name = n;
      const p = cleanProps(props);
      if (p) ev.props = p;
      full(ev);
    },
    // identify({email, name?}) (Reveal) · identify(userId, traits?) / identify({userId, email?}, traits?)
    // (Analytics: your own first-party user id). Either way consent-only (`full`); traits follow track() props.
    identify(identity: string | { email?: string; name?: string; userId?: string }, traits?: Record<string, unknown>): void {
      const o = typeof identity === 'string' ? { userId: identity } : (identity && typeof identity === 'object' ? identity : {});
      const email = typeof o.email === 'string' ? o.email.trim() : '';
      const uid = typeof o.userId === 'string' ? o.userId.trim().slice(0, 190) : '';
      const mailOk = EMAIL.test(email);
      if (!mailOk && !uid) return;
      const ev = base('identify');
      ev.identity = mailOk ? { email } : {};
      if (uid) ev.identity.userId = uid;
      if (mailOk && 'name' in o && o.name) ev.identity.name = String(o.name).slice(0, 120);
      const p = cleanProps(traits);
      if (p) ev.props = p;
      full(ev);
    },
    setConsent(given: boolean): void {
      consentSet = !!given;
      recheck();
    },
    flush(): Promise<void> { return flush(); },
    diagnose,
    stop(): void {
      if (stopped) return;
      engage();
      stopped = true;
      cmp.stop();
      if (unsubForm) unsubForm();
      if (unmount) unmount();
      try {
        document.removeEventListener('visibilitychange', onVisibility);
        document.removeEventListener('securitypolicyviolation', onCsp);
        window.removeEventListener('pagehide', onHide);
        window.removeEventListener('popstate', onRoute);
        window.removeEventListener('scroll', onScroll);
        if (spa) { hist.pushState = origPush; hist.replaceState = origReplace; }
      } catch { /* partial DOM */ }
      if (interval !== null) clearInterval(interval);
      void flush();
    },
  };
}
