import { sha256hex, leadingZeroBits } from './sha256';
import type { ChallengeResult } from './index';

type SdkInfo = { name: string; version: string; channel: string };

// Prynt Challenge client: fetch a risk-adaptive proof-of-work, solve it invisibly, and return a
// passToken your server validates. The self-hostable Turnstile/Arkose alternative.

interface IssuedChallenge { challenge: string; salt: string; difficulty: number }
interface VerifyResult { passed: boolean; passToken?: string }

async function postJson<T>(url: string, body: Record<string, unknown>, timeoutMs: number, sdk?: SdkInfo): Promise<T> {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(sdk ? { ...body, sdk } : body), signal: ctrl.signal,
    });
    return (await res.json()) as T;
  } finally {
    clearTimeout(to);
  }
}

export async function solveChallenge(
  endpoint: string, apiKey: string, timeoutMs: number, requestId?: string, sdk?: SdkInfo,
): Promise<ChallengeResult> {
  const base = endpoint.replace(/\/$/, '');
  const issued = await postJson<IssuedChallenge>(base + '/v1/challenge',
    { publicKey: apiKey, requestId }, timeoutMs, sdk);
  const { salt, difficulty } = issued;
  let nonce = 0;
  for (;;) {
    if (leadingZeroBits(sha256hex(salt + ':' + nonce)) >= difficulty) break;
    nonce++;
    if (nonce > 50_000_000) return { passed: false, passToken: null };   // safety bound
  }
  const verified = await postJson<VerifyResult>(base + '/v1/challenge/verify',
    { publicKey: apiKey, challenge: issued.challenge, nonce: String(nonce) }, timeoutMs, sdk);
  return { passed: !!verified.passed, passToken: verified.passToken ?? null };
}
