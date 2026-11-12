/**
 * The Prynt MCP server: tools over the public /v1 server API plus an integration guide.
 * Every tool maps to one route of the Prynt server API; nothing here invents data.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { PryntApiClient, PryntApiError, type FetchLike } from './client.js';
import { keyEnvironment, type PryntMcpConfig } from './config.js';
import { GUIDE_URI, INTEGRATION_GUIDE } from './guide.js';

export { DEFAULT_ENDPOINT, loadConfig, ConfigError } from './config.js';
export { PryntApiClient, PryntApiError } from './client.js';
export { INTEGRATION_GUIDE, GUIDE_URI } from './guide.js';

export const SERVER_NAME = 'prynt';
import { SERVER_VERSION } from './version.js';

export { SERVER_VERSION };

/** Labels accepted by POST /v1/outcomes. */
export const BAD_LABELS = ['fraud', 'abuse', 'bot', 'account_takeover', 'chargeback', 'spam'] as const;
export const GOOD_LABELS = ['legit', 'trusted'] as const;
export const OUTCOME_LABELS = [...BAD_LABELS, ...GOOD_LABELS] as const;

export interface CreateServerOptions extends PryntMcpConfig {
  /** Injected in tests; defaults to global fetch. */
  fetch?: FetchLike;
  timeoutMs?: number;
}

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };

