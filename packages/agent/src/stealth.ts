// Stealth-evasion tells. Stealth plugins (puppeteer-extra-stealth, playwright-stealth, hand-rolled
// init scripts) hide automation by redefining browser APIs in JavaScript. Each redefinition leaves
// a "lie": a getter that is not native, a function that is constructible or carries a prototype, a
// Proxy where the engine has a plain function, a value the page realm reports differently from a
// Web Worker the init script never reached. These checks look for the lies, not for a fingerprint.
//
// Everything here is NON-IDENTIFYING: booleans and short lists of API names (no canvas, no GPU
// string, no fonts), so it can be sent on its own (see collectBotSignals in index.ts). The SERVER
// decides what is a bot tell and what is only tampering (privacy extensions lie too).

export interface WorkerTells {
  ok: boolean;              // false = no Worker / CSP blocked blob: workers → inconclusive
  uaMismatch: boolean;
  headlessUA: boolean;      // Worker UA says HeadlessChrome, page UA does not (UA spoofed in page only)
  platformMismatch: boolean;
  hardwareMismatch: boolean;
  languagesMismatch: boolean;
  timezoneMismatch: boolean;
  webglMismatch: boolean;   // page and Worker report different WebGL renderers
  webglSpoof: boolean;      // page claims a hardware GPU, Worker renders in software (SwiftShader/llvmpipe)
  webdriver: boolean;       // navigator.webdriver true inside the Worker
}

export interface StealthTells {
  navLies: string[];        // Navigator.prototype getters that fail the native-function lie tests
  fnLies: string[];         // other patched natives (permissions.query, canvas, WebGL, contentWindow…)
  toStringProxy: boolean;   // Function.prototype.toString itself replaced or proxied
  webdriverLie: boolean;    // Navigator.prototype.webdriver getter redefined in JavaScript
  webdriverMissing: boolean;// webdriver deleted from Navigator.prototype (every modern engine has it)
  iframeProxy: boolean;     // a DETACHED srcdoc iframe returned a contentWindow (stealth's iframe proxy)
  chromeShape: string[];    // window.chrome present but shaped like a hand-made stub
  pluginsShape: string[];   // navigator.plugins / mimeTypes not built from the engine's own classes
  evalStack: boolean;       // identify() called from a Puppeteer/Playwright evaluation script
  screenIsViewport: boolean;// screen size == viewport
  emulatedScreen: boolean;  // …and no taskbar/menu bar and not fullscreen: Playwright/Puppeteer's
                            // viewport emulation rewrites screen.* to the viewport size
  localeMismatch: boolean;  // Intl default locale language != navigator.language; report-only
  worker: WorkerTells | null;
}

type Fn = (...args: unknown[]) => unknown;

const SOFTWARE_GL = /swiftshader|llvmpipe|softpipe|software rasterizer|mesa offscreen/i;

function realm(): { toString: (f: unknown) => string } | null {
  // A fresh same-origin iframe gives an unpatched Function.prototype.toString for most stealth
  // set-ups (page init scripts patch the top realm), so a patched page toString can't vouch for itself.
  try {
    const f = document.createElement('iframe');
    f.style.display = 'none';
    (document.body || document.documentElement).appendChild(f);
    const w = f.contentWindow as (Window & { Function: FunctionConstructor }) | null;
    const ts = w && w.Function && w.Function.prototype.toString;
    f.remove();
    if (!ts) return null;
    return { toString: (fn: unknown) => ts.call(fn as Fn) };
  } catch { return null; }
}

