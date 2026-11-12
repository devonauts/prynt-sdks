// Tests for src/reveal.ts — `node --test test/`. No dependencies beyond esbuild (already a
// devDependency): the module is bundled in-memory and imported from a data: URL, and the browser
// surface it touches (window/document/location/history/navigator/localStorage/fetch) is the tiny
// shim in test/_env.mjs (shared with consent_cmp.test.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load, setup as setupEnv, def, ENDPOINT, COLLECT } from './_env.mjs';

const { createReveal, botHint, markShielded } = await load();
const setup = (o) => setupEnv(createReveal, o);

test('session id is rvs_<24 chars>, stored in prynt_rvs and renewed after 30 min of inactivity', async () => {
  const s = setup();
  const c = s.make();
  await c.flush();
  const first = s.env.calls[0].body.sessionId;
  assert.match(first, /^rvs_[a-z0-9]{24}$/);
  const stored = JSON.parse(s.env.store.prynt_rvs);
  assert.equal(stored.id, first);
  assert.equal(stored.last, s.env.now);
  s.env.now += 10 * 60 * 1000;                 // 10 min: same session
  c.pageview(); await c.flush();
  assert.equal(s.env.calls[1].body.sessionId, first);
  s.env.now += 31 * 60 * 1000;                 // 31 min idle: new session
  c.pageview(); await c.flush();
  assert.notEqual(s.env.calls[2].body.sessionId, first);
  assert.match(s.env.calls[2].body.sessionId, /^rvs_[a-z0-9]{24}$/);
  c.stop();
});

test('falls back to an in-memory session when localStorage throws', async () => {
  const s = setup(); s.env.storageThrows = true;
  const c = s.make();
  c.pageview(); await c.flush();
  const ids = new Set(s.env.calls.map((x) => x.body.sessionId));
  assert.equal(ids.size, 1);
  assert.match([...ids][0], /^rvs_[a-z0-9]{24}$/);
  c.stop();
});

test('every event carries a unique evt_ id (idempotency key)', async () => {
  const s = setup();
  const c = s.make();
  for (let i = 0; i < 30; i++) c.track('e' + i);
  await c.flush();
  const ids = s.events().map((e) => e.eventId);
  assert.equal(ids.length, 31);
  assert.equal(new Set(ids).size, 31);
  for (const id of ids) assert.match(id, /^evt_[a-z0-9]{20}$/);
  c.stop();
});

test('pageview payload: body shape, website without www, utm parsed, click ids as booleans', async () => {
  const s = setup();
  const c = s.make();
  await c.flush();
  const { url, init, body } = s.env.calls[0];
  assert.equal(url, COLLECT);
  assert.equal(init.method, 'POST');
  assert.equal(init.headers['Content-Type'], 'text/plain');
  assert.equal(init.keepalive, true);
  assert.equal(init.credentials, 'omit');
  assert.equal(body.publicKey, 'pk_test_x');
  assert.equal(body.website, 'acme.com');
  assert.equal(body.consent, true);
  assert.equal(body.visitorId, 'vst_abc');
  assert.equal(body.events.length, 1);
  const ev = body.events[0];
  assert.equal(ev.kind, 'pageview');
  assert.equal(ev.url, 'https://www.acme.com/pricing?utm_source=linkedin&utm_medium=social&gclid=abc123');
  assert.equal(ev.path, '/pricing');
  assert.equal(ev.title, 'Pricing');
  assert.equal(ev.referrer, 'https://www.google.com/');
  assert.deepEqual(ev.utm, { source: 'linkedin', medium: 'social', gclid: true });
  assert.ok(!JSON.stringify(ev.utm).includes('abc123'));
  assert.equal(ev.ts, new Date(s.env.now).toISOString());
  c.stop();
});

test('consent false: only minimal pageviews (no referrer/utm/query/visitorId), track/identify withheld', async () => {
  const s = setup();
  const c = s.make({ consent: false });
  c.track('clicked', { plan: 'pro' });
  c.identify({ email: 'ann@acme.com' });
  await c.flush();
  assert.equal(s.env.calls.length, 1);
  const body = s.env.calls[0].body;
  assert.equal(body.consent, false);
  assert.equal(body.visitorId, null);
  assert.equal(body.events.length, 1);
  const ev = body.events[0];
  assert.equal(ev.kind, 'pageview');
  assert.equal(ev.url, 'https://www.acme.com/pricing');
  assert.equal(ev.path, '/pricing');
  assert.equal(ev.referrer, undefined);
  assert.equal(ev.utm, undefined);
  assert.equal(ev.identity, undefined);
  c.stop();
});

