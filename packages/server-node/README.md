# @pryntid/node

Prynt Node.js server SDK — verify visitor identifications server-side with your **secret** key.
Node 18+, zero dependencies, ESM and CommonJS, TypeScript types included.

```bash
npm install @pryntid/node
```

```js
import { PryntServer } from '@pryntid/node';

const prynt = new PryntServer({ secretKey: process.env.PRYNT_SECRET_KEY });  // sk_live_...

// In your API route, after the browser sends you its requestId:
const event = await prynt.getEvent(requestId);
if (event.decision === 'block' || event.smartSignals.bot?.result) return res.status(403).end();
console.log(event.visitorId, event.confidence.score, event.environment);
```

`endpoint` defaults to Prynt Cloud (`https://api.pryntid.com`); pass
`endpoint: 'https://your-prynt-server'` only when self-hosting. `timeoutMs` defaults to 5000.

## Signup abuse: accounts on this device

`getEvent()` returns `accountsOnDevice` — every one of your account ids (`linkedId`) ever seen on
the device that made the request. After creating the account, attach its id with `updateEvent()`
so the next signup from the same device sees it:

```js
app.post('/signup', async (req, res) => {
  const event = await prynt.getEvent(req.body.pryntRequestId);
  if (event.decision === 'block') return res.status(403).json({ error: 'blocked' });
  if (event.accountsOnDevice.count >= 1) {
    // e.g. one free trial per device: refuse, require verification, or flag for review
    return res.status(409).json({ error: 'device_already_has_an_account' });
  }

  const user = await createUser(req.body);
  await prynt.updateEvent(req.body.pryntRequestId, { linkedId: String(user.id) });
  res.status(201).json({ id: user.id });
});
```

```ts
event.accountsOnDevice: {
  count: number;          // accounts listed (max 20)
  truncated: boolean;     // more than 20 exist
  accounts: { linkedId: string; events: number; firstSeenAt: string | null; lastSeenAt: string | null }[];
}
```

`updateEvent(requestId, { linkedId })` returns `{ requestId, visitorId, linkedId, accountsOnDevice }`.

## Also included

- `unsealResult(sealedResult, sealingKeyBase64)` — decrypt a sealed result (AES-256-GCM).
- `verifyWebhook(rawBody, signatureHeader, timestamp, secret, toleranceSec = 300)` — check the
  `X-Prynt-Signature` / `X-Prynt-Timestamp` of a webhook delivery (pass the **raw** body).
- `isBot(requestId)` — shortcut for `smartSignals.bot.result`.

Never trust the browser's `identify()` response alone — always confirm with `getEvent`.
Errors throw a typed `PryntError` with `.status` and `.code` (`status` 0 with code `timeout` or
`network_error` when the API could not be reached).

MIT © Prynt
