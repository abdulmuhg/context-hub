import type { IncomingMessage, ServerResponse } from 'node:http';
import { securityHeaders } from './html.js';

// Everything the pages look like and do lives here, because the Content-Security-Policy
// allows no inline style or script. Both files are served as-is, with no build step.

// The fonts are pulled in from here, not from a <link>, so the signed-out page carries no font URL.
const CSS = `@import url("https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700&family=Space+Mono:wght@400;700&display=swap");
/* context-hub dashboard */
:root {
  color-scheme: light;
  --bg: #FAFAF9;
  --ink: #18181B;
  --card: #FFFFFF;
  --hairline: #E7E5E4;
  --muted: #78716C;
  --success: #15704A;
  --danger: #B42318;
  --radius: 8px;
  --radius-sm: 6px;
  --font-text: "Plus Jakarta Sans", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  --font-mono: "Space Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    color-scheme: dark;
    --bg: #151514;
    --ink: #F5F5F3;
    --card: #1C1C1A;
    --hairline: #2E2E2B;
    --muted: #A8A29E;
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
  --success: #2E9E6B;
  --danger: #F04438;
}

* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--ink);
  font-family: var(--font-text);
  font-size: 15px;
  line-height: 1.55;
}
h1, h2, h3, h4 { line-height: 1.25; margin: 1.4em 0 0.5em; font-weight: 600; }
h1 { font-size: 1.6rem; margin-top: 0; }
h2 { font-size: 1.2rem; }
h3 { font-size: 1.05rem; }
h4 { font-size: 0.95rem; }
p, ul { margin: 0 0 1em; }
ul { padding-left: 1.3em; }
a { color: inherit; text-decoration-color: var(--muted); text-underline-offset: 2px; }
a:hover { text-decoration-color: currentColor; }
code, time, .mono { font-family: var(--font-mono); font-size: 0.9em; }
code { background: var(--hairline); padding: 0.1em 0.35em; border-radius: var(--radius-sm); }
.muted { color: var(--muted); }
.ok { color: var(--success); }
.bad { color: var(--danger); }

:focus-visible { outline: 2px solid var(--ink); outline-offset: 2px; }

button, .button {
  font: inherit;
  font-weight: 500;
  color: var(--ink);
  background: var(--card);
  border: 1px solid var(--hairline);
  border-radius: var(--radius-sm);
  padding: 0.5em 0.9em;
  cursor: pointer;
  min-height: 40px;
}
button:hover, .button:hover { border-color: var(--muted); }
button.danger { color: var(--danger); }
input[type="text"], input[type="search"], select {
  font: inherit;
  color: var(--ink);
  background: var(--card);
  border: 1px solid var(--hairline);
  border-radius: var(--radius-sm);
  padding: 0.5em 0.7em;
  min-height: 40px;
  max-width: 100%;
}

.card {
  background: var(--card);
  border: 1px solid var(--hairline);
  border-radius: var(--radius);
  padding: 16px 20px;
  margin: 0 0 16px;
}
table { width: 100%; border-collapse: collapse; }
th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--hairline); vertical-align: top; }
th { color: var(--muted); font-weight: 500; font-size: 0.85rem; }
.table-wrap { overflow-x: auto; }

/* Layout: sidebar and content */
.layout { display: flex; min-height: 100vh; }
.sidebar {
  width: 220px;
  flex: none;
  background: var(--card);
  border-right: 1px solid var(--hairline);
  padding: 20px 14px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.brand { font-weight: 700; padding: 0 10px 14px; letter-spacing: -0.01em; }
.nav { display: flex; flex-direction: column; gap: 2px; }
.nav a {
  display: block;
  padding: 8px 10px;
  border-radius: var(--radius-sm);
  text-decoration: none;
  color: var(--muted);
}
.nav a:hover { color: var(--ink); }
.nav a[aria-current="page"] { color: var(--ink); background: var(--bg); font-weight: 600; }
.sidebar form { margin-top: auto; padding-top: 14px; }
.sidebar form button { width: 100%; }
.main { flex: 1; min-width: 0; }
.topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 24px;
  border-bottom: 1px solid var(--hairline);
}
.topbar-title { font-weight: 600; }
.topbar-actions { display: flex; gap: 8px; margin-left: auto; }
.menu-button { display: none; }
.content { padding: 24px; max-width: 1100px; }

/* Overview: the number cards and the problems box */
.cards {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(170px, 1fr));
  gap: 16px;
  margin: 0 0 16px;
}
.cards .card { margin: 0; display: flex; flex-direction: column; gap: 4px; }
.stat-label { color: var(--muted); font-size: 0.85rem; }
.stat-value { font-family: var(--font-mono); font-size: 1.05rem; font-weight: 700; }
.stat-value.ok { color: var(--success); }
.stat-value.bad { color: var(--danger); }
.stat-value .muted { font-weight: 400; font-size: 0.85rem; }
.problems { border-color: var(--danger); }
.problems h2 { color: var(--danger); margin-top: 0; }
.card > h2:first-child { margin-top: 0; }
.card ul { margin: 0; }

/* Activity: the direction filter and the pager */
.filters { display: flex; flex-wrap: wrap; gap: 8px; margin: 0 0 16px; }
.filters a {
  padding: 6px 12px;
  border: 1px solid var(--hairline);
  border-radius: var(--radius-sm);
  text-decoration: none;
  color: var(--muted);
}
.filters a:hover { color: var(--ink); }
.filters a[aria-current="page"] { color: var(--ink); background: var(--card); font-weight: 600; }
.pager { display: flex; align-items: center; gap: 16px; margin: 0 0 16px; }
th.num, td.num { text-align: right; }
td.num { font-family: var(--font-mono); }

/* Projects: the state page rendered from its Markdown */
.state { margin: 0 0 1em; }
.state > :first-child { margin-top: 0; }
.state > :last-child { margin-bottom: 0; }
.state h1, .state h2 { font-size: 1.05rem; }
.state h3, .state h4 { font-size: 0.95rem; }

/* Sign-ins: one table per group, with the Disconnect button in the last column */
td.actions { text-align: right; white-space: nowrap; }
td.actions form { margin: 0; }
tr.revoked, tr.revoked a { color: var(--muted); }
.confirm { display: flex; flex-wrap: wrap; align-items: center; gap: 16px; }

/* Sign-in */
.signin { max-width: 380px; margin: 12vh auto 0; padding: 0 16px; }
.signin form { display: flex; flex-direction: column; gap: 10px; }
.signin label { font-weight: 600; }
.signin input[type="text"] { font-family: var(--font-mono); letter-spacing: 0.08em; }
.signin [role="alert"] { color: var(--danger); }

/* Phone: the sidebar hides behind the menu button. Without scripting it stays visible. */
@media (max-width: 767px) {
  .layout { flex-direction: column; }
  .topbar { padding: 10px 16px; }
  .content { padding: 16px; }
  .menu-button { display: inline-block; }
  .sidebar { width: auto; border-right: 0; border-bottom: 1px solid var(--hairline); }
  html.js .sidebar { display: none; }
  html.js body.nav-open .sidebar { display: flex; }
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

  function localiseTimes() {
    var now = Date.now();
    var els = document.querySelectorAll('time[datetime]');
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      var t = new Date(el.getAttribute('datetime'));
      if (isNaN(t.getTime())) continue;
      var local = t.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
      el.textContent = local + ' \\u00b7 ' + timeAgo(t.getTime(), now);
      el.setAttribute('title', t.toISOString());
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

const FILES: Record<string, { type: string; body: string }> = {
  '/assets/app.css': { type: 'text/css; charset=utf-8', body: CSS },
  '/assets/app.js': { type: 'text/javascript; charset=utf-8', body: JS },
};

export const isAsset = (path: string): boolean => Object.hasOwn(FILES, path);

/** Serves a stylesheet or script. Needs no session, and keeps long-lived caching instead of `no-store`. */
export function serveAsset(req: IncomingMessage, res: ServerResponse, path: string): void {
  const file = FILES[path]!;
  res.writeHead(200, {
    ...securityHeaders(),
    'Cache-Control': 'public, max-age=604800',
    'Content-Type': file.type,
    'Content-Length': Buffer.byteLength(file.body),
  });
  res.end(req.method === 'HEAD' ? undefined : file.body);
}
