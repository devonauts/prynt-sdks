import { NativeModules } from 'react-native';

const Native = NativeModules.Prynt as {
  identify(apiKey: string, endpoint: string, tag: object | null, linkedId: string | null): Promise<PryntResult>;
  replayStart(publicKey: string, website: string, endpoint: string, maskAllText: boolean, consent: boolean): void;
  replayIdentify(userId: string): void;
  replaySetConsent(given: boolean): void;
  replayStop(): void;
} | undefined;

export interface PryntConfidence { score: number; level: 'low' | 'medium' | 'high'; }
export interface PryntResult {
  requestId: string;
  visitorId: string;
  visitorFound: boolean;
  confidence: PryntConfidence;
}

/**
 * Prynt React Native SDK. Bridges to the native iOS/Android SDKs (device signals, integrity,
 * Keychain/Keystore id, attestation) and resolves identity server-side.
 *
 * ```ts
 * const prynt = new Prynt('pk_live_…', 'https://api.pryntid.com');
 * const { visitorId, confidence } = await prynt.identify();
 * ```
 */
export class Prynt {
  constructor(private readonly apiKey: string, private readonly endpoint = 'https://api.pryntid.com') {
    if (!apiKey.startsWith('pk_')) throw new Error('[Prynt] apiKey must start with pk_');
  }

  identify(opts?: { tag?: Record<string, unknown>; linkedId?: string }): Promise<PryntResult> {
    if (!Native) return Promise.reject(new Error('[Prynt] native module not linked'));
    return Native.identify(this.apiKey, this.endpoint, opts?.tag ?? null, opts?.linkedId ?? null);
  }
}

/**
 * Prynt Replay for React Native: the native recorders (iOS / Android) capture the app as low-rate screenshots with
 * every TextInput (a native field) masked on the device, taps as clicks, and send them to the same Replay console.
 *
 * ```ts
 * PryntReplay.start({ publicKey: 'pk_live_…', website: 'acme.com' });
 * PryntReplay.identify('user_42');
 * ```
 * Mask any other view with `nativeID="prynt-mask"` (iOS accessibilityIdentifier) / `testID="prynt-mask"`.
 */
export const PryntReplay = {
  start(o: { publicKey: string; website: string; endpoint?: string; maskAllText?: boolean; consent?: boolean }): void {
    if (!o.publicKey.startsWith('pk_')) throw new Error('[Prynt] publicKey must start with pk_');
    Native?.replayStart(o.publicKey, o.website, o.endpoint ?? 'https://api.pryntid.com', !!o.maskAllText, o.consent ?? true);
  },
  identify(userId: string): void { if (userId && !userId.includes('@')) Native?.replayIdentify(userId); },
  setConsent(given: boolean): void { Native?.replaySetConsent(given); },
  stop(): void { Native?.replayStop(); },
};

export default Prynt;
