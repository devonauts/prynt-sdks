# @pryntid/mcp

A [Model Context Protocol](https://modelcontextprotocol.io) server for Prynt. It lets an AI
assistant (Claude Desktop, Claude Code, Cursor, or any MCP client) call the Prynt server API with
your secret key: look up identification events, check an IP's network reputation, report outcomes,
check service health, and walk you through a Prynt integration.

It runs locally over stdio; `npx` fetches it on first run — nothing to clone or build.

## Install

Requires Node.js 18 or newer. The command every client runs is:

```bash
npx -y @pryntid/mcp
```

The same package is also served as a tarball from <https://pryntid.com/sdks> (for networks that
cannot reach the npm registry): `npx -y --package=<tarball URL> prynt-mcp`.

## Configure

| Variable | Required | Default | Meaning |
|---|---|---|---|
| `PRYNT_SECRET_KEY` | yes | — | A Prynt **secret** key, `sk_test_…` or `sk_live_…`. A public `pk_…` key is rejected. |
| `PRYNT_ENDPOINT` | no | `https://api.pryntid.com` | API base URL. Set it for a self-hosted Prynt server. |

A `sk_test_…` key only sees and writes the test environment; a `sk_live_…` key only the live one.
The server refuses to start without a valid secret key, and warns on stderr if `PRYNT_ENDPOINT`
uses plain `http://` for a host other than localhost.

### Claude Desktop

Edit `claude_desktop_config.json` (Settings → Developer → Edit Config):

```json
{
  "mcpServers": {
    "prynt": {
      "command": "npx",
      "args": ["-y", "@pryntid/mcp"],
      "env": {
        "PRYNT_SECRET_KEY": "sk_test_your_secret_key"
      }
    }
  }
}
```

Restart Claude Desktop after saving.

### Claude Code

```bash
claude mcp add prynt -e PRYNT_SECRET_KEY=sk_test_your_secret_key \
  -- npx -y @pryntid/mcp
```

To share the server with a team through a project `.mcp.json`, keep the key out of the file and
let each developer provide it from their own environment:

```json
{
  "mcpServers": {
    "prynt": {
      "command": "npx",
      "args": ["-y", "@pryntid/mcp"],
      "env": { "PRYNT_SECRET_KEY": "${PRYNT_SECRET_KEY}" }
    }
  }
}
```

### Cursor

Add the same `mcpServers` block to `~/.cursor/mcp.json` (all projects) or `.cursor/mcp.json`
(one project):

```json
{
  "mcpServers": {
    "prynt": {
      "command": "npx",
      "args": ["-y", "@pryntid/mcp"],
      "env": {
        "PRYNT_SECRET_KEY": "sk_test_your_secret_key",
        "PRYNT_ENDPOINT": "https://api.pryntid.com"
      }
    }
  }
}
```

## Tools

| Tool | API route | What it does |
|---|---|---|
| `prynt_get_event` | `GET /v1/events/{requestId}` | Returns the server-side record of one identification: `visitorId`, `confidence`, `decision`, `riskScore`, `smartSignals`, IP and location, user agent, `linkedId`, the visitor (`firstSeenAt`, `seenCount`, …) and `accountsOnDevice`. Read-only. |
| `prynt_lookup_ip` | `POST /v1/ip` | Network reputation for a raw IP: country, ASN, ASN organisation and type, datacenter / VPN / Tor / proxy flags and a reputation field. Does not use identification quota; counts against the per-minute rate limit. Read-only. |
| `prynt_health` | `GET /v1/health` | Overall API status (`ok` / `degraded` / `down`) and per-component status. Sends no key. Read-only. |
| `prynt_integration_guide` | none | Returns a short integration guide: install `@pryntid/js`, identify in the browser, verify the `requestId` on your server, link accounts, report outcomes. Also exposed as the resource `prynt://guide/integration`. |
| `prynt_replay_sessions` | `GET /v1/replay/sessions` | **Prynt Replay.** Finds recorded sessions by page path, your user id, Identify `visitorId`, country, device, JS errors, failed requests, rage / dead clicks or a minimum frustration score. Each result says who the visitor was and links to the console player. Bot sessions are excluded. Read-only. |
| `prynt_replay_session` | `GET /v1/replay/sessions/{id}` | One session: pages, every signal with its time offset, who the visitor was and Py's saved summary. Never form values or page text. Read-only. |
| `prynt_replay_summarize` | `POST /v1/replay/sessions/{id}/summary` | **Py**, Prynt's AI, summarizes a session: what happened, where the visitor got stuck, key moments, outcome, next step. Saved and reused; a new one spends one Py request. |
| `prynt_replay_issues` | `GET /v1/replay/issues` | Errors, failed requests and frustration grouped into issues, ranked by sessions, users and (with `goalPath` / `goalEvent`) conversions lost. Read-only. |
| `prynt_ask_py` | `POST /v1/replay/ask` | Ask Py a question about a site's recent sessions ("Why do people leave the pricing page?"). Py reads up to 100 sessions and cites recordings as `[#id]`. Spends one Py request. |
| `prynt_report_outcome` | `POST /v1/outcomes` | **Writes data.** Records a label (`fraud`, `abuse`, `bot`, `account_takeover`, `chargeback`, `spam`, `legit`, `trusted`) for a `requestId`, `visitorId` or `linkedId`. A bad label flags that device / account / IP so its future visits are marked in your account, and every label is stored as risk-model training data. On Prynt's cloud the cross-customer reputation network is on: bad labels also feed it as one-way salted hashes unless your account turned contribution off (console › Rules › Reputation network); a self-hosted server shares only if its operator enabled it. This server has no tool to remove a label. |

API errors come back as tool errors with the HTTP status, Prynt's error code and message (for
example `not_found` when a `requestId` does not belong to your key's tenant and environment).

## What to ask your assistant

- "Use Prynt to look up request `req_…` and tell me whether this signup looks risky."
- "Does this device already have other accounts on it?"
- "Check the IP 203.0.113.7 with Prynt — is it a datacenter or VPN?"
- "Read the Prynt integration guide and add identify-on-signup to this form, with server-side
  verification in our Express route."
- "Is the Prynt API healthy?"

## Security

- **Try it with a test key first** (`sk_test_…`). Test keys only touch the test environment.
- **The key stays on your machine.** The server runs locally, reads the key from its environment,
  and sends it only to `PRYNT_ENDPOINT` in the `Authorization: Bearer` header. No tool returns
  it, and any tool output that happened to contain it is redacted before it reaches the assistant.
- **Tool results do go to your AI assistant.** An event contains personal data (IP address, user
  agent, the account ids you linked). Whatever a tool returns becomes part of the conversation
  with your assistant's model provider. Use test data unless your policies allow sending live
  visitor data there.
- Don't commit config files that contain a key; use environment variables (see the `.mcp.json`
  example above).
- `prynt_report_outcome` is the only tool that writes. Claude Desktop, Claude Code and Cursor can ask
  for your approval before each tool call; don't auto-approve this one.

## Develop

```bash
npm install
npm run build
npm test      # node:test; the HTTP layer is a fake fetch — no network, no real keys
```

## License

MIT
