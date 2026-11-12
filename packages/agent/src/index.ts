import { hash128 } from './hash';
import * as S from './signals';
import { botTells, permissionAnomaly, incognitoHint, descriptorTells } from './bot';
import { readHints, persist } from './storage';
import { startBehavior } from './behavior';
import { stealthTells } from './stealth';
import { solveChallenge } from './challenge';
import { createReveal } from './reveal';
import { createAnalytics } from './analytics';
import { loadReplay } from './replay_loader';
import { markShielded } from './forms';
import type { BehaviorTracker } from './behavior';

export interface PryntConfig {
  apiKey: string;                 // public key pk_...
  endpoint?: string;              // default https://api.pryntid.com (Prynt Cloud); self-hosted: your API base URL
  timeout?: number;               // ms, default 6000
  extendedResult?: boolean;       // request smart signals in the response (plan-gated server-side)
  tag?: Record<string, unknown>;  // arbitrary key/values stored with the event (e.g. { action:'checkout' })
  linkedId?: string;              // your own user id to associate with this visitor
  respectGPC?: boolean;           // honor navigator.globalPrivacyControl (default true)
  respectDNT?: boolean;           // honor Do Not Track (default false; DNT is deprecated)
  requireConsent?: boolean;       // don't identify until setConsent(true) is called (default false)
  sealedResult?: boolean;         // request an encrypted, tamper-proof result (needs a sealing key configured)
  behaviorTiming?: boolean;       // opt-in: add key-hold and mouse-cadence AGGREGATES to the behaviour
                                  // summary (never keys, positions or timestamps). Default false.
  deterrence?: boolean;           // if the server returns a deterrence notice for a flagged visitor,
                                  // also console.warn it (default false — by default the notice is
                                  // just returned and YOUR site decides whether to display it)
}

// A security notice from the server: a flagged-visitor DETERRENCE notice on a normal response, or a
// PROHIBITION notice when the key is used on an unlicensed origin. `ref` links to a real event.
export interface SecurityNotice {
  level: 'warning' | 'block' | 'prohibited';
  message: string;
  ref?: string;
}

// Message content submitted for server-side spam analysis (Cyrillic/CJK mismatch, links, keywords).
export interface FormContent { text?: string; subject?: string; expectedScripts?: string[]; }
// Anti-bot signals captured around a protected form (honeypot + timing + interaction).
export interface FormSignals { honeypotTripped: boolean; timeToSubmitMs?: number; interacted?: boolean; pasted?: boolean; }
// Handle returned by protectForm(); call signals() at submit time to read the captured tells.
export interface FormGuard { signals: () => FormSignals; }

export interface ProtectFormOpts {
  honeypotName?: string;
  // Drop-in mode: intercept the form's submit, run identify (honeypot + timing + content), and
  // block the submission on a bad verdict — the integrator writes no submit handler.
  autoGuard?: boolean;
  // Field to read the message text from for content spam analysis: a CSS selector, or omitted to
  // auto-detect the form's first <textarea>. Set expectedScripts to enable the Cyrillic/CJK check.
  messageSelector?: string;
  expectedScripts?: string[];
  // How to treat a 'challenge' verdict in autoGuard (default 'block' — fail safe).
  challengeAs?: 'block' | 'allow';
  // Callbacks (autoGuard). onVerdict may return false to force-allow despite the verdict.
  onVerdict?: (result: IdentifyResult) => void | boolean;
  onBlocked?: (result: IdentifyResult) => void;
  onError?: (err: unknown) => void;
}

