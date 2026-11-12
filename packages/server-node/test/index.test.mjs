// Runs against the built dist/ (npm test builds first) and a local stub of the Prynt API.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { PryntServer, PryntError, DEFAULT_ENDPOINT } from '../dist/index.mjs';

const SK = 'sk_test_abc';
const ACCOUNTS = { count: 1, truncated: false,
  accounts: [{ linkedId: 'user_1', events: 3, firstSeenAt: '2026-10-01T00:00:00Z', lastSeenAt: '2026-10-02T00:00:00Z' }] };
const calls = [];
let server; let base;

before(async () => {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      calls.push({ method: req.method, url: req.url, auth: req.headers.authorization,
                   type: req.headers['content-type'], body: raw ? JSON.parse(raw) : undefined });
      const send = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
      if (req.headers.authorization !== `Bearer ${SK}`) return send(401, { error: { code: 'invalid_key', message: 'Unknown or disabled secret key' } });
      if (req.url === '/v1/events/req_missing') return send(404, { error: { code: 'not_found', message: 'No such requestId for this tenant' } });
      if (req.method === 'GET') {
        return send(200, { requestId: 'req_1', visitorId: 'vis_1', visitorFound: true, environment: 'live',
          confidence: { score: 0.99, level: 'high' }, smartSignals: { bot: { result: false } },
          decision: 'allow', riskScore: 3, accountsOnDevice: ACCOUNTS });
      }
      if (req.method === 'PUT') {
        return send(200, { requestId: 'req_1', visitorId: 'vis_1', linkedId: calls.at(-1).body.linkedId,
          accountsOnDevice: { count: 2, truncated: false, accounts: [
            { linkedId: calls.at(-1).body.linkedId, events: 1, firstSeenAt: null, lastSeenAt: null }, ...ACCOUNTS.accounts] } });
      }
      send(405, { error: { code: 'method_not_allowed', message: 'nope' } });
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}/`;   // trailing slash is stripped
});
after(() => server.close());

test('defaults to Prynt Cloud', () => {
  assert.equal(DEFAULT_ENDPOINT, 'https://api.pryntid.com');
  assert.equal(new PryntServer({ secretKey: SK }).endpoint, 'https://api.pryntid.com');
});

test('rejects a non-secret key', () => {
  assert.throws(() => new PryntServer({ secretKey: 'pk_live_x' }), /sk_/);
});

test('getEvent returns accountsOnDevice', async () => {
  const prynt = new PryntServer({ secretKey: SK, endpoint: base });
  const ev = await prynt.getEvent('req_1');
  assert.equal(ev.visitorId, 'vis_1');
  assert.equal(ev.decision, 'allow');
  assert.deepEqual(ev.accountsOnDevice, ACCOUNTS);
  const c = calls.at(-1);
  assert.equal(c.method, 'GET');
  assert.equal(c.url, '/v1/events/req_1');
  assert.equal(c.auth, `Bearer ${SK}`);
});

test('updateEvent PUTs the linkedId', async () => {
  const prynt = new PryntServer({ secretKey: SK, endpoint: base });
  const r = await prynt.updateEvent('req_1', { linkedId: 'user_2' });
  const c = calls.at(-1);
  assert.equal(c.method, 'PUT');
  assert.equal(c.url, '/v1/events/req_1');
  assert.equal(c.type, 'application/json');
  assert.deepEqual(c.body, { linkedId: 'user_2' });
  assert.equal(r.linkedId, 'user_2');
  assert.equal(r.accountsOnDevice.count, 2);
});

test('updateEvent validates its input before calling the API', async () => {
  const prynt = new PryntServer({ secretKey: SK, endpoint: base });
  const n = calls.length;
  await assert.rejects(prynt.updateEvent('req_1', { linkedId: '  ' }), /linkedId/);
  await assert.rejects(prynt.updateEvent('', { linkedId: 'x' }), /requestId/);
  assert.equal(calls.length, n);
});

test('API errors throw PryntError with status and code', async () => {
  const prynt = new PryntServer({ secretKey: SK, endpoint: base });
  await assert.rejects(prynt.getEvent('req_missing'), (e) =>
    e instanceof PryntError && e.status === 404 && e.code === 'not_found');
  const bad = new PryntServer({ secretKey: 'sk_test_wrong', endpoint: base });
  await assert.rejects(bad.updateEvent('req_1', { linkedId: 'u' }), (e) => e.status === 401 && e.code === 'invalid_key');
});

test('network failures throw PryntError', async () => {
  const prynt = new PryntServer({ secretKey: SK, endpoint: 'http://127.0.0.1:1' });
  await assert.rejects(prynt.getEvent('req_1'), (e) => e instanceof PryntError && e.code === 'network_error');
});

test('CommonJS build exposes the same API', () => {
  const require = createRequire(import.meta.url);
  const cjs = require('../dist/index.cjs');
  assert.equal(typeof cjs.PryntServer.prototype.updateEvent, 'function');
  assert.equal(typeof cjs.verifyWebhook, 'function');
});
