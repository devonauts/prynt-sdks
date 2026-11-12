// `Prynt.replay()` in the core agent: a ~1 kB loader. It injects dist/prynt-replay.umd.js (rrweb recorder,
// ~25 kB gz, built from replay_entry.ts) only when a page asks for Replay, and forwards calls made before the
// script arrived. Script location: `scriptUrl`, else next to the core script that loaded us
// (…/cdn/prynt.umd.js → …/cdn/prynt-replay.umd.js), else `<endpoint>/cdn/prynt-replay.umd.js`.
import type { ReplayClient, ReplayDiagnostics, ReplayOptions } from './index';

interface ReplayGlobal { replay: (o: ReplayOptions, vid?: () => string | null) => ReplayClient }
const FILE = 'prynt-replay.umd.js';
const CORE_RX = /\/prynt(\.umd|\.global)?\.js(\?.*)?$/;
// document.currentScript is only set while the core script itself runs: read it once, at load.
const CORE_SRC = ((): string => {
  try {
    const s = typeof document !== 'undefined' ? (document.currentScript as HTMLScriptElement | null) : null;
    return s && s.src && CORE_RX.test(s.src) ? s.src : '';
  } catch { return ''; }
})();
let loading: Promise<ReplayGlobal | null> | null = null;

export function replayScriptUrl(opts: ReplayOptions, endpoint: string): string {
  if (opts.scriptUrl) return opts.scriptUrl;
  if (CORE_SRC) return CORE_SRC.replace(CORE_RX, '/' + FILE);
  return endpoint.replace(/\/$/, '') + '/cdn/' + FILE;
}

function inject(src: string): Promise<ReplayGlobal | null> {
  const w = window as unknown as { PryntReplay?: ReplayGlobal };
  if (w.PryntReplay) return Promise.resolve(w.PryntReplay);
  if (loading) return loading;
  loading = new Promise((resolve) => {
    try {
      const s = document.createElement('script');
      s.src = src;
      s.async = true;
      s.crossOrigin = 'anonymous';
      s.onload = (): void => resolve(w.PryntReplay || null);
      s.onerror = (): void => { loading = null; resolve(null); };
      (document.head || document.documentElement).appendChild(s);
    } catch { resolve(null); }
  });
  return loading;
}

export function loadReplay(opts: ReplayOptions, defaultEndpoint: string, visitorId: () => string | null): ReplayClient {
  if (!opts || !opts.publicKey) throw new Error('[Prynt] replay: publicKey is required');
  const endpoint = (opts.endpoint || defaultEndpoint).replace(/\/$/, '');
  const queue: Array<(c: ReplayClient) => void> = [];
  let inner: ReplayClient | null = null, failed = false;
  const off = (reason: string): ReplayDiagnostics => ({ state: failed ? 'off' : 'loading', reason, sessionId: null, seq: 0,
    chunksSent: 0, bytesSent: 0, lastStatus: null, consent: false, consentSource: 'default', gpc: false, endpoint });
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return { identify: () => undefined, setConsent: () => undefined, state: () => undefined, stop: () => undefined, flush: () => Promise.resolve(),
             diagnose: () => ({ ...off('no_dom'), state: 'off' }), ready: Promise.resolve(false) };
  }
  const ready = inject(replayScriptUrl(opts, endpoint)).then((g) => {
    if (!g) { failed = true; return false; }
    inner = g.replay({ ...opts, endpoint }, visitorId);
    for (const fn of queue.splice(0)) fn(inner);
    return inner.ready;
  });
  const call = (fn: (c: ReplayClient) => void): void => { if (inner) fn(inner); else if (!failed) queue.push(fn); };
  return {
    identify: (userId: string, traits?: { accountId?: string | number }): void => call((c) => c.identify(userId, traits)),
    setConsent: (given: boolean): void => call((c) => c.setConsent(given)),
    state: (label: string, value?: unknown): void => call((c) => c.state(label, value)),
    stop: (): void => call((c) => c.stop()),
    flush: (): Promise<void> => (inner ? inner.flush() : Promise.resolve()),
    diagnose: (): ReplayDiagnostics => (inner ? inner.diagnose() : off(failed ? 'script_unavailable' : 'loading')),
    ready,
  };
}