export function createPryntMcpServer(opts: CreateServerOptions): McpServer {
  const client = new PryntApiClient(opts);
  const environment = keyEnvironment(opts.secretKey);

  // Defense in depth: nothing the server returns may contain the secret key, even if an
  // upstream error message or a proxy page happened to echo it.
  const redact = (text: string) => text.split(opts.secretKey).join('[redacted]');
  const ok = (data: unknown): ToolResult => ({
    content: [{ type: 'text', text: redact(JSON.stringify(data, null, 2)) }],
  });
  const fail = (message: string): ToolResult => ({
    content: [{ type: 'text', text: redact(message) }],
    isError: true,
  });
  const failFrom = (e: unknown): ToolResult => {
    if (e instanceof PryntApiError) {
      const status = e.status ? `HTTP ${e.status}` : 'no response';
      let hint = '';
      if (e.status === 401) hint = ' Check PRYNT_SECRET_KEY in the MCP server config (it must be an active secret key).';
      if (e.status === 429) hint = ' The per-minute rate limit was hit; wait a moment and retry.';
      return fail(`Prynt API error (${status}, ${e.code}): ${e.message}.${hint}`);
    }
    return fail(`Unexpected error: ${(e as Error)?.message ?? String(e)}`);
  };

  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        `Tools for the Prynt device-intelligence API, authenticated with a ${environment} secret key ` +
        `(data from the ${environment} environment only). Read-only tools: prynt_get_event, ` +
        'prynt_lookup_ip, prynt_health, prynt_integration_guide, and for Prynt Replay: prynt_replay_sessions, ' +
        'prynt_replay_session, prynt_replay_issues, prynt_replay_summarize and prynt_ask_py (Py is Prynt\'s AI; ' +
        'the last two spend one Py request each). prynt_report_outcome WRITES a label; ' +
        'only call it when the user explicitly asks to report an outcome.',
    },
  );

  server.registerTool(
    'prynt_get_event',
    {
      title: 'Look up an identification event',
      description:
        'Fetch the server-side record of one identification by its requestId (GET /v1/events/{requestId}). ' +
        'Returns visitorId, confidence, decision (allow/challenge/block), riskScore, smartSignals, ' +
        'ipLocation, linkedId, url, userAgent, ip, the visitor (firstSeenAt, seenCount…) and ' +
        'accountsOnDevice (account ids seen on the same device). Only events of this key\'s tenant ' +
        `and environment (${environment}) are visible. Read-only. The result contains personal data ` +
        '(IP address, user agent); do not paste it anywhere public.',
      inputSchema: {
        requestId: z.string().trim().min(1).max(40)
          .describe('The requestId returned by identify() in the browser, e.g. "req_…"'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ requestId }) => {
      try {
        const { data } = await client.request('GET', `/v1/events/${encodeURIComponent(requestId)}`);
        return ok(data);
      } catch (e) {
        return failFrom(e);
      }
    },
  );

  server.registerTool(
    'prynt_lookup_ip',
    {
      title: 'IP intelligence',
      description:
        'Network reputation for a raw IP address (POST /v1/ip): country, ASN and ASN organisation/type, ' +
        'and datacenter / VPN / Tor / proxy flags plus a reputation field, from Prynt\'s IP data. ' +
        'Does not need a browser identification and does not consume identification quota, but it ' +
        'counts against the per-minute rate limit. Read-only.',
      inputSchema: {
        ip: z.string().trim().min(2).max(45).describe('IPv4 or IPv6 address, e.g. "203.0.113.7"'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ ip }) => {
      try {
        const { data } = await client.request('POST', '/v1/ip', { body: { ip } });
        return ok(data);
      } catch (e) {
        return failFrom(e);
      }
    },
  );

  server.registerTool(
    'prynt_health',
    {
      title: 'Prynt service health',
      description:
        'Check whether the configured Prynt API is up (GET /v1/health). Returns the overall status ' +
        '(ok / degraded / down) and per-component status (database, store, reputation). ' +
        'Sends no API key. Read-only.',
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async () => {
      try {
        const { status, data } = await client.request('GET', '/v1/health', { auth: false, acceptStatuses: [503] });
        return ok({ httpStatus: status, ...(data as object) });
      } catch (e) {
        return failFrom(e);
      }
    },
  );

  server.registerTool(
    'prynt_report_outcome',
    {
      title: 'Report an outcome (writes a label)',
      description:
        'WRITES DATA. Records a ground-truth label for an identification, visitor or account ' +
        '(POST /v1/outcomes). Bad labels (fraud, abuse, bot, account_takeover, chargeback, spam) flag ' +
        'that visitorId / account / IP so future visits from it are marked in your account; every ' +
        'label is also stored as training data for the risk model. On Prynt\'s cloud the cross-customer ' +
        'reputation network is on: bad labels also feed that SHARED network as one-way salted hashes, ' +
        'unless the account turned contribution off (console › Rules › Reputation network); a ' +
        'self-hosted server shares only if its operator enabled it. There is no delete tool here. Only call this when the user ' +
        'explicitly asks to report an outcome, and confirm the label and target with them first. ' +
        'Provide at least one of requestId, visitorId or linkedId.',
      inputSchema: {
        label: z.enum(OUTCOME_LABELS).describe('What the entity turned out to be'),
        requestId: z.string().trim().min(1).max(40).optional()
          .describe('Identification to label; its visitorId, linkedId and IP are filled in by the server'),
        visitorId: z.string().trim().min(1).max(40).optional().describe('Device to label, e.g. "vst_…"'),
        linkedId: z.string().trim().min(1).max(190).optional().describe('Your own account/user id'),
        ip: z.string().trim().min(2).max(45).optional().describe('IP address to include in the label'),
        notes: z.string().max(500).optional().describe('Free-text note stored with the label (max 500 chars)'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ label, requestId, visitorId, linkedId, ip, notes }) => {
      if (!requestId && !visitorId && !linkedId) {
        return fail('Provide at least one of requestId, visitorId or linkedId.');
      }
      const body: Record<string, string> = { label };
      if (requestId) body.requestId = requestId;
      if (visitorId) body.visitorId = visitorId;
      if (linkedId) body.linkedId = linkedId;
      if (ip) body.ip = ip;
      if (notes) body.notes = notes;
      try {
        const { data } = await client.request('POST', '/v1/outcomes', { body });
        return ok(data);
      } catch (e) {
        return failFrom(e);
      }
    },
  );

  // --- Prynt Replay + Py (Prynt's AI) — owner 2026-11-11. Needs Replay active on the key's account. ------------
  const qs = (o: Record<string, unknown>): string => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(o)) {
      if (v === undefined || v === null || v === '' || v === false) continue;
      p.set(k, v === true ? '1' : String(v));
    }
    const s = p.toString();
    return s ? `?${s}` : '';
  };
  const website = z.string().trim().max(253).optional()
    .describe('The site domain, e.g. "acme.com". Omit to use the account\'s first site.');

  server.registerTool(
    'prynt_replay_sessions',
    {
      title: 'Find Replay sessions',
      description:
        'Search recorded sessions of Prynt Replay (GET /v1/replay/sessions): by page path (e.g. "/checkout" or ' +
        '"/blog/*"), your own userId, Identify visitorId, country, device, sessions with JS errors, failed ' +
        'requests, rage or dead clicks, or a minimum frustration score (0-100). Each result has who the visitor ' +
        'was, the counts, the frustration score and a console link to watch it. Bot sessions are excluded. Read-only.',
      inputSchema: {
        website,
        days: z.number().int().min(1).max(365).optional().describe('Look back this many days (default 7, capped by the plan retention)'),
        path: z.string().trim().max(300).optional(),
        userId: z.string().trim().max(190).optional(),
        visitorId: z.string().trim().max(40).optional(),
        country: z.string().trim().length(2).optional().describe('ISO country code, e.g. "US"'),
        device: z.enum(['desktop', 'tablet', 'mobile']).optional(),
        hasErrors: z.boolean().optional(),
        hasNetworkErrors: z.boolean().optional(),
        hasRage: z.boolean().optional(),
        hasDead: z.boolean().optional(),
        minFrustration: z.number().int().min(0).max(100).optional(),
        sort: z.enum(['newest', 'oldest', 'longest', 'errors', 'frustration']).optional(),
        page: z.number().int().min(1).max(10000).optional(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args) => {
      try {
        const { data } = await client.request('GET', `/v1/replay/sessions${qs(args)}`);
        return ok(data);
      } catch (e) {
        return failFrom(e);
      }
    },
  );

  server.registerTool(
    'prynt_replay_session',
    {
      title: 'Read one Replay session',
      description:
        'One recorded session (GET /v1/replay/sessions/{id}): pages visited, every signal with its time offset ' +
        '(JS errors, failed requests, rage / dead / error clicks), who the visitor was, and Py\'s saved summary ' +
        'when there is one. Never contains form values or page text. Read-only.',
      inputSchema: { id: z.number().int().positive().describe('Recording id from prynt_replay_sessions') },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ id }) => {
      try {
        const { data } = await client.request('GET', `/v1/replay/sessions/${id}`);
        return ok(data);
      } catch (e) {
        return failFrom(e);
      }
    },
  );

  server.registerTool(
    'prynt_replay_summarize',
    {
      title: 'Ask Py to summarize a session',
      description:
        'Py, Prynt\'s AI, summarizes one recorded session (POST /v1/replay/sessions/{id}/summary): what the ' +
        'visitor did, where they got stuck, the key moments, the outcome and the next step. The summary is saved ' +
        'and reused; a new one spends one Py request of the account\'s monthly allowance.',
      inputSchema: { id: z.number().int().positive().describe('Recording id') },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ id }) => {
      try {
        const { data } = await client.request('POST', `/v1/replay/sessions/${id}/summary`, { body: {} });
        return ok(data);
      } catch (e) {
        return failFrom(e);
      }
    },
  );

  server.registerTool(
    'prynt_replay_issues',
    {
      title: 'Replay issues by impact',
      description:
        'Errors, failed requests and frustration grouped into issues and ranked by impact (GET /v1/replay/issues): ' +
        'sessions and users affected and, with a goal page (goalPath) or event (goalEvent), conversions lost. ' +
        'Each issue has a sample recording with the moment it happened. Read-only.',
      inputSchema: {
        website,
        days: z.number().int().min(1).max(365).optional(),
        goalPath: z.string().trim().max(200).optional().describe('A page that counts as a conversion, e.g. "/thank-you"'),
        goalEvent: z.string().trim().max(120).optional().describe('A custom event that counts as a conversion'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args) => {
      try {
        const { data } = await client.request('GET', `/v1/replay/issues${qs(args)}`);
        return ok(data);
      } catch (e) {
        return failFrom(e);
      }
    },
  );

  server.registerTool(
    'prynt_ask_py',
    {
      title: 'Ask Py about your sessions',
      description:
        'Ask Py, Prynt\'s AI, a question in plain words about a site\'s recent sessions (POST /v1/replay/ask), ' +
        'e.g. "Why do people leave the pricing page?" or "Which sessions had checkout errors this week?". Py reads ' +
        'up to 100 recent sessions and cites the recordings it used as [#id]. Spends one Py request.',
      inputSchema: {
        question: z.string().trim().min(3).max(500),
        website,
        days: z.number().int().min(1).max(90).optional(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ question, website: site, days }) => {
      try {
        const { data } = await client.request('POST', `/v1/replay/ask${qs({ website: site })}`, { body: { question, days } });
        return ok(data);
      } catch (e) {
        return failFrom(e);
      }
    },
  );

  server.registerTool(
    'prynt_integration_guide',
    {
      title: 'Prynt integration guide',
      description:
        'Returns a short guide for adding Prynt to an app: install @pryntid/js, identify in the browser, ' +
        'verify the requestId on the server with the secret key, link accounts and report outcomes. ' +
        `Same text as the ${GUIDE_URI} resource. No API call.`,
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => ({ content: [{ type: 'text', text: INTEGRATION_GUIDE }] }),
  );

  server.registerResource(
    'integration-guide',
    GUIDE_URI,
    {
      title: 'Prynt integration guide',
      description: 'Install @pryntid/js, identify in the browser, verify on the server.',
      mimeType: 'text/markdown',
    },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'text/markdown', text: INTEGRATION_GUIDE }] }),
  );

  return server;
}
