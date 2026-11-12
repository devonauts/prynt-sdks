/**
 * Prynt Node server SDK. Verify a browser identification from your backend using your
 * SECRET key — never trust the browser's response body alone.
 *
 *   import { PryntServer } from '@pryntid/node';
 *   const prynt = new PryntServer({ secretKey: process.env.PRYNT_SECRET_KEY });
 *   const event = await prynt.getEvent(requestId);
 *   if (event.smartSignals?.bot?.result) blockRequest();
 *   if (event.accountsOnDevice.count > 0) reviewSignup();     // multi-accounting
 *   await prynt.updateEvent(requestId, { linkedId: newUser.id }); // after the account exists
 */
import { createDecipheriv, createHmac, timingSafeEqual } from 'node:crypto';

export const DEFAULT_ENDPOINT = 'https://api.pryntid.com';
/** This SDK's version, sent as User-Agent / X-Prynt-SDK so Prynt can tell which SDKs an account runs. */
export const SDK_VERSION = '1.0.0';

export interface PryntServerConfig {
  secretKey: string;
  endpoint?: string;      // default https://api.pryntid.com (Prynt Cloud); self-hosted: your API base URL
  timeoutMs?: number;     // default 5000
}

export interface Confidence { score: number; level: 'low' | 'medium' | 'high'; }
export interface SmartSignal { result: boolean; [k: string]: unknown; }

/** One of your accounts (a linkedId) seen on the device. */
export interface AccountOnDevice {
  linkedId: string;
  /** Identifications on this device carrying this linkedId. */
  events: number;
  firstSeenAt: string | null;
  lastSeenAt: string | null;
}

/**
 * Every linkedId (your own account id) ever seen on the event's device, newest first.
 * The one-call answer to "does this device already have other accounts?" at signup.
 */
export interface AccountsOnDevice {
  /** Accounts listed (at most 20). */
  count: number;
  /** True when the device has more accounts than were listed. */
  truncated: boolean;
  accounts: AccountOnDevice[];
}

/** The visitor (device) behind an event. */
export interface PryntVisitor {
  visitorId: string;
  environment: string;
  firstSeenAt: string | null;
  lastSeenAt: string | null;
  seenCount: number;
  linkedId: string | null;
  lastConfidence: number | null;
}

export interface PryntEvent {
  requestId: string;
  visitorId: string;
  visitorFound: boolean;
  environment: string;
  confidence: Confidence;
  smartSignals: Record<string, SmartSignal>;
  /** Verdict of your rules: allow | challenge | block. */
  decision?: 'allow' | 'challenge' | 'block' | null;
  /** 0–100. */
  riskScore?: number | null;
  /** Behavioral risk breakdown and reasons. */
  risk?: Record<string, unknown>;
  ip?: string;
  ipLocation?: { country?: string | null; city?: string | null };
  url?: string | null;
  referrer?: string | null;
  userAgent?: string | null;
  fingerprint?: string | null;
  tag?: Record<string, unknown> | null;
  linkedId?: string | null;
  createdAt?: string | null;
  matchedSignals?: Record<string, number>;
  visitor?: PryntVisitor;
  accountsOnDevice: AccountsOnDevice;
}

/** Body of updateEvent(): the account to attach to an identification. */
export interface UpdateEventParams {
  /** Your own account/user id (1–190 chars). */
  linkedId: string;
}

export interface UpdateEventResult {
  requestId: string;
  visitorId: string;
  linkedId: string;
  /** The device's accounts, now including linkedId. */
  accountsOnDevice: AccountsOnDevice;
}

/** The plaintext behind a sealed result (the full identification record). */
export interface PryntSealedResult {
  requestId: string;
  visitorId: string;
  visitorFound: boolean;
  confidence: Confidence;
  smartSignals?: Record<string, SmartSignal>;
  environment?: string;
  [k: string]: unknown;
}

/**
 * Decrypt a sealed identification result on YOUR server with your sealing key.
 * Wire format: base64( nonce[12] || ciphertext || tag[16] ), AES-256-GCM. The browser and
 * Prynt never see the plaintext — only the holder of the sealing key can open it.
 *
 *   import { unsealResult } from '@pryntid/node';
 *   const result = unsealResult(req.body.sealedResult, process.env.PRYNT_SEALING_KEY);
 */
export function unsealResult<T = PryntSealedResult>(sealed: string, sealingKeyBase64: string): T {
  const key = Buffer.from(sealingKeyBase64, 'base64');
  if (key.length !== 32) throw new Error('[Prynt] sealing key must decode to 32 bytes');
  const blob = Buffer.from(sealed, 'base64');
  if (blob.length < 12 + 16) throw new Error('[Prynt] malformed sealed result');
  const nonce = blob.subarray(0, 12);
  const tag = blob.subarray(blob.length - 16);
  const ciphertext = blob.subarray(12, blob.length - 16);
  const decipher = createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return JSON.parse(plaintext.toString('utf8')) as T;
}