// Attach honeypot + timing protection to a form. Injects an invisible decoy field (bots fill it),
// stamps render time, watches for real interaction/paste. With autoGuard it also intercepts submit,
// runs identify, and blocks bots automatically. Deterrent-grade, zero user friction.
function protectForm(form: HTMLFormElement, opts?: ProtectFormOpts,
                     identifyFn?: PryntClient['identify']): FormGuard {
  opts = opts || {};
  markShielded(form);   // lets Reveal's `form` event say shielded:true for this form (FP-6)
  const state = { renderedAt: nowMs(), interacted: false, pasted: false, hp: null as HTMLInputElement | null };
  try {
    const hp = document.createElement('input');
    hp.type = 'text';
    hp.name = opts.honeypotName || 'pr_hp_' + Math.floor(nowMs() % 1e6).toString(36);
    hp.tabIndex = -1;
    hp.autocomplete = 'off';
    hp.setAttribute('aria-hidden', 'true');
    hp.style.cssText = 'position:absolute!important;left:-9999px!important;top:auto;width:1px;height:1px;opacity:0;pointer-events:none';
    form.appendChild(hp);
    state.hp = hp;
    const onInteract = (e: Event) => { if (e.target !== hp) state.interacted = true; };
    const onPaste = () => { state.pasted = true; };
    form.addEventListener('keydown', onInteract, true);
    form.addEventListener('focusin', onInteract, true);
    form.addEventListener('paste', onPaste, true);
  } catch { /* DOM unavailable — signals() still returns a safe default */ }

  const guard: FormGuard = {
    signals(): FormSignals {
      const hpVal = state.hp ? state.hp.value : '';
      return { honeypotTripped: !!hpVal, timeToSubmitMs: Math.max(0, nowMs() - state.renderedAt),
               interacted: state.interacted, pasted: state.pasted };
    },
  };

  if (opts.autoGuard && identifyFn) {
    let cleared = false;   // set once a submission is verified-good, to let the native submit pass
    const readMessage = (): string => {
      try {
        const el = opts!.messageSelector
          ? form.querySelector(opts!.messageSelector)
          : (form.querySelector('textarea') || form.querySelector('input[name="message"],input[name="body"],input[name="comment"]'));
        return el && 'value' in el ? String((el as HTMLInputElement).value || '') : '';
      } catch { return ''; }
    };
    form.addEventListener('submit', (ev: Event) => {
      if (cleared) { cleared = false; return; }   // our own re-submit — let it through
      ev.preventDefault();
      ev.stopPropagation();
      const content: FormContent | undefined = (() => {
        const text = readMessage();
        return text ? { text, expectedScripts: opts!.expectedScripts } : undefined;
      })();
      identifyFn({ formSignals: guard.signals(), content })
        .then((result) => {
          const verdict = result.decision && result.decision.decision;
          const blockOnChallenge = (opts!.challengeAs || 'block') === 'block';
          const bad = verdict === 'block' || (verdict === 'challenge' && blockOnChallenge);
          let allow = !bad;
          if (opts!.onVerdict) {
            const ov = opts!.onVerdict(result);
            if (ov === false) allow = true;   // integrator overrides to allow
          }
          if (allow) { cleared = true; try { form.requestSubmit ? form.requestSubmit() : form.submit(); } catch { form.submit(); } }
          else if (opts!.onBlocked) opts!.onBlocked(result);
        })
        .catch((err) => {
          // Fail OPEN on our error so a Prynt outage never blocks a real user's submission.
          if (opts!.onError) opts!.onError(err);
          cleared = true; try { form.requestSubmit ? form.requestSubmit() : form.submit(); } catch { form.submit(); }
        });
    }, true);
  }

  return guard;
}

function nowMs(): number { try { return Date.now(); } catch { return 0; } }

// Render a server security notice as a styled console banner. Deterrent only — a determined actor
// can strip this; the real enforcement (origin allowlist, rate limits, reputation) is server-side.
function emitNotice(notice: SecurityNotice): void {
  try {
    const prohibited = notice.level === 'prohibited';
    const label = prohibited ? '⛔ PRYNT — UNLICENSED USE' : '🔒 PRYNT — SECURITY NOTICE';
    const color = prohibited || notice.level === 'block' ? '#d1443f' : '#b9770a';
    const ref = notice.ref ? `\nRef: ${notice.ref}` : '';
    // eslint-disable-next-line no-console
    console.warn(`%c${label}%c ${notice.message}${ref}`,
      `background:${color};color:#fff;padding:2px 6px;border-radius:3px;font-weight:700`, 'color:inherit');
  } catch { /* console unavailable — ignore */ }
}

// Result of challenge(): pass the passToken to your server, which validates it with Prynt.
// (Declared here, not in challenge.ts, so the published index.d.ts is self-contained.)
export interface ChallengeResult { passed: boolean; passToken: string | null }