// Lie tests for a function the engine implements natively. Returns the failed test names.
function lies(fn: unknown, name: string, other: ReturnType<typeof realm>): string[] {
  const out: string[] = [];
  if (typeof fn !== 'function') return out;
  const f = fn as Fn;
  try {
    const s = Function.prototype.toString.call(f);
    if (s.indexOf('[native code]') === -1) out.push('toString');
  } catch { out.push('toString'); }
  if (other) {
    try {
      // A Proxy prints as "function () { [native code] }": the name is gone.
      const s = other.toString(f);
      const rx = new RegExp('^function\\s+(get\\s+|set\\s+)?' + name.replace(/[$]/g, '\\$') + '\\s*\\(\\)\\s*\\{\\s*\\[native code\\]\\s*\\}$');
      if (s.indexOf('[native code]') === -1) out.push('realmToString');
      else if (!rx.test(s)) out.push('realmName');
    } catch { /* cross-realm call refused: inconclusive */ }
  }
  try { if ('prototype' in f) out.push('prototype'); } catch { /* skip */ }
  try {
    // Native methods/getters are not constructors; a JS replacement function is.
    const C = f as unknown as new () => object;
    // `class extends` evaluates the heritage without calling it: no side effects. WebIDL
    // operations and attribute getters are never constructors, so this must throw TypeError.
    // (The class is read back so a minifier cannot drop the expression as side-effect free.)
    const K = class extends C {};
    out.push(Object.getPrototypeOf(K) === C ? 'constructible' : 'constructibleOdd');
  } catch (e) { if (!(e instanceof TypeError)) out.push('extendsError'); }
  try {
    // Chain-cycle test: setting f's prototype to an object inheriting from f must throw a cyclic
    // __proto__ TypeError for a plain function; a Proxy forwards it to its target, no cycle seen.
    const orig = Object.getPrototypeOf(f);
    let threw = false;
    try { Object.setPrototypeOf(f, Object.create(f)); } catch (e) { threw = e instanceof TypeError; } finally {
      try { Object.setPrototypeOf(f, orig); } catch { /* skip */ }
    }
    if (!threw) out.push('proxy');
  } catch { /* skip */ }
  return out;
}

function getter(proto: object | undefined, prop: string): unknown {
  try { const d = proto && Object.getOwnPropertyDescriptor(proto, prop); return d && d.get; } catch { return undefined; }
}

function workerTells(page: { ua: string; platform: string; hc: number; langs: string; tz: string; gl: string }): Promise<WorkerTells | null> {
  return new Promise((resolve) => {
    let url = '';
    let w: Worker | null = null;
    const done = (v: WorkerTells | null): void => {
      try { if (w) w.terminate(); } catch { /* skip */ }
      try { if (url) URL.revokeObjectURL(url); } catch { /* skip */ }
      resolve(v);
    };
    try {
      if (typeof Worker === 'undefined' || typeof Blob === 'undefined' || typeof URL === 'undefined') return resolve(null);
      const src = 'self.onmessage=function(){var r={};var n=self.navigator||{};' +
        'try{r.ua=n.userAgent;r.pl=n.platform;r.hc=n.hardwareConcurrency;r.lang=(n.languages||[]).join(",");r.wd=n.webdriver===true}catch(e){}' +
        'try{r.tz=Intl.DateTimeFormat().resolvedOptions().timeZone}catch(e){}' +
        'try{var c=new OffscreenCanvas(1,1),g=c.getContext("webgl");if(g){var d=g.getExtension("WEBGL_debug_renderer_info");' +
        'r.gl=String(d?g.getParameter(d.UNMASKED_RENDERER_WEBGL):g.getParameter(g.RENDERER))}}catch(e){}' +
        'postMessage(r)}';
      url = URL.createObjectURL(new Blob([src], { type: 'application/javascript' }));
      w = new Worker(url);
      const to = setTimeout(() => done(null), 800);
      w.onerror = () => { clearTimeout(to); done(null); };
      w.onmessage = (ev: MessageEvent) => {
        clearTimeout(to);
        const r = (ev.data || {}) as { ua?: string; pl?: string; hc?: number; lang?: string; tz?: string; gl?: string; wd?: boolean };
        const wgl = r.gl || '';
        const pgl = page.gl || '';
        const glBoth = !!wgl && !!pgl && pgl !== 'unsupported' && !pgl.startsWith('err:');
        done({
          ok: true,
          uaMismatch: !!r.ua && r.ua !== page.ua,
          headlessUA: !!r.ua && /HeadlessChrome/.test(r.ua) && !/HeadlessChrome/.test(page.ua),
          platformMismatch: !!r.pl && !!page.platform && r.pl !== page.platform,
          hardwareMismatch: typeof r.hc === 'number' && typeof page.hc === 'number' && r.hc !== page.hc,
          languagesMismatch: !!r.lang && !!page.langs && r.lang !== page.langs,
          timezoneMismatch: !!r.tz && !!page.tz && r.tz !== page.tz,
          webglMismatch: glBoth && wgl !== pgl,
          webglSpoof: glBoth && SOFTWARE_GL.test(wgl) && !SOFTWARE_GL.test(pgl),
          webdriver: r.wd === true,
        });
      };
      w.postMessage(1);
    } catch { done(null); }
  });
}

