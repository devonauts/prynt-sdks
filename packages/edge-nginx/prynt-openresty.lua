-- Prynt Edge — OpenResty (access_by_lua) connector. Full control: block → 403, challenge → serve
-- an interstitial, allow → continue. Requires lua-resty-http.
--   access_by_lua_file /etc/nginx/prynt-openresty.lua;
local http = require "resty.http"

local PRYNT_API  = os.getenv("PRYNT_API") or "https://api.pryntid.com"
local PUBLIC_KEY = os.getenv("PRYNT_PUBLIC_KEY") or "pk_live_your_public_key"
-- Console → API Keys → First-party proxy. Lets Prynt trust the visitor IP this box forwards;
-- without it Prynt scores this server's IP instead of the visitor's.
local PROXY_SECRET = os.getenv("PRYNT_PROXY_SECRET") or ""

local httpc = http.new()
httpc:set_timeout(1500)  -- fail fast; never hold the request

local ok, res = pcall(function()
  return httpc:request_uri(PRYNT_API .. "/v1/edge/gate", {
    method = "GET",
    headers = {
      ["X-Prynt-Public-Key"] = PUBLIC_KEY,
      ["X-Prynt-Client-IP"]  = ngx.var.remote_addr,
      ["X-Prynt-Proxy-Secret"] = PROXY_SECRET,
      ["User-Agent"]         = ngx.var.http_user_agent or "",
      ["X-Prynt-SDK"]        = "edge-nginx/1.0.0",   -- connector version (console: SDKs in use)
      -- Web Bot Auth (signed AI agents): what the agent signed, plus this request's host/method/URI.
      ["Signature"]               = ngx.var.http_signature,
      ["Signature-Input"]         = ngx.var.http_signature_input,
      ["Signature-Agent"]         = ngx.var.http_signature_agent,
      ["X-Prynt-Original-Host"]   = ngx.var.http_host,
      ["X-Prynt-Original-Method"] = ngx.var.request_method,
      ["X-Prynt-Original-URI"]    = ngx.var.request_uri,
      -- ["X-JA4"]           = ngx.var.ssl_ja4,   -- if your TLS stack exposes it
    },
  })
end)

-- Fail open: if Prynt is unreachable, let the request through.
if not ok or not res then return end

local decision = res.headers["X-Prynt-Decision"] or "allow"
ngx.var.prynt_decision = decision   -- optional: `set $prynt_decision "";` in the location

if decision == "block" then
  ngx.status = 403
  ngx.header.content_type = "text/html"
  ngx.say("<!doctype html><h1>Access denied</h1><p>Blocked by Prynt.</p>")
  return ngx.exit(403)
elseif decision == "challenge" then
  -- Serve your challenge page, or pass through and let the Prynt agent escalate:
  ngx.req.set_header("X-Prynt-Decision", "challenge")
end
-- allow → continue to your app
