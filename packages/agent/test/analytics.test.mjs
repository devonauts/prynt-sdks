// src/analytics.ts: the shared-collect client (Prynt.analytics()). Same fake browser as reveal.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load, setup as setupEnv, ENDPOINT } from './_env.mjs';

const { createAnalytics } = await load();
const setup = (o) => setupEnv(createAnalytics, o);

test('analytics: beacons go to /v1/track; page() and track() send pageview / custom', async () => {
  const s = setup();
  const c = s.make();
  c.page('/docs');
  c.track('signup_click', { plan: 'pro' });
  await c.flush();
  assert.ok(s.env.calls.length >= 1);
  for (const call of s.env.calls) assert.equal(call.url, ENDPOINT + '/v1/track');
  const kinds = s.events().map((e) => e.kind);
  assert.ok(kinds.filter((k) => k === 'pageview').length >= 2);   // initial pageview + page()
  const custom = s.events().find((e) => e.kind === 'custom');
  assert.equal(custom.name, 'signup_click');
  assert.deepEqual(custom.props, { plan: 'pro' });
  assert.equal(c.diagnose().endpoint, ENDPOINT);
  c.stop();
});

test('analytics: GPC wins — consent false, no visitorId, no pid read', async () => {
  const s = setup({ href: 'https://www.acme.com/?pid=' + 'a'.repeat(30) + '.' + 'b'.repeat(43) });
  globalThis.navigator.globalPrivacyControl = true;
  const c = s.make();
  await c.flush();
  const body = s.env.calls[0].body;
  assert.equal(body.consent, false);
  assert.equal(body.consentSource, 'gpc');
  assert.equal(body.visitorId, null);
  assert.equal(body.pid, undefined);
  c.stop();
});

test('analytics: identify(userId, traits) sends a consented identify event with the user id and clean traits', async () => {
  const s = setup();
  const c = s.make();
  c.identify('user_42', { plan: 'pro', email: 'x@y.com', seats: 3 });
  c.identify({ userId: 'user_43', email: 'not-an-email' });
  c.identify('   ');                               // nothing to link → ignored
  await c.flush();
  const ids = s.events().filter((e) => e.kind === 'identify');
  assert.equal(ids.length, 2);
  assert.deepEqual(ids[0].identity, { userId: 'user_42' });
  assert.deepEqual(ids[0].props, { plan: 'pro', seats: 3 });   // PII-looking keys dropped client-side
  assert.deepEqual(ids[1].identity, { userId: 'user_43' });
  c.stop();
});

test('analytics: identify waits for consent; SPA route change = pageview with utm + referrer', async () => {
  const s = setup();
  const c = s.make({ consent: undefined });
  c.setConsent(false);
  c.identify('user_9');
  await c.flush();
  assert.equal(s.events().filter((e) => e.kind === 'identify').length, 0);
  c.setConsent(true);
  history.pushState({}, '', '/signup?utm_source=newsletter');
  await c.flush();
  const ids = s.events().filter((e) => e.kind === 'identify');
  assert.equal(ids.length, 1);
  const pv = s.events().filter((e) => e.kind === 'pageview').pop();
  assert.equal(pv.path, '/signup');
  assert.equal(pv.utm.source, 'newsletter');
  assert.ok(pv.referrer.includes('/pricing'));
  c.stop();
});
