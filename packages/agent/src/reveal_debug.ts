// `?prynt_debug=1` panel (PRD ON-3): a small fixed box, inline styles only (no external CSS, no
// network), re-rendered every second from diagnose(). Built as an HTML string to stay tiny.
import type { RevealDiagnostics } from './index';

const esc = (s: unknown): string => String(s).replace(/[&<>]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'));

export function mountDebug(diag: () => RevealDiagnostics): () => void {
  let el: HTMLElement;
  try {
    el = document.createElement('div');
    el.id = 'prynt-debug';
    el.style.cssText = 'position:fixed;z-index:2147483647;right:12px;bottom:12px;width:300px;font:12px/1.6 monospace;background:#14161a;color:#eee;border-radius:8px;padding:10px 12px';
    document.body.appendChild(el);
  } catch { return () => { /* no DOM */ }; }
  const render = (): void => {
    const d = diag();
    const ls = d.lastSend;
    const rows: [string, unknown, boolean?][] = [
      ['loaded', d.loaded, !d.loaded], ['key', d.publicKey || 'missing', !d.publicKey], ['website', d.website],
      ['consent', d.consent + ' · ' + d.consentSource], ['cmp', d.cmpDetected || 'none'],
      ['storage', d.storage, d.storage === 'blocked'], ['gpc', d.gpc], ['cspBlocked', d.cspBlocked, d.cspBlocked],
      ['queued', d.queued],
      ['lastSend', ls ? (ls.error || ls.status || 'beacon') + ' · ' + ls.accepted + ' ok · ' + ls.at.slice(11, 19) : 'none yet', !!(ls && ls.error)],
    ];
    el.innerHTML = '<b>Prynt Reveal ' + esc(d.sdkVersion) + '</b><span data-x="1" style="float:right;cursor:pointer">✕</span>'
      + rows.map(([k, v, bad]) => '<div><span style="color:#8b93a1">' + k + '</span> <span' + (bad ? ' style="color:#ff6b6b"' : '') + '>' + esc(v) + '</span></div>').join('')
      + '<a href="https://pryntid.com/docs/reveal/csp-and-storage" target="_blank" style="color:#6cb6ff">CSP &amp; storage docs ↗</a>';
  };
  render();
  const t = setInterval(render, 1000);
  const stop = (): void => { clearInterval(t); try { el.remove(); } catch { /* gone */ } };
  try { el.addEventListener('click', (e) => { if ((e.target as HTMLElement).getAttribute('data-x')) stop(); }); } catch { /* ignore */ }
  return stop;
}