test('setConsent(true) flushes the identify/custom events queued while consent was off', async () => {
  const s = setup();
  const c = s.make({ consent: false });
  await c.flush();
  c.identify({ email: 'ann@acme.com', name: 'Ann' });
  c.track('demo_requested', { seats: 5 });
  await c.flush();
  assert.equal(s.env.calls.length, 1);          // still only the minimal pageview
  c.setConsent(true);
  await c.flush();
  const full = s.env.calls.filter((x) => x.body.consent === true);
  assert.equal(full.length, 1);
  assert.equal(full[0].body.visitorId, 'vst_abc');
  const kinds = full[0].body.events.map((e) => e.kind);
  assert.deepEqual(kinds, ['identify', 'custom']);
  assert.deepEqual(full[0].body.events[0].identity, { email: 'ann@acme.com', name: 'Ann' });
  assert.deepEqual(full[0].body.events[1].props, { seats: 5 });
  c.stop();
});

test('consent default: false on EU/UK/CH-looking pages or GPC, true elsewhere', async () => {
  let s = setup({ tz: 'Europe/Madrid' });
  let c = s.make({ consent: undefined }); await c.flush();
  assert.equal(s.env.calls[0].body.consent, false); c.stop();
  s = setup({ tz: 'America/Bogota', lang: 'de' });
  c = s.make({ consent: undefined }); await c.flush();
  assert.equal(s.env.calls[0].body.consent, false); c.stop();
  s = setup({ tz: 'America/Bogota', lang: 'en-GB' });
  c = s.make({ consent: undefined }); await c.flush();
  assert.equal(s.env.calls[0].body.consent, false); c.stop();
  s = setup({ tz: 'America/New_York', lang: 'en' });
  c = s.make({ consent: undefined }); await c.flush();
  assert.equal(s.env.calls[0].body.consent, true); c.stop();
  s = setup({ tz: 'America/New_York', lang: 'es' });
  navigator.globalPrivacyControl = true;
  c = s.make({ consent: undefined }); await c.flush();
  assert.equal(s.env.calls[0].body.consent, false); c.stop();
  // function form is read at each event
  s = setup({ tz: 'Europe/Paris' });
  let ok = false;
  c = s.make({ consent: () => ok }); await c.flush();
  assert.equal(s.env.calls[0].body.consent, false);
  ok = true; c.pageview(); await c.flush();
  assert.equal(s.env.calls[1].body.consent, true); c.stop();
});

test('SPA: pushState/replaceState/popstate emit a pageview (after the engagement of the page left)', async () => {
  const s = setup();
  const c = s.make();
  await c.flush();
  s.env.now += 4000;
  history.pushState({}, '', '/features?utm_campaign=spring');
  await c.flush();
  const evs = s.events();
  assert.deepEqual(evs.map((e) => e.kind), ['pageview', 'engagement', 'pageview']);
  assert.equal(evs[1].url, 'https://www.acme.com/pricing?utm_source=linkedin&utm_medium=social&gclid=abc123');
  assert.equal(evs[1].durationMs, 4000);
  assert.equal(evs[2].path, '/features');
  assert.equal(evs[2].referrer, 'https://www.acme.com/pricing?utm_source=linkedin&utm_medium=social&gclid=abc123');
  assert.deepEqual(evs[2].utm, { campaign: 'spring' });
  history.replaceState({}, '', '/features');   // same path, different query → new pageview
  s.nav('/docs'); window.emit('popstate');
  history.pushState({}, '', '/docs');          // same URL again → no duplicate
  await c.flush();
  assert.deepEqual(s.events().slice(3).map((e) => e.kind + ' ' + e.path), ['pageview /features', 'pageview /docs']);
  c.stop();
});

