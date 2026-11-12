/**
 * Short integration guide served as an MCP resource and a tool, so an AI assistant can walk a
 * developer through adding Prynt. Kept in sync with packages/agent/README.md and
 * packages/server-node — it only describes calls those packages and the API really expose.
 */
export const GUIDE_URI = 'prynt://guide/integration';

export const INTEGRATION_GUIDE = `# Integrate Prynt (browser identify + server verify)

Prynt gives each browser a stable visitorId. The browser result is only a hint; the decision
is made on your server with your SECRET key. Two keys exist:
- public key  pk_live_… / pk_test_…  -> goes in the browser
- secret key  sk_live_… / sk_test_…  -> server only, never in client code or a repository
Test keys (pk_test_/sk_test_) read and write the test environment, separate from live data.

## 1. Load the browser agent

The npm packages (@pryntid/js, @pryntid/node) are not published yet. Load the agent from the CDN:

    <script src="https://api.pryntid.com/cdn/prynt.umd.js"></script>

## 2. Identify in the browser

    const prynt = await Prynt.load({ apiKey: 'pk_live_your_public_key' });
    // Self-hosted Prynt: Prynt.load({ apiKey, endpoint: 'https://your-prynt-server' })
    const { requestId, visitorId } = await prynt.identify({ tag: { action: 'signup' } });

Send requestId to your backend together with the form (for example a hidden field
"pryntRequestId"). Do not make decisions on visitorId from the browser.

## 3. Verify on your server

With any HTTP client (the server SDKs are not published yet):

    curl https://api.pryntid.com/v1/events/$REQUEST_ID \\
      -H "Authorization: Bearer $PRYNT_SECRET_KEY"

    // Node 18+
    const res = await fetch('https://api.pryntid.com/v1/events/' + encodeURIComponent(requestId),
      { headers: { Authorization: 'Bearer ' + process.env.PRYNT_SECRET_KEY } });
    const event = await res.json();

Fields commonly used for a decision:
- decision: "allow" | "challenge" | "block"   (the verdict of your rules)
- riskScore: 0–100
- smartSignals.bot.result, smartSignals.vpn.result, … (each signal has a boolean "result")
- confidence.score / confidence.level
- accountsOnDevice.count: how many of your account ids (linkedId) were seen on this device
A 404 (not_found) means the requestId does not exist for this key's tenant and environment.

## 4. Link the account after signup (optional)

    PUT /v1/events/{requestId}   { "linkedId": "<your user id>" }   (secret key)

From then on the device's accountsOnDevice includes that account id.

## 5. Report outcomes (optional)

When you learn what a visitor really was, report it so future visits are flagged:

    POST /v1/outcomes   { "label": "fraud", "requestId": "req_…" }
    labels: fraud, abuse, bot, account_takeover, chargeback, spam (bad) · legit, trusted (good)

## Checklist
- Public key in the browser only; secret key in server environment variables only.
- Send requestId to the server; call GET /v1/events/{requestId} there before trusting it.
- Start with test keys; switch to live keys when the flow works.
- Other server languages: see https://pryntid.com/sdks · Docs: https://pryntid.com/docs
`;
