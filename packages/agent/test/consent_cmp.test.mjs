// Tests for src/consent_cmp.ts (CMP auto-detection, PRD FP-8) and its wiring into reveal.ts:
// consentSource in the collect body, re-evaluation on CMP change, GPC always winning.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load, setup as setupEnv } from './_env.mjs';

const { readCmp, watchCmp, createReveal } = await load();
const setup = (o) => setupEnv(createReveal, o);

const CKY = 'consentid:abc,consent:yes,action:yes,necessary:yes,functional:yes,analytics:yes,performance:yes,advertisement:no,other:no';

test('readCmp: nothing installed → no CMP, no decision', () => {
  setup();
  assert.deepEqual(readCmp(undefined), { cmp: null, consent: null });
});

test('readCmp: CookieYes via getCkyConsent() (analytics category) and via the cookieyes-consent cookie', () => {
  setup();
  window.getCkyConsent = () => ({ isUserActionCompleted: true, categories: { necessary: true, analytics: true, advertisement: false } });
  assert.deepEqual(readCmp(), { cmp: 'cookieyes', consent: true });
  window.getCkyConsent = () => ({ isUserActionCompleted: true, categories: { analytics: false } });
  assert.deepEqual(readCmp(), { cmp: 'cookieyes', consent: false });
  window.getCkyConsent = () => ({ isUserActionCompleted: false, categories: { analytics: false } });   // banner still open
  assert.deepEqual(readCmp(), { cmp: 'cookieyes', consent: null });
  setup({ cookie: 'foo=1; cookieyes-consent=' + encodeURIComponent(CKY) });
  assert.deepEqual(readCmp(), { cmp: 'cookieyes', consent: true });
  setup({ cookie: 'cookieyes-consent=' + CKY.replace('analytics:yes', 'analytics:no') });
  assert.deepEqual(readCmp(), { cmp: 'cookieyes', consent: false });
  setup({ cookie: 'cookieyes-consent=' + CKY.replace('action:yes', 'action:no').replace('analytics:yes', 'analytics:no') });
  assert.deepEqual(readCmp(), { cmp: 'cookieyes', consent: null });
});

test('readCmp: Cookiebot statistics category; no response yet → null', () => {
  setup();
  window.Cookiebot = { hasResponse: true, consent: { necessary: true, statistics: true, marketing: false } };
  assert.deepEqual(readCmp(), { cmp: 'cookiebot', consent: true });
  window.Cookiebot.consent.statistics = false;
  assert.deepEqual(readCmp(), { cmp: 'cookiebot', consent: false });
  window.Cookiebot = { hasResponse: false, consent: { statistics: false } };
  assert.deepEqual(readCmp(), { cmp: 'cookiebot', consent: null });
});

test('readCmp: OneTrust OnetrustActiveGroups contains C0002; present but empty → null', () => {
  setup();
  window.OnetrustActiveGroups = ',C0001,C0002,C0004,';
  assert.deepEqual(readCmp(), { cmp: 'onetrust', consent: true });
  window.OnetrustActiveGroups = ',C0001,';
  assert.deepEqual(readCmp(), { cmp: 'onetrust', consent: false });
  window.OnetrustActiveGroups = '';
  window.OneTrust = {};
  assert.deepEqual(readCmp(), { cmp: 'onetrust', consent: null });
});

test('readCmp: Klaro — service "prynt", else an analytics/statistics-named service; unconfirmed → null', () => {
  setup();
  const mgr = { confirmed: true, consents: { prynt: true, googleAnalytics: false } };
  window.klaro = { getManager: () => mgr };
  assert.deepEqual(readCmp(), { cmp: 'klaro', consent: true });
  mgr.consents = { googleAnalytics: false, maps: true };
  assert.deepEqual(readCmp(), { cmp: 'klaro', consent: false });
  mgr.consents = { maps: true };
  assert.deepEqual(readCmp(), { cmp: 'klaro', consent: null });
  mgr.confirmed = false; mgr.consents = { prynt: true };
  assert.deepEqual(readCmp(), { cmp: 'klaro', consent: null });
});

test('readCmp: TCF state comes from the listener (undefined = no __tcfapi)', () => {
  setup();
  assert.deepEqual(readCmp(undefined), { cmp: null, consent: null });
  assert.deepEqual(readCmp(null), { cmp: 'tcf', consent: null });
  assert.deepEqual(readCmp(true), { cmp: 'tcf', consent: true });
  assert.deepEqual(readCmp(false), { cmp: 'tcf', consent: false });
});

test('readCmp: Google Consent Mode — analytics_storage from dataLayer consent default/update (arguments objects too)', () => {
  setup();
  window.dataLayer = [{ event: 'gtm.js' }];
  assert.deepEqual(readCmp(), { cmp: null, consent: null });           // dataLayer alone is not a CMP
  function gtag() { window.dataLayer.push(arguments); }
  gtag('consent', 'default', { ad_storage: 'denied', analytics_storage: 'denied' });
  assert.deepEqual(readCmp(), { cmp: 'gcm', consent: false });
  gtag('consent', 'update', { analytics_storage: 'granted' });
  assert.deepEqual(readCmp(), { cmp: 'gcm', consent: true });
  window.dataLayer = [['consent', 'default', { ad_storage: 'denied' }]];
  assert.deepEqual(readCmp(), { cmp: 'gcm', consent: null });          // consent entries without analytics_storage
});

