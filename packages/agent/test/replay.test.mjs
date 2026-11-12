// Prynt Replay recorder (src/replay.ts) and core loader (src/replay_loader.ts) on a tiny fake browser. The rrweb
// recorder is replaced by a fake (`deps.record`): these tests cover masking options, URL rules, the consent /
// GPC gate, the server's record decision and chunk upload. The real recorder runs in the Playwright smoke test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { load, Target, def } from './_env.mjs';

const mod = await load('../src/replay.ts');
const loader = await load('../src/replay_loader.ts');
const ENDPOINT = 'https://api.pryntid.test';

function browser({ gpc = false, config = {}, chunkStatus = 202, tz = 'America/New_York', lang = '' } = {}) {
  const env = { calls: [], store: {}, now: 1_760_000_000_000 };
  const win = new Target(); const doc = new Target();
  win.scrollY = 0; win.innerHeight = 800;
  doc.documentElement = { lang, scrollHeight: 2000 }; doc.visibilityState = 'visible'; doc.cookie = '';
  def('window', win); def('document', doc);
  def('location', { href: 'https://acme.com/pricing?email=a@b.com', pathname: '/pricing', origin: 'https://acme.com', hostname: 'acme.com' });
  def('history', { pushState() {}, replaceState() {} });
  def('navigator', { globalPrivacyControl: gpc, sendBeacon: () => true });
  def('localStorage', { getItem: (k) => (k in env.store ? env.store[k] : null), setItem: (k, v) => { env.store[k] = String(v); } });
  Intl.DateTimeFormat = () => ({ resolvedOptions: () => ({ timeZone: tz }) });
  Date.now = () => env.now;
  // intervals (flush timer, CMP polling) are captured, never scheduled: the test process must be able to exit
  globalThis.setInterval = (fn) => ({ fn });
  globalThis.clearInterval = () => undefined;
  def('fetch', async (url, init = {}) => {
    let body = null;
    if (init.body) body = JSON.parse(typeof init.body === 'string' ? init.body : await init.body.text());
    env.calls.push({ url, method: init.method || 'GET', body });
    if (url.includes('/v1/replay/config')) {
      const cfg = { record: true, reason: null, consentLevel: 'standard', maskAllText: false, maskSelector: null,
                    unmaskSelector: null, blockSelector: null, urlAllow: [], urlDeny: [], captureErrors: true,
                    maxChunkBytes: 1048576, flushMs: 10000, ...config };
      return { ok: true, status: 200, json: async () => cfg };
    }
    const st = env.chunkStatus ?? chunkStatus;
    return { ok: st < 400, status: st, json: async () => ({ error: { code: 'x' } }) };
  });
  // no CompressionStream in this fake: chunks go out as plain JSON (the server accepts both)
  delete globalThis.CompressionStream;
  const rec = { started: 0, stopped: 0, emit: null, opts: null, custom: [], snapshots: 0 };
  const record = (o) => { rec.started++; rec.emit = o.emit; rec.opts = o; return () => { rec.stopped++; }; };
  record.addCustomEvent = (tag, payload) => { rec.custom.push([tag, payload]); rec.emit({ type: 5, timestamp: env.now, data: { tag, payload } }); };
  record.takeFullSnapshot = () => { rec.snapshots++; };
  const make = (opts = {}) => mod.createReplay({ publicKey: 'pk_test_x', endpoint: ENDPOINT, consent: true, ...opts },
                                               'https://unused', () => 'vst_1', { record });
  const settle = () => new Promise((r) => setTimeout(r, 5));
  const chunks = () => env.calls.filter((c) => c.url.includes('/v1/replay/chunk'));
  return { env, rec, make, settle, chunks, win, doc };
}

