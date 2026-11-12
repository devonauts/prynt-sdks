# Prynt Edge — Cloudflare Worker

Decides **allow / challenge / block at the edge** (sub-10ms, before your origin) and serves the
Prynt agent **first-party** so ad/tracker blockers can't strip it. No origin changes.

```bash
cd packages/edge-cloudflare
npm i -g wrangler
wrangler secret put PRYNT_PUBLIC_KEY   # your pk_live_… key
wrangler secret put PRYNT_PROXY_SECRET # console → API Keys → First-party proxy (keeps visitor IPs)
wrangler deploy
```

Then route your zone/paths to the Worker (Workers Routes). In your pages, load the agent
same-origin:

```html
<script src="/__prynt/agent.js"></script>
<script>Prynt.load({ apiKey: 'pk_live_…', endpoint: location.origin + '/__prynt' })
  .then(p => p.identify());</script>
```

- **JA4** comes from `request.cf.botManagement.ja4` (Bot Management). Without it, the decision
  still uses IP intelligence + UA + reputation.
- **Fail-open**: if Prynt is unreachable the Worker lets traffic through — it never takes your site
  down. Blocked requests get a clean 403 page; challenge/allow pass through with an `X-Prynt-Decision`
  header your app can read.

## Signed AI agents (Web Bot Auth)

Agents such as **ChatGPT agent** (`Signature-Agent: "https://chatgpt.com"`), **Google-Agent**
(`https://agent.bot.goog`) and **YouBot** (`https://you.com`) sign their HTTP requests with
RFC 9421 HTTP Message Signatures (Ed25519) under the IETF Web Bot Auth profile
(draft-ietf-webbotauth-httpsig-protocol-01). The signature covers the host the agent connected
to, so only your edge can see it — the browser agent never does. The Worker forwards
`Signature`, `Signature-Input` and `Signature-Agent` plus `X-Prynt-Original-Host/-Method/-URI`
to `/v1/edge/gate` (and on the first-party `/__prynt/*` proxy). Prynt verifies the signature
against the operator's key directory (`/.well-known/http-message-signatures-directory`) and
returns `VERIFIED_AGENT` (allowed by default, scored as an AI agent, not as a malicious bot) or
`SIGNED_AGENT_INVALID` (forged, replayed, expired or a demo key).

**`PRYNT_PROXY_SECRET` is required** for verification: Prynt trusts the forwarded original host
only alongside it. Block or challenge verified agents with a rule, e.g. `agentOperator eq openai
→ block`, or `verifiedAgent eq true → challenge`.