test('engagement counts active (visible) time only and the max scroll depth', async () => {
  const s = setup();
  const c = s.make();
  s.env.now += 5000;
  window.scrollY = 600; window.emit('scroll');       // (600+800)/2000 = 70 %
  window.scrollY = 200; window.emit('scroll');       // lower: max stays 70
  document.hidden = true; document.emit('visibilitychange');
  s.env.now += 60_000;                                // hidden for a minute: not counted
  document.hidden = false; document.emit('visibilitychange');
  s.env.now += 3000;
  window.emit('pagehide');
  await c.flush();
  const eng = [...s.events(), ...s.env.beacons.flatMap((b) => b.body.events)].filter((e) => e.kind === 'engagement');
  assert.equal(eng.length, 2);
  assert.equal(eng[0].durationMs, 5000);
  assert.equal(eng[0].scrollPct, 70);
  assert.equal(eng[1].durationMs, 3000);
  assert.equal(eng[1].scrollPct, 70);
  assert.equal(eng[0].path, '/pricing');
  c.stop();
});

test('form submit extracts only email/name (never password or other fields) and needs consent', async () => {
  const s = setup();
  let passwordRead = false;
  const input = (type, name, value, extra = {}) => ({ type, name, id: '', autocomplete: '', value, ...extra });
  const pw = input('password', 'password', '');
  Object.defineProperty(pw, 'value', { get() { passwordRead = true; return 'hunter2'; } });
  const form = {
    id: 'lead', name: '',
    matches: (sel) => sel === '#lead',
    querySelectorAll: () => [
      input('text', 'full_name', '  Ann Lee '),
      input('text', 'company', 'Acme'),
      input('tel', 'phone', '+1555'),
      input('text', 'work_email', 'ann@acme.com'),
      pw,
      input('hidden', 'email_backup', 'secret@acme.com'),
    ],
  };
  const c = s.make({ forms: ['#lead'] });
  document.emit('submit', { target: { id: 'other', matches: () => false, querySelectorAll: () => [] } });
  document.emit('submit', { target: form });
  await c.flush();
  const forms = s.events().filter((e) => e.kind === 'form');
  assert.equal(forms.length, 1);
  assert.deepEqual(forms[0].identity, { email: 'ann@acme.com', name: 'Ann Lee', formId: 'lead' });
  assert.equal(passwordRead, false);
  assert.ok(!JSON.stringify(s.env.calls).includes('Acme"'));
  assert.ok(!JSON.stringify(s.env.calls).includes('+1555'));
  c.stop();
  // forms: true matches every form, but never without consent
  const s2 = setup();
  const c2 = s2.make({ forms: true, consent: false });
  document.emit('submit', { target: form });
  await c2.flush();
  assert.equal(s2.events().filter((e) => e.kind === 'form').length, 0);
  assert.equal(passwordRead, false);
  c2.setConsent(true);
  document.emit('submit', { target: form });
  await c2.flush();
  assert.equal(s2.events().filter((e) => e.kind === 'form').length, 1);
  c2.stop();
});

test('track(): PII-looking keys dropped, non-primitives dropped, 20 keys / 200 chars caps', async () => {
  const s = setup();
  const c = s.make();
  const many = {};
  for (let i = 0; i < 30; i++) many['k' + i] = i;
  c.track('signup', { plan: 'pro', seats: 3, trial: true, email: 'x@y.z', phone: '1', firstName: 'A',
                      password: 'p', apiToken: 't', cardNumber: '4', nested: { a: 1 }, list: [1], nothing: null,
                      long: 'a'.repeat(300) });
  c.track('many', many);
  c.track('  ', { a: 1 });              // empty name: ignored
  c.track('bare');
  await c.flush();
  const custom = s.events().filter((e) => e.kind === 'custom');
  assert.equal(custom.length, 3);
  assert.equal(custom[0].name, 'signup');
  assert.deepEqual(Object.keys(custom[0].props), ['plan', 'seats', 'trial', 'long']);
  assert.equal(custom[0].props.long.length, 200);
  assert.equal(Object.keys(custom[1].props).length, 20);
  assert.equal(custom[2].props, undefined);
  c.stop();
});

