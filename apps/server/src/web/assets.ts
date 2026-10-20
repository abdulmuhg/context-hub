import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { securityHeaders } from './html.js';
import { ICON_SVG, iconPng } from './icon.js';

// Everything the pages look like and do lives here, because the Content-Security-Policy
// allows no inline style or script. Both files are served as-is, with no build step.

// The fonts are pulled in from here, not from a <link>, so the signed-out page carries no font URL.
// Inter for everything people read; JetBrains Mono only for things that are code (keys, ids, versions).
const CSS = `@import url("https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap");
/* context-hub dashboard */
:root {
  color-scheme: light;
  --bg: #FAFAF9;
  --ink: #18181B;
  --card: #FFFFFF;
  --hairline: #E7E5E4;
  --muted: #78716C;
  --chip: #F5F5F4;
  --success: #15704A;
  --danger: #B42318;
  --radius: 8px;
  --radius-sm: 6px;
  --font-text: "Inter", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  --font-mono: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    color-scheme: dark;
    --bg: #151514;
    --ink: #F5F5F3;
    --card: #1C1C1A;
    --hairline: #2E2E2B;
    --muted: #A8A29E;
    --chip: #262624;
    --success: #2E9E6B;
    --danger: #F04438;
  }
}
:root[data-theme="light"] {
  color-scheme: light;
  --bg: #FAFAF9;
  --ink: #18181B;
  --card: #FFFFFF;
  --hairline: #E7E5E4;
  --muted: #78716C;
  --chip: #F5F5F4;
  --success: #15704A;
  --danger: #B42318;
}
:root[data-theme="dark"] {
  color-scheme: dark;
  --bg: #151514;
  --ink: #F5F5F3;
  --card: #1C1C1A;
  --hairline: #2E2E2B;
  --muted: #A8A29E;
  --chip: #262624;
  --success: #2E9E6B;
  --danger: #F04438;
}

/* One type scale, used the same way on every page:
   page title 22/600, section title 15/600, labels and table headers 12/500 muted,
   body and cells 14/400, card values 24/600. */
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--ink);
  font-family: var(--font-text);
  font-size: 14px;
  line-height: 1.5;
  -webkit-font-smoothing: antialiased;
}
h1, h2, h3, h4 { line-height: 1.3; font-weight: 600; }
h1 { font-size: 22px; letter-spacing: -0.01em; margin: 0 0 20px; }
h2 { font-size: 15px; margin: 0 0 12px; }
h3, h4 { font-size: 14px; margin: 1.2em 0 0.4em; }
p, ul { margin: 0 0 12px; }
ul { padding-left: 1.2em; }
li + li { margin-top: 4px; }
a { color: inherit; text-decoration-color: var(--hairline); text-underline-offset: 3px; }
a:hover { text-decoration-color: currentColor; }
code, .mono { font-family: var(--font-mono); font-size: 12.5px; }
code { background: var(--chip); padding: 1px 5px; border-radius: 4px; }
time { font-variant-numeric: tabular-nums; white-space: nowrap; }
time .ago { color: var(--muted); }
time .ago::before { content: "\\00a0\\00b7\\00a0"; }
td time .ago, .stat time .ago { display: block; font-size: 12.5px; }
td time .ago::before, .stat time .ago::before { content: none; }
.actions { display: flex; flex-wrap: wrap; gap: 8px; margin: 0 0 20px; }
.code-value { font-family: "Inter", system-ui, sans-serif; font-size: 28px; letter-spacing: 0.12em; font-weight: 600; margin: 0 0 8px; }
.copyline { font-family: var(--font-mono); font-size: 12.5px; background: var(--chip); border-radius: 4px; padding: 8px 10px; margin: 0 0 8px; overflow-x: auto; user-select: all; }
.muted { color: var(--muted); }
.ok { color: var(--success); }
.bad { color: var(--danger); }
.intro { color: var(--muted); margin: -12px 0 20px; }
.tag {
  display: inline-block;
  font-size: 12px;
  font-weight: 500;
  line-height: 18px;
  padding: 0 7px;
  border-radius: 4px;
  background: var(--chip);
  color: var(--ink);
  margin-right: 8px;
  white-space: nowrap;
}

:focus-visible { outline: 2px solid var(--ink); outline-offset: 2px; }

button, .button {
  font: inherit;
  font-weight: 500;
  color: var(--ink);
  background: var(--card);
  border: 1px solid var(--hairline);
  border-radius: var(--radius-sm);
  padding: 0 14px;
  cursor: pointer;
  min-height: 36px;
}
button:hover, .button:hover { border-color: var(--muted); }
button.danger { color: var(--danger); }
.icon-button { width: 36px; padding: 0; display: inline-flex; align-items: center; justify-content: center; }
.icon-button svg { width: 18px; height: 18px; }
/* The theme button shows where a click goes: a moon in light mode, a sun in dark mode. */
.icon-sun { display: none; }
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) .icon-sun { display: block; }
  :root:not([data-theme="light"]) .icon-moon { display: none; }
}
:root[data-theme="dark"] .icon-sun { display: block; }
:root[data-theme="dark"] .icon-moon { display: none; }
input[type="text"], input[type="search"], select {
  font: inherit;
  color: var(--ink);
  background: var(--card);
  border: 1px solid var(--hairline);
  border-radius: var(--radius-sm);
  padding: 0 12px;
  min-height: 40px;
  max-width: 100%;
}

.card {
  background: var(--card);
  border: 1px solid var(--hairline);
  border-radius: var(--radius);
  padding: 20px;
  margin: 0 0 16px;
}
table { width: 100%; border-collapse: collapse; }
th, td { text-align: left; padding: 10px 12px; border-bottom: 1px solid var(--hairline); vertical-align: top; }
th { color: var(--muted); font-weight: 500; font-size: 12px; padding-top: 0; white-space: nowrap; }
tbody tr:last-child td { border-bottom: 0; }
th:first-child, td:first-child { padding-left: 0; }
th:last-child, td:last-child { padding-right: 0; }
td.name { font-weight: 500; }
td .sub { display: block; color: var(--muted); font-size: 12.5px; font-weight: 400; margin-top: 2px; }
td .sub.mono { font-size: 12px; }
.table-wrap { overflow-x: auto; }

/* Layout: sidebar and content */
.layout { display: flex; min-height: 100vh; }
.sidebar {
  width: 220px;
  flex: none;
  background: var(--card);
  border-right: 1px solid var(--hairline);
  padding: 20px 12px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.brand { font-size: 15px; font-weight: 600; padding: 0 10px 16px; letter-spacing: -0.01em; }
.nav { display: flex; flex-direction: column; gap: 2px; }
.nav a {
  display: block;
  padding: 7px 10px;
  border-radius: var(--radius-sm);
  text-decoration: none;
  color: var(--muted);
  font-weight: 500;
}
.nav a:hover { color: var(--ink); }
.nav a[aria-current="page"] { color: var(--ink); background: var(--chip); }
.sidebar form { margin-top: auto; padding-top: 16px; }
.sidebar form button { width: 100%; }
.main { flex: 1; min-width: 0; }
.topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 32px;
  border-bottom: 1px solid var(--hairline);
  min-height: 57px;
}
.topbar-title { color: var(--muted); font-weight: 500; }
.topbar-actions { display: flex; gap: 8px; margin-left: auto; }
.menu-button { display: none; }
.content { padding: 32px; }

/* Overview: the number cards and the problems box */
.cards {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 16px;
  margin: 0 0 16px;
}
.cards .card { margin: 0; display: flex; flex-direction: column; gap: 6px; padding: 16px 20px; }
.stat-label { color: var(--muted); font-size: 12px; font-weight: 500; }
.stat-value { font-size: 24px; font-weight: 600; line-height: 1.2; letter-spacing: -0.01em; font-variant-numeric: tabular-nums; }
.stat-value.ok { color: var(--success); }
.stat-value.bad { color: var(--danger); }
.stat-sub { color: var(--muted); font-size: 12.5px; }
.problems { border-color: var(--danger); }
.problems h2 { color: var(--danger); }
.card ul { margin: 0; }
.card-foot { margin: 12px 0 0; }
.footnote { color: var(--muted); font-size: 12.5px; }

/* Activity: the direction filter and the pager */
.filters { display: flex; flex-wrap: wrap; gap: 8px; margin: 0 0 16px; }
.filters a {
  padding: 5px 12px;
  border: 1px solid var(--hairline);
  border-radius: var(--radius-sm);
  text-decoration: none;
  color: var(--muted);
  font-weight: 500;
}
.filters a:hover { color: var(--ink); }
.filters a[aria-current="page"] { color: var(--ink); background: var(--card); }
.pager { display: flex; align-items: center; gap: 16px; margin: 0 0 16px; }
th.num, td.num { text-align: right; font-variant-numeric: tabular-nums; }
td.what { min-width: 240px; }

/* Projects: the state page rendered from its Markdown */
.state { margin: 0 0 12px; }
.state > :first-child { margin-top: 0; }
.state > :last-child { margin-bottom: 0; }
.state h1, .state h2 { font-size: 15px; margin: 20px 0 8px; }
.state h3, .state h4 { font-size: 14px; }
.lead { font-size: 15px; margin-bottom: 16px; }

/* Sign-ins: active entries first; disconnected ones fold away */
td.actions { text-align: right; white-space: nowrap; }
td.actions form { margin: 0; }
tr.revoked, tr.revoked a { color: var(--muted); }
tr.revoked td.name { font-weight: 400; }
details.revoked-list { margin-top: 12px; }
details.revoked-list summary { color: var(--muted); cursor: pointer; font-size: 13px; font-weight: 500; }
details.revoked-list[open] summary { margin-bottom: 8px; }
.confirm { display: flex; flex-wrap: wrap; align-items: center; gap: 16px; }

/* Sign-in */
.signin { max-width: 360px; margin: 14vh auto 0; padding: 0 16px; }
.signin form { display: flex; flex-direction: column; gap: 10px; }
.signin label { font-weight: 500; }
.signin p { color: var(--muted); margin: 0; }
.signin input[type="text"] { font-family: var(--font-mono); letter-spacing: 0.1em; text-transform: uppercase; }
.signin [role="alert"] { color: var(--danger); }

/* Phone: the sidebar hides behind the menu button. Without scripting it stays visible. */
@media (max-width: 767px) {
  .layout { flex-direction: column; }
  .topbar { padding: 10px 16px; }
  .content { padding: 20px 16px; }
  .menu-button { display: inline-flex; align-items: center; }
  .sidebar { width: auto; border-right: 0; border-bottom: 1px solid var(--hairline); }
  html.js .sidebar { display: none; }
  html.js body.nav-open .sidebar { display: flex; }
  .cards { grid-template-columns: 1fr 1fr; }
}
`;

