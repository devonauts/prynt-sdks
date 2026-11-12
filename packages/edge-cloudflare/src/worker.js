// Prynt Edge — Cloudflare Worker. Decides allow/challenge/block at the nearest PoP BEFORE origin,
// and serves the Prynt agent first-party (same-origin → defeats ad/tracker blockers, keeps
// first-party storage alive for better cross-session identity). Zero origin changes.
//
// Deploy: set PRYNT_PUBLIC_KEY (secret) + optionally PRYNT_API / PROTECT_PATHS. See README.

// Sent to Prynt on the gate call so the console can tell which connector version a site runs.
const SDK = 'edge-cloudflare/1.0.0';

const BLOCK_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Access denied</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,"SF Pro Display",sans-serif;background:#fbfbfd;
color:#1d1d1f;display:grid;place-items:center;height:100vh;margin:0}main{text-align:center;max-width:420px}
h1{font-size:28px;letter-spacing:-.02em}p{color:#6e6e73}</style></head>
<body><main><h1>Access denied</h1><p>This request was blocked. If you believe this is a mistake, contact support.</p></main></body></html>`;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const api = (env.PRYNT_API || 'https://api.pryntid.com').replace(/\/$/, '');

    // 1. First-party agent + API proxy under /__prynt/* (same-origin ⇒ ad-blocker-proof).
    if (url.pathname === '/__prynt/agent.js') {
      const r = await fetch(api + '/cdn/prynt.umd.js', { cf: { cacheEverything: true, cacheTtl: 3600 } });
      return new Response(r.body, {
        headers: { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'public, max-age=3600' },
      });
    }
    if (url.pathname.startsWith('/__prynt/')) {
      // The agent calls `${endpoint}/v1/identify`, so /__prynt/v1/… must not become /v1/v1/….
      const rest = url.pathname.slice('/__prynt/'.length).replace(/^v1\//, '');
      const target = api + '/v1/' + rest + url.search;
      const fwd = new Request(target, request);
      vouchForVisitor(fwd.headers, request, env);
      forwardSignature(fwd.headers, request, url, env);
      return fetch(fwd);
    }

    // 2. Gate. By default only HTML navigations; override with PROTECT_PATHS="/login,/checkout".
    const protect = (env.PROTECT_PATHS || '').split(',').map((s) => s.trim()).filter(Boolean);
    const gateThis = protect.length
      ? protect.some((p) => url.pathname.startsWith(p))
      : (request.headers.get('Accept') || '').includes('text/html');

    if (!gateThis || !env.PRYNT_PUBLIC_KEY) return fetch(request);

    const cf = request.cf || {};
    const ja4 = cf.botManagement?.ja4 || cf.tlsClientHelloJA4 || cf.botManagement?.ja3 || '';
    let decision = 'allow';
    try {
      const headers = new Headers({
        'X-Prynt-Public-Key': env.PRYNT_PUBLIC_KEY,
        'User-Agent': request.headers.get('User-Agent') || '',
        'X-JA4': ja4,
        'X-Prynt-SDK': SDK,
      });
      vouchForVisitor(headers, request, env);
      forwardSignature(headers, request, url, env);
      const gate = await fetch(api + '/v1/edge/gate', { headers });
      decision = gate.headers.get('X-Prynt-Decision') || 'allow';
    } catch (_e) {
      decision = 'allow'; // fail open — never take the site down because Prynt was unreachable
    }

    if (decision === 'block') {
      return new Response(BLOCK_PAGE, { status: 403, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }
    // allow / challenge → pass to origin, tagging the decision so the app (or the agent) can escalate.
    const originResp = await fetch(request);
    const headers = new Headers(originResp.headers);
    headers.set('X-Prynt-Decision', decision);
    return new Response(originResp.body, { status: originResp.status, statusText: originResp.statusText, headers });
  },
};


// Every request reaches Prynt from this worker's IP, so pass the visitor's real IP — Prynt only
// accepts it alongside the proxy secret from the console (API Keys → First-party proxy).
function vouchForVisitor(headers, request, env) {
  const ip = request.headers.get('CF-Connecting-IP') || (request.cf && request.cf.clientIp) || '';
  if (env.PRYNT_PROXY_SECRET && ip) {
    headers.set('X-Prynt-Proxy-Secret', env.PRYNT_PROXY_SECRET);
    headers.set('X-Prynt-Client-IP', ip);
  }
}


// Web Bot Auth (signed AI agents such as ChatGPT agent): the agent signs the request it sent to THIS
// site — its @authority and Signature-Agent — so Prynt needs those headers plus the original host,
// method and URI. Prynt trusts the X-Prynt-Original-* values only next to the proxy secret, so
// without PRYNT_PROXY_SECRET a signed agent is reported but never verified.
function forwardSignature(headers, request, url, env) {
  for (const h of ['Signature', 'Signature-Input', 'Signature-Agent']) {
    const v = request.headers.get(h);
    if (v) headers.set(h, v);
  }
  if (env.PRYNT_PROXY_SECRET && (request.headers.get('Signature-Input') || request.headers.get('Signature-Agent'))) {
    headers.set('X-Prynt-Original-Host', url.host);
    headers.set('X-Prynt-Original-Method', request.method);
    headers.set('X-Prynt-Original-URI', url.pathname + url.search);
  }
}