test('batching: auto-flush at 10 queued events, max 50 events per request', async () => {
  const s = setup();
  const c = s.make();
  for (let i = 0; i < 9; i++) c.track('e');      // 1 pageview + 9 = 10 → flushed synchronously
  assert.equal(s.env.calls.length, 1);
  assert.equal(s.env.calls[0].body.events.length, 10);
  await c.flush();
  for (let i = 0; i < 9; i++) c.track('e');      // 9 queued, under the threshold → timer only
  assert.equal(s.env.calls.length, 1);
  await c.flush();
  assert.equal(s.env.calls.length, 2);
  // a big backlog (events held until consent, released at once) is split into requests of ≤ 50
  const s2 = setup();
  const c2 = s2.make();
  c2.setConsent(false);
  for (let i = 0; i < 60; i++) c2.track('x', { i });
  await c2.flush();                                // sends only the initial pageview
  const n1 = s2.env.calls.length;
  c2.setConsent(true);
  await c2.flush();
  const sizes = s2.env.calls.slice(n1).map((x) => x.body.events.length);
  assert.deepEqual(sizes, [50, 10]);
  assert.ok(s2.env.calls.slice(n1).every((x) => x.body.consent === true));
  c2.stop();
  c.stop();
});

test('pagehide: engagement + flush through navigator.sendBeacon (text body, no fetch)', async () => {
  const s = setup();
  const c = s.make();
  await c.flush();
  s.env.now += 1500;
  c.track('cta');
  window.emit('pagehide');
  await c.flush();
  assert.equal(s.env.beacons.length, 1);
  assert.equal(s.env.beacons[0].url, COLLECT);
  assert.deepEqual(s.env.beacons[0].body.events.map((e) => e.kind), ['custom', 'engagement']);
  assert.equal(s.env.beacons[0].body.events[1].durationMs, 1500);
  assert.equal(s.env.calls.length, 1);          // only the initial pageview went through fetch
  // when sendBeacon refuses (queue full) fetch keepalive is the fallback
  navigator.sendBeacon = () => false;
  c.track('cta2'); window.emit('pagehide'); await c.flush();
  assert.equal(s.env.calls.length, 2);
  c.stop();
});

test('transport: retries once on network error / 5xx, drops on 4xx', async () => {
  const s = setup();
  const c = s.make();
  s.env.fail = 1;
  await c.flush();
  assert.equal(s.env.calls.length, 2);
  assert.equal(s.env.calls[0].body.events[0].eventId, s.env.calls[1].body.events[0].eventId);
  s.env.status = 503; c.pageview(); await c.flush();
  assert.equal(s.env.calls.length, 4);
  s.env.status = 403; c.pageview(); await c.flush();
  assert.equal(s.env.calls.length, 5);
  s.env.fail = 2; c.pageview(); await c.flush();   // never more than one retry
  assert.equal(s.env.calls.length, 7);
  c.stop();
});

test('stop() removes every listener, restores history and flushes; nothing after', async () => {
  const s = setup();
  const c = s.make({ forms: true });
  assert.ok(s.win.count() >= 3 && s.doc.count() >= 2);
  assert.notEqual(history.pushState, s.origPush);
  c.track('last');
  c.stop();
  await c.flush();
  assert.equal(s.win.count(), 0);
  assert.equal(s.doc.count(), 0);
  assert.equal(history.pushState, s.origPush);
  assert.deepEqual(s.events().map((e) => e.kind), ['pageview', 'custom']);
  c.track('after'); c.pageview(); await c.flush();
  assert.equal(s.events().length, 2);
});

test('no DOM: returns a no-op client; missing publicKey throws', () => {
  setup();
  assert.throws(() => createReveal({}, ENDPOINT, () => null), /publicKey/);
  def('window', undefined);
  const c = createReveal({ publicKey: 'pk_test_x' }, ENDPOINT, () => null, '1.0.0');
  c.pageview(); c.track('x'); c.identify({ email: 'a@b.co' }); c.setConsent(true); c.stop();
  const d = c.diagnose();
  assert.equal(d.loaded, false);
  assert.equal(d.publicKey, 'pk_test_x');
  assert.equal(d.consentSource, 'default');
  return c.flush();
});

// ---- Sprint 2: ESP params (FP-1) ----

