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
    // Not no-referrer: with it, browsers send `Origin: null` on form posts, and the Origin
    // check on sign-in and every action then refuses the owner's own forms. same-origin still
    // sends nothing to other sites.
    'Referrer-Policy': 'same-origin',
    'Cache-Control': 'no-store',
  };
}

/** The head every page shares. The script sits in the head, unblocked by layout, so a stored theme applies before first paint. */
function head(title: string): string {
  return (
    `<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>${escapeHtml(title)}</title>` +
    `<link rel="stylesheet" href="/assets/app.css">` +
    `<script src="/assets/app.js"></script>`
  );
}

/** Writes a finished document with the security headers. */
export function sendDocument(res: ServerResponse, status: number, html: string): void {
  if (res.headersSent) return;
  drainBody(res);
  res.writeHead(status, {
    ...securityHeaders(),
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(html),
  });
  res.end(res.req.method === 'HEAD' ? undefined : html);
}

/** Wraps page content in the bare document shell (no sidebar) and writes it. */
export function sendPage(res: ServerResponse, status: number, title: string, inner: string): void {
  sendDocument(res, status, `<!doctype html><html lang="en"><head>${head(title)}</head><body>${inner}</body></html>`);
}

export type NavKey = 'overview' | 'activity' | 'projects' | 'sign-ins';

const NAV: ReadonlyArray<{ key: NavKey; href: string; label: string }> = [
  { key: 'overview', href: '/', label: 'Overview' },
  { key: 'activity', href: '/activity', label: 'Activity' },
  { key: 'projects', href: '/projects', label: 'Projects' },
  { key: 'sign-ins', href: '/sign-ins', label: 'Sign-ins' },
];

/**
 * The signed-in page: sidebar with the four pages and Sign out, a header with the theme switch and
 * the phone menu button, then `body`. `body` is trusted HTML the caller has already escaped.
 */
export function pageShell(o: { title: string; active: NavKey; csrf: string; body: string }): string {
  const links = NAV.map(
    (n) => `<a href="${n.href}"${n.key === o.active ? ' aria-current="page"' : ''}>${n.label}</a>`,
  ).join('');
  return (
    `<!doctype html><html lang="en"><head>${head(`${o.title} - context-hub`)}</head><body><div class="layout">` +
    `<aside class="sidebar" id="sidebar"><div class="brand">context-hub</div><nav class="nav" aria-label="Pages">${links}</nav>
` +
    `<form method="post" action="/logout"><input type="hidden" name="csrf" value="${escapeHtml(o.csrf)}"><button type="submit">Sign out</button></form></aside>` +
    `<div class="main"><header class="topbar"><button type="button" class="menu-button" data-menu-toggle aria-controls="sidebar" aria-expanded="false">Menu</button>` +
    `<span class="topbar-title">${escapeHtml(o.title)}</span>` +
    `<div class="topbar-actions"><button type="button" data-theme-toggle aria-label="Switch between light and dark theme">Theme</button></div></header>` +
    `<main class="content">${o.body}</main></div></div></body></html>`
  );
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
    `<main class="signin"><h1>context-hub</h1>
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
