// Consent-manager auto-detection for Reveal (PRD FP-8). Read-only: the SDK never writes to a CMP.
//
// A CMP is "detected" when its global/cookie is present; `consent` is then true/false once the
// visitor decided and `null` while the banner is still open (treated as no consent). Category used:
// analytics/statistics (CookieYes `analytics`, Cookiebot `statistics`, OneTrust `C0002`, Klaro a
// service named `prynt` or one named like analytics/statistics, TCF 2.2 purposes 1 AND 7, Google
// Consent Mode `analytics_storage`). Order = first match wins (a site rarely runs two CMPs).
// Every read is wrapped: a CMP that throws must never break the host page.

export type CmpName = 'cookieyes' | 'cookiebot' | 'onetrust' | 'klaro' | 'tcf' | 'gcm';
export interface CmpState { cmp: CmpName | null; consent: boolean | null }

type Any = Record<string, any>;   // eslint-disable-line @typescript-eslint/no-explicit-any

const r = (cmp: CmpName, consent: boolean | null): CmpState => ({ cmp, consent });

// `tcf` is the last TCF decision seen by the __tcfapi listener (TCF is callback-only).
export function readCmp(tcf: boolean | null | undefined): CmpState {
  const w = window as Any;
  try {
    if (typeof w.getCkyConsent === 'function') {
      const c = w.getCkyConsent();
      if (c && c.categories) return r('cookieyes', c.isUserActionCompleted === false ? null : !!c.categories.analytics);
    }
    const m = /(?:^|;\s*)cookieyes-consent=([^;]*)/.exec(document.cookie);
    if (m) { const v = decodeURIComponent(m[1]); return r('cookieyes', /action:yes/.test(v) ? /analytics:yes/.test(v) : null); }
  } catch { /* next */ }
  try {
    const cb = w.Cookiebot;
    if (cb && cb.consent) return r('cookiebot', cb.hasResponse === false ? null : !!cb.consent.statistics);
  } catch { /* next */ }
  try {
    const g = w.OnetrustActiveGroups;
    if (typeof g === 'string' || w.OneTrust) return r('onetrust', typeof g === 'string' && g ? g.indexOf('C0002') >= 0 : null);
  } catch { /* next */ }
  try {
    const k = w.klaro;
    if (k && typeof k.getManager === 'function') {
      const mg = k.getManager(), cs: Any = (mg && mg.consents) || {};
      let v: boolean | null = null;
      if ('prynt' in cs) v = !!cs.prynt;
      else for (const n in cs) if (/analytics|statistics/i.test(n)) { v = !!cs[n]; break; }
      return r('klaro', mg && mg.confirmed === false ? null : v);
    }
  } catch { /* next */ }
  if (tcf !== undefined) return r('tcf', tcf);
  try {
    const dl = w.dataLayer;
    if (Array.isArray(dl)) {
      let v: boolean | null = null, seen = false;
      for (let i = 0; i < dl.length; i++) {
        const e = dl[i];
        if (e && e[0] === 'consent' && (e[1] === 'default' || e[1] === 'update') && e[2]) {
          seen = true;
          const a = e[2].analytics_storage;
          if (a) v = a === 'granted';
        }
      }
      if (seen) return r('gcm', v);
    }
  } catch { /* next */ }
  return { cmp: null, consent: null };
}

// Watches for consent changes with a 1 s poll (CMPs load after us, every CMP state above is
// readable, and GCM has no event) plus the TCF listener (TCF is callback-only). `onChange` fires
// on every tick; the caller diffs. Returns read()/stop().
export function watchCmp(onChange: () => void): { read: () => CmpState; stop: () => void } {
  const w = window as Any;
  let tcf: boolean | null | undefined;          // undefined = no __tcfapi seen
  const tick = (): void => {
    if (tcf === undefined && typeof w.__tcfapi === 'function') {
      tcf = null;
      try {
        w.__tcfapi('addEventListener', 2, (d: Any, ok: boolean) => {
          if (!ok || !d) return;
          if (d.gdprApplies === false) tcf = true;
          else if (d.eventStatus === 'tcloaded' || d.eventStatus === 'useractioncomplete') {
            const c = d.purpose && d.purpose.consents;
            tcf = !!(c && c[1] && c[7]);
          } else return;
          onChange();
        });
      } catch { /* ignore */ }
    }
    onChange();
  };
  tick();
  const iv = setInterval(tick, 1000);
  return { read: () => readCmp(tcf), stop: () => clearInterval(iv) };
}