test('ESP: mc_eid becomes props.espToken and is removed from the sent url (utm kept)', async () => {
  const s = setup({ href: 'https://acme.com/blog/post?utm_source=newsletter&mc_eid=abc123&mc_cid=camp9&x=1' });
  const c = s.make();
  await c.flush();
  const ev = s.events()[0];
  assert.deepEqual(ev.props, { espToken: { provider: 'mailchimp', token: 'abc123' } });
  assert.equal(ev.url, 'https://acme.com/blog/post?utm_source=newsletter&x=1');
  assert.deepEqual(ev.utm, { source: 'newsletter' });
  assert.ok(!ev.url.includes('mc_') && !JSON.stringify(s.env.calls).includes('camp9'));
  // the stripped url is also what the next SPA pageview reports as referrer
  history.pushState({}, '', '/pricing');
  await c.flush();
  assert.equal(s.events()[1].referrer, 'https://acme.com/blog/post?utm_source=newsletter&x=1');
  c.stop();
});

test('ESP: never sent without consent (test_esp_params_only_with_consent)', async () => {
  const s = setup({ href: 'https://acme.com/p?_hsenc=p2ANq&_hsmi=55&utm_medium=email' });
  const c = s.make({ consent: false });
  await c.flush();
  const ev = s.events()[0];
  assert.equal(ev.props, undefined);
  assert.equal(ev.url, 'https://acme.com/p');
  assert.ok(!JSON.stringify(s.env.calls).includes('p2ANq'));
  c.setConsent(true); c.pageview(); await c.flush();
  assert.deepEqual(s.events()[1].props, { espToken: { provider: 'hubspot', token: 'p2ANq' } });
  assert.equal(s.events()[1].url, 'https://acme.com/p?utm_medium=email');
  c.stop();
});

test('ESP: every provider param is recognised; utm_medium=email alone is provider "email"', async () => {
  const cases = [['_kx=K1', 'klaviyo', 'K1'], ['vgo_ee=V1', 'activecampaign', 'V1'], ['_cio_id=C1', 'customerio', 'C1'],
                 ['mkt_tok=M1', 'marketo', 'M1'], ['utm_medium=email&utm_campaign=q4', 'email', '']];
  for (const [q, provider, token] of cases) {
    const s = setup({ href: 'https://acme.com/p?' + q });
    const c = s.make(); await c.flush();
    assert.deepEqual(s.events()[0].props, { espToken: { provider, token } }, q);
    assert.ok(!s.events()[0].url.includes(token) || !token, q);
    c.stop();
  }
  const s = setup({ href: 'https://acme.com/p?a=1' });
  const c = s.make(); await c.flush();
  assert.equal(s.events()[0].props, undefined);
  c.stop();
});

// ---- Sprint 2: diagnose() + debug panel (ON-3) ----

test('diagnose(): installation diagnostics with a masked key, storage, session and lastSend', async () => {
  const s = setup();
  const c = s.make({ publicKey: 'pk_test_abcdefghijklmnop' });
  let d = c.diagnose();
  assert.equal(d.loaded, true);
  assert.equal(d.sdkVersion, '1.0.0');
  assert.equal(d.publicKey, 'pk_test_ab…op');
  assert.ok(!JSON.stringify(d).includes('abcdefghijklmnop'));
  assert.equal(d.website, 'acme.com');
  assert.equal(d.endpoint, ENDPOINT);
  assert.equal(d.consent, true);
  assert.equal(d.consentSource, 'config');
  assert.equal(d.cmpDetected, null);
  assert.equal(d.storage, 'localStorage');
  assert.equal(d.gpc, false);
  assert.equal(d.cspBlocked, false);
  assert.match(d.sessionId, /^rvs_/);
  assert.equal(d.visitorId, 'vst_abc');
  assert.equal(d.queued, 1);
  assert.equal(d.lastSend, null);
  await c.flush();
  d = c.diagnose();
  assert.equal(d.queued, 0);
  assert.deepEqual(d.lastSend, { at: new Date(s.env.now).toISOString(), status: 202, accepted: 1, error: null });
  s.env.status = 403; c.pageview(); await c.flush();
  assert.deepEqual(c.diagnose().lastSend, { at: new Date(s.env.now).toISOString(), status: 403, accepted: 0, error: 'http 403' });
  c.stop();
  assert.equal(c.diagnose().loaded, false);
});

