import { hash128 } from './hash';

// Each collector is defensive: a throw becomes a stable sentinel so a single blocked
// API never breaks the whole fingerprint. Order/emptiness of results is itself a signal.

const err = (tag: string) => `err:${tag}`;
const notReadable = 'unsupported';

export interface ScreenInfo {
  w: number; h: number; availW: number; availH: number; colorDepth: number; pixelRatio: number;
}
export interface TouchInfo { maxTouchPoints: number; touchEvent: boolean; touchStart: boolean; }

export function screenSignal(): ScreenInfo | string {
  try {
    const s = window.screen;
    return {
      w: Math.max(s.width, s.height),
      h: Math.min(s.width, s.height),
      availW: Math.max(s.availWidth, s.availHeight),
      availH: Math.min(s.availWidth, s.availHeight),
      colorDepth: s.colorDepth,
      pixelRatio: Math.round((window.devicePixelRatio || 1) * 100) / 100,
    };
  } catch { return err('screen'); }
}

export function timezone(): string {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || err('tz'); }
  catch { return err('tz'); }
}

export function timezoneOffset(): number {
  try { return new Date().getTimezoneOffset(); } catch { return 0; }
}

export function languages() {
  try {
    return {
      list: Array.isArray(navigator.languages) ? navigator.languages.slice(0, 8) : [],
      primary: navigator.language || '',
    };
  } catch { return { list: [], primary: '' }; }
}

export function hardware() {
  const nav = navigator;
  return {
    hardwareConcurrency: typeof nav.hardwareConcurrency === 'number' ? nav.hardwareConcurrency : 0,
    deviceMemory: typeof nav.deviceMemory === 'number' ? nav.deviceMemory : 0,
    platform: nav.platform || '',
    vendor: nav.vendor || '',
    cpuClass: nav.cpuClass || 'unknown',
    maxTouchPoints: typeof nav.maxTouchPoints === 'number' ? nav.maxTouchPoints : 0,
  };
}

export function touchSupport(): TouchInfo {
  try {
    let maxTouchPoints = 0, touchEvent = false;
    if (typeof navigator.maxTouchPoints === 'number') maxTouchPoints = navigator.maxTouchPoints;
    try { document.createEvent('TouchEvent'); touchEvent = true; } catch { /* no */ }
    const touchStart = 'ontouchstart' in window;
    return { maxTouchPoints, touchEvent, touchStart };
  } catch { return { maxTouchPoints: 0, touchEvent: false, touchStart: false }; }
}

export function colorGamut(): string {
  try {
    for (const g of ['rec2020', 'p3', 'srgb']) {
      if (window.matchMedia(`(color-gamut: ${g})`).matches) return g;
    }
  } catch { /* no */ }
  return 'unknown';
}

export function contrastPrefs() {
  const probe = (q: string) => { try { return window.matchMedia(q).matches; } catch { return false; } };
  return {
    reducedMotion: probe('(prefers-reduced-motion: reduce)'),
    dark: probe('(prefers-color-scheme: dark)'),
    hdr: probe('(dynamic-range: high)'),
    invertedColors: probe('(inverted-colors: inverted)'),
    forcedColors: probe('(forced-colors: active)'),
  };
}

// --- Canvas fingerprint: text + emoji + gradients render differently per GPU/driver/OS ---
// Render the fixed Prynt scene into a fresh canvas and return raw pixels + dataURL.
function drawCanvasScene(): { ctx: CanvasRenderingContext2D; data: string; imageData: ImageData | null; winding: boolean } | null {
  const c = document.createElement('canvas');
  c.width = 280; c.height = 60;
  const ctx = c.getContext('2d');
  if (!ctx) return null;
  ctx.rect(0, 0, 10, 10); ctx.rect(2, 2, 6, 6);
  const winding = ctx.isPointInPath(5, 5, 'evenodd') === false;

  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = '#f60';
  ctx.fillRect(125, 1, 62, 20);
  ctx.fillStyle = '#069';
  ctx.font = "11pt 'Arial'";
  const line = 'Prynt \u{1F510} device ♥ fp 0123456789';
  ctx.fillText(line, 2, 15);
  ctx.fillStyle = 'rgba(102, 204, 0, 0.7)';
  ctx.font = '18pt Arial';
  ctx.fillText(line, 4, 45);
  ctx.globalCompositeOperation = 'multiply';
  for (const [color, x, y] of [['#f0f', 40, 40], ['#0ff', 80, 40], ['#ff0', 60, 60]] as const) {
    ctx.fillStyle = color as string;
    ctx.beginPath();
    ctx.arc(x as number, y as number, 40, 0, Math.PI * 2, true);
    ctx.closePath(); ctx.fill();
  }
  let imageData: ImageData | null = null;
  try { imageData = ctx.getImageData(0, 0, c.width, c.height); } catch { imageData = null; }
  return { ctx, data: c.toDataURL(), imageData, winding };
}