const JS = `(function () {
  'use strict';
  var root = document.documentElement;
  root.classList.add('js');

  // Theme: the stored choice wins; without one the page follows prefers-color-scheme through CSS.
  try {
    var saved = localStorage.getItem('hub-theme');
    if (saved === 'light' || saved === 'dark') root.setAttribute('data-theme', saved);
  } catch (e) { /* storage blocked: keep the system default */ }

  function effectiveTheme() {
    var set = root.getAttribute('data-theme');
    if (set === 'light' || set === 'dark') return set;
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  function timeAgo(then, now) {
    var s = Math.round((now - then) / 1000);
    if (s < 0) s = 0;
    if (s < 45) return 'just now';
    var m = Math.round(s / 60);
    if (m < 60) return m + ' min ago';
    var h = Math.round(m / 60);
    if (h < 24) return h + ' h ago';
    var d = Math.round(h / 24);
    if (d < 60) return d + ' d ago';
    return Math.round(d / 30) + ' mo ago';
  }

  function sameDay(a, b) {
    return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  }
  function clock(t) { return t.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }); }
  function day(t, now) {
    var o = { month: 'short', day: 'numeric' };
    if (t.getFullYear() !== now.getFullYear()) o.year = 'numeric';
    return t.toLocaleDateString(undefined, o);
  }
  // Today shows only the clock; an older time shows the day, and the clock too where there is room.
  function short(t, now, withClock) {
    if (sameDay(t, now)) return clock(t);
    return withClock ? day(t, now) + ', ' + clock(t) : day(t, now);
  }

  // data-time picks the form: none (table cells and cards: short time, "x ago" below it),
  // "inline" (short time · x ago), "when" (short time only), "ago" (x ago only).
  function localiseTimes() {
    var now = new Date();
    var els = document.querySelectorAll('time[datetime]');
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      var t = new Date(el.getAttribute('datetime'));
      if (isNaN(t.getTime())) continue;
      var mode = el.getAttribute('data-time') || 'stack';
      var ago = timeAgo(t.getTime(), now.getTime());
      el.textContent = '';
      if (mode === 'ago') {
        el.textContent = ago;
      } else if (mode === 'when') {
        el.textContent = short(t, now, true);
      } else {
        el.appendChild(document.createTextNode(short(t, now, mode === 'inline')));
        var small = document.createElement('span');
        small.className = 'ago';
        small.textContent = ago;
        el.appendChild(small);
      }
      el.setAttribute('title', t.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }));
    }
  }

  function wire() {
    var themeButton = document.querySelector('[data-theme-toggle]');
    if (themeButton) {
      themeButton.addEventListener('click', function () {
        var next = effectiveTheme() === 'dark' ? 'light' : 'dark';
        root.setAttribute('data-theme', next);
        try { localStorage.setItem('hub-theme', next); } catch (e) { /* not saved */ }
      });
    }
    var menuButton = document.querySelector('[data-menu-toggle]');
    if (menuButton) {
      menuButton.addEventListener('click', function () {
        var open = document.body.classList.toggle('nav-open');
        menuButton.setAttribute('aria-expanded', open ? 'true' : 'false');
      });
    }
    localiseTimes();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
  else wire();
})();
`;