test('diagnose(): storage blocked, visitorId hidden without consent, GPC reported', async () => {
  const s = setup(); s.env.storageThrows = true;
  const c = s.make({ consent: false });
  const d = c.diagnose();
  assert.equal(d.storage, 'blocked');
  assert.equal(d.visitorId, null);
  assert.equal(d.consent, false);
  c.stop();
  const s2 = setup(); navigator.globalPrivacyControl = true;
  const c2 = s2.make();
  assert.equal(c2.diagnose().gpc, true);
  assert.equal(c2.diagnose().consentSource, 'gpc');
  c2.stop();
});

test('diagnose(): cspBlocked from the first fetch TypeError and from securitypolicyviolation; cleared by a response', async () => {
  const s = setup();
  const c = s.make();
  s.env.fail = 2;                                   // first send + its retry both fail: nothing ever answered
  await c.flush();
  assert.equal(c.diagnose().cspBlocked, true);
  assert.equal(c.diagnose().lastSend.status, null);
  assert.equal(c.diagnose().lastSend.error, 'Failed to fetch');
  c.pageview(); await c.flush();                    // a real response clears it
  assert.equal(c.diagnose().cspBlocked, false);
  s.env.fail = 2; c.pageview(); await c.flush();     // later network errors are not CSP
  assert.equal(c.diagnose().cspBlocked, false);
  document.emit('securitypolicyviolation', { blockedURI: 'https://other.example' });
  assert.equal(c.diagnose().cspBlocked, false);
  document.emit('securitypolicyviolation', { blockedURI: ENDPOINT, violatedDirective: 'connect-src' });
  assert.equal(c.diagnose().cspBlocked, true);
  c.stop();
});

test('?prynt_debug=1 (or debug:true) mounts the fixed panel, re-renders on a tick, removed by stop()', async () => {
  const s = setup({ href: 'https://acme.com/p?prynt_debug=1' });
  const c = s.make();
  assert.equal(s.env.mounted.length, 1);
  const el = s.env.mounted[0];
  assert.equal(el.id, 'prynt-debug');
  assert.match(el.style.cssText, /position:fixed/);
  assert.match(el.innerHTML, /Prynt Reveal 1\.0\.0/);
  for (const k of ['loaded', 'key', 'website', 'consent', 'cmp', 'storage', 'gpc', 'cspBlocked', 'lastSend']) assert.ok(el.innerHTML.includes(k), k);
  assert.match(el.innerHTML, /pk_test_x/);
  assert.match(el.innerHTML, /none yet/);
  assert.match(el.innerHTML, /docs\/reveal\/csp-and-storage/);
  await c.flush(); s.tick();
  assert.match(el.innerHTML, /202 · 1 ok/);
  c.stop();
  assert.equal(s.env.mounted.length, 0);
  const s2 = setup();
  const c2 = s2.make({ debug: true });
  assert.equal(s2.env.mounted.length, 1);
  c2.stop();
  const s3 = setup();
  const c3 = s3.make();
  assert.equal(s3.env.mounted.length, 0);
  c3.stop();
});

// ---- Sprint 2: Form Shield + identify (FP-6), bot hint ----

const mkForm = (id, extraInputs = []) => ({
  id, name: '',
  matches: (sel) => sel === '#' + id,
  querySelectorAll: () => [{ type: 'email', name: 'email', id: '', autocomplete: '', value: 'ann@acme.com' }, ...extraInputs],
  querySelector: (sel) => (sel.includes('pr_hp_') ? extraInputs.find((i) => /^pr_hp_/.test(i.name)) || null : null),
});

test('forms as an object: selectors + requireConsent (default true)', async () => {
  const s = setup();
  const c = s.make({ forms: { selectors: ['#lead'] }, consent: false });
  document.emit('submit', { target: mkForm('lead') });
  await c.flush();
  assert.equal(s.events().filter((e) => e.kind === 'form').length, 0);     // consent required
  c.setConsent(true);
  document.emit('submit', { target: mkForm('other') });                    // not selected
  document.emit('submit', { target: mkForm('lead') });
  await c.flush();
  const forms = s.events().filter((e) => e.kind === 'form');
  assert.equal(forms.length, 1);
  assert.equal(forms[0].identity.formId, 'lead');
  assert.equal(forms[0].shielded, false);
  assert.equal(forms[0].consentRef, undefined);
  c.stop();
});