// Perceptual hash: downsample the rendered canvas to an 8×8 grayscale grid and emit a
// 64-bit "above/below mean" signature as 16 hex chars. Unlike the exact hash, a small
// per-pixel perturbation (GPU driver bump, sub-pixel AA change) barely moves this — so
// the SERVER can score canvas similarity by Hamming distance instead of exact equality.
function perceptualHash(img: ImageData | null): string {
  if (!img) return notReadable;
  const { data, width, height } = img;
  const gw = 8, gh = 8;
  const cellW = width / gw, cellH = height / gh;
  const grid: number[] = new Array(gw * gh).fill(0);
  for (let gy = 0; gy < gh; gy++) {
    for (let gx = 0; gx < gw; gx++) {
      let sum = 0, count = 0;
      const x0 = Math.floor(gx * cellW), x1 = Math.floor((gx + 1) * cellW);
      const y0 = Math.floor(gy * cellH), y1 = Math.floor((gy + 1) * cellH);
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = (y * width + x) * 4;
          // luminance
          sum += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
          count++;
        }
      }
      grid[gy * gw + gx] = count ? sum / count : 0;
    }
  }
  const mean = grid.reduce((a, b) => a + b, 0) / grid.length;
  let bits = '';
  for (const v of grid) bits += v >= mean ? '1' : '0';
  // pack 64 bits -> 16 hex chars
  let hex = '';
  for (let i = 0; i < 64; i += 4) hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
  return hex;
}

// Known-answer read-back: two flat colour blocks must read back byte-exact on every engine.
// Per-read noise is caught by the double read below; a per-SESSION noise (same offset on every
// read) is only visible against a value we know in advance. null = canvas not readable.
export function canvasKnownAnswer(): boolean | null {
  try {
    const c = document.createElement('canvas');
    c.width = 16; c.height = 8;
    const ctx = c.getContext('2d');
    if (!ctx) return null;
    ctx.fillStyle = 'rgb(17,34,51)'; ctx.fillRect(0, 0, 8, 8);
    ctx.fillStyle = 'rgb(204,102,0)'; ctx.fillRect(8, 0, 8, 8);
    const d = ctx.getImageData(0, 0, 16, 8).data;
    for (let i = 0; i < d.length; i += 4) {
      const left = ((i / 4) % 16) < 8;
      const [r, g, b] = left ? [17, 34, 51] : [204, 102, 0];
      if (d[i] !== r || d[i + 1] !== g || d[i + 2] !== b || d[i + 3] !== 255) return false;
    }
    return true;
  } catch { return null; }
}

export function canvas(): { hash: string; phash: string; winding: boolean; noise: boolean } {
  try {
    const a = drawCanvasScene();
    if (!a) return { hash: notReadable, phash: notReadable, winding: false, noise: false };
    // Double-read: genuine hardware is deterministic, so a second identical render must
    // match. Anti-detect browsers / canvas-farbling extensions inject per-read randomness
    // → the two dataURLs differ. That mismatch IS the tell.
    const b = drawCanvasScene();
    const noise = !!b && b.data !== a.data;
    return { hash: hash128(a.data), phash: perceptualHash(a.imageData), winding: a.winding, noise };
  } catch { return { hash: notReadable, phash: notReadable, winding: false, noise: false }; }
}

