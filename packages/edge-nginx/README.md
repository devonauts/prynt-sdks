# Prynt Edge — nginx / OpenResty

Two connectors:

- **`prynt-authrequest.conf`** — stock nginx `auth_request`. Drop into your `server {}`, set your
  public key, point `proxy_pass` at your app. 204=allow, 403=block; challenge passes through with
  an `X-Prynt-Decision` header. Zero extra dependencies.
- **`prynt-openresty.lua`** — OpenResty (`access_by_lua_file`). Full control incl. serving a
  challenge interstitial. Needs `lua-resty-http`.

Both **fail open** — if Prynt is unreachable the request is allowed, never blocking your site.

Your server is the one talking to Prynt, so set the **proxy secret** (console → API Keys →
First-party proxy): in `prynt-authrequest.conf` replace `pps_your_proxy_secret`; for OpenResty
export `PRYNT_PROXY_SECRET` and add `env PRYNT_PROXY_SECRET;` (and `env PRYNT_PUBLIC_KEY;`) to
`nginx.conf`. Without it Prynt scores your server's IP instead of the visitor's.
Forward JA4 (`X-JA4`) if your TLS stack exposes it for network-layer detection; otherwise the
decision uses IP intelligence + UA + reputation.

## Signed AI agents (Web Bot Auth)

Agents such as ChatGPT agent, Google-Agent and YouBot sign each request with RFC 9421 HTTP Message
Signatures (Ed25519, IETF Web Bot Auth: draft-ietf-webbotauth-httpsig-protocol-01). The
signature covers *your* host, so it can only be checked where the request arrives — here. Both
connectors pass `Signature`, `Signature-Input`, `Signature-Agent` and `X-Prynt-Original-Host /
-Method / -URI` to Prynt (`auth_request` forwards the visitor headers by itself; the conf adds the
`X-Prynt-Original-*` lines). With the **proxy secret** set, Prynt verifies the signature against
the operator's published key directory and reports `VERIFIED_AGENT` or `SIGNED_AGENT_INVALID` in
`X-Prynt-Codes`. Do not strip those headers in front of nginx (draft §6.6).
