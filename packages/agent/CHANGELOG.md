# Changelog — @pryntid/js

All notable changes to this package. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and versions follow [Semantic Versioning](https://semver.org/). New notes go under **Unreleased**;
`scripts/sdk/release.sh agent X.Y.Z` dates them.

## [Unreleased]

## [1.1.0] - 2026-11-12

- Reveal: consent-manager auto-detection (CookieYes, Cookiebot, OneTrust, Klaro, IAB TCF 2.2, Google Consent Mode) when no `consent` option is given, re-evaluated every second and on TCF events; Global Privacy Control now always wins (consent `false`, even over `consent:true`/`setConsent(true)`); every batch carries `consentSource` (`config | override | gpc | cookieyes | cookiebot | onetrust | klaro | tcf | gcm | default`). Types `RevealConsentSource`.
- Reveal: `diagnose()` on the client (type `RevealDiagnostics`: loaded, masked key, website, endpoint, consent + source, CMP, storage `localStorage|memory|blocked`, GPC, `cspBlocked`, session, visitor, queued, last send) and a `?prynt_debug=1` / `debug:true` panel (inline styles, no network). `cspBlocked` is set by a `fetch` TypeError before any response and by `securitypolicyviolation` events for the endpoint.
- Reveal: email-service-provider click parameters (`mc_eid`, `mc_cid`, `_hsenc`, `_hsmi`, `_kx`, `vgo_ee`, `_cio_id`, `mkt_tok`, `utm_medium=email`) become `pageview.props.espToken {provider, token}` with consent only, and are always stripped from the sent `url`.
- Reveal: `forms` accepts `{ selectors?, requireConsent? }`; `form` events carry `shielded: true` when `protectForm()` guards the same form (shared `submit` listener in `forms.ts`; an `autoGuard` re-submit within 2 s is counted once); `requireConsent:false` sends the `form` event as its own consented request with the form id as `consentRef`. Body field `botHint: true` from a compact crawler/headless UA list + `navigator.webdriver`.
- `RevealClient.diagnose` is now required (was optional); `RevealOptions.forms` widened; new `RevealOptions.debug`; new exported type `RevealFormsOptions`. No breaking change for callers.
- Tests: `test/consent_cmp.test.mjs` (CMP detection + wiring) and new Reveal cases; shared fake browser in `test/_env.mjs`.
- Added the Reveal-only build (`src/reveal_entry.ts`): `dist/prynt-reveal.umd.js` (global `PryntReveal` with `reveal(opts)` and `version`), `dist/prynt-reveal.mjs` / `.cjs` as `@pryntid/js/reveal` (types `dist/reveal.d.ts`). No device-intelligence code; independent of `Prynt.load()` — the full agent, when present on `window.Prynt`, is detected at runtime (`Prynt._agent()`, internal) so the `visitorId` is reused.
- Bundle: `dist/prynt.umd.js` (full agent, Reveal included) 46,950 B raw / 18,901 B gzip (was 40,643 / 16,131); `dist/prynt-reveal.umd.js` see docs/reveal/SDK.md "Size budget".
- Added `Prynt.reveal(options)` — B2B visitor identification (Reveal): pageviews, SPA route changes, engagement (active time + scroll depth), `track()` custom events, `identify()` and opt-in form capture (email/name only), batched to `POST /v1/reveal/collect` with `sendBeacon` on unload. 30-minute session id in `localStorage` (`prynt_rvs`); reuses the agent's `visitorId` when `identify()` already ran. Conservative consent default (off on EU/UK/CH-looking pages and under GPC); without consent only minimal pageviews are sent. Types `RevealOptions` / `RevealClient`. Adds ~2.7 kB gzipped to the bundle.
- Added `npm test` (`node --test`, no new dependencies).

## [1.0.0]

- First public release. Browser agent: `Prynt.load()` + `identify()` (alias `get()`), stable `visitorId` with confidence, optional Smart Signals (`extendedResult`), linkedId/tag, consent (GPC honored by default, `requireConsent`/`setConsent`), cookie + localStorage + IndexedDB persistence. ESM, CJS and a UMD build (`<script>` global `Prynt`); TypeScript types.