test('masking options: inputs always masked, data-prynt-mask / data-prynt-block, site selectors, mask-all allow-list', () => {
  const base = mod.recordOptions({ maskAllText: false, maskSelector: '.secret', unmaskSelector: null, blockSelector: '.chat' }, {});
  assert.equal(base.maskAllInputs, true);
  assert.equal(base.maskInputOptions.password, true);
  assert.equal(base.maskInputFn('hunter2 x'), '******* *');
  assert.match(base.maskTextSelector, /\[data-prynt-mask\]/);
  assert.match(base.maskTextSelector, /\.secret/);
  assert.match(base.blockSelector, /\[data-prynt-block\]/);
  assert.match(base.blockSelector, /\.chat/);
  assert.equal(base.recordCanvas, false);
  const all = mod.recordOptions({ maskAllText: true, maskSelector: null, unmaskSelector: 'h1, nav', blockSelector: null },
                                { blockSelector: '#ads' });
  assert.equal(all.maskTextSelector, '*');
  assert.match(all.blockSelector, /#ads/);
  const el = (allowed, marked) => ({ closest: (sel) => (sel.includes('data-prynt-mask') ? marked : sel === 'h1, nav' ? allowed : false) });
  assert.equal(all.maskTextFn('Pricing', el(true, false)), 'Pricing');      // allow-listed heading in clear
  assert.equal(all.maskTextFn('Jane Doe', el(false, false)), '**** ***');
  assert.equal(all.maskTextFn('Card 4111', el(true, true)), '**** ****');   // data-prynt-mask always wins
});

test('URL allow / deny rules (globs on the path, or the full URL with ://)', () => {
  const cfg = { urlAllow: [], urlDeny: ['/account/*', 'https://acme.com/admin*'] };
  assert.equal(mod.urlAllowed(cfg, '/pricing', 'https://acme.com/pricing'), true);
  assert.equal(mod.urlAllowed(cfg, '/account/billing', 'https://acme.com/account/billing'), false);
  assert.equal(mod.urlAllowed(cfg, '/admin/x', 'https://acme.com/admin/x'), false);
  assert.equal(mod.urlAllowed({ urlAllow: ['/checkout/*'], urlDeny: [] }, '/pricing', ''), false);
  assert.equal(mod.urlAllowed({ urlAllow: ['/checkout/*'], urlDeny: [] }, '/checkout/pay', ''), true);
});

test('GPC: the config is never fetched and nothing is recorded', async () => {
  const b = browser({ gpc: true });
  const c = b.make();
  await b.settle();
  assert.equal(b.env.calls.length, 0);
  assert.equal(b.rec.started, 0);
  assert.equal(c.diagnose().state, 'off');
  assert.equal(c.diagnose().reason, 'gpc');
  assert.equal(await c.ready, false);
});

test('no consent: waits; setConsent(true) starts; chunks carry the shared session id, masked href, seq', async () => {
  const b = browser();
  const c = b.make({ consent: undefined, });
  b.env.store.prynt_rvs = JSON.stringify({ id: 'rvs_shared123456', last: b.env.now });
  // region default outside the EU is true: use an EU timezone to start without consent
  const eu = browser({ tz: 'Europe/Madrid' });
  const ce = eu.make({ consent: undefined });
  await eu.settle();
  assert.equal(eu.rec.started, 0);
  assert.equal(ce.diagnose().state, 'waiting_consent');
  ce.setConsent(true);
  assert.equal(eu.rec.started, 1);
  eu.rec.emit({ type: 4, timestamp: eu.env.now, data: { href: 'https://acme.com/pricing?email=a@b.com#x', width: 1280, height: 800 } });
  eu.rec.emit({ type: 2, timestamp: eu.env.now + 1, data: { node: {} } });
  await ce.flush();
  const [chunk] = eu.chunks();
  assert.ok(chunk.url.startsWith(ENDPOINT + '/v1/replay/chunk?pk=pk_test_x'));
  assert.equal(chunk.method, 'POST');
  assert.equal(chunk.body.seq, 0);
  assert.equal(chunk.body.consent, true);
  assert.equal(chunk.body.consentSource, 'override');
  assert.equal(chunk.body.events[0].data.href, 'https://acme.com/pricing');   // query + fragment stripped
  assert.match(chunk.body.sessionId, /^rvs_/);
  eu.rec.emit({ type: 3, timestamp: eu.env.now + 2, data: { source: 1 } });
  await ce.flush();
  assert.equal(eu.chunks()[1].body.seq, 1);
  ce.setConsent(false);                                     // withdrawn: the recorder stops
  assert.equal(eu.rec.stopped, 1);
  assert.equal(ce.diagnose().state, 'waiting_consent');
  c.stop();
});

test('same session id as Analytics (prynt_rvs) and sequence numbers survive page loads', async () => {
  const b = browser();
  b.env.store.prynt_rvs = JSON.stringify({ id: 'rvs_shared123456', last: b.env.now });
  b.env.store.prynt_rps = JSON.stringify({ s: 'rvs_shared123456', n: 7 });
  const c = b.make();
  await b.settle();
  b.rec.emit({ type: 3, timestamp: b.env.now, data: { source: 1 } });
  await c.flush();
  assert.equal(b.chunks()[0].body.sessionId, 'rvs_shared123456');
  assert.equal(b.chunks()[0].body.seq, 7);
  assert.equal(b.chunks()[0].body.visitorId, 'vst_1');
});

test('server decides: sampled out / disabled → off without recording; explicit level refuses the regional default', async () => {
  const b = browser({ config: { record: false, reason: 'sampled_out' } });
  const c = b.make();
  await b.settle();
  assert.equal(b.rec.started, 0);
  assert.equal(c.diagnose().reason, 'sampled_out');
  const e = browser({ config: { consentLevel: 'explicit' } });
  const ce = e.make({ consent: undefined });                // US default = true, but not a real decision
  await e.settle();
  assert.equal(e.rec.started, 0);
  assert.equal(ce.diagnose().reason, 'explicit_consent_required');
  const ok = browser({ config: { consentLevel: 'explicit' } });
  ok.make({ consent: true });                               // the integrator's config is a decision
  await ok.settle();
  assert.equal(ok.rec.started, 1);
});

test('denied URL: paused, nothing recorded', async () => {
  const b = browser({ config: { urlDeny: ['/pricing'] } });
  const c = b.make();
  await b.settle();
  assert.equal(b.rec.started, 0);
  assert.equal(c.diagnose().state, 'paused');
});

test('a 4xx from the server (consent / product / quota) stops the recorder for this page', async () => {
  const b = browser({ chunkStatus: 403 });
  const c = b.make();
  await b.settle();
  b.rec.emit({ type: 3, timestamp: b.env.now, data: { source: 1 } });
  await c.flush();
  assert.equal(b.rec.stopped, 1);
  assert.equal(c.diagnose().state, 'off');
  assert.equal(c.diagnose().reason, 'server_403');
});

test('a 5xx (storage outage) keeps the events and resends them with the next chunk, at most 3 times', async () => {
  const b = browser();
  const c = b.make();
  await b.settle();
  b.env.chunkStatus = 503;
  b.rec.emit({ type: 3, timestamp: b.env.now, data: { source: 1, n: 'a' } });
  await c.flush();
  assert.equal(c.diagnose().state, 'recording');            // not halted like a 4xx
  b.env.chunkStatus = 202;
  b.rec.emit({ type: 3, timestamp: b.env.now + 1, data: { source: 1, n: 'b' } });
  await c.flush();
  const [failed, ok] = b.chunks();
  assert.deepEqual(failed.body.events.map((e) => e.data.n), ['a']);
  assert.deepEqual(ok.body.events.map((e) => e.data.n), ['a', 'b']);
  assert.equal(ok.body.seq, failed.body.seq + 1);
  b.env.chunkStatus = 503;                                   // a lasting outage: dropped after 3 re-queues
  b.rec.emit({ type: 3, timestamp: b.env.now + 2, data: { source: 1, n: 'c' } });
  for (let i = 0; i < 5; i++) await c.flush();
  assert.deepEqual(b.chunks().slice(2).map((x) => x.body.events.length), [1, 1, 1, 1]);
  c.stop();
});

test('JS errors, identify (never an email) and scroll depth become custom events', async () => {
  const b = browser();
  const c = b.make();
  c.identify('user_42');                                    // before start: queued
  c.identify('jane@example.com');                           // refused
  await b.settle();
  b.win.emit('error', { message: 'boom', error: { message: 'boom', stack: 'at x (a.js:1:1)' }, filename: 'https://acme.com/a.js?v=2', lineno: 1, colno: 1 });
  b.win.scrollY = 1200;
  b.win.emit('scroll');
  const tags = b.rec.custom.map(([t]) => t);
  assert.deepEqual(tags, ['prynt.identify', 'prynt.error', 'prynt.scroll']);
  assert.equal(b.rec.custom[0][1].userId, 'user_42');
  assert.equal(b.rec.custom[1][1].source, 'https://acme.com/a.js');
  assert.deepEqual(b.rec.custom[2][1], { pct: 100, docH: 2000 });
  c.stop();
});

test('loader: script next to the core bundle, explicit scriptUrl, or <endpoint>/cdn/', () => {
  assert.equal(loader.replayScriptUrl({ publicKey: 'pk', scriptUrl: 'https://cdn.example/r.js' }, ENDPOINT), 'https://cdn.example/r.js');
  assert.equal(loader.replayScriptUrl({ publicKey: 'pk' }, ENDPOINT + '/'), ENDPOINT + '/cdn/prynt-replay.umd.js');
});

test('loader: calls made before the script loads are forwarded to the recorder', async () => {
  const b = browser();
  const seen = [];
  window.PryntReplay = { replay: (o) => ({ identify: (u) => seen.push(['identify', u, o.endpoint]), setConsent: (g) => seen.push(['consent', g]),
                                           stop: () => seen.push(['stop']), flush: async () => {}, diagnose: () => ({ state: 'recording' }),
                                           ready: Promise.resolve(true) }) };
  const c = loader.loadReplay({ publicKey: 'pk_test_x' }, ENDPOINT, () => null);
  c.identify('u1');
  assert.equal(await c.ready, true);
  c.setConsent(false);
  assert.deepEqual(seen, [['identify', 'u1', ENDPOINT], ['consent', false]]);
  assert.equal(c.diagnose().state, 'recording');
  delete window.PryntReplay;
  assert.equal(b.rec.started, 0);
});

test('failed fetch / XHR become prynt.net events: method + origin/path + status, never the query, the Prynt API skipped', async () => {
  class FakeXHR extends Target {
    open(m, u) { this.m = m; this.u = u; }
    send() { setTimeout(() => { this.status = this.nextStatus; this.emit(this.aborted ? 'abort' : 'loadend'); if (this.aborted) this.emit('loadend'); }, 0); }
  }
  def('XMLHttpRequest', FakeXHR);
  const b = browser();
  const c = b.make();
  await b.settle();
  b.env.chunkStatus = 500;
  const r = await globalThis.fetch('https://acme.com/api/cart?token=abc&email=a@b.com', { method: 'post', body: JSON.stringify({ card: '4111' }) });
  assert.equal(r.status, 500);                               // the page still gets its response
  await globalThis.fetch(ENDPOINT + '/v1/replay/chunk?pk=x', { method: 'POST' });   // our own API: never reported
  b.env.chunkStatus = 200;
  await globalThis.fetch('/api/ok');                         // success: not reported
  const x = new FakeXHR(); x.nextStatus = 0; x.open('GET', '/api/search?q=jane'); x.send();
  const y = new FakeXHR(); y.nextStatus = 404; y.open('DELETE', 'https://cdn.acme.com/x.json'); y.send();
  const z = new FakeXHR(); z.nextStatus = 0; z.aborted = true; z.open('GET', '/api/aborted'); z.send();
  await b.settle();
  const nets = b.rec.custom.filter(([t]) => t === 'prynt.net').map(([, p]) => p);
  assert.deepEqual(nets.map((n) => [n.method, n.url, n.status, n.kind]), [
    ['POST', 'https://acme.com/api/cart', 500, 'fetch'],
    ['GET', 'https://acme.com/api/search', 0, 'xhr'],
    ['DELETE', 'https://cdn.acme.com/x.json', 404, 'xhr']]);
  assert.ok(nets.every((n) => typeof n.durationMs === 'number'));
  assert.ok(!JSON.stringify(nets).includes('token') && !JSON.stringify(nets).includes('jane') && !JSON.stringify(nets).includes('4111'));
  c.stop();                                                  // undo: fetch and XHR are the page's own again
  const before = b.rec.custom.length;
  b.env.chunkStatus = 503;
  await globalThis.fetch('https://acme.com/api/after-stop');
  assert.equal(b.rec.custom.length, before);
  assert.equal(FakeXHR.prototype.open.name, 'open');
});

test('captureErrors off: the network is not watched', async () => {
  const b = browser({ config: { captureErrors: false } });
  const c = b.make();
  await b.settle();
  b.env.chunkStatus = 500;
  await globalThis.fetch('https://acme.com/api/x');
  assert.equal(b.rec.custom.filter(([t]) => t === 'prynt.net').length, 0);
  c.stop();
});

test('dist/prynt-replay.umd.js size budget (rrweb + recorder, gzip <= 30 kB)', { skip: !existsSync(new URL('../dist/prynt-replay.umd.js', import.meta.url)) && 'run `node build.mjs` first' }, () => {
  const gz = gzipSync(readFileSync(new URL('../dist/prynt-replay.umd.js', import.meta.url))).length;
  assert.ok(gz <= 30 * 1024, `prynt-replay.umd.js is ${gz} B gzip`);
});

// --- developer tools (2026-11-07): console, every request, scrub ---
test("devScrub removes emails, long numbers and tokens and caps length", () => {
  const out = mod.devScrub("user ana@acme.io card 4111111111111111 key abcdefghijklmnopqrstuvwxyz0123", 300);
  assert.equal(out, "user [email] card [number] key [token]");
  assert.equal(mod.devScrub({ a: 1 }), "{\"a\":1}");
  assert.equal(mod.devScrub("ab ".repeat(200), 10).length, 10);
});

test("watchConsole records only the allowed levels, scrubbed, and restores console on undo", () => {
  const seen = [];
  const orig = { log: console.log, warn: console.warn, error: console.error };
  const silent = () => undefined;
  console.log = silent; console.warn = silent; console.error = silent;
  try {
    const undo = mod.watchConsole(["error", "warn"], (lv, args) => seen.push([lv, args]));
    console.error("failed for bob@x.io", 42);
    console.warn("slow");
    console.log("not recorded");
    undo();
    console.error("after undo");
    assert.deepEqual(seen, [["error", ["failed for [email]", "42"]], ["warn", ["slow"]]]);
  } finally { Object.assign(console, orig); }
});

test("watchNetwork reports failures to report() and successes to ok() only when given", async () => {
  def("location", { href: "https://acme.com/", host: "acme.com" });
  const responses = [{ status: 500 }, { status: 200 }];
  def("fetch", async () => responses.shift());
  const fails = [], oks = [];
  const undo = mod.watchNetwork("https://api.pryntid.test", (n) => fails.push(n), (n) => oks.push(n));
  await globalThis.fetch("https://acme.com/api/cart?token=1");
  await globalThis.fetch("https://acme.com/api/ok");
  undo();
  assert.equal(fails.length, 1); assert.equal(fails[0].status, 500); assert.equal(fails[0].url, "https://acme.com/api/cart");
  assert.equal(oks.length, 1); assert.equal(oks[0].status, 200);
});

test('page performance: Core Web Vitals sent once per page as prynt.vitals, rounded', async () => {
  const b = browser();
  const observers = {};
  def('PerformanceObserver', class { constructor(cb) { this.cb = cb; } observe(o) { observers[o.type] = this; } disconnect() {} });
  def('performance', { getEntriesByType: () => [{ responseStart: 212.7 }] });
  const r = b.make();
  await r.ready; await b.settle();
  const fire = (type, entries) => observers[type].cb({ getEntries: () => entries });
  fire('largest-contentful-paint', [{ startTime: 2480.6 }]);
  fire('paint', [{ name: 'first-contentful-paint', startTime: 900.2 }]);
  fire('layout-shift', [{ value: 0.12345, hadRecentInput: false }, { value: 0.5, hadRecentInput: true }]);
  fire('event', [{ interactionId: 7, duration: 180 }, { interactionId: 0, duration: 900 }]);
  b.win.emit('pagehide', {});
  const v = b.rec.custom.filter(([t]) => t === 'prynt.vitals');
  assert.equal(v.length, 1);
  assert.deepEqual(v[0][1], { ttfb: 213, lcp: 2481, fcp: 900, cls: 0.123, inp: 180 });
  b.win.emit('pagehide', {});
  assert.equal(b.rec.custom.filter(([t]) => t === 'prynt.vitals').length, 1);   // once per page
  delete globalThis.PerformanceObserver; delete globalThis.performance;
});

test('Sentry on the page: events carry a link to this replay at that second', async () => {
  const b = browser({ config: { consoleUrl: 'https://app.pryntid.test' } });
  const tags = {}; const procs = [];
  b.win.Sentry = { setTag: (k, v) => { tags[k] = v; }, addEventProcessor: (f) => procs.push(f) };
  const r = b.make();
  await r.ready; await b.settle();
  assert.match(tags.prynt_replay, /^https:\/\/app\.pryntid\.test\/replay\/session\/rvs_/);
  const ev = procs[0]({ tags: { a: '1' } });
  assert.equal(ev.tags.a, '1');
  assert.match(ev.tags.prynt_replay, /\?ts=\d+$/);
  delete b.win.Sentry;
});
