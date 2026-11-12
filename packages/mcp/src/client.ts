/**
 * Minimal HTTP client for the Prynt server API. Auth matches @pryntid/node:
 * `Authorization: Bearer <secret key>`. The fetch implementation is injectable so tests
 * never touch the network.
 */
import type { PryntMcpConfig } from './config.js';
import { SERVER_VERSION } from './version.js';

export type FetchLike = (input: string, init: {
  method: string;
  headers: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export class PryntApiError extends Error {
  status: number;
  code: string;
  constructor(message: string, status: number, code: string) {
    super(message);
    this.name = 'PryntApiError';
    this.status = status;
    this.code = code;
  }
}

export interface ClientOptions extends PryntMcpConfig {
  fetch?: FetchLike;
  timeoutMs?: number;
}

export interface ApiResult<T = unknown> {
  status: number;
  data: T;
}

export class PryntApiClient {
  private readonly secretKey: string;
  private readonly endpoint: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;

  constructor(opts: ClientOptions) {
    this.secretKey = opts.secretKey;
    this.endpoint = opts.endpoint.replace(/\/+$/, '');
    this.fetchImpl = opts.fetch ?? (globalThis.fetch as unknown as FetchLike);
    this.timeoutMs = opts.timeoutMs ?? 10_000;
  }

  /**
   * Call the API. `auth: false` sends no key at all (used for the public health route).
   * `acceptStatuses` lets a caller treat a non-2xx status as a normal answer (health returns
   * 503 with a JSON body when the database is down).
   */
  async request<T = unknown>(method: string, path: string, opts: {
    body?: unknown;
    auth?: boolean;
    acceptStatuses?: number[];
  } = {}): Promise<ApiResult<T>> {
    const headers: Record<string, string> = { Accept: 'application/json',
      'User-Agent': `prynt-mcp/${SERVER_VERSION}`, 'X-Prynt-SDK': `mcp/${SERVER_VERSION}` };
    if (opts.auth !== false) headers.Authorization = `Bearer ${this.secretKey}`;
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    let res: Awaited<ReturnType<FetchLike>>;
    try {
      res = await this.fetchImpl(`${this.endpoint}${path}`, {
        method,
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        signal: ctrl.signal,
      });
    } catch (e) {
      const aborted = (e as Error)?.name === 'AbortError';
      throw new PryntApiError(
        aborted ? `Request to Prynt timed out after ${this.timeoutMs} ms`
                : `Could not reach Prynt at ${this.endpoint}: ${(e as Error)?.message ?? String(e)}`,
        0, aborted ? 'timeout' : 'network_error');
    } finally {
      clearTimeout(timer);
    }

    const raw = await res.text().catch(() => '');
    let data: any = null;
    try {
      data = raw ? JSON.parse(raw) : null;
    } catch {
      data = null;
    }
    if (!res.ok && !(opts.acceptStatuses ?? []).includes(res.status)) {
      const err = data && typeof data === 'object' ? data.error ?? {} : {};
      throw new PryntApiError(
        typeof err.message === 'string' ? err.message : `Request failed with HTTP ${res.status}`,
        res.status,
        typeof err.code === 'string' ? err.code : 'http_error');
    }
    if (data === null) {
      throw new PryntApiError(`Prynt returned a non-JSON response (HTTP ${res.status})`, res.status, 'bad_response');
    }
    return { status: res.status, data: data as T };
  }
}
