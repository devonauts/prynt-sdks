// Client-side bot / automation tells. Raw observations only — the SERVER decides the verdict.
// Sending raw tells (not a boolean) lets the engine weigh them and resist trivial spoofing.

export interface HeadlessHints {
  chromeMissing: boolean;
  permissionsAnomaly: boolean;
  languagesEmpty: boolean;
  webglSwiftShader: boolean;
  uaHeadless: boolean;
  noPlugins: boolean;
  zeroDimensions: boolean;
  toStringHacked: boolean;
}

export interface UaDataTells {
  brands: string[];
  mobile: boolean;
  platform: string;
}

export interface BotTells {
  webdriver: boolean;
  automationProps: string[];
  headlessHints: HeadlessHints;
  userAgent: string;
  uaData: UaDataTells | null;
  productSub: string;
}

export function botTells(): BotTells {
  const nav = navigator;
  const win = window;
  const automationProps: string[] = [];
  // 'webdriver' is deliberately NOT probed with `in`: Navigator.prototype.webdriver exists in
  // every modern browser, so `'webdriver' in navigator` is always true. The real tell is the
  // value (nav.webdriver === true), read below.
  const candidates = [
    '__webdriver_evaluate', '__selenium_evaluate', '__webdriver_script_function',
    '__webdriver_script_func', '__webdriver_script_fn', '__fxdriver_evaluate', '__driver_unwrapped',
    '__webdriver_unwrapped', '__driver_evaluate', '__selenium_unwrapped', '__fxdriver_unwrapped',
    '_phantom', '__nightmare', 'callPhantom', 'phantom', '_Selenium_IDE_Recorder',
    'domAutomation', 'domAutomationController', '__$webdriverAsyncExecutor', '__lastWatirAlert',
    'spawn', 'emit', 'Buffer', '_playwright', '__playwright', '__pw_manual', '__PW_inspect',
    // Playwright page-side helpers (context.addInitScript / exposeBinding), Selenium IDE leftovers.
    '__pwInitScripts', '__playwright__binding__', '__playwright_clock__', '_WEBDRIVER_ELEM_CACHE',
  ];
  for (const p of candidates) {
    try { if (p in win || p in nav || (win.document && p in win.document)) automationProps.push(p); } catch { /* skip */ }
  }
  try {
    const keys = Object.keys(win.document || {});
    for (const k of keys) {
      if (/\$cdc_|\$chrome_asyncScriptInfo|cdc_adoQpoasnfa76pfcZLmcfl/.test(k)) automationProps.push(k);
    }
  } catch { /* skip */ }

  const headlessHints: HeadlessHints = {
    // Real Chrome exposes window.chrome; headless historically omits it
    chromeMissing: (() => { try { return /Chrome/.test(nav.userAgent) && !win.chrome; } catch { return false; } })(),
    // Headless often reports notification permission "denied" while Notification.permission is "default"
    permissionsAnomaly: false,
    languagesEmpty: (() => { try { return !nav.languages || nav.languages.length === 0; } catch { return false; } })(),
    // SwiftShader is the software GL renderer used by headless Chrome
    webglSwiftShader: false,
    // Headless UA marker
    uaHeadless: (() => { try { return /HeadlessChrome/.test(nav.userAgent); } catch { return false; } })(),
    // No plugins AND no mimeTypes is suspicious on desktop Chrome
    noPlugins: (() => { try { return nav.plugins && nav.plugins.length === 0 && /Chrome/.test(nav.userAgent) && !nav.userAgent.includes('Mobile'); } catch { return false; } })(),
    // Outer dimensions zero => often headless/automation
    zeroDimensions: (() => { try { return win.outerWidth === 0 && win.outerHeight === 0; } catch { return false; } })(),
    // Native function toString should not be patched
    toStringHacked: (() => {
      try {
        const s = Function.prototype.toString;
        return s.call(nav.permissions && nav.permissions.query || function () {}).indexOf('native code') === -1 &&
               typeof (nav.permissions && nav.permissions.query) === 'function';
      } catch { return false; }
    })(),
  };

  return {
    webdriver: (() => { try { return nav.webdriver === true; } catch { return false; } })(),
    automationProps,
    headlessHints,
    userAgent: (() => { try { return nav.userAgent || ''; } catch { return ''; } })(),
    uaData: (() => {
      try {
        const d = nav.userAgentData;
        if (!d) return null;
        return { brands: (d.brands || []).map((b) => `${b.brand} ${b.version}`), mobile: !!d.mobile, platform: d.platform || '' };
      } catch { return null; }
    })(),
    productSub: (() => { try { return nav.productSub || ''; } catch { return ''; } })(),
    // Chrome always reports productSub "20030107"; deviations are odd
  };
}