// --- WebGL fingerprint: unmasked vendor/renderer + parameter matrix ---
export function webgl() {
  try {
    const c = document.createElement('canvas');
    const gl = (c.getContext('webgl') || c.getContext('experimental-webgl')) as WebGLRenderingContext | null;
    if (!gl) return { vendor: notReadable, renderer: notReadable, hash: notReadable };
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    const vendor = dbg ? String(gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL)) : String(gl.getParameter(gl.VENDOR));
    const renderer = dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : String(gl.getParameter(gl.RENDERER));
    const parts: string[] = [vendor, renderer, String(gl.getParameter(gl.VERSION)), String(gl.getParameter(gl.SHADING_LANGUAGE_VERSION))];
    const params = [
      gl.ALPHA_BITS, gl.BLUE_BITS, gl.DEPTH_BITS, gl.GREEN_BITS, gl.RED_BITS, gl.STENCIL_BITS,
      gl.MAX_COMBINED_TEXTURE_IMAGE_UNITS, gl.MAX_CUBE_MAP_TEXTURE_SIZE, gl.MAX_FRAGMENT_UNIFORM_VECTORS,
      gl.MAX_RENDERBUFFER_SIZE, gl.MAX_TEXTURE_IMAGE_UNITS, gl.MAX_TEXTURE_SIZE, gl.MAX_VARYING_VECTORS,
      gl.MAX_VERTEX_ATTRIBS, gl.MAX_VERTEX_TEXTURE_IMAGE_UNITS, gl.MAX_VERTEX_UNIFORM_VECTORS, gl.MAX_VIEWPORT_DIMS,
    ];
    // Structured param vector: the server compares these field-by-field so a single
    // driver-changed value doesn't nuke the whole match (unlike a collapsed hash).
    const paramVec: string[] = [];
    for (const p of params) { try { const v = String(gl.getParameter(p)); parts.push(v); paramVec.push(v); } catch { paramVec.push(''); } }
    try {
      const aliased = gl.getParameter(gl.ALIASED_LINE_WIDTH_RANGE);
      if (aliased) { parts.push(`${aliased[0]},${aliased[1]}`); paramVec.push(`${aliased[0]},${aliased[1]}`); }
      const exts = gl.getSupportedExtensions() || [];
      parts.push(exts.sort().join(','));
    } catch { /* skip */ }
    return { vendor, renderer, hash: hash128(parts.join('~')), params: paramVec };
  } catch { return { vendor: err('webgl'), renderer: err('webgl'), hash: err('webgl'), params: [] as string[] }; }
}

// --- Audio fingerprint: OfflineAudioContext DSP output varies per platform ---
export function audio(): Promise<string> {
  return new Promise((resolve) => {
    try {
      const AC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
      if (!AC) return resolve(notReadable);
      const ctx = new AC(1, 5000, 44100);
      const osc = ctx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.value = 10000;
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -50; comp.knee.value = 40; comp.ratio.value = 12;
      comp.attack.value = 0; comp.release.value = 0.25;
      osc.connect(comp); comp.connect(ctx.destination);
      osc.start(0);
      let done = false;
      const finish = (v: string) => { if (!done) { done = true; resolve(v); } };
      ctx.oncomplete = (e: OfflineAudioCompletionEvent) => {
        try {
          const buf = e.renderedBuffer.getChannelData(0);
          let sum = 0;
          for (let i = 4500; i < 5000; i++) sum += Math.abs(buf[i]);
          finish(sum.toString());
        } catch { finish(err('audio')); }
      };
      ctx.startRendering();
      setTimeout(() => finish(err('audio-timeout')), 1000);
    } catch { resolve(err('audio')); }
  });
}