export interface Confidence { score: number; level: 'low' | 'medium' | 'high'; /** Other visitors that also matched this browser without a storage id (identical hardware). */ lookalikes?: number; }
export interface SmartSignal { result: boolean; [k: string]: unknown; }

export interface Decision {
  decision: 'allow' | 'challenge' | 'block';
  suspectScore: number;
  riskScore?: number;
  reasonCodes?: string[];
  tags?: string[];
}

export type UseCase = 'signup' | 'free_trial' | 'bonus' | 'login' | 'checkout' | 'extra_seat' | 'sms' | 'otp' | 'paywall' | 'trial' | 'seat';
export interface ControlDecision {
  useCase: string;
  mode: 'enforce' | 'mirror';
  decision: 'allow' | 'step_up' | 'block';
  step: 'none' | 'captcha' | 'verify_email' | 'card_or_passkey' | 'block';
  reasons: Array<{ code: string; text: string }>;
  cappedAt?: string;
  wouldBe?: { decision: string; step: string };
}
export interface MirrorInfo { active: boolean; wouldBe: string; until: string; }

interface IdentifyResponse {
  requestId: string;
  visitorId: string;
  ip?: string;
  visitorFound?: boolean;
  confidence?: Confidence;
  firstSeenAt?: string;
  lastSeenAt?: string;
  seenCount?: number;
  daysSinceFirstSeen?: number;
  smartSignals?: Record<string, SmartSignal>;
  decision?: Decision;
  reputation?: { status?: string | null; reason?: string | null };
  storage?: string;
  sealed?: boolean;
  sealedResult?: string;
  notice?: SecurityNotice;
  control?: ControlDecision;
  mirror?: MirrorInfo;
}

export interface IdentifyResult {
  requestId: string;
  visitorId: string;
  // Full resolved client IP as seen by the server (from trusted edge headers).
  ip?: string;
  visitorFound: boolean;
  confidence: Confidence;
  firstSeenAt?: string;
  lastSeenAt?: string;
  seenCount?: number;
  daysSinceFirstSeen?: number;
  smartSignals?: Record<string, SmartSignal>;
  // Allow/challenge/block verdict with the normalized suspect score (0–1) and reason codes.
  decision?: Decision;
  reputation?: { status?: string | null; reason?: string | null };
  // Security notice for a flagged visitor (deterrence). Returned so YOUR site can decide whether
  // to display it; with config.deterrence=true the agent also console.warns it.
  notice?: SecurityNotice;
  // Raw fingerprint hash computed on-device (stable component ids), useful for debugging
  fingerprint: string;
  // True when the request was suppressed to honor GPC/DNT/consent.
  consentWithheld?: boolean;
  // Encrypted result (base64). Present only in sealed mode; decrypt it on YOUR server with the
  // sealing key. When set, the plaintext visitorId/confidence/smartSignals are intentionally absent.
  sealedResult?: string;
  // Prynt Control: the use-case decision, when identify() was called with a useCase.
  control?: ControlDecision;
  // Mirror mode: the decision was answered allow; wouldBe is the real verdict.
  mirror?: MirrorInfo;
}

const SDK_VERSION = '1.1.0';
// How this copy was installed, baked in by build.mjs: 'cdn' (script tag build), 'npm' (the
// registry package) or 'download' (the tarball from pryntid.com/downloads). Sent with every
// call so the console can show which SDK versions and channels each account runs.
declare const __PRYNT_CHANNEL__: string;
const SDK_CHANNEL = typeof __PRYNT_CHANNEL__ === 'string' ? __PRYNT_CHANNEL__ : 'npm';
const SDK_INFO = { name: 'js', version: SDK_VERSION, channel: SDK_CHANNEL };
// Bumped whenever a signal's collection algorithm changes so the server can compare
// like-for-like (or migrate) instead of treating old and new values as equivalent.
const SIGNAL_VERSION = 2;