test('forms requireConsent:false — the submission is the consent: sent as consent:true with consentRef, pageviews stay minimal', async () => {
  const s = setup();
  const c = s.make({ forms: { requireConsent: false }, consent: false });
  await c.flush();
  assert.equal(s.env.calls[0].body.consent, false);
  document.emit('submit', { target: mkForm('demo') });
  await c.flush();
  const req = s.env.calls.find((x) => x.body.events.some((e) => e.kind === 'form'));
  assert.equal(req.body.consent, true);
  assert.equal(req.body.visitorId, 'vst_abc');
  const ev = req.body.events[0];
  assert.deepEqual(ev.identity, { email: 'ann@acme.com', formId: 'demo' });
  assert.equal(ev.consentRef, 'demo');
  c.track('x'); c.pageview(); await c.flush();                              // nothing else is unlocked
  assert.equal(s.events().filter((e) => e.kind === 'custom').length, 0);
  assert.ok(s.env.calls.filter((x) => x.body.consent === true).every((x) => x.body.events.every((e) => e.kind === 'form')));
  c.stop();
});

test('shielded:true when protectForm() marked the form or injected its honeypot; re-submit within 2 s counted once', async () => {
  const s = setup();
  const c = s.make({ forms: true });
  const marked = mkForm('a'); markShielded(marked);
  const hp = mkForm('b', [{ type: 'text', name: 'pr_hp_k3', id: '', autocomplete: '', value: '' }]);
  const plain = mkForm('c');
  document.emit('submit', { target: marked });
  document.emit('submit', { target: marked });                              // autoGuard re-submit, same instant
  document.emit('submit', { target: hp });
  document.emit('submit', { target: plain });
  s.env.now += 3000;
  document.emit('submit', { target: marked });                              // a later, real second submit
  await c.flush();
  const forms = s.events().filter((e) => e.kind === 'form');
  assert.deepEqual(forms.map((e) => e.identity.formId + ':' + e.shielded), ['a:true', 'b:true', 'c:false', 'a:true']);
  c.stop();
});

test('botHint: compact UA list + navigator.webdriver; sent only when true', async () => {
  const yes = ['Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)', 'Mozilla/5.0 HeadlessChrome/120.0',
               'python-requests/2.31', 'curl/8.4.0', 'Slackbot-LinkExpanding 1.0', 'GPTBot/1.0', 'Mozilla/5.0 (compatible; SemrushBot/7)',
               'facebookexternalhit/1.1', 'Chrome-Lighthouse', 'Mozilla/5.0 (compatible; AhrefsBot/7.0)', 'PerplexityBot', 'UptimeRobot/2.0'];
  const no = ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
              'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
              'Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0',
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0'];
  for (const ua of yes) { setup({ ua }); assert.equal(botHint(), true, ua); }
  for (const ua of no) { setup({ ua }); assert.equal(botHint(), false, ua); }
  setup({ ua: no[0] }); navigator.webdriver = true; assert.equal(botHint(), true);
  const s = setup({ ua: yes[0] });
  const c = s.make(); await c.flush();
  assert.equal(s.env.calls[0].body.botHint, true);
  c.stop();
  const s2 = setup({ ua: no[0] });
  const c2 = s2.make(); await c2.flush();
  assert.equal('botHint' in s2.env.calls[0].body, false);
  c2.stop();
});

test('SPA same-URL check uses the raw href, so encoded queries do not duplicate pageviews', async () => {
  const s = setup({ href: 'https://acme.com/search?q=a%20b' });
  const c = s.make();
  await c.flush();
  history.pushState({}, '', '/search?q=a%20b');
  await c.flush();
  assert.equal(s.events().length, 1);
  c.stop();
});

// ---- signed email-link token `pid` (S3-W2-T3, FP-3) -------------------------------------------
const PID = 'djEuMS4xLWFiY2RlZjAxMjM0NTY3ODlhYmNkLmVtYWlsLjE3OTk5OTk5OTkuYWJjZGVmZ2gxMg.' + 'A'.repeat(43);
const withPid = (q = `pid=${PID}&utm_source=nl`) => `https://www.acme.com/pricing?${q}`;
const removable = (s) => { localStorage.removeItem = (k) => { delete s.env.store[k]; }; return s; };