// --- Font detection: measure text width for candidate fonts vs base fonts ---
const FONT_LIST = [
  'Andale Mono','Arial','Arial Black','Arial Narrow','Arial Rounded MT Bold','Bookman Old Style','Bradley Hand ITC',
  'Century','Century Gothic','Comic Sans MS','Courier','Courier New','Georgia','Gentium','Helvetica','Impact',
  'King','Lucida Console','Lalit','Modena','Monotype Corsiva','Papyrus','Tahoma','TeX','Times','Times New Roman',
  'Trebuchet MS','Verdana','Verona','Menlo','Monaco','Consolas','DejaVu Sans','Ubuntu','Roboto','Segoe UI',
  'SF Pro Text','Cantarell','Noto Sans','Liberation Sans','Optima','Gill Sans','Palatino','Futura','Baskerville',
];
export function fonts(): { list: string[]; hash: string } {
  try {
    const baseFonts = ['monospace', 'sans-serif', 'serif'];
    const testString = 'mmmmmmmmmmlli WWWWWWW 0123456789';
    const testSize = '72px';
    const span = document.createElement('span');
    span.style.cssText = 'position:absolute;left:-9999px;top:-9999px;font-size:' + testSize + ';line-height:normal;visibility:hidden;';
    span.textContent = testString;
    const body = document.body || document.documentElement;
    const defaults: Record<string, { w: number; h: number }> = {};
    const spans: HTMLSpanElement[] = [];
    for (const base of baseFonts) {
      const s = span.cloneNode(true) as HTMLSpanElement;
      s.style.fontFamily = base;
      body.appendChild(s);
      spans.push(s);
      defaults[base] = { w: s.offsetWidth, h: s.offsetHeight };
    }
    const available: string[] = [];
    for (const font of FONT_LIST) {
      let detected = false;
      for (let i = 0; i < baseFonts.length; i++) {
        const s = span.cloneNode(true) as HTMLSpanElement;
        s.style.fontFamily = `'${font}',${baseFonts[i]}`;
        body.appendChild(s);
        if (s.offsetWidth !== defaults[baseFonts[i]].w || s.offsetHeight !== defaults[baseFonts[i]].h) detected = true;
        body.removeChild(s);
      }
      if (detected) available.push(font);
    }
    for (const s of spans) body.removeChild(s);
    return { list: available, hash: hash128(available.join(',')) };
  } catch { return { list: [], hash: err('fonts') }; }
}

// --- Math/FPU fingerprint: transcendental fn implementations differ per engine/CPU ---
export function mathFp(): string {
  const M = Math;
  const acos = M.acos || (() => 0), asinh = M.asinh || (() => 0), atanh = M.atanh || (() => 0);
  const cbrt = M.cbrt || (() => 0), cosh = M.cosh || (() => 0), expm1 = M.expm1 || (() => 0);
  const sinh = M.sinh || (() => 0), tan = M.tan || (() => 0), tanh = M.tanh || (() => 0), pow = M.pow;
  const vals = [
    acos(0.123), asinh(1e308), atanh(0.5), cbrt(100), cosh(10), expm1(1), sinh(1), tanh(0.5), tan(-1e300),
    pow(Math.PI, -100), Math.exp(1), Math.log(1000), Math.sin(1e10),
  ];
  return hash128(vals.map((v) => String(v)).join(','));
}

// --- Media / codec support: which codecs decode is device/OS dependent ---
export function mediaCodecs(): string {
  try {
    const v = document.createElement('video');
    const a = document.createElement('audio');
    const types = [
      [v, 'video/mp4; codecs="avc1.42E01E"'], [v, 'video/webm; codecs="vp9"'], [v, 'video/webm; codecs="vp8"'],
      [v, 'video/mp4; codecs="hev1.1.6.L93.B0"'], [v, 'video/mp4; codecs="av01.0.08M.08"'],
      [a, 'audio/mpeg'], [a, 'audio/ogg; codecs="vorbis"'], [a, 'audio/mp4; codecs="mp4a.40.2"'], [a, 'audio/webm; codecs="opus"'],
    ] as const;
    return types.map(([el, t]) => (el as HTMLMediaElement).canPlayType(t) || '').join('|');
  } catch { return err('media'); }
}

export function storageQuota(): Promise<number> {
  return new Promise((resolve) => {
    try {
      const sm = navigator.storage;
      if (sm && sm.estimate) sm.estimate().then((e) => resolve(e.quota || 0)).catch(() => resolve(0));
      else resolve(0);
    } catch { resolve(0); }
  });
}

// UA Client Hints high-entropy values. On Chromium the UA string is frozen; the real
// entropy (device model, OS build, CPU arch/bitness) and the best UA-spoof cross-check
// live here. Async but cheap.
export function uaHighEntropy(): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    try {
      const d = navigator.userAgentData;
      if (!d || !d.getHighEntropyValues) return resolve(null);
      d.getHighEntropyValues([
        'architecture', 'bitness', 'model', 'platformVersion', 'uaFullVersion',
        'fullVersionList', 'wow64',
      ]).then((r) => resolve({
        architecture: r.architecture || '',
        bitness: r.bitness || '',
        model: r.model || '',
        platformVersion: r.platformVersion || '',
        uaFullVersion: r.uaFullVersion || '',
        fullVersionList: Array.isArray(r.fullVersionList)
          ? r.fullVersionList.map((b) => `${b.brand} ${b.version}`) : [],
        wow64: !!r.wow64,
      })).catch(() => resolve(null));
    } catch { resolve(null); }
  });
}
