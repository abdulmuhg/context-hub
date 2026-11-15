import { assetHref } from './assets.js';
import { escapeHtml, head, THEME_BUTTON } from './html.js';

/** Why the waitlist form is shown again. */
export type WaitlistNote = 'invalid' | 'busy' | 'full';

const REPO = 'https://github.com/abdulmuhg/context-hub';

// The same three lines as the README's quick start.
const QUICK_START = [
  'mkdir -p context-hub/backups/status && cd context-hub && curl -fsSLO https://raw.githubusercontent.com/abdulmuhg/context-hub/main/deploy/docker-compose.yml -O https://raw.githubusercontent.com/abdulmuhg/context-hub/main/deploy/Caddyfile',
  'echo "HUB_DOMAIN=hub.example.com" > .env',
  'docker compose up -d',
];

const NOTES: Record<WaitlistNote, string> = {
  invalid: 'That does not look like an email address.',
  busy: 'Too many tries from this address. Try again in 15 minutes.',
  full: 'The waitlist is full right now. Try again later.',
};

// All static text: nothing on this page comes from the database.
const EXAMPLE = `You      where did we leave off on jsonroom?

Claude   From your hub, last synced 2 hours ago:
         - The share-link expiry bug is fixed and merged.
         - Next: rate limiting on the public API. You chose a
           token bucket per key and had started the tests.
         - Open question: whether free rooms expire after 30 days.`;

const TITLE = 'context-hub: your AI assistants forget, your hub does not';
const DESCRIPTION =
  'One private briefing per project, written from your Claude Code, Codex and Antigravity sessions. Self-hosted and open source.';

/** Share and search tags. The address tags are written only when the hub's public address is known. */
function shareTags(origin: string | null): string {
  const meta = (attr: string, name: string, content: string): string => `<meta ${attr}="${name}" content="${escapeHtml(content)}">`;
  let tags =
    meta('name', 'description', DESCRIPTION) +
    meta('property', 'og:title', TITLE) +
    meta('property', 'og:description', DESCRIPTION) +
    meta('property', 'og:type', 'website');
  if (typeof origin === 'string') {
    tags +=
      meta('property', 'og:url', `${origin}/`) +
      meta('property', 'og:image', `${origin}/apple-touch-icon.png`) +
      `<link rel="canonical" href="${escapeHtml(origin)}/">`;
  }
  return tags + meta('name', 'twitter:card', 'summary');
}

/** What /robots.txt says: crawlers may read only the landing page when it is on, nothing otherwise. */
export function robotsTxt(landing: boolean): string {
  return landing ? 'User-agent: *\nAllow: /$\nDisallow: /\n' : 'User-agent: *\nDisallow: /\n';
}

const topBar = (): string =>
  `<header class="landing-bar"><a class="landing-brand" href="/">context-hub</a>` +
  `<a href="${REPO}">GitHub</a><a href="/login">Sign in</a>${THEME_BUTTON}</header>`;

const wholeDocument = (title: string, inner: string, extraHead = ''): string =>
  `<!doctype html><html lang="en"><head>${head(title, [assetHref('/assets/landing.css')], extraHead)}</head><body>${inner}</body></html>`;

const copyRow = (line: string): string =>
  `<div class="copyrow"><pre class="copyline">${escapeHtml(line)}</pre>` +
  `<button type="button" class="copybtn" data-copy="${escapeHtml(line)}">Copy</button></div>`;