// A value that carries no identifying entropy (blocked/errored/timed-out API). These must
// never enter the stable fingerprint nor count as a "match" — otherwise every locked-down
// (Tor/Brave/Lockdown) browser collapses onto one shared identity.
function isSentinel(v: unknown): boolean {
  return typeof v === 'string' && (v === 'unsupported' || v.startsWith('err:') || v.endsWith('-timeout'));
}

let _consentGiven: boolean | null = null;
// Behavioral biometrics tracker, started on load() so it observes the whole session.
let _behavior: BehaviorTracker | null = null;
// Last visitorId returned by identify() and the endpoint given to load(): reused by Prynt.reveal()
// so Reveal events join the same visitor without spending another identification.
let _lastVisitorId: string | null = null;
let _agentEndpoint: string | null = null;

// Detect a browser-level opt-out (Global Privacy Control / Do Not Track).
function privacyOptOut(cfg: PryntConfig): { withheld: boolean; reason?: string } {
  const nav = navigator;
  if (cfg.respectGPC !== false && nav.globalPrivacyControl === true) {
    return { withheld: true, reason: 'gpc' };
  }
  if (cfg.respectDNT === true) {
    const dnt = nav.doNotTrack || window.doNotTrack || nav.msDoNotTrack;
    if (dnt === '1' || dnt === 'yes') return { withheld: true, reason: 'dnt' };
  }
  if (cfg.requireConsent === true && _consentGiven !== true) {
    return { withheld: true, reason: 'no-consent' };
  }
  return { withheld: false };
}

// Automation / stealth tells only: booleans, API names, the UA and UA-CH low-entropy brands that
// every request carries anyway, and the behaviour aggregates. NO canvas/WebGL/audio/font values and
// nothing stored on the device, so this set is separable from identification. (Today it is still
// only sent together with the full signal set: GPC/DNT/consent opt-outs send nothing — whether bot
// checks may run under GPC is a legal decision, not a technical one.)
async function collectBotSignals(webglRenderer: string) {
  const [permAnomaly, stealth] = await Promise.all([permissionAnomaly(), stealthTells(webglRenderer)]);
  const bot = botTells();
  const descriptor = descriptorTells();
  if (bot.headlessHints) {
    bot.headlessHints.permissionsAnomaly = permAnomaly;
    bot.headlessHints.webglSwiftShader = /swiftshader|llvmpipe|software/i.test(webglRenderer);
  }
  return {
    webdriver: bot.webdriver,
    automationProps: bot.automationProps,
    headlessHints: bot.headlessHints,
    descriptorTells: descriptor,
    stealthTells: stealth,
    userAgent: bot.userAgent,
    uaData: bot.uaData,
    productSub: bot.productSub,
    behavior: _behavior ? _behavior.summary() : { observed: false },
  };
}

async function collect() {
  // Kick off async collectors together
  const webgl = S.webgl();
  const [audio, storageQuota, incognito, uaCH, botSignals] = await Promise.all([
    S.audio(), S.storageQuota(), incognitoHint(), S.uaHighEntropy(), collectBotSignals(webgl.renderer),
  ]);

  const canvas = S.canvas();
  const fonts = S.fonts();

  const signals = {
    signalVersion: SIGNAL_VERSION,
    canvas: canvas.hash,
    canvasPhash: canvas.phash,          // perceptual hash → server scores by similarity
    canvasWinding: canvas.winding,
    canvasNoise: canvas.noise,          // farbling / anti-detect tell
    canvasKnown: S.canvasKnownAnswer(), // false = read-back altered (per-session noise)
    brave: (() => { try { return 'brave' in navigator; } catch { return false; } })(),
    webglVendor: webgl.vendor,
    webglRenderer: webgl.renderer,
    webglHash: webgl.hash,
    webglParams: webgl.params,          // structured vector for field-level comparison
    audio,
    fontsHash: fonts.hash,
    fonts: fonts.list,                  // raw list → server scores Jaccard overlap
    timezone: S.timezone(),
    timezoneOffset: S.timezoneOffset(),
    languages: S.languages(),
    screen: S.screenSignal(),
    touchSupport: S.touchSupport(),
    colorGamut: S.colorGamut(),
    contrast: S.contrastPrefs(),
    math: S.mathFp(),
    mediaCodecs: S.mediaCodecs(),
    storageQuota,
    ...S.hardware(),
    cookiesEnabled: (() => { try { return navigator.cookieEnabled; } catch { return false; } })(),
    localStorageAvailable: (() => { try { localStorage.setItem('__p', '1'); localStorage.removeItem('__p'); return true; } catch { return false; } })(),
    incognitoHint: incognito,
    ...botSignals,
    uaHighEntropy: uaCH,
  };

  // On-device fingerprint: hash of the STABLE, high-entropy components only. Sentinel
  // values are excluded so blocked signals don't manufacture false collisions.
  const stable = [
    signals.canvas, signals.webglHash, signals.audio, signals.fontsHash, signals.math,
    signals.timezone, signals.languages.primary, signals.platform, signals.vendor,
    String(signals.hardwareConcurrency), String(signals.deviceMemory), signals.colorGamut,
    typeof signals.screen === 'object' ? `${signals.screen.w}x${signals.screen.h}x${signals.screen.colorDepth}` : '',
    signals.mediaCodecs, String(signals.touchSupport.maxTouchPoints),
  ].filter((v) => v && !isSentinel(v)).join('###');
  const fingerprint = hash128(stable);

  return { signals, fingerprint };
}

