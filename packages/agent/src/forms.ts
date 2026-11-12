// Shared form plumbing for Reveal (`forms` option) and Form Shield (`protectForm`), PRD FP-6.
//
// - One capture-phase `submit` listener per document, fanned out to subscribers (Reveal subscribes;
//   protectForm keeps its own per-form listener, so its blocking behaviour is untouched).
// - `markShielded(form)` is called by protectForm; `isShielded(form)` lets a Reveal `form` event say
//   `shielded: true` when the same form is protected. Falls back to spotting the honeypot input.

type Sub = (e: Event) => void;
let subs: Sub[] = [];
let attached = false;
const fan = (e: Event): void => { for (const s of subs.slice()) { try { s(e); } catch { /* a subscriber must not break the others */ } } };

export function onSubmit(fn: Sub): () => void {
  subs.push(fn);
  if (!attached) { try { document.addEventListener('submit', fan, true); attached = true; } catch { /* no DOM */ } }
  return () => {
    subs = subs.filter((s) => s !== fn);
    if (!subs.length && attached) { attached = false; try { document.removeEventListener('submit', fan, true); } catch { /* ignore */ } }
  };
}

const shielded = typeof WeakSet === 'function' ? new WeakSet<object>() : null;
export function markShielded(form: object): void { try { if (shielded) shielded.add(form); } catch { /* not an object */ } }
export function isShielded(form: HTMLFormElement): boolean {
  try {
    if (shielded && shielded.has(form)) return true;
    return !!form.querySelector('input[name^="pr_hp_"]');
  } catch { return false; }
}

// Client-side bot hint (sent as `botHint`, the server still decides): a compact UA list in the
// spirit of isbot / @posthog/core — crawlers, SEO tools, link previewers, monitors, headless and
// automation frameworks, AI agents — plus navigator.webdriver.
const BOT = /bot|crawl|spider|slurp|headless|phantom|lighthouse|pingdom|gtmetrix|wget|curl\/|python|httpclient|java\/|go-http|scrapy|puppeteer|playwright|selenium|externalhit|preview|embedly|whatsapp|telegram|discord|semrush|ahrefs|mj12|petal|yandex|baidu|gpt|claude|anthropic|perplexity|inspectiontool|mediapartners|feedfetcher|apis-google|uptime|monitor|checker|validator|archive|screaming/i;
export function botHint(): boolean {
  try { return navigator.webdriver === true || BOT.test(navigator.userAgent || ''); } catch { return false; }
}