export function permissionAnomaly(): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const perms = navigator.permissions;
      if (!perms || !perms.query || typeof Notification === 'undefined') return resolve(false);
      perms.query({ name: 'notifications' as PermissionName })
        .then((res) => resolve(Notification.permission === 'denied' && res.state === 'prompt'))
        .catch(() => resolve(false));
    } catch { resolve(false); }
  });
}

// Incognito heuristic hint (server confirms via storageQuota too). Chrome-only quick check.
export function incognitoHint(): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const sm = navigator.storage;
      if (sm && sm.estimate) {
        sm.estimate().then((e) => {
          // Incognito Chrome caps quota to ~120MB regardless of disk. Normal is GBs.
          resolve(typeof e.quota === 'number' && e.quota < 300 * 1024 * 1024);
        }).catch(() => resolve(false));
      } else resolve(false);
    } catch { resolve(false); }
  });
}

// Property-descriptor / native-function probes. Anti-detect browsers hide webdriver and
// spoof platform/vendor/hardwareConcurrency by redefining properties with getters or
// Proxies. These raw tells are cheap and hard to fake consistently; the SERVER judges.
export function descriptorTells(): Record<string, unknown> {
  const nav = navigator;
  const win = window;
  const out: Record<string, unknown> = {};

  // A spoofed navigator prop is usually an own-property getter, while genuine props live
  // as accessor descriptors on Navigator.prototype (own descriptor undefined).
  const ownDescriptorProps: string[] = [];
  for (const p of ['webdriver', 'platform', 'vendor', 'languages', 'hardwareConcurrency', 'deviceMemory', 'userAgent']) {
    try {
      if (Object.getOwnPropertyDescriptor(nav, p)) ownDescriptorProps.push(p);
    } catch { /* skip */ }
  }
  out.navigatorOwnProps = ownDescriptorProps;

  // Native functions must report "[native code]". A patched getContext/getParameter/query
  // (canvas-noise, UA spoof) betrays itself here.
  const nativeCheck = (fn: unknown): boolean => {
    try { return typeof fn === 'function' && Function.prototype.toString.call(fn).indexOf('[native code]') !== -1; }
    catch { return false; }
  };
  try {
    const c = document.createElement('canvas');
    const ctx = c.getContext('2d');
    out.getContextNative = nativeCheck(HTMLCanvasElement.prototype.getContext);
    out.toDataURLNative = nativeCheck(HTMLCanvasElement.prototype.toDataURL);
    out.getImageDataNative = ctx ? nativeCheck(ctx.getImageData) : true;
  } catch { /* skip */ }
  try {
    const gl = document.createElement('canvas').getContext('webgl') as WebGLRenderingContext | null;
    out.glGetParameterNative = gl ? nativeCheck(gl.getParameter) : true;
  } catch { /* skip */ }
  try { out.permissionsQueryNative = nativeCheck(navigator.permissions && navigator.permissions.query); } catch { /* skip */ }

  // Deep window.chrome surface — headless/patched builds get these subtly wrong.
  try {
    out.chromeRuntime = !!(win.chrome && win.chrome.runtime);
    out.chromeObject = !!win.chrome;
  } catch { /* skip */ }

  // Fresh-iframe re-read: reading navigator.webdriver from a new same-origin iframe often
  // bypasses a top-level override, exposing the spoof.
  try {
    const f = document.createElement('iframe');
    f.style.display = 'none';
    document.documentElement.appendChild(f);
    const iwin = f.contentWindow;
    if (iwin && iwin.navigator) {
      out.iframeWebdriver = iwin.navigator.webdriver === true;
      out.iframeHardwareConcurrency = iwin.navigator.hardwareConcurrency;
      out.topHardwareMismatch = iwin.navigator.hardwareConcurrency !== nav.hardwareConcurrency;
    }
    f.remove();
  } catch { /* skip */ }

  return out;
}
