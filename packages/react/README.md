# @pryntid/react

React bindings for [Prynt](https://pryntid.com) — a `PryntProvider`, a `useVisitorData()` hook and
a `useProtectForm()` hook. Built on [`@pryntid/js`](https://www.npmjs.com/package/@pryntid/js)
(a peer dependency). React 17+.

```bash
npm install @pryntid/react @pryntid/js
```

## Quick start

```jsx
import { PryntProvider, useVisitorData } from '@pryntid/react';

function Root() {
  return (
    <PryntProvider apiKey="pk_live_your_public_key">
      <Checkout />
    </PryntProvider>
  );
}

function Checkout() {
  const { data, isLoading, error } = useVisitorData({ tag: { action: 'checkout' } });
  if (isLoading) return <p>Identifying…</p>;
  if (error) return <p>Could not identify: {error.message}</p>;
  return <p>Visitor {data?.visitorId} · {Math.round((data?.confidence.score ?? 0) * 100)}%</p>;
}
```

`PryntProvider` takes every [`@pryntid/js` option](https://www.npmjs.com/package/@pryntid/js#options--pryntloadconfig)
as a prop (`apiKey` is the only required one). `endpoint` defaults to Prynt Cloud
(`https://api.pryntid.com`); set it only when self-hosting.

## `useVisitorData(options?)`

| Option | Default | |
|---|---|---|
| `immediate` | `true` | Identify as soon as the agent is loaded |
| `tag` | — | Key/values stored with the event |
| `linkedId` | — | Your own user id, when known |

Returns `{ data, isLoading, error, getData }`. `getData(overrides?)` runs `identify()` on demand
(overrides: `tag`, `linkedId`, `content`, `formSignals`) and resolves with the result, or `null`
on error.

### Signup abuse: one account per device

Identify when the form is submitted, send the `requestId` to your server, and let the server
decide with your secret key (`GET /v1/events/:requestId` → `accountsOnDevice.count`, then
`PUT /v1/events/:requestId {linkedId}` once the account exists — see
[the full recipe](https://www.npmjs.com/package/@pryntid/js#stop-signup-abuse-multi-accounting)):

```jsx
function SignupForm() {
  const { getData } = useVisitorData({ immediate: false });
  async function onSubmit(e) {
    e.preventDefault();
    const result = await getData({ tag: { action: 'signup' } });
    await fetch('/signup', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...formValues(e.target), pryntRequestId: result?.requestId }),
    });
  }
  return <form onSubmit={onSubmit}>…</form>;
}
```

## Form Shield — protect a form from bots & spam

```tsx
import { useState } from 'react';
import { useProtectForm } from '@pryntid/react';

function ContactForm() {
  const [error, setError] = useState('');
  const { ref } = useProtectForm({
    autoGuard: true,                 // intercept submit, run identify, block bots automatically
    expectedScripts: ['latin'],      // flag Cyrillic/CJK spam
    onBlocked: () => setError('This submission was flagged as spam.'),
  });
  return (
    <form ref={ref} action="/contact" method="post">
      <textarea name="message" />
      <button type="submit">Send</button>
      {error && <p role="alert">{error}</p>}
    </form>
  );
}
```

`useProtectForm` injects an invisible honeypot, tracks submit timing, and (with `autoGuard`) runs
identification on submit and blocks bot/spam submissions. It fails open — a Prynt outage never
blocks a real user. Without `autoGuard`, read `signals()` at submit time and pass it on:
`getData({ formSignals: signals() })`.

All `@pryntid/js` types (`IdentifyResult`, `PryntConfig`, …) are re-exported from `@pryntid/react`.

MIT © Prynt