/**
 * Verify a Prynt webhook signature. Prynt signs each delivery as
 *   X-Prynt-Signature: sha256=<hex of HMAC_SHA256(secret, `${timestamp}.${rawBody}`)>
 * with the timestamp in X-Prynt-Timestamp. Pass the RAW request body (bytes/string), not a
 * re-serialized object. Optionally reject deliveries older than toleranceSec (default 300s).
 */
export function verifyWebhook(
  rawBody: string | Buffer,
  signatureHeader: string,
  timestamp: string,
  secret: string,
  toleranceSec = 300,
): boolean {
  if (!signatureHeader || !timestamp || !secret) return false;
  const provided = signatureHeader.startsWith('sha256=') ? signatureHeader.slice(7) : signatureHeader;
  if (toleranceSec > 0) {
    const age = Math.abs(Date.now() / 1000 - Number(timestamp));
    if (!Number.isFinite(age) || age > toleranceSec) return false;
  }
  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody, 'utf8');
  const mac = createHmac('sha256', secret).update(`${timestamp}.`).update(body).digest('hex');
  const a = Buffer.from(mac);
  const b = Buffer.from(provided);
  return a.length === b.length && timingSafeEqual(a, b);
}

export class PryntError extends Error {
  status: number;
  code: string;
  constructor(message: string, status: number, code: string) {
    super(message);
    this.name = 'PryntError';
    this.status = status;
    this.code = code;
  }
}

export class PryntServer {
  private secretKey: string;
  private endpoint: string;
  private timeoutMs: number;

  constructor(config: PryntServerConfig) {
    if (!config?.secretKey) throw new Error('[Prynt] secretKey is required');
    if (!/^sk_/.test(config.secretKey)) throw new Error('[Prynt] secretKey must start with sk_');
    this.secretKey = config.secretKey;
    this.endpoint = (config.endpoint || DEFAULT_ENDPOINT).replace(/\/$/, '');
    this.timeoutMs = config.timeoutMs ?? 5000;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), this.timeoutMs);
    let res: Response;
    try {
      const headers: Record<string, string> = { Authorization: `Bearer ${this.secretKey}`,
        'User-Agent': `prynt-node/${SDK_VERSION}`, 'X-Prynt-SDK': `node/${SDK_VERSION}` };
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      res = await fetch(`${this.endpoint}${path}`, {
        method, headers, signal: ctrl.signal,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (e) {
      const aborted = (e as Error)?.name === 'AbortError';
      throw new PryntError(aborted ? `Request timed out after ${this.timeoutMs}ms`
                                   : `Network error: ${(e as Error)?.message || e}`,
                           0, aborted ? 'timeout' : 'network_error');
    } finally { clearTimeout(to); }
    const data: any = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = data?.error || {};
      throw new PryntError(err.message || `Request failed (${res.status})`, res.status, err.code || 'error');
    }
    return data as T;
  }

  /**
   * Fetch the authoritative server-side record for a requestId, including
   * `accountsOnDevice` (every linkedId seen on this device).
   */
  async getEvent(requestId: string): Promise<PryntEvent> {
    if (!requestId) throw new Error('[Prynt] requestId is required');
    return this.request<PryntEvent>('GET', `/v1/events/${encodeURIComponent(requestId)}`);
  }

  /**
   * Attach your account id to an identification after the fact — typically right after signup,
   * when the browser identified before the user id existed. From then on, the device's
   * `accountsOnDevice` includes it.
   */
  async updateEvent(requestId: string, params: UpdateEventParams): Promise<UpdateEventResult> {
    if (!requestId) throw new Error('[Prynt] requestId is required');
    const linkedId = params?.linkedId;
    if (typeof linkedId !== 'string' || !linkedId.trim()) throw new Error('[Prynt] linkedId is required');
    return this.request<UpdateEventResult>('PUT', `/v1/events/${encodeURIComponent(requestId)}`, { linkedId });
  }

  /** Convenience: true when the identification was flagged as a bot. */
  async isBot(requestId: string): Promise<boolean> {
    const e = await this.getEvent(requestId);
    return !!e.smartSignals?.bot?.result;
  }

  /** Decrypt a sealed result with your sealing key. See the top-level unsealResult(). */
  unsealResult<T = PryntSealedResult>(sealed: string, sealingKeyBase64: string): T {
    return unsealResult<T>(sealed, sealingKeyBase64);
  }

  /** Verify a webhook signature. See the top-level verifyWebhook(). */
  verifyWebhook(rawBody: string | Buffer, signatureHeader: string, timestamp: string,
                secret: string, toleranceSec = 300): boolean {
    return verifyWebhook(rawBody, signatureHeader, timestamp, secret, toleranceSec);
  }
}

export default PryntServer;