const DEFAULT_ENDPOINT = 'https://api.pryntid.com';

class PryntClient {
  private config: Required<Pick<PryntConfig, 'apiKey' | 'endpoint' | 'timeout'>> & PryntConfig;
  constructor(config: PryntConfig) {
    if (!config || !config.apiKey) throw new Error('[Prynt] apiKey (public key) is required');
    // Defaults to Prynt Cloud; self-hosted installs pass their own API base URL.
    this.config = {
      ...config,
      endpoint: config.endpoint || DEFAULT_ENDPOINT,
      timeout: config.timeout ?? 6000,
    };
    _agentEndpoint = this.config.endpoint;
  }

  /** Record the user's consent decision (for requireConsent flows). */
  setConsent(given: boolean): void { _consentGiven = given; }

  /** Solve a risk-adaptive proof-of-work challenge and return a passToken your server validates. */
  challenge(requestId?: string): Promise<ChallengeResult> {
    return solveChallenge(this.config.endpoint, this.config.apiKey, this.config.timeout, requestId, SDK_INFO);
  }

  private async sendConsentWithheld(reason?: string): Promise<IdentifyResult> {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), this.config.timeout);
    try {
      await fetch(this.config.endpoint.replace(/\/$/, '') + '/v1/identify', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'omit',
        body: JSON.stringify({ publicKey: this.config.apiKey, sdkVersion: SDK_VERSION, sdk: SDK_INFO,
                               consent: { withheld: true, reason } }),
        signal: ctrl.signal, keepalive: true,
      }).catch(() => undefined);
    } finally { clearTimeout(to); }
    return {
      requestId: '', visitorId: '', visitorFound: false,
      confidence: { score: 0, level: 'low' }, fingerprint: '',
      consentWithheld: true,
    } as IdentifyResult;
  }

  async identify(opts?: { tag?: Record<string, unknown>; linkedId?: string;
                          content?: FormContent; formSignals?: FormSignals;
                          useCase?: UseCase; email?: string; phone?: string;
                          paymentMethod?: string }): Promise<IdentifyResult> {
    // Privacy opt-out: send a minimal, non-tracking request the server honors.
    const optOut = privacyOptOut(this.config);
    if (optOut.withheld) {
      return this.sendConsentWithheld(optOut.reason);
    }
    const { signals, fingerprint } = await collect();
    const identityHints = await readHints();

    const body = {
      publicKey: this.config.apiKey,
      sdkVersion: SDK_VERSION,
      sdk: SDK_INFO,
      extendedResult: !!this.config.extendedResult,
      sealed: !!this.config.sealedResult,
      tag: (opts && opts.tag) || this.config.tag || undefined,
      linkedId: (opts && opts.linkedId) || this.config.linkedId || undefined,
      // Form-protection payloads: message content for spam analysis + honeypot/timing signals.
      content: (opts && opts.content) || undefined,
      formSignals: (opts && opts.formSignals) || undefined,
      // Prynt Control: the moment being decided (signup, free_trial, bonus, login, checkout,
      // extra_seat) and, optionally, the email the user typed (disposable-inbox check).
      useCase: (opts && opts.useCase) || undefined,
      email: (opts && opts.email) || undefined,
      // useCase 'sms': the number (E.164, e.g. +14155550101) the code is about to go to. Hashed server side, never stored.
      phone: (opts && opts.phone) || undefined,
      // useCase 'checkout': an opaque card id (Stripe card fingerprint, or BIN+last4). Hashed server side.
      paymentMethod: (opts && opts.paymentMethod) || undefined,
      page: {
        url: (() => { try { return location.href; } catch { return ''; } })(),
        referrer: (() => { try { return document.referrer; } catch { return ''; } })(),
      },
      fingerprint,
      signals,
      identityHints,
    };

    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), this.config.timeout);
    let res: Response;
    try {
      res = await fetch(this.config.endpoint.replace(/\/$/, '') + '/v1/identify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        // Credential-less: the public API key is the auth boundary, not a cookie.
        // The server never combines credentials with a wildcard CORS origin.
        credentials: 'omit',
        signal: ctrl.signal,
        keepalive: true,
      });
    } finally { clearTimeout(to); }

    if (!res.ok) {
      let errBody: { error?: { code?: string; notice?: SecurityNotice } } | null = null;
      try { errBody = await res.json(); } catch { /* ignore */ }
      // Copied snippet / key used on an unlicensed origin: the server attaches a prohibition
      // notice. Surface it loudly so an unauthorized deployment is told it isn't licensed.
      const prohibition = errBody && errBody.error && errBody.error.notice;
      if (res.status === 403 && prohibition) emitNotice(prohibition);
      const detail = errBody ? JSON.stringify(errBody.error || errBody) : '';
      throw new Error(`[Prynt] identify failed: ${res.status} ${detail}`);
    }
    const data = await res.json() as IdentifyResponse;
    // Deterrence notice for a flagged visitor: always returned to the caller; only auto-logged to
    // the visitor's console when the integrator opted in with config.deterrence.
    if (data.notice && this.config.deterrence) emitNotice(data.notice);
    const token = data.storage || data.visitorId;
    if (token) { try { await persist(token); } catch { /* best effort */ } }
    if (data.visitorId) _lastVisitorId = data.visitorId;

    return {
      requestId: data.requestId,
      visitorId: data.visitorId ?? '',
      ip: data.ip,
      visitorFound: !!data.visitorFound,
      confidence: data.confidence || { score: 0, level: 'low' },
      firstSeenAt: data.firstSeenAt,
      lastSeenAt: data.lastSeenAt,
      seenCount: data.seenCount,
      daysSinceFirstSeen: data.daysSinceFirstSeen,
      smartSignals: data.smartSignals,
      decision: data.decision,
      reputation: data.reputation,
      notice: data.notice,
      sealedResult: data.sealedResult,
      control: data.control,
      mirror: data.mirror,
      fingerprint,
    };
  }
}

