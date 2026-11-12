// The Reveal-only bundle (src/reveal_entry.ts → dist/prynt-reveal.*): works without Prynt.load(),
// picks up the full agent's visitorId/endpoint only when `window.Prynt` (the full bundle) is present.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { load, setup as setupEnv, ENDPOINT, COLLECT } from './_env.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const entry = await load('../src/reveal_entry.ts');
const setup = (o) => setupEnv(entry.reveal, o);

test('reveal-only entry: default export {reveal, version}; sends with visitorId null and Prynt Cloud endpoint', async () => {
  const s = setup();
  assert.equal(typeof entry.default.reveal, 'function');
  assert.equal(typeof entry.version, 'string');
  const c = entry.reveal({ publicKey: 'pk_test_x' });        // no endpoint, no window.Prynt
  await c.flush();
  assert.equal(s.env.calls[0].url, 'https://api.pryntid.com/v1/reveal/collect');
  assert.equal(s.env.calls[0].body.visitorId, null);
  assert.equal(c.diagnose().visitorId, null);
  assert.equal(c.diagnose().sdkVersion, entry.version);
  c.stop();
});

test('reveal-only entry: the full agent on window.Prynt is detected at runtime (visitorId + endpoint)', async () => {
  const s = setup();
  let vid = null;
  window.Prynt = { _agent: () => ({ visitorId: vid, endpoint: ENDPOINT }) };
  const c = entry.reveal({ publicKey: 'pk_test_x' });
  await c.flush();
  assert.equal(s.env.calls[0].url, COLLECT);
  assert.equal(s.env.calls[0].body.visitorId, null);
  vid = 'vst_full';                                           // Prynt.load()+identify() ran later
  c.pageview(); await c.flush();
  assert.equal(s.env.calls[1].body.visitorId, 'vst_full');
  window.Prynt = { _agent: () => { throw new Error('boom'); } };
  c.pageview(); await c.flush();
  assert.equal(s.env.calls[2].body.visitorId, null);
  c.stop();
});

test('dist/prynt-reveal.umd.js: global PryntReveal, version = package.json, no device-intelligence code, size budget', { skip: !existsSync(path.join(here, '..', 'dist', 'prynt-reveal.umd.js')) && 'run `node build.mjs` first' }, () => {
  setup();
  const js = readFileSync(path.join(here, '..', 'dist', 'prynt-reveal.umd.js'), 'utf8');
  const pkg = JSON.parse(readFileSync(path.join(here, '..', 'package.json'), 'utf8'));
  const g = {};
  new Function('globalThis', 'window', js + ';globalThis.PryntReveal=PryntReveal;')(g, window);
  assert.equal(typeof g.PryntReveal.reveal, 'function');
  assert.equal(g.PryntReveal.version, pkg.version);
  assert.ok(!/getImageData|toDataURL|WEBGL_debug|AudioContext|hardwareConcurrency|__prynt_id/i.test(js), 'no fingerprinting code in the Reveal-only bundle');
  assert.ok(js.length < 16_000, `prynt-reveal.umd.js is ${js.length} B (budget 16,000)`);
});
