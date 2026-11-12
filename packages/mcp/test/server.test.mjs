// Drives the built server through a real MCP client over an in-memory transport. The HTTP
// layer is a fake fetch: no network, no real keys.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createPryntMcpServer, GUIDE_URI, OUTCOME_LABELS } from '../dist/server.js';

const SK = 'sk_test_Ab12Cd34Ef56Gh78Ij90Kl12Mn34';
const ENDPOINT = 'https://api.example.test';

let calls;
let routes;
const outputs = [];

function json(status, body) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) };
}

const fakeFetch = async (url, init) => {
  const call = { url, method: init.method, headers: init.headers, body: init.body ? JSON.parse(init.body) : undefined };
  calls.push(call);
  const handler = routes[`${init.method} ${url.slice(ENDPOINT.length)}`];
  if (!handler) return json(404, { error: { code: 'no_route', message: 'not stubbed' } });
  return handler(call);
};

async function connect(opts = {}) {
  const server = createPryntMcpServer({ secretKey: SK, endpoint: ENDPOINT, fetch: fakeFetch, ...opts });
  const client = new Client({ name: 'test', version: '0.0.0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

async function call(client, name, args = {}) {
  const res = await client.callTool({ name, arguments: args });
  outputs.push(JSON.stringify(res));
  return res;
}

const textOf = (res) => res.content.map((c) => c.text).join('\n');

beforeEach(() => {
  calls = [];
  routes = {};
});

const EVENT = {
  requestId: 'req_abc', visitorId: 'vst_def', environment: 'test', visitorFound: true,
  confidence: { score: 0.97, level: 'high' }, smartSignals: { bot: { result: false } },
  decision: 'allow', riskScore: 4, ip: '203.0.113.7',
  accountsOnDevice: { count: 0, truncated: false, accounts: [] },
};

test('lists exactly the ten tools with honest annotations', async () => {
  const client = await connect();
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, ['prynt_ask_py', 'prynt_get_event', 'prynt_health', 'prynt_integration_guide',
                           'prynt_lookup_ip', 'prynt_replay_issues', 'prynt_replay_session',
                           'prynt_replay_sessions', 'prynt_replay_summarize', 'prynt_report_outcome']);
  for (const t of tools) {
    if (t.name === 'prynt_report_outcome') {
      assert.equal(t.annotations.readOnlyHint, false);
      assert.match(t.description, /WRITES DATA/);
      assert.match(t.description, /SHARED network/);
      assert.match(t.description, /contribution off/);
      assert.deepEqual([...t.inputSchema.properties.label.enum].sort(), [...OUTCOME_LABELS].sort());
    } else {
      assert.equal(t.annotations.readOnlyHint, true, t.name);
    }
    assert.ok(!JSON.stringify(t).includes(SK));
  }
});

test('get_event calls GET /v1/events/{id} with the bearer key', async () => {
  routes['GET /v1/events/req_abc'] = () => json(200, EVENT);
  const client = await connect();
  const res = await call(client, 'prynt_get_event', { requestId: 'req_abc' });
  assert.ok(!res.isError);
  assert.deepEqual(JSON.parse(textOf(res)), EVENT);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${ENDPOINT}/v1/events/req_abc`);
  assert.equal(calls[0].method, 'GET');
  assert.equal(calls[0].headers.Authorization, `Bearer ${SK}`);
  assert.equal(calls[0].body, undefined);
});

test('get_event URL-encodes the requestId', async () => {
  const client = await connect();
  await call(client, 'prynt_get_event', { requestId: '../admin?x=1' });
  assert.equal(calls[0].url, `${ENDPOINT}/v1/events/..%2Fadmin%3Fx%3D1`);
});

test('get_event surfaces a 404 as a tool error', async () => {
  routes['GET /v1/events/req_missing'] = () => json(404, { error: { code: 'not_found', message: 'No such requestId for this tenant' } });
  const client = await connect();
  const res = await call(client, 'prynt_get_event', { requestId: 'req_missing' });
  assert.equal(res.isError, true);
  assert.match(textOf(res), /HTTP 404, not_found\): No such requestId for this tenant/);
});

test('a 401 explains the key problem without echoing the key', async () => {
  routes['GET /v1/events/req_abc'] = () => json(401, { error: { code: 'invalid_key', message: 'Unknown or disabled secret key' } });
  const client = await connect();
  const res = await call(client, 'prynt_get_event', { requestId: 'req_abc' });
  assert.equal(res.isError, true);
  assert.match(textOf(res), /invalid_key/);
  assert.match(textOf(res), /PRYNT_SECRET_KEY/);
  assert.ok(!textOf(res).includes(SK));
});

test('the key is redacted even if the upstream echoes it', async () => {
  routes['GET /v1/events/req_abc'] = () => json(200, { ...EVENT, debug: `auth was Bearer ${SK}` });
  routes['POST /v1/ip'] = () => json(500, { error: { code: 'boom', message: `bad key ${SK}` } });
  const client = await connect();
  const ok = await call(client, 'prynt_get_event', { requestId: 'req_abc' });
  assert.match(textOf(ok), /Bearer \[redacted\]/);
  const bad = await call(client, 'prynt_lookup_ip', { ip: '198.51.100.1' });
  assert.equal(bad.isError, true);
  assert.match(textOf(bad), /bad key \[redacted\]/);
});

test('network failures and non-JSON bodies become tool errors', async () => {
  const client = await connect({ fetch: async () => { throw new Error('getaddrinfo ENOTFOUND'); } });
  const res = await call(client, 'prynt_health');
  assert.equal(res.isError, true);
  assert.match(textOf(res), /network_error/);

  routes['GET /v1/events/req_abc'] = () => ({ ok: true, status: 200, text: async () => '<html>proxy</html>' });
  const client2 = await connect();
  const res2 = await call(client2, 'prynt_get_event', { requestId: 'req_abc' });
  assert.equal(res2.isError, true);
  assert.match(textOf(res2), /non-JSON/);
});

test('lookup_ip POSTs { ip } to /v1/ip', async () => {
  const intel = { ip: '198.51.100.1', version: 4, isPrivate: false, country: 'US', asn: 64500,
                  asnOrg: 'Example', asnType: 'hosting', datacenter: true, vpn: false, tor: false,
                  proxy: false, reputation: null };
  routes['POST /v1/ip'] = () => json(200, intel);
  const client = await connect();
  const res = await call(client, 'prynt_lookup_ip', { ip: ' 198.51.100.1 ' });
  assert.ok(!res.isError);
  assert.deepEqual(JSON.parse(textOf(res)), intel);
  assert.deepEqual(calls[0].body, { ip: '198.51.100.1' });
  assert.equal(calls[0].headers['Content-Type'], 'application/json');
  assert.equal(calls[0].headers.Authorization, `Bearer ${SK}`);
});

test('health sends no key and reports a 503 body as data', async () => {
  const body = { status: 'down', service: 'prynt-ingest', components: { database: { status: 'down' } } };
  routes['GET /v1/health'] = () => json(503, body);
  const client = await connect();
  const res = await call(client, 'prynt_health');
  assert.ok(!res.isError);
  assert.deepEqual(JSON.parse(textOf(res)), { httpStatus: 503, ...body });
  assert.equal(calls[0].headers.Authorization, undefined);
});

test('report_outcome requires a target and makes no call without one', async () => {
  const client = await connect();
  const res = await call(client, 'prynt_report_outcome', { label: 'fraud' });
  assert.equal(res.isError, true);
  assert.match(textOf(res), /requestId, visitorId or linkedId/);
  assert.equal(calls.length, 0);
});

test('report_outcome rejects unknown labels before calling the API', async () => {
  const client = await connect();
  let rejected = false;
  try {
    const res = await call(client, 'prynt_report_outcome', { label: 'suspicious', requestId: 'req_abc' });
    rejected = res.isError === true;
  } catch {
    rejected = true;
  }
  assert.ok(rejected);
  assert.equal(calls.length, 0);
});

test('report_outcome POSTs only the provided fields to /v1/outcomes', async () => {
  routes['POST /v1/outcomes'] = (c) => json(200, { recorded: true, label: c.body.label });
  const client = await connect();
  const res = await call(client, 'prynt_report_outcome', { label: 'chargeback', requestId: 'req_abc', notes: 'disputed order 42' });
  assert.ok(!res.isError);
  assert.deepEqual(JSON.parse(textOf(res)), { recorded: true, label: 'chargeback' });
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].url, `${ENDPOINT}/v1/outcomes`);
  assert.deepEqual(calls[0].body, { label: 'chargeback', requestId: 'req_abc', notes: 'disputed order 42' });
});

test('the integration guide is a tool and a resource, with no API call', async () => {
  const client = await connect();
  const res = await call(client, 'prynt_integration_guide');
  const text = textOf(res);
  for (const needle of ['/cdn/prynt.umd.js', 'prynt.identify(', '/v1/events/', 'Authorization: Bearer $PRYNT_SECRET_KEY']) {
    assert.ok(text.includes(needle), needle);
  }
  const { resources } = await client.listResources();
  assert.deepEqual(resources.map((r) => r.uri), [GUIDE_URI]);
  const read = await client.readResource({ uri: GUIDE_URI });
  assert.equal(read.contents[0].text, text);
  assert.equal(calls.length, 0);
});

test('no tool output in this suite contained the secret key', () => {
  assert.ok(outputs.length > 5);
  for (const o of outputs) assert.ok(!o.includes(SK));
});


test('replay tools call the /v1/replay routes with the bearer key', async () => {
  routes['GET /v1/replay/sessions?website=acme.com&hasErrors=1&minFrustration=40'] = () => json(200, { recordings: [{ id: 7 }], total: 1 });
  routes['GET /v1/replay/sessions/7'] = () => json(200, { id: 7, signals: [] });
  routes['POST /v1/replay/sessions/7/summary'] = () => json(200, { headline: 'Paid on the third try' });
  routes['GET /v1/replay/issues?days=14&goalPath=%2Fthanks'] = () => json(200, { issues: [] });
  routes['POST /v1/replay/ask?website=acme.com'] = (c) => json(200, { answer: `ok: ${c.body.question}` });
  const client = await connect();
  assert.match(textOf(await call(client, 'prynt_replay_sessions', { website: 'acme.com', hasErrors: true, minFrustration: 40 })), /"total": 1/);
  assert.match(textOf(await call(client, 'prynt_replay_session', { id: 7 })), /"id": 7/);
  assert.match(textOf(await call(client, 'prynt_replay_summarize', { id: 7 })), /third try/);
  assert.ok(!(await call(client, 'prynt_replay_issues', { days: 14, goalPath: '/thanks' })).isError);
  assert.match(textOf(await call(client, 'prynt_ask_py', { question: 'Why do people leave?', website: 'acme.com' })), /Why do people leave/);
  for (const c of calls) assert.equal(c.headers.Authorization, `Bearer ${SK}`);
});