export interface PryntAgent {
  identify: PryntClient['identify'];
  /** Alias of identify(), so code written for FingerprintJS (`fp.get()`) works unchanged. */
  get: PryntClient['identify'];
  setConsent: PryntClient['setConsent'];
  challenge: PryntClient['challenge'];
  protectForm: (form: HTMLFormElement, opts?: ProtectFormOpts) => FormGuard;
}

// ---- Reveal (B2B visitor identification) — public types; implementation in reveal.ts ----
export interface RevealOptions {
  publicKey: string;                       // public key pk_...
  website?: string;                        // default: location.hostname without "www."
  // true/false, or a function read at each event (e.g. your CMP's state). Default: true unless
  // the page looks EU/UK/CH (timezone or <html lang>) or the browser sends GPC — then false.
  consent?: boolean | (() => boolean);
  spa?: boolean;                           // pageviews on history.pushState/replaceState/popstate (default true)
  engagement?: boolean;                    // active time + scroll depth events (default true)
  // Email/name from submitted forms (default off): `true` = every form, CSS selectors, or
  // `{ selectors?, requireConsent? }`. requireConsent (default true) = capture only when consent is
  // true; `false` = the submission itself is the first-party consent (the form id is sent as
  // consentRef) — only use it when your form says so.
  forms?: boolean | string[] | RevealFormsOptions;
  endpoint?: string;                       // API base; default: the endpoint given to Prynt.load(), else Prynt Cloud
  debug?: boolean;                         // show the diagnostics panel (same as ?prynt_debug=1 in the URL)
  // Signed email-link person token (`?pid=`, S3-W2-T3): on by default, read only once consent is true;
  // `false` turns it off, an object sets the parameter name / localStorage persistence.
  pid?: boolean | RevealPidOptions;
}
export interface RevealFormsOptions { selectors?: string[]; requireConsent?: boolean }

