// Reveal-only entry: dist/prynt-reveal.{umd.js,mjs,cjs} (UMD global `PryntReveal`). Bundles
// reveal.ts + consent_cmp.ts + forms.ts + reveal_debug.ts and nothing of the device-intelligence
// agent, so Reveal-only customers load ~14 kB instead of the full ~47 kB bundle.
//
// Independent of Prynt.load(): the visitorId stays null unless the FULL agent is also present on
// window.Prynt (same page, loaded from /cdn/prynt.umd.js or npm) — detected at call time through
// its `_agent()` hook, never imported. The version is injected by build.mjs from package.json.
import type { RevealOptions, RevealClient } from './index';
import { createReveal } from './reveal';

declare const __PRYNT_VERSION__: string;
const DEFAULT_ENDPOINT = 'https://api.pryntid.com';

interface FullAgent { _agent?: () => { visitorId: string | null; endpoint: string | null } }

const fullAgent = (): { visitorId: string | null; endpoint: string | null } | null => {
  try {
    const p = (window as unknown as { Prynt?: FullAgent }).Prynt;
    return p && typeof p._agent === 'function' ? p._agent() : null;
  } catch { return null; }
};

/** The @pryntid/js version this Reveal-only build was made from (same as the full agent's). */
export const version: string = typeof __PRYNT_VERSION__ === 'string' ? __PRYNT_VERSION__ : '0.0.0';

/** Reveal: B2B visitor identification. Starts tracking immediately; see RevealOptions. */
export function reveal(opts: RevealOptions): RevealClient {
  const agent = fullAgent();
  return createReveal(opts, (agent && agent.endpoint) || DEFAULT_ENDPOINT,
                      () => { const a = fullAgent(); return a ? a.visitorId : null; }, version);
}

const PryntReveal = { reveal, version };
export default PryntReveal;
export { PryntReveal };
