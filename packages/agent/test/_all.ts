// Single test entry so reveal.ts, forms.ts and consent_cmp.ts share one module instance
// (forms.ts keeps a WeakSet of shielded forms; two bundles would mean two sets).
export { createReveal } from '../src/reveal';
export { createAnalytics } from '../src/analytics';
export { botHint, markShielded, isShielded, onSubmit } from '../src/forms';
export { readCmp, watchCmp } from '../src/consent_cmp';