// Where the consent decision in force came from (PRD FP-8). Sent as `consentSource` with every
// batch and written to reveal_consent_records on change. GPC always wins (consent = false).
export type RevealConsentSource =
  | 'config'      // the `consent` option (boolean or function) passed to Prynt.reveal()
  | 'override'    // setConsent() called by the integrator
  | 'gpc'         // navigator.globalPrivacyControl
  | 'cookieyes' | 'cookiebot' | 'onetrust' | 'klaro'   // auto-detected consent managers
  | 'tcf'         // IAB TCF 2.2 (__tcfapi)
  | 'gcm'         // Google Consent Mode (dataLayer consent / analytics_storage)
  | 'default';    // nothing configured, no CMP: the EU/UK/CH heuristic

// Result of Prynt.reveal(...).diagnose() — the installation debugger (PRD ON-3): the 7 install
// checks plus storage and GPC. Rendered by the `?prynt_debug=1` panel and the console wizard.
export interface RevealDiagnostics {
  loaded: boolean;              // a Reveal client is running on this page
  sdkVersion: string;
  publicKey: string | null;     // masked (pk_live_ab…yz); never the full key
  website: string;              // what events are sent with (option or location.hostname sans www)
  endpoint: string;
  consent: boolean;
  consentSource: RevealConsentSource;
  cmpDetected: string | null;   // 'cookieyes' | 'cookiebot' | 'onetrust' | 'klaro' | 'tcf' | 'gcm' | null
  storage: 'localStorage' | 'memory' | 'blocked';   // where prynt_rvs lives; 'blocked' = storage access threw
  gpc: boolean;
  cspBlocked: boolean;          // a send to the endpoint was refused by the page's CSP (connect-src)
  sessionId: string | null;
  visitorId: string | null;     // from Prynt.load(), when it ran and consent is true
  queued: number;               // events waiting in the current batch
  lastSend: { at: string; status: number | null; accepted: number; error: string | null } | null;
}

// Signed email-link person token (`?pid=…`, FP-3, S3-W2-T3): read by reveal.ts only after consent +
// GPC/CMP checks; stripped from the URL that is sent and from the address bar.
export interface RevealPidOptions {
  param?: string;    // URL parameter that carries the signed token (default 'pid')
  store?: boolean;   // keep the token in localStorage (`prynt_pid`) for later visits; opt-out clears it
}

export interface RevealClient {
  /** Record a pageview (automatic on start and on SPA route changes; call it for custom routers). */
  pageview(url?: string): void;
  /** Custom event. props: flat strings/numbers/booleans, max 20 keys, 200 chars; PII-looking keys dropped. */
  track(name: string, props?: Record<string, unknown>): void;
  /** First-party identity from your own login/form. Queued until consent is true. `identify(userId, traits?)`
      links the session to YOUR user id (Analytics cohorts / retention); traits follow the track() props rules. */
  identify(identity: string | { email?: string; name?: string; userId?: string }, traits?: Record<string, unknown>): void;
  setConsent(given: boolean): void;
  flush(): Promise<void>;
  stop(): void;
  /** Installation diagnostics (PRD ON-3): what the `?prynt_debug=1` panel shows. */
  diagnose: () => RevealDiagnostics;
}

// ---- Shared product events (Prynt.analytics) — implementation in analytics.ts ----
/** Options of Prynt.analytics(): RevealOptions without the Reveal-only signed email-link token. */
export type AnalyticsOptions = Omit<RevealOptions, 'pid'>;
export interface AnalyticsClient extends RevealClient {
  /** Pageview of the current URL (or `url`); same as pageview(). */
  page(url?: string): void;
}

