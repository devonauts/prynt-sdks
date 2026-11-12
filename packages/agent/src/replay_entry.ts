// Replay bundle entry: dist/prynt-replay.{umd.js,mjs,cjs} (UMD global `PryntReplay`), the rrweb recorder +
// fflate + replay.ts. Loaded on demand by `Prynt.replay()` of the core agent (replay_loader.ts) or imported
// directly as `@pryntid/js/replay`. The core bundle never contains rrweb.
import { record } from '@rrweb/record';
import type { ReplayClient, ReplayOptions } from './index';
import { createReplay } from './replay';
import type { ReplayDeps } from './replay';

declare const __PRYNT_VERSION__: string;
const DEFAULT_ENDPOINT = 'https://api.pryntid.com';

interface FullAgent { _agent?: () => { visitorId: string | null; endpoint: string | null } }
const fullAgent = (): { visitorId: string | null; endpoint: string | null } | null => {
  try {
    const p = (window as unknown as { Prynt?: FullAgent }).Prynt;
    return p && typeof p._agent === 'function' ? p._agent() : null;
  } catch { return null; }
};

/** The @pryntid/js version this Replay build was made from. */
export const version: string = typeof __PRYNT_VERSION__ === 'string' ? __PRYNT_VERSION__ : '0.0.0';

/** Prynt Replay: privacy-first session recording. See ReplayOptions. `visitorId` is used by the core loader. */
export function replay(opts: ReplayOptions, visitorId?: () => string | null): ReplayClient {
  const agent = fullAgent();
  const vid = visitorId || ((): string | null => { const a = fullAgent(); return a ? a.visitorId : null; });
  return createReplay(opts, (agent && agent.endpoint) || DEFAULT_ENDPOINT, vid,
                      { record: record as unknown as ReplayDeps['record'] });
}

const PryntReplay = { replay, version };
export default PryntReplay;
export { PryntReplay };

/** Redux middleware: records each action type in the replay's State tab (payloads are not recorded). */
export function reduxMiddleware(r: ReplayClient) {
  return () => (next: (a: unknown) => unknown) => (action: unknown): unknown => {
    const out = next(action);
    try { const t = action && typeof action === 'object' ? (action as { type?: unknown }).type : null; if (typeof t === 'string') r.state('action', t); } catch { /* ignore */ }
    return out;
  };
}