test('pid: read after consent, stripped from the url, sent as body.pid on consented batches', async () => {
  const s = setup({ href: withPid() });
  const c = s.make();
  c.track('x');
  await c.flush();
  const body = s.env.calls[0].body;
  assert.equal(body.pid, PID);
  assert.equal(body.events[0].url, 'https://www.acme.com/pricing?utm_source=nl');
  assert.ok(!JSON.stringify(body.events).includes(PID));
  assert.equal(s.env.store.prynt_pid, undefined);              // not stored without store:true
  c.stop();
});

test('pid: never read without consent, nor under GPC (which also deletes a stored one)', async () => {
  const s = setup({ href: withPid() });
  const c = s.make({ consent: false });
  await c.flush();
  assert.equal(s.env.calls[0].body.pid, undefined);
  assert.ok(!JSON.stringify(s.env.calls[0].body).includes(PID));
  c.stop();
  const g = removable(setup({ href: withPid() }));
  g.env.store.prynt_pid = PID;
  navigator.globalPrivacyControl = true;
  const c2 = g.make({ consent: true, pid: { store: true } });
  await c2.flush();
  assert.equal(g.env.calls[0].body.consent, false);
  assert.equal(g.env.calls[0].body.pid, undefined);
  assert.equal(g.env.store.prynt_pid, undefined);
  c2.stop();
});

test('pid: store:true persists prynt_pid and reuses it on a later page without the param', async () => {
  const s = setup({ href: withPid() });
  const c = s.make({ pid: { store: true } });
  await c.flush();
  assert.equal(s.env.store.prynt_pid, PID);
  c.stop();
  const s2 = setup({ href: 'https://www.acme.com/docs' });
  s2.env.store.prynt_pid = PID;
  const c2 = s2.make({ pid: { store: true } });
  await c2.flush();
  assert.equal(s2.env.calls[0].body.pid, PID);
  c2.stop();
  const s3 = setup({ href: 'https://www.acme.com/docs' });
  s3.env.store.prynt_pid = PID;
  const c3 = s3.make();                                        // store not enabled: storage is not read
  await c3.flush();
  assert.equal(s3.env.calls[0].body.pid, undefined);
  c3.stop();
});

test('pid: custom param name; a non-token value (product id) is left in the url', async () => {
  const s = setup({ href: withPid(`ref=${PID}&pid=SKU-123`) });
  const c = s.make({ pid: { param: 'ref' } });
  await c.flush();
  assert.equal(s.env.calls[0].body.pid, PID);
  assert.equal(s.env.calls[0].body.events[0].url, 'https://www.acme.com/pricing?pid=SKU-123');
  c.stop();
  const s2 = setup({ href: withPid('pid=SKU-123') });
  const c2 = s2.make();
  await c2.flush();
  assert.equal(s2.env.calls[0].body.pid, undefined);
  assert.equal(s2.env.calls[0].body.events[0].url, 'https://www.acme.com/pricing?pid=SKU-123');
  c2.stop();
});

test('pid: pid:false disables reading entirely', async () => {
  const s = setup({ href: withPid() });
  const c = s.make({ pid: false });
  await c.flush();
  assert.equal(s.env.calls[0].body.pid, undefined);
  c.stop();
});

test('pid: consent granted later reads the pid from the current url; setConsent(false) deletes it', async () => {
  const s = removable(setup({ href: withPid() }));
  const c = s.make({ consent: false, pid: { store: true } });
  await c.flush();
  assert.equal(s.env.calls[0].body.pid, undefined);
  c.setConsent(true);
  c.track('later');
  await c.flush();
  const full = s.env.calls.filter((x) => x.body.consent === true);
  assert.equal(full[0].body.pid, PID);
  assert.equal(s.env.store.prynt_pid, PID);
  c.setConsent(false);
  assert.equal(s.env.store.prynt_pid, undefined);
  c.pageview();
  await c.flush();
  assert.equal(s.env.calls.at(-1).body.pid, undefined);
  c.stop();
});
