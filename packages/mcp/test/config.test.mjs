import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, ConfigError, DEFAULT_ENDPOINT } from '../dist/config.js';

const SK = 'sk_test_Ab12Cd34Ef56Gh78Ij90Kl12Mn34';

test('requires PRYNT_SECRET_KEY', () => {
  assert.throws(() => loadConfig({}), (e) => e instanceof ConfigError && /PRYNT_SECRET_KEY is not set/.test(e.message));
  assert.throws(() => loadConfig({ PRYNT_SECRET_KEY: '   ' }), ConfigError);
});

test('rejects a public key without echoing it', () => {
  const pk = 'pk_live_Zz99Yy88Xx77Ww66';
  assert.throws(() => loadConfig({ PRYNT_SECRET_KEY: pk }), (e) => {
    assert.match(e.message, /public key/);
    assert.ok(!e.message.includes(pk));
    return true;
  });
});

test('rejects a malformed secret key without echoing it', () => {
  assert.throws(() => loadConfig({ PRYNT_SECRET_KEY: 'sk_live_' }), ConfigError);
  for (const bad of ['sk_prod_abc123QRS', 'secret123QRS', 'sk_live_abc defQRS']) {
    assert.throws(() => loadConfig({ PRYNT_SECRET_KEY: bad }), (e) => {
      assert.ok(e instanceof ConfigError);
      assert.ok(!e.message.includes(bad));
      return true;
    });
  }
});

test('defaults the endpoint and accepts live and test keys', () => {
  const { config, warnings } = loadConfig({ PRYNT_SECRET_KEY: SK });
  assert.equal(config.endpoint, DEFAULT_ENDPOINT);
  assert.equal(DEFAULT_ENDPOINT, 'https://api.pryntid.com');
  assert.equal(config.secretKey, SK);
  assert.deepEqual(warnings, []);
  assert.equal(loadConfig({ PRYNT_SECRET_KEY: 'sk_live_Q1w2E3r4' }).config.secretKey, 'sk_live_Q1w2E3r4');
});

test('normalizes a custom endpoint', () => {
  const { config } = loadConfig({ PRYNT_SECRET_KEY: SK, PRYNT_ENDPOINT: 'https://prynt.example.com/api/' });
  assert.equal(config.endpoint, 'https://prynt.example.com/api');
});

test('rejects bad endpoints', () => {
  assert.throws(() => loadConfig({ PRYNT_SECRET_KEY: SK, PRYNT_ENDPOINT: 'not a url' }), ConfigError);
  assert.throws(() => loadConfig({ PRYNT_SECRET_KEY: SK, PRYNT_ENDPOINT: 'ftp://x.example.com' }), ConfigError);
  assert.throws(() => loadConfig({ PRYNT_SECRET_KEY: SK, PRYNT_ENDPOINT: 'https://u:p@x.example.com' }), ConfigError);
});

test('warns on plain http outside localhost', () => {
  assert.equal(loadConfig({ PRYNT_SECRET_KEY: SK, PRYNT_ENDPOINT: 'http://localhost:5050' }).warnings.length, 0);
  const { warnings } = loadConfig({ PRYNT_SECRET_KEY: SK, PRYNT_ENDPOINT: 'http://203.0.113.5:5050' });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /unencrypted/);
});
