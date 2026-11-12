# @pryntid/js

The Prynt browser agent — stable visitor identification & device intelligence. A free,
self-hostable alternative to FingerprintJS Pro. ~10 kB gzipped, zero dependencies.
TypeScript types included.

## Install

```bash
npm install @pryntid/js
```

Or with a `<script>` tag (exposes a global `Prynt`):

```html
<script src="https://cdn.jsdelivr.net/npm/@pryntid/js@1/dist/prynt.umd.js"></script>
<!-- self-hosted Prynt servers also serve it at https://your-prynt-server/cdn/prynt.umd.js -->
```

## Quick start

```js
import Prynt from '@pryntid/js';

const prynt = await Prynt.load({ apiKey: 'pk_live_your_public_key' });
const { requestId, visitorId, confidence } = await prynt.identify();
```

Only the **public** key (`pk_...`) goes in the browser. The agent talks to Prynt Cloud
(`https://api.pryntid.com`) by default; self-hosted installs pass `endpoint: 'https://your-prynt-server'`.

## Stop signup abuse (multi-accounting)

The browser result is a hint, not proof — anything in the browser can be tampered with. Make the
decision on **your server** with your **secret** key (`sk_...`):

**1. Browser** — identify on the signup form and send the `requestId` along with the form:

```js
const { requestId } = await prynt.identify({ tag: { action: 'signup' } });
await fetch('/signup', { method: 'POST', headers: { 'Content-Type': 'application/json' },
                         body: JSON.stringify({ email, password, pryntRequestId: requestId }) });
```

**2. Server** — fetch the authoritative event and check how many accounts this device already has:

```bash
curl https://api.pryntid.com/v1/events/$REQUEST_ID -H "Authorization: Bearer $PRYNT_SECRET_KEY"
```

```jsonc
{
  "requestId": "req_…", "visitorId": "…",
  "decision": "allow",              // allow | challenge | block
  "riskScore": 12,                  // 0–100
  "smartSignals": { "bot": { "result": false }, "vpn": { "result": false }, … },
  "accountsOnDevice": {
    "count": 2,                     // distinct linkedIds seen on this device (max 20 listed)
    "truncated": false,             // true when there are more than 20
    "accounts": [
      { "linkedId": "user_123", "events": 7, "firstSeenAt": "…", "lastSeenAt": "…" }
    ]
  }
}
```

Reject or review the signup when `decision` is `block`, or when `accountsOnDevice.count` is above
your limit (e.g. one free trial per device).

**3. Server, after the account is created** — attach your new user id to that identification so
the next signup from this device sees it in `accountsOnDevice`:

```bash
curl -X PUT https://api.pryntid.com/v1/events/$REQUEST_ID \
  -H "Authorization: Bearer $PRYNT_SECRET_KEY" -H "Content-Type: application/json" \
  -d '{"linkedId": "user_456"}'
```