// ---- Session replay (Prynt.replay) — loader in replay_loader.ts, recorder in replay.ts (separate bundle) ----
export interface ReplayOptions {
  publicKey: string;                       // public key pk_...
  website?: string;                        // default: location.hostname without "www."
  endpoint?: string;                       // API base; default: the endpoint given to Prynt.load(), else Prynt Cloud
  // Same consent model as Prynt.analytics(): nothing is recorded until consent is true; GPC never records.
  consent?: boolean | (() => boolean);
  // Can only mask MORE than the site's policy (Replay settings in the console). Inputs are always masked.
  maskAllText?: boolean;
  maskSelector?: string;                   // CSS selectors whose text is masked
  blockSelector?: string;                  // CSS selectors not recorded at all
  scriptUrl?: string;                      // where prynt-replay.umd.js is served (default: next to prynt.umd.js)
}
export interface ReplayDiagnostics {
  state: 'loading' | 'waiting_consent' | 'recording' | 'paused' | 'off';
  reason: string | null;                   // e.g. gpc, no_consent, sampled_out, url_excluded, quota, server_403
  sessionId: string | null;
  seq: number;                             // next chunk sequence number
  chunksSent: number;
  bytesSent: number;                       // compressed
  lastStatus: number | null;
  consent: boolean;
  consentSource: RevealConsentSource;
  gpc: boolean;
  endpoint: string;
}
export interface ReplayClient {
  /** Your own user id (never an email): find this user's sessions in the console. `accountId` is your customer /
   *  company / workspace id: list a whole account's sessions (`GET /v1/replay/sessions?accountId=`). */
  identify(userId: string, traits?: { accountId?: string | number }): void;
  setConsent(given: boolean): void;
  /** App state or an action for the developer tools (recorded only when the site turns «state» on). */
  state(label: string, value?: unknown): void;
  stop(): void;
  flush(): Promise<void>;
  diagnose(): ReplayDiagnostics;
  /** Resolves true once recording started, false when this session is not recorded. */
  ready: Promise<boolean>;
}

const Prynt = {
  /** Initialize the agent. Returns an object with identify(). */
  load(config: PryntConfig): Promise<PryntAgent> {
    if (!_behavior) _behavior = startBehavior(!!(config && config.behaviorTiming));
    const client = new PryntClient(config);
    const identify = client.identify.bind(client);
    return Promise.resolve({
      identify,
      get: identify,
      setConsent: client.setConsent.bind(client),
      challenge: client.challenge.bind(client),
      protectForm: (form: HTMLFormElement, opts?: ProtectFormOpts): FormGuard =>
        protectForm(form, opts, identify),
    });
  },
  /** Reveal: B2B visitor identification. Starts tracking immediately; see RevealOptions. */
  reveal(opts: RevealOptions): RevealClient {
    return createReveal(opts, _agentEndpoint || DEFAULT_ENDPOINT, () => _lastVisitorId, SDK_VERSION);
  },
  /** Product events (pageviews, engagement, track()) to the shared collect POST /v1/track, for any product
      that reads events (Analytics, Reveal, …). Same consent model as reveal(): GPC always wins. */
  analytics(opts: AnalyticsOptions): AnalyticsClient {
    return createAnalytics(opts, _agentEndpoint || DEFAULT_ENDPOINT, () => _lastVisitorId, SDK_VERSION);
  },
  /** Replay: privacy-first session recording. Loads the recorder (prynt-replay.umd.js) on demand. */
  replay(opts: ReplayOptions): ReplayClient {
    return loadReplay(opts, _agentEndpoint || DEFAULT_ENDPOINT, () => _lastVisitorId);
  },
  version: SDK_VERSION,
  /** @internal Read by the Reveal-only bundle (dist/prynt-reveal.umd.js) when both are on a page. */
  _agent(): { visitorId: string | null; endpoint: string | null } {
    return { visitorId: _lastVisitorId, endpoint: _agentEndpoint };
  },
};

export default Prynt;
export { Prynt };