export async function stealthTells(pageGlRenderer: string): Promise<StealthTells> {
  const nav = navigator;
  const other = realm();
  const NavProto = Object.getPrototypeOf(nav) as object | undefined;

  const navLies: string[] = [];
  let webdriverLie = false;
  let webdriverMissing = false;
  for (const p of ['webdriver', 'plugins', 'mimeTypes', 'languages', 'platform', 'userAgent',
    'hardwareConcurrency', 'deviceMemory', 'vendor', 'maxTouchPoints']) {
    const g = getter(NavProto, p);
    if (g === undefined) {
      if (p === 'webdriver') webdriverMissing = !Object.prototype.hasOwnProperty.call(nav, 'webdriver');
      continue;
    }
    const l = lies(g, p, other);
    if (l.length) { navLies.push(p); if (p === 'webdriver') webdriverLie = true; }
  }
  // An own-property webdriver on the navigator instance (defineProperty(navigator, …)) is also a lie.
  try { if (Object.getOwnPropertyDescriptor(nav, 'webdriver')) { webdriverLie = true; if (navLies.indexOf('webdriver') < 0) navLies.push('webdriver'); } } catch { /* skip */ }

  const fnLies: string[] = [];
  const check = (label: string, fn: unknown, name: string): void => { if (lies(fn, name, other).length) fnLies.push(label); };
  try { check('permissions.query', (window as unknown as { Permissions?: { prototype: { query: unknown } } }).Permissions?.prototype.query, 'query'); } catch { /* skip */ }
  try { check('canvas.toDataURL', HTMLCanvasElement.prototype.toDataURL, 'toDataURL'); } catch { /* skip */ }
  try { check('canvas.getContext', HTMLCanvasElement.prototype.getContext, 'getContext'); } catch { /* skip */ }
  try { check('webgl.getParameter', WebGLRenderingContext.prototype.getParameter, 'getParameter'); } catch { /* skip */ }
  try { check('iframe.contentWindow', getter(HTMLIFrameElement.prototype, 'contentWindow'), 'contentWindow'); } catch { /* skip */ }
  try { check('window.outerWidth', getter(window, 'outerWidth'), 'outerWidth'); } catch { /* skip */ }
  try { check('screen.width', getter(Object.getPrototypeOf(screen) as object, 'width'), 'width'); } catch { /* skip */ }
  // Fingerprint-noise extensions (font metrics, audio, canvas read-back, WebGL2) patch these.
  const W = window as unknown as Record<string, { prototype: Record<string, unknown> } | undefined>;
  const proto = (cls: string): Record<string, unknown> | undefined => { try { return W[cls] && W[cls]!.prototype; } catch { return undefined; } };
  try { check('canvas.getImageData', proto('CanvasRenderingContext2D')?.getImageData, 'getImageData'); } catch { /* skip */ }
  try { check('canvas.measureText', proto('CanvasRenderingContext2D')?.measureText, 'measureText'); } catch { /* skip */ }
  try { check('element.offsetWidth', getter(proto('HTMLElement'), 'offsetWidth'), 'offsetWidth'); } catch { /* skip */ }
  try { check('element.offsetHeight', getter(proto('HTMLElement'), 'offsetHeight'), 'offsetHeight'); } catch { /* skip */ }
  try { check('audio.getChannelData', proto('AudioBuffer')?.getChannelData, 'getChannelData'); } catch { /* skip */ }
  try { check('audio.copyFromChannel', proto('AudioBuffer')?.copyFromChannel, 'copyFromChannel'); } catch { /* skip */ }
  try { check('audio.getFloatFrequencyData', proto('AnalyserNode')?.getFloatFrequencyData, 'getFloatFrequencyData'); } catch { /* skip */ }
  try { check('webgl2.getParameter', proto('WebGL2RenderingContext')?.getParameter, 'getParameter'); } catch { /* skip */ }
  try { check('webgl.readPixels', WebGLRenderingContext.prototype.readPixels, 'readPixels'); } catch { /* skip */ }

  let toStringProxy = false;
  try { toStringProxy = lies(Function.prototype.toString, 'toString', other).length > 0; } catch { /* skip */ }

  let iframeProxy = false;
  try {
    const f = document.createElement('iframe');
    f.srcdoc = 'x';
    iframeProxy = !!f.contentWindow;     // a detached iframe has no browsing context → null
  } catch { /* skip */ }

  const chromeShape: string[] = [];
  try {
    const ua = nav.userAgent || '';
    const c = (window as unknown as { chrome?: Record<string, unknown> }).chrome;
    if (c && /Chrome\//.test(ua)) {
      const rt = c.runtime as Record<string, unknown> | undefined;
      if (rt && typeof rt === 'object' && typeof rt.connect !== 'function' && typeof rt.sendMessage !== 'function') chromeShape.push('runtimeStub');
      const app = c.app as Record<string, unknown> | undefined;
      if (app && typeof app === 'object' && (typeof app.getDetails !== 'function' || typeof app.getIsInstalled !== 'function')) chromeShape.push('appStub');
      // chrome.csi / chrome.loadTimes are V8-extension functions (constructible, unnamed) in real
      // Chrome, so the WebIDL lie tests do not apply to them — deliberately not checked.
    }
  } catch { /* skip */ }

  const pluginsShape: string[] = [];
  try {
    const w = window as unknown as { PluginArray?: Fn; Plugin?: Fn; MimeTypeArray?: Fn; MimeType?: Fn };
    const pl = nav.plugins as unknown;
    const mt = nav.mimeTypes as unknown;
    if (w.PluginArray && pl && !(pl instanceof (w.PluginArray as unknown as new () => object))) pluginsShape.push('pluginArray');
    if (w.MimeTypeArray && mt && !(mt instanceof (w.MimeTypeArray as unknown as new () => object))) pluginsShape.push('mimeTypeArray');
    const p0 = nav.plugins && nav.plugins.length ? nav.plugins[0] as unknown : null;
    if (p0 && w.Plugin && !(p0 instanceof (w.Plugin as unknown as new () => object))) pluginsShape.push('plugin');
    const m0 = nav.mimeTypes && nav.mimeTypes.length ? nav.mimeTypes[0] as unknown : null;
    if (m0 && w.MimeType && !(m0 instanceof (w.MimeType as unknown as new () => object))) pluginsShape.push('mimeType');
    if (nav.plugins && lies(nav.plugins.item, 'item', other).length) pluginsShape.push('item');
  } catch { /* skip */ }

  let evalStack = false;
  try { evalStack = /__puppeteer_evaluation_script__|__playwright_evaluation_script__|pptr:evaluate/.test(String(new Error().stack || '')); } catch { /* skip */ }

  let screenIsViewport = false;
  let emulatedScreen = false;
  try {
    screenIsViewport = screen.width === window.innerWidth && screen.height === window.innerHeight;
    // A real window always loses height to tabs/toolbar unless the page is fullscreen (F11, kiosk,
    // video) — those report display-mode fullscreen or a fullscreenElement and are excluded.
    const fullscreen = !!document.fullscreenElement ||
      (typeof matchMedia === 'function' && (matchMedia('(display-mode: fullscreen)').matches || matchMedia('(display-mode: kiosk)').matches));
    // Firefox resistFingerprinting reports screen = window on purpose (lab: 30/30 RFP controls),
    // and Brave can shrink the screen in its stricter modes: only Chromium-family, non-Brave.
    const ua = nav.userAgent || '';
    const chromium = /Chrome\//.test(ua) && !/Firefox\//.test(ua) && !('brave' in nav);
    emulatedScreen = chromium && screenIsViewport && !fullscreen &&
      screen.availWidth === screen.width && screen.availHeight === screen.height;
  } catch { /* skip */ }

  let localeMismatch = false;
  let tz = '';
  try {
    const ro = Intl.DateTimeFormat().resolvedOptions();
    tz = ro.timeZone || '';
    const a = (ro.locale || '').split('-')[0].toLowerCase();
    const b = (nav.language || '').split('-')[0].toLowerCase();
    localeMismatch = !!a && !!b && a !== b;
  } catch { /* skip */ }

  const worker = await workerTells({
    ua: nav.userAgent || '', platform: nav.platform || '', hc: nav.hardwareConcurrency,
    langs: (nav.languages || []).join(','), tz, gl: pageGlRenderer || '',
  });

  return { navLies, fnLies, toStringProxy, webdriverLie, webdriverMissing, iframeProxy, chromeShape,
    pluginsShape, evalStack, screenIsViewport, emulatedScreen, localeMismatch, worker };
}