/** The page a signed-out visitor sees at / when LANDING is on. A whole HTML document. */
export function landingPage(note?: WaitlistNote, origin: string | null = null): string {
  const alert = note ? `<p role="alert">${NOTES[note]}</p>` : '';
  return wholeDocument(
    TITLE,
    `<main class="landing">${topBar()}
<section class="landing-hero">
<h1>Your AI assistants forget. Your hub does not.</h1>
<p class="lede">One private briefing per project, written from your Claude Code, Codex and Antigravity sessions. Any assistant, on any computer, picks up where the last one stopped.</p>
<div class="landing-buttons"><a class="button primary" href="#self-host">Self-host in 3 commands</a><a class="button" href="#waitlist">Join the hosted waitlist</a></div>
<div class="card landing-example"><span class="tag">Example</span><pre>${escapeHtml(EXAMPLE)}</pre></div>
</section>
<section>
<h2>How it works</h2>
<ol class="landing-steps">
<li><strong>Sync</strong><span>The hub command finds your AI sessions for the projects you choose.</span></li>
<li><strong>Summarise</strong><span>Claude Code on your own computer writes a short summary. Secrets are stripped before anything is uploaded.</span></li>
<li><strong>Ask</strong><span>Any assistant connected to your hub reads the project's briefing: Claude Code, claude.ai, desktop or mobile.</span></li>
</ol>
</section>
<section>
<h2>Private by design</h2>
<ul class="landing-points">
<li>Runs on your own server.</li>
<li>Secrets and card numbers are stripped on your computer, and again on the server.</li>
<li>Nothing is uploaded until you say yes to a project.</li>
<li>Open source, MIT licensed.</li>
</ul>
</section>
<section id="self-host">
<h2>Self-host in 3 commands</h2>
<p>You need a Linux server with Docker and a domain name pointing at it.</p>
${QUICK_START.map(copyRow).join('\n')}
<p>Then run <code>docker compose exec context-hub hub-admin setup</code> for your sign-in code and the line that connects your first computer.</p>
<p><a href="${REPO}/blob/main/deploy/README.md">Full guide</a></p>
</section>
<section id="questions">
<h2>Questions</h2>
<details><summary>What gets uploaded?</summary><p>Only the projects you say yes to. For each AI session in them, the hub gets the conversation and a short summary of it, with tokens, keys and passwords stripped out first. The files in your repository are not uploaded, unless you add a notes folder yourself.</p></details>
<details><summary>Which assistants does it work with?</summary><p>Sessions are collected from Claude Code, Codex and Antigravity. They can then be read from Claude Code, claude.ai, Claude desktop and mobile, or another tool that speaks MCP.</p></details>
<details><summary>What does it cost?</summary><p>The software is free. You pay for a small server. Summaries are written by Claude Code on your own computer and count against your Claude plan, so the hub needs no API key.</p></details>
<details><summary>Can a team share one hub?</summary><p>Not yet. A hub has no separate users: everyone with access sees everything in it. For now, run one hub per person.</p></details>
<details><summary>What if I stop using it?</summary><p><code>hub forget &lt;project&gt;</code> deletes a project from the hub, and removing the server removes everything. The files on your computer are never touched.</p></details>
</section>
<section id="waitlist">
<h2>Hosted hub</h2>
<p>A hosted hub, with nothing to run yourself, is not open yet. Leave your email and we will tell you when it is.</p>
${alert}
<form method="post" action="/waitlist" class="waitlist">
<label for="waitlist-email">Email</label>
<input type="email" id="waitlist-email" name="email" required maxlength="254" autocomplete="email">
<button type="submit">Join waitlist</button>
</form>
<p class="muted">We use your email only to tell you when the hosted hub opens. Ask to be removed at any time.</p>
</section>
<footer class="landing-footer"><a href="${REPO}">GitHub</a><a href="${REPO}/blob/main/docs/using.md">Docs</a><a href="${REPO}/blob/main/SECURITY.md">Security</a></footer>
</main>`,
    shareTags(origin),
  );
}

/** Shown after a waitlist post. It never shows the address that was entered. */
export function waitlistThanksPage(): string {
  return wholeDocument(
    'You are on the list - context-hub',
    `<main class="landing">${topBar()}
<section class="landing-hero landing-thanks">
<h1>You are on the list</h1>
<p class="lede">We will email you when the hosted hub opens. Until then, you can self-host in three commands.</p>
<p><a href="/#self-host">Self-host in 3 commands</a></p>
</section>
</main>`,
    '<meta name="robots" content="noindex">',
  );
}
