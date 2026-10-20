import type { ServerResponse } from 'node:http';
import { drainBody } from '../http.js';

/** Escapes text for HTML bodies and quoted attribute values. */
export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Nothing is loaded from anywhere but this host, the Google Fonts CDN and data: images.
// No inline script or style is allowed, so the theme switch and the look live in /assets.
export const CSP =
  "default-src 'none'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; " +
  "script-src 'self'; img-src 'self' data:; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";

/** The headers every dashboard answer carries, page or redirect. */
export function securityHeaders(): Record<string, string> {
  return {
    'Content-Security-Policy': CSP,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'no-store',
  };
}

/** Wraps page content in the document shell and writes it with the security headers. */
export function sendPage(res: ServerResponse, status: number, title: string, inner: string): void {
  if (res.headersSent) return;
  const html =
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>${escapeHtml(title)}</title></head><body>${inner}</body></html>`;
  drainBody(res);
  res.writeHead(status, {
    ...securityHeaders(),
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(html),
  });
  res.end(res.req.method === 'HEAD' ? undefined : html);
}

/** A 302 to another page. Carries the same headers, and never a body that could leak what was asked for. */
export function redirectTo(res: ServerResponse, location: string): void {
  if (res.headersSent) return;
  drainBody(res);
  res.writeHead(302, { ...securityHeaders(), Location: location, 'Content-Length': 0 });
  res.end();
}

export interface SignInView {
  /** The code just tried was wrong or already used. */
  wrongCode: boolean;
  /** This address has failed too often and is waiting out the block. */
  blocked: boolean;
}

/** The only page a signed-out browser is shown. It says nothing about what is stored. */
export function signInPage(res: ServerResponse, v: SignInView): void {
  const note = v.blocked
    ? `<p role="alert">Too many wrong codes. Try again in 15 minutes.</p>`
    : v.wrongCode
      ? `<p role="alert">That code is wrong or has expired.</p>`
      : '';
  sendPage(
    res,
    v.blocked ? 429 : 200,
    'Sign in - context-hub',
    `<main><h1>context-hub</h1>
${note}
<form method="post" action="/login" autocomplete="off">
<label for="code">Sign-in code</label>
<p>Run hub connect on your PC to get one.</p>
<input type="text" id="code" name="code" required autocomplete="off" autocapitalize="characters" spellcheck="false">
<button type="submit">Sign in</button>
</form></main>`,
  );
}

/** Answers an action that failed its anti-forgery checks, or a POST with no session. */
export function forbiddenPage(res: ServerResponse): void {
  sendPage(res, 403, 'context-hub', `<main><h1>That request was refused</h1><p>Open the dashboard again and retry.</p></main>`);
}
