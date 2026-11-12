/**
 * Configuration from the environment. The secret key is validated here and never printed:
 * every error message below describes the problem without echoing the value.
 */
export const DEFAULT_ENDPOINT = 'https://api.pryntid.com';

export interface PryntMcpConfig {
  /** Your Prynt secret key (sk_live_… or sk_test_…). */
  secretKey: string;
  /** API base URL without a trailing slash. */
  endpoint: string;
}

const SECRET_KEY_RE = /^sk_(live|test)_[A-Za-z0-9]+$/;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/** Which environment a key belongs to, from its prefix. */
export function keyEnvironment(secretKey: string): 'live' | 'test' {
  return secretKey.startsWith('sk_test_') ? 'test' : 'live';
}

export function loadConfig(env: Record<string, string | undefined> = process.env): {
  config: PryntMcpConfig;
  warnings: string[];
} {
  const warnings: string[] = [];
  const secretKey = (env.PRYNT_SECRET_KEY ?? '').trim();
  if (!secretKey) {
    throw new ConfigError('PRYNT_SECRET_KEY is not set. Use a secret key from the Prynt console (sk_test_… to try it).');
  }
  if (secretKey.startsWith('pk_')) {
    throw new ConfigError('PRYNT_SECRET_KEY holds a public key (pk_…). The server API needs a secret key (sk_live_… or sk_test_…).');
  }
  if (!SECRET_KEY_RE.test(secretKey)) {
    throw new ConfigError('PRYNT_SECRET_KEY is not a valid Prynt secret key (expected sk_live_… or sk_test_…).');
  }

  const rawEndpoint = (env.PRYNT_ENDPOINT ?? '').trim() || DEFAULT_ENDPOINT;
  let url: URL;
  try {
    url = new URL(rawEndpoint);
  } catch {
    throw new ConfigError('PRYNT_ENDPOINT is not a valid URL (example: https://api.pryntid.com).');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new ConfigError('PRYNT_ENDPOINT must be an http(s) URL.');
  }
  if (url.username || url.password) {
    throw new ConfigError('PRYNT_ENDPOINT must not contain credentials.');
  }
  if (url.protocol === 'http:' && !LOCAL_HOSTS.has(url.hostname)) {
    warnings.push('PRYNT_ENDPOINT uses plain http: the secret key travels unencrypted. Use https outside local development.');
  }
  const endpoint = (url.origin + url.pathname).replace(/\/+$/, '');
  return { config: { secretKey, endpoint }, warnings };
}
