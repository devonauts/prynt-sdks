// End-to-end over stdio with the built binary: startup validation and the MCP handshake.
// No tool is called, so nothing leaves the machine.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const BIN = fileURLToPath(new URL('../dist/index.js', import.meta.url));

function run(env, input) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN], { env: { PATH: process.env.PATH, ...env } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      stdout += d;
      if (input && stdout.includes('"id":2')) child.stdin.end();
    });
    child.stderr.on('data', (d) => { stderr += d; });
    const timer = setTimeout(() => child.kill(), 10_000);
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    if (input) child.stdin.write(input); else child.stdin.end();
  });
}

test('exits 1 with a clear message when the key is missing', async () => {
  const { code, stdout, stderr } = await run({});
  assert.equal(code, 1);
  assert.match(stderr, /PRYNT_SECRET_KEY is not set/);
  assert.equal(stdout, '');
});

test('answers initialize and tools/list over stdio', async () => {
  const SK = 'sk_test_Zz11Yy22Xx33Ww44';
  const msgs = [
    { jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
  ];
  const { stdout, stderr } = await run({ PRYNT_SECRET_KEY: SK }, msgs.map((m) => JSON.stringify(m)).join('\n') + '\n');
  const lines = stdout.trim().split('\n').map((l) => JSON.parse(l));
  const init = lines.find((l) => l.id === 1);
  assert.equal(init.result.serverInfo.name, 'prynt');
  const list = lines.find((l) => l.id === 2);
  assert.equal(list.result.tools.length, 10);
  assert.ok(!stdout.includes(SK));
  assert.ok(!stderr.includes(SK));
  assert.match(stderr, /ready \(endpoint https:\/\/api\.pryntid\.com\)/);
});