test('readCmp: first detected CMP wins (CookieYes > Cookiebot > OneTrust > Klaro > TCF > GCM)', () => {
  setup();
  window.Cookiebot = { hasResponse: true, consent: { statistics: false } };
  window.OnetrustActiveGroups = ',C0002,';
  assert.deepEqual(readCmp(true), { cmp: 'cookiebot', consent: false });
  window.getCkyConsent = () => ({ isUserActionCompleted: true, categories: { analytics: true } });
  assert.deepEqual(readCmp(true), { cmp: 'cookieyes', consent: true });
  delete window.getCkyConsent; delete window.Cookiebot; delete window.OnetrustActiveGroups;
  assert.deepEqual(readCmp(true), { cmp: 'tcf', consent: true });
});

test('readCmp: a CMP that throws is skipped, never thrown into the page', () => {
  setup();
  window.getCkyConsent = () => { throw new Error('boom'); };
  Object.defineProperty(window, 'Cookiebot', { get() { throw new Error('boom'); }, configurable: true });
  window.OnetrustActiveGroups = ',C0002,';
  assert.deepEqual(readCmp(), { cmp: 'onetrust', consent: true });
});

test('watchCmp: TCF 2.2 listener — purposes 1 AND 7, tcloaded/useractioncomplete only, gdprApplies:false = ok', () => {
  const s = setup();
  let cb = null;
  window.__tcfapi = (cmd, ver, fn) => { assert.equal(cmd, 'addEventListener'); assert.equal(ver, 2); cb = fn; };
  let changes = 0;
  const w = watchCmp(() => { changes++; });
  assert.ok(cb);
  assert.deepEqual(w.read(), { cmp: 'tcf', consent: null });
  cb({ eventStatus: 'cmpuishown', purpose: { consents: { 1: true, 7: true } } }, true);
  assert.deepEqual(w.read(), { cmp: 'tcf', consent: null });
  cb({ eventStatus: 'useractioncomplete', purpose: { consents: { 1: true, 7: false } } }, true);
  assert.deepEqual(w.read(), { cmp: 'tcf', consent: false });
  cb({ eventStatus: 'tcloaded', purpose: { consents: { 1: true, 7: true } } }, true);
  assert.deepEqual(w.read(), { cmp: 'tcf', consent: true });
  cb({ eventStatus: 'tcloaded', purpose: { consents: {} } }, false);                 // success=false ignored
  assert.deepEqual(w.read(), { cmp: 'tcf', consent: true });
  cb({ gdprApplies: false, eventStatus: 'tcloaded' }, true);
  assert.deepEqual(w.read(), { cmp: 'tcf', consent: true });
  assert.ok(changes >= 4);
  assert.equal(s.env.intervals.length, 1);
  w.stop();
  assert.equal(s.env.intervals.length, 0);
});

test('watchCmp: polls every second (a CMP that loads after the SDK is picked up) and stop() clears the poll', () => {
  const s = setup();
  let n = 0;
  const w = watchCmp(() => { n++; });
  assert.equal(n, 1);
  assert.deepEqual(w.read(), { cmp: null, consent: null });
  window.Cookiebot = { hasResponse: true, consent: { statistics: true } };
  s.tick();
  assert.equal(n, 2);
  assert.deepEqual(w.read(), { cmp: 'cookiebot', consent: true });
  w.stop();
  s.tick();
  assert.equal(n, 2);
});

// ---- wiring into reveal.ts ----

test('consentSource in the collect body: config / override / default / gpc', async () => {
  let s = setup(); let c = s.make({ consent: true }); await c.flush();
  assert.equal(s.env.calls[0].body.consentSource, 'config'); c.stop();
  s = setup(); c = s.make({ consent: () => false }); await c.flush();
  assert.equal(s.env.calls[0].body.consentSource, 'config');
  c.setConsent(true); c.pageview(); await c.flush();
  assert.equal(s.env.calls[1].body.consentSource, 'override');
  assert.equal(s.env.calls[1].body.consent, true); c.stop();
  s = setup({ tz: 'Europe/Berlin' }); c = s.make({ consent: undefined }); await c.flush();
  assert.equal(s.env.calls[0].body.consentSource, 'default');
  assert.equal(s.env.calls[0].body.consent, false); c.stop();
  s = setup(); navigator.globalPrivacyControl = true; c = s.make({ consent: true }); await c.flush();
  assert.equal(s.env.calls[0].body.consentSource, 'gpc');
  assert.equal(s.env.calls[0].body.consent, false);
  c.setConsent(true); c.identify({ email: 'a@b.co' }); c.pageview(); await c.flush();   // GPC always wins
  assert.ok(s.env.calls.every((x) => x.body.consent === false && x.body.consentSource === 'gpc'));
  assert.equal(s.events().filter((e) => e.kind === 'identify').length, 0);
  c.stop();
});