const FILES: Record<string, { type: string; body: string | Buffer }> = {
  '/assets/app.css': { type: 'text/css; charset=utf-8', body: CSS },
  '/assets/app.js': { type: 'text/javascript; charset=utf-8', body: JS },
  // The app icon. Browsers fetch /favicon.ico by habit, so it is served there too (as a PNG,
  // which every browser accepts at that address). The home-screen icon is a full square: phones
  // round the corners themselves.
  '/favicon.svg': { type: 'image/svg+xml', body: ICON_SVG },
  '/favicon.ico': { type: 'image/png', body: iconPng(32) },
  '/apple-touch-icon.png': { type: 'image/png', body: iconPng(180, 0) },
};

export const isAsset = (path: string): boolean => Object.hasOwn(FILES, path);

/**
 * Serves a stylesheet, script or icon. Needs no session, and keeps long-lived caching instead of
 * `no-store`. Icons skip the page CSP: it would forbid the SVG's own style block, and an image
 * runs no script anyway.
 */
export function serveAsset(req: IncomingMessage, res: ServerResponse, path: string): void {
  const file = FILES[path]!;
  const headers = file.type.startsWith('image/')
    ? { 'X-Content-Type-Options': 'nosniff' }
    : securityHeaders();
  res.writeHead(200, {
    ...headers,
    'Cache-Control': 'public, max-age=604800',
    'Content-Type': file.type,
    'Content-Length': Buffer.byteLength(file.body),
  });
  res.end(req.method === 'HEAD' ? undefined : file.body);
}

/**
 * The address a page links an asset by. The query carries a fingerprint of the file, so a deploy
 * that changes it gets a new address and no browser keeps last week's copy from its cache.
 */
const FINGERPRINT: Record<string, string> = Object.fromEntries(
  Object.entries(FILES).map(([path, f]) => [
    path,
    // Letters only: the signed-out page must carry no numbers, so the fingerprint uses a to p.
    [...createHash('sha256').update(f.body).digest().subarray(0, 8)].map((b) => String.fromCharCode(97 + (b % 16))).join(''),
  ]),
);
export const assetHref = (path: '/assets/app.css' | '/assets/app.js' | '/favicon.svg'): string => `${path}?v=${FINGERPRINT[path]}`;
