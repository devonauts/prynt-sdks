// Prynt Replay feedback widget (owner 2026-11-11): a small button that opens a one-question survey — CSAT (1-5) or
// NPS (0-10) plus an optional comment — and posts it to /v1/replay/feedback with the Replay session id, so every
// answer opens the replay at the moment it was given. Loaded only on sites that turned it on (replay config
// `feedback`), as dist/prynt-feedback.umd.js (UMD global PryntFeedback). Shadow DOM: the page's CSS never leaks in,
// and the host is data-prynt-block so the recorder never captures what is typed here.

export interface FeedbackConfig {
  kind: 'csat' | 'nps'; question: string; label: string; position: 'right' | 'left'; thanks: string; placeholder: string; send: string;
}
export interface MountOptions { endpoint: string; publicKey: string; website: string; sessionId: string; cfg: FeedbackConfig }

const CSS = `
:host{all:initial}
.b{position:fixed;bottom:18px;z-index:2147483000;font:600 13px/1 system-ui,-apple-system,Segoe UI,sans-serif;color:#fff;
background:linear-gradient(135deg,#5b8cff,#7a4fe6);border:0;border-radius:999px;padding:11px 16px;cursor:pointer;box-shadow:0 8px 24px rgba(90,80,230,.35)}
.p{position:fixed;bottom:70px;z-index:2147483001;width:min(340px,calc(100vw - 32px));background:#fff;color:#0d1020;border-radius:16px;
box-shadow:0 18px 50px rgba(20,24,60,.25);padding:16px;font:14px/1.45 system-ui,-apple-system,Segoe UI,sans-serif;box-sizing:border-box}
.q{font-weight:650;margin:0 0 12px}.s{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 12px}
.s button{flex:1 0 auto;min-width:28px;padding:8px 0;border-radius:10px;border:1px solid #d9dbe5;background:#f6f7fb;cursor:pointer;font:600 13px system-ui,sans-serif;color:#0d1020}
.s button[aria-pressed=true]{background:#5d4fe0;border-color:#5d4fe0;color:#fff}
textarea{width:100%;box-sizing:border-box;min-height:64px;border:1px solid #d9dbe5;border-radius:10px;padding:8px;font:13px system-ui,sans-serif;resize:vertical}
.r{display:flex;justify-content:space-between;align-items:center;margin-top:10px}
.x{background:none;border:0;color:#6b7080;cursor:pointer;font-size:13px}
.go{background:#11162a;color:#fff;border:0;border-radius:999px;padding:9px 16px;font:600 13px system-ui,sans-serif;cursor:pointer}
.go:disabled{opacity:.4;cursor:default}.t{margin:6px 0;font-weight:600}
@media (prefers-color-scheme:dark){.p{background:#1b1e2b;color:#eef0f7}.s button{background:#262a3a;border-color:#363b50;color:#eef0f7}
textarea{background:#262a3a;border-color:#363b50;color:#eef0f7}.go{background:#eef0f7;color:#11162a}}`;

export function mount(o: MountOptions): () => void {
  const host = document.createElement('div');
  host.setAttribute('data-prynt-block', '');
  host.className = 'prynt-block';
  const root = host.attachShadow({ mode: 'open' });
  const side = o.cfg.position === 'left' ? 'left:18px' : 'right:18px';
  const max = o.cfg.kind === 'nps' ? 10 : 5;
  const min = o.cfg.kind === 'nps' ? 0 : 1;
  let score: number | null = null;
  const el = (tag: string, cls?: string, text?: string): HTMLElement => {
    const e = document.createElement(tag); if (cls) e.className = cls; if (text) e.textContent = text; return e;
  };
  const style = el('style'); style.textContent = CSS;
  const btn = el('button', 'b', o.cfg.label) as HTMLButtonElement; btn.style.cssText = side; btn.type = 'button';
  const panel = el('div', 'p'); panel.style.cssText = side; panel.hidden = true; panel.setAttribute('role', 'dialog');
  const q = el('p', 'q', o.cfg.question);
  const scale = el('div', 's');
  const note = el('textarea') as HTMLTextAreaElement; note.placeholder = o.cfg.placeholder; note.maxLength = 1000;
  const row = el('div', 'r');
  const close = el('button', 'x', '×') as HTMLButtonElement; close.type = 'button'; close.setAttribute('aria-label', 'Close');
  const send = el('button', 'go', o.cfg.send) as HTMLButtonElement; send.type = 'button'; send.disabled = true;
  for (let i = min; i <= max; i++) {
    const b = el('button', undefined, String(i)) as HTMLButtonElement; b.type = 'button'; b.setAttribute('aria-pressed', 'false');
    b.onclick = (): void => {
      score = i; send.disabled = false;
      scale.querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    };
    scale.appendChild(b);
  }
  row.append(close, send);
  panel.append(q, scale, note, row);
  root.append(style, btn, panel);
  btn.onclick = (): void => { panel.hidden = !panel.hidden; };
  close.onclick = (): void => { panel.hidden = true; };
  send.onclick = (): void => {
    if (score == null) return;
    send.disabled = true;
    const body = JSON.stringify({ publicKey: o.publicKey, website: o.website, sessionId: o.sessionId, kind: o.cfg.kind, score,
      comment: note.value.trim().slice(0, 1000) || null, path: location.pathname });
    fetch(o.endpoint + '/v1/replay/feedback?pk=' + encodeURIComponent(o.publicKey),
      { method: 'POST', body, headers: { 'Content-Type': 'text/plain' }, credentials: 'omit', mode: 'cors', keepalive: true })
      .catch(() => undefined);
    panel.replaceChildren(el('p', 't', o.cfg.thanks));
    setTimeout(() => { host.remove(); }, 2500);
  };
  (document.body || document.documentElement).appendChild(host);
  return () => host.remove();
}
