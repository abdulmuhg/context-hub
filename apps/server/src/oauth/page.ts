import type { ServerResponse } from 'node:http';

/** Escapes text for HTML bodies and quoted attribute values. */
export function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// The form posts to /oauth/authorize, which answers 302 to Claude. Chrome applies
// form-action to that redirect, so Claude's hosts must be listed or sign-in silently breaks.
export const CSP =
  "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; form-action 'self' https://claude.ai https://claude.com";

const CSS = `
body{font-family:system-ui,sans-serif;margin:0;padding:16px;background:#f6f6f4;color:#1c1c1a}
main{max-width:28rem;margin:8vh auto 0;background:#fff;border:1px solid #ddd;border-radius:10px;padding:24px}
h1{font-size:1.3rem;margin:0 0 12px}
p{line-height:1.5}
label{display:block;margin:16px 0 4px;font-weight:600}
.hint{font-size:.9rem;color:#555;margin:0 0 6px}
.check{display:flex;gap:8px;align-items:center;font-weight:400}
input[type=text]{width:100%;box-sizing:border-box;font-size:1.2rem;padding:10px;letter-spacing:.1em;border:1px solid #888;border-radius:6px}
button{margin-top:20px;width:100%;font-size:1rem;padding:12px;border:0;border-radius:6px;background:#1c1c1a;color:#fff}
.err{background:#fdecea;border:1px solid #e0a39c;border-radius:6px;padding:10px}
`;

function document(status: number, res: ServerResponse, inner: string): void {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>context-hub</title><style>${CSS}</style></head><body><main>${inner}</main></body></html>`;
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(html),
    'Content-Security-Policy': CSP,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(html);
}

export function errorPage(res: ServerResponse, status: number, reason: string): void {
  document(status, res, `<h1>This sign-in request can't be used</h1><p>${esc(reason)}</p>`);
}

export interface SignInView {
  clientName: string;
  redirectHost: string;
  /** Parameters repeated as hidden inputs so a retry needs no restart. */
  hidden: Record<string, string>;
  wrongCode: boolean;
}

export function signInPage(res: ServerResponse, v: SignInView): void {
  const hidden = Object.entries(v.hidden)
    .map(([k, val]) => `<input type="hidden" name="${esc(k)}" value="${esc(val)}">`)
    .join('');
  const err = v.wrongCode ? `<p class="err" role="alert">That code is wrong or has expired. Run hub connect for a new one.</p>` : '';
  document(
    200,
    res,
    `<h1>Connect to context-hub</h1>
<p>${esc(v.clientName)} wants to read your project history. After you sign in, you'll be sent back to ${esc(v.redirectHost)}.</p>
${err}
<form method="post" action="/oauth/authorize" autocomplete="off">${hidden}
<label class="check"><input type="checkbox" name="save" value="on" checked> Also allow it to save notes to your projects</label>
<label for="code">Sign-in code</label>
<p class="hint">Run hub connect on your PC to get one.</p>
<input type="text" id="code" name="code" required autocomplete="off" autocapitalize="characters" spellcheck="false">
<button type="submit">Connect</button>
</form>`,
  );
}