The server SDKs wrap both calls: `getEvent` / `updateEvent` in
[`@pryntid/node`](https://www.npmjs.com/package/@pryntid/node), `get_event` / `update_event` in the
Python SDK. (If the user is already logged in, pass `linkedId` straight to `identify()` instead.)

## Options — `Prynt.load(config)`

| Option | Type | Default | |
|---|---|---|---|
| `apiKey` | `string` | — (required) | Your public key, `pk_...` |
| `endpoint` | `string` | `https://api.pryntid.com` | API base URL; set it only when self-hosting |
| `timeout` | `number` | `6000` | Request timeout, ms |
| `extendedResult` | `boolean` | `false` | Include Smart Signals in the browser response (plan-gated) |
| `tag` | `object` | — | Key/values stored with every event, e.g. `{ action: 'checkout' }` |
| `linkedId` | `string` | — | Your own user id, when already known |
| `respectGPC` | `boolean` | `true` | Don't identify when Global Privacy Control is on |
| `respectDNT` | `boolean` | `false` | Don't identify when Do Not Track is on |
| `requireConsent` | `boolean` | `false` | Don't identify until `setConsent(true)` |
| `sealedResult` | `boolean` | `false` | Return an encrypted result only your server can open (needs a sealing key) |
| `deterrence` | `boolean` | `false` | Also `console.warn` the security notice returned for flagged visitors |

When identification is withheld (GPC/DNT/no consent) `identify()` resolves with
`consentWithheld: true` and empty ids.

## Methods — the object returned by `Prynt.load()`

- `identify(opts?)` → `Promise<IdentifyResult>`. `opts`: `{ tag?, linkedId?, content?, formSignals? }`
  (per-call values override the ones given to `load`).
- `setConsent(given: boolean)` — record the user's consent for `requireConsent` flows.
- `challenge(requestId?)` → `Promise<{ passed, passToken }>` — solve an invisible proof-of-work;
  validate `passToken` on your server.
- `protectForm(form, opts?)` → `{ signals() }` — invisible honeypot + timing on a form. With
  `{ autoGuard: true }` it intercepts submit, runs `identify()` and blocks bots/spam on its own
  (fails open if Prynt is unreachable). Other options: `honeypotName`, `messageSelector`,
  `expectedScripts`, `challengeAs`, `onVerdict`, `onBlocked`, `onError`.

## `IdentifyResult`

```ts
{
  requestId: string;            // send this to your server
  visitorId: string;            // stable across sessions & cookie clears
  visitorFound: boolean;
  confidence: { score: number; level: 'low' | 'medium' | 'high' };
  ip?: string;
  firstSeenAt?: string; lastSeenAt?: string; seenCount?: number; daysSinceFirstSeen?: number;
  decision?: { decision: 'allow' | 'challenge' | 'block'; suspectScore: number;
               riskScore?: number; reasonCodes?: string[]; tags?: string[] };
  smartSignals?: Record<string, { result: boolean; [k: string]: unknown }>;  // with extendedResult
  reputation?: { status?: string | null; reason?: string | null };
  notice?: { level: 'warning' | 'block' | 'prohibited'; message: string; ref?: string };
  sealedResult?: string;        // sealedResult mode only
  consentWithheld?: boolean;
  fingerprint: string;          // on-device stable hash
}
```

Always verify server-side with your **secret** key: `GET /v1/events/:requestId`.

## Reveal — B2B visitor identification

`Prynt.reveal()` turns anonymous traffic into named companies in the Prynt console: it sends
pageviews, engagement (active time, scroll depth), SPA route changes and optional first-party
identities to `/v1/reveal/collect`, batched and beaconed on unload. Two builds, same public key:

| Build | Script | Global | Size | Use when |
|---|---|---|---|---|
| **Reveal-only** (recommended for Reveal customers) | `https://api.pryntid.com/cdn/prynt-reveal.umd.js` · `import { reveal } from '@pryntid/js/reveal'` | `PryntReveal` | ~14 kB raw / ~6 kB gzip | You only use Reveal |
| Full agent | `https://api.pryntid.com/cdn/prynt.umd.js` · `import Prynt from '@pryntid/js'` | `Prynt` | ~47 kB raw / ~19 kB gzip | You also use `Prynt.load()` / `identify()` — Reveal events then carry the agent's `visitorId` |

The Reveal-only build has no device-intelligence code and does not need `Prynt.load()`; if the
full agent happens to be on the same page (`window.Prynt`) it is detected at runtime and the
`visitorId` is reused. Both expose the same `reveal(options)` and `version`.

```html
<script src="https://api.pryntid.com/cdn/prynt-reveal.umd.js" async
  onload="PryntReveal.reveal({publicKey:'pk_live_your_public_key',website:'example.com'})"></script>
```

```js
import { reveal as pryntReveal } from '@pryntid/js/reveal';   // or: import Prynt from '@pryntid/js'; Prynt.reveal(...)
const reveal = pryntReveal({ publicKey: 'pk_live_…', forms: ['#demo-form'], consent: () => cmp.hasConsent('analytics') });
reveal.track('pricing_calculator', { plan: 'growth', seats: 12 });
reveal.identify({ email: user.email, name: user.name });   // after your own login/form
```

| Option | Type | Default | |
|---|---|---|---|
| `publicKey` | `string` | — (required) | Your public key, `pk_...` |
| `website` | `string` | `location.hostname` minus `www.` | The verified website in the console |
| `consent` | `boolean \| () => boolean` | region-based (see below) | Permission to collect referrer/utm/identity |
| `spa` | `boolean` | `true` | Pageviews on `pushState`/`replaceState`/`popstate` |
| `engagement` | `boolean` | `true` | Active time + scroll depth every 15 s, on tab hide and on unload |
| `forms` | `boolean \| string[] \| { selectors?, requireConsent? }` | `false` | Capture email/name from submitted forms (all, CSS selectors, or an object; `requireConsent:false` = the submission is the consent) |
| `endpoint` | `string` | the one given to `Prynt.load()`, else Prynt Cloud | API base URL |
| `debug` | `boolean` | `false` | Show the diagnostics panel (same as `?prynt_debug=1` in the URL) |

Methods: `pageview(url?)`, `track(name, props?)`, `identify({ email, name? })`, `setConsent(bool)`,
`flush()`, `stop()`, `diagnose()`.

**Consent.** Resolved at every event, first rule wins, and sent as `consentSource`: Global Privacy
Control → always `false` · `setConsent()` · the `consent` option · a consent manager detected on
the page (CookieYes, Cookiebot, OneTrust, Klaro, IAB TCF 2.2, Google Consent Mode — re-read every
second, so a late acceptance releases the held events) · the regional default (`false` on EU/UK/CH-
looking pages, `true` elsewhere). Without consent only `pageview` events are sent, flagged
`consent:false`, carrying the path and title only — no query string, referrer, utm, ESP token,
visitorId or identity; `identify()`/`track()` are held until consent arrives.

**Diagnostics.** `diagnose()` returns `RevealDiagnostics` (loaded, masked key, website, endpoint,
consent + source, CMP detected, storage, GPC, `cspBlocked`, session, queued, last send). Opening a
page with `?prynt_debug=1` renders the same values in a small fixed panel.

**Email click tokens.** With consent, `mc_eid`/`mc_cid` (Mailchimp), `_hsenc`/`_hsmi` (HubSpot),
`_kx` (Klaviyo), `vgo_ee` (ActiveCampaign), `_cio_id` (Customer.io), `mkt_tok` (Marketo) and
`utm_medium=email` become `props.espToken = { provider, token }` on the pageview and are removed
from the URL that is sent.

**Forms.** Field values are read only when `forms` is on AND consent is true (or `requireConsent:
false`), only on submit, and only from inputs that are `type=email` / named like email, plus the
input named `name` (or `autocomplete="name"`). Passwords, hidden inputs and every other field are
never read. A form protected with `protectForm()` produces `form` events with `shielded: true`.

Full reference: `docs/reveal/SDK.md` in the Prynt repository.

MIT © Prynt