test('CMP auto-detect drives consent when no `consent` option is given; the option overrides the CMP', async () => {
  let s = setup({ tz: 'Europe/Madrid' });
  window.Cookiebot = { hasResponse: true, consent: { statistics: true } };
  let c = s.make({ consent: undefined }); await c.flush();
  assert.equal(s.env.calls[0].body.consent, true);
  assert.equal(s.env.calls[0].body.consentSource, 'cookiebot');
  assert.equal(c.diagnose().cmpDetected, 'cookiebot');
  c.stop();
  s = setup({ tz: 'America/New_York' });
  window.OnetrustActiveGroups = ',C0001,';
  c = s.make({ consent: undefined }); await c.flush();
  assert.equal(s.env.calls[0].body.consent, false);             // CMP says no even though the region default would be yes
  assert.equal(s.env.calls[0].body.consentSource, 'onetrust');
  c.stop();
  s = setup();
  window.OnetrustActiveGroups = ',C0001,';
  c = s.make({ consent: true }); await c.flush();
  assert.equal(s.env.calls[0].body.consent, true);              // explicit option wins over the CMP
  assert.equal(s.env.calls[0].body.consentSource, 'config');
  assert.equal(c.diagnose().cmpDetected, 'onetrust');
  c.stop();
});

test('CMP change is re-evaluated: a late grant releases held identify/track; a later denial goes back to minimal', async () => {
  const s = setup({ cookie: 'cookieyes-consent=' + CKY.replace('action:yes', 'action:no').replace('analytics:yes', 'analytics:no') });
  const c = s.make({ consent: undefined, engagement: false });
  await c.flush();
  assert.equal(s.env.calls[0].body.consent, false);
  assert.equal(s.env.calls[0].body.consentSource, 'cookieyes');
  c.identify({ email: 'ann@acme.com' }); c.track('demo');
  await c.flush();
  assert.equal(s.env.calls.length, 1);
  document.cookie = 'cookieyes-consent=' + CKY;                  // visitor accepts
  s.tick();                                                      // the 1 s poll
  await c.flush();
  const full = s.env.calls.filter((x) => x.body.consent === true);
  assert.equal(full.length, 1);
  assert.equal(full[0].body.consentSource, 'cookieyes');
  assert.deepEqual(full[0].body.events.map((e) => e.kind), ['identify', 'custom']);
  document.cookie = 'cookieyes-consent=' + CKY.replace('analytics:yes', 'analytics:no');   // later withdrawal
  s.tick(); c.pageview(); await c.flush();
  const last = s.env.calls[s.env.calls.length - 1].body;
  assert.equal(last.consent, false);
  assert.equal(last.events[0].referrer, undefined);
  c.stop();
});

test('Google Consent Mode: gtag consent update after load is honoured on the next tick', async () => {
  const s = setup({ tz: 'Europe/Paris' });
  window.dataLayer = [];
  function gtag() { window.dataLayer.push(arguments); }
  gtag('consent', 'default', { analytics_storage: 'denied' });
  const c = s.make({ consent: undefined, engagement: false });
  await c.flush();
  assert.equal(s.env.calls[0].body.consentSource, 'gcm');
  assert.equal(s.env.calls[0].body.consent, false);
  c.identify({ email: 'ann@acme.com' });
  gtag('consent', 'update', { analytics_storage: 'granted' });
  s.tick(); await c.flush();
  const full = s.env.calls.filter((x) => x.body.consent === true);
  assert.equal(full.length, 1);
  assert.equal(full[0].body.consentSource, 'gcm');
  assert.equal(full[0].body.events[0].kind, 'identify');
  c.stop();
});

test('TCF through reveal: __tcfapi decision flips consent and consentSource is "tcf"', async () => {
  const s = setup({ tz: 'Europe/Rome' });
  let cb = null;
  window.__tcfapi = (cmd, ver, fn) => { cb = fn; };
  const c = s.make({ consent: undefined, engagement: false });
  await c.flush();
  assert.equal(s.env.calls[0].body.consentSource, 'tcf');
  assert.equal(s.env.calls[0].body.consent, false);
  c.track('x');
  cb({ eventStatus: 'useractioncomplete', purpose: { consents: { 1: true, 7: true } } }, true);
  await c.flush();
  const full = s.env.calls.filter((x) => x.body.consent === true);
  assert.equal(full.length, 1);
  assert.equal(full[0].body.consentSource, 'tcf');
  c.stop();
});

test('stop() ends the CMP poll; a CMP decision after stop() sends nothing', async () => {
  const s = setup();
  window.Cookiebot = { hasResponse: false, consent: { statistics: false } };
  const c = s.make({ consent: undefined });
  c.identify({ email: 'ann@acme.com' });
  c.stop(); await c.flush();
  const n = s.env.calls.length;
  window.Cookiebot = { hasResponse: true, consent: { statistics: true } };
  s.tick(); await c.flush();
  assert.equal(s.env.intervals.length, 0);
  assert.equal(s.env.calls.length, n);
});
