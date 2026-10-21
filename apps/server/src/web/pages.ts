import { countActivity, listActivity, type Action, type ActivityRow, type Direction } from '../activity.js';
import type { Db } from '../db.js';
import type { HubScope } from '../oauth/config.js';
import { listGrants, type CodePurpose } from '../oauth/store.js';
import { getProject, listProjects, projectName, resolveProject } from '../store.js';
import { listTokens } from '../tokens.js';
import { formatUsd } from '../usage.js';
import { computeHealth, type Health, type Problem } from './health.js';
import { escapeHtml, pageShell } from './html.js';
import { renderMarkdown } from './markdown.js';
import type { WebConfig } from './routes.js';
import { listBrowsers } from './session.js';

/** How many activity rows the Overview shows before the link to the Activity page. */
const OVERVIEW_ACTIVITY_ROWS = 10;

/** How many rows a page of the Activity log holds (global constraint). */
export const ACTIVITY_ROWS = 50;

/** How many recent sessions and notes a project page lists. */
const PROJECT_SESSIONS = 10;

/**
 * A stored time as a `<time>` element with UTC text; app.js rewrites the text to the browser's
 * local time and "x ago". A value we cannot read is shown as plain escaped text.
 */
export function timeTag(iso: string, mode: TimeMode = 'stack'): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return `<span class="mono">${escapeHtml(iso)}</span>`;
  const s = d.toISOString();
  const form = mode === 'stack' ? '' : ` data-time="${mode}"`;
  return `<time datetime="${escapeHtml(s)}"${form}>${s.slice(0, 10)} ${s.slice(11, 16)} UTC</time>`;
}

/**
 * How app.js writes a time: `stack` (table cells: short time with "x ago" below), `inline`
 * (short time · x ago, inside a sentence), `when` (short time only), `ago` (x ago only).
 */
export type TimeMode = 'stack' | 'inline' | 'when' | 'ago';

/** A number card: a small label, one large value, and an optional muted line under it. */
const card = (label: string, value: string, sub = '', tone = ''): string =>
  `<div class="card stat"><span class="stat-label">${label}</span>` +
  `<span class="stat-value${tone ? ` ${tone}` : ''}">${value}</span>` +
  (sub === '' ? '' : `<span class="stat-sub">${sub}</span>`) +
  `</div>`;

/** One problem or notice: the escaped text, then its time where the rule has one. */
const line = (p: Problem, suffix = ''): string =>
  `<li>${escapeHtml(p.text)}${p.at === undefined ? '' : ` <span class="muted">${timeTag(p.at, 'inline')}</span>`}${suffix}</li>`;

function spendCard(h: Health): string {
  const { today, month } = h.cards.spend;
  if (month.calls === 0) return card('Model spend', '$0.00', 'No model calls recorded yet');
  const calls = `${today.calls} call${today.calls === 1 ? '' : 's'} today`;
  return card('Model spend', formatUsd(today.micro_usd), `${calls} · ${formatUsd(month.micro_usd)} in 30 days`);
}

function cards(h: Health): string {
  const sync = h.cards.lastSync;
  const backup = h.cards.lastBackup;
  const offsite =
    backup === null
      ? ''
      : !backup.offsite_configured
        ? 'no off-site storage'
        : backup.offsite_ok === true
          ? 'copied off-site'
          : '<span class="bad">not copied off-site</span>';
  const count = h.problems.length;
  return (
    `<section class="cards">` +
    card(
      'Status',
      h.healthy ? 'Healthy' : 'Needs attention',
      h.healthy ? 'No problems found' : `${count} problem${count === 1 ? '' : 's'} below`,
      h.healthy ? 'ok' : 'bad',
    ) +
    card('Projects', String(h.cards.projects)) +
    card('Sessions', String(h.cards.sessions)) +
    (sync === null
      ? card('Last sync', '—', 'No sync reported yet')
      : card('Last sync', timeTag(sync.finishedAt, 'ago'), `${timeTag(sync.finishedAt, 'when')} · ${sync.uploaded} uploaded`)) +
    (backup === null
      ? card('Last backup', '—', 'No backup status yet')
      : card('Last backup', timeTag(backup.finished_at, 'ago'), `${timeTag(backup.finished_at, 'when')} · ${offsite}`)) +
    spendCard(h) +
    `</section>`
  );
}

const DIRECTION: Record<Direction, string> = { in: 'saved in', out: 'read out' };

/**
 * The What column: a plain name for every stored action, so no tool name reaches the page.
 * `upload` is the exception: its text counts the sessions in the row (see `collapse`).
 */
const WHAT: Record<Action, string> = {
  upload: 'session',
  delete: 'deleted',
  note: 'note',
  sync: 'sync',
  list_projects: 'project list',
  get_project: 'read page',
  search: 'search',
  get_session: 'read session',
};

/** One line of the table: a row, and how many uploads were folded into it. */
interface ActivityItem {
  row: ActivityRow;
  sessions: number;
  /** The time of the oldest row folded in, which the next row is measured against. */
  oldestAt: string;
}

/** Uploads to one project by one actor less than this apart are one line. */
const COLLAPSE_MS = 2 * 60_000;

/**
 * Folds a run of consecutive `upload` rows for the same project and actor into one line.
 * Rows arrive newest first, so each is measured against the oldest one folded in so far;
 * a different project, actor or action, or a longer gap, starts a new line. Only the rows
 * on the page being rendered are folded, never across a page boundary.
 */
function collapse(rows: ActivityRow[]): ActivityItem[] {
  const out: ActivityItem[] = [];
  for (const row of rows) {
    const last = out[out.length - 1];
    const gap = last === undefined ? NaN : Date.parse(last.oldestAt) - Date.parse(row.at);
    if (
      last !== undefined &&
      row.action === 'upload' &&
      last.row.action === 'upload' &&
      last.row.projectKey === row.projectKey &&
      last.row.actor === row.actor &&
      gap >= 0 &&
      gap <= COLLAPSE_MS
    ) {
      last.sessions += 1;
      last.oldestAt = row.at;
      continue;
    }
    out.push({ row, sessions: 1, oldestAt: row.at });
  }
  return out;
}

/** One table row, shared by the Overview and the Activity page so both read alike. */
/**
 * One table row, shared by the Overview and the Activity page so both read alike. The action is a
 * small tag; the text beside it says what happened. Uploads folded together read "3 sessions" with
 * the newest title under it, since one title would misdescribe the rest.
 */
function activityRow(item: ActivityItem): string {
  const r = item.row;
  // An upload's tag is its count ("3 sessions"); every other action's tag is its plain name.
  const label =
    r.action === 'upload' ? `${item.sessions} session${item.sessions === 1 ? '' : 's'}` : (WHAT[r.action] ?? r.action);
  const tag = `<span class="tag">${escapeHtml(label)}</span>`;
  const text =
    r.detail === null
      ? ''
      : r.action === 'upload' && item.sessions > 1
        ? `<span class="muted">latest:</span> ${escapeHtml(r.detail)}`
        : escapeHtml(r.detail);
  const project =
    r.projectKey === null
      ? '<span class="muted">—</span>'
      : `<a href="/projects/${escapeHtml(encodeURIComponent(r.projectKey))}" title="${escapeHtml(r.projectKey)}">${escapeHtml(projectName(r.projectKey))}</a>`;
  return (
    `<tr><td>${timeTag(r.at)}</td><td class="muted">${DIRECTION[r.direction]}</td>` +
    `<td class="what">${tag}${text}</td>` +
    `<td>${project}</td><td>${escapeHtml(r.actor)}</td></tr>`
  );
}

function activityTable(rows: ActivityRow[]): string {
  if (rows.length === 0) return `<p class="muted">Nothing yet.</p>`;
  const body = collapse(rows).map(activityRow).join('');
  return (
    `<div class="table-wrap"><table><thead><tr><th>Time</th><th>Direction</th><th>What</th><th>Project</th><th>By</th></tr></thead>` +
    `<tbody>${body}</tbody></table></div>`
  );
}

/** The Overview page (spec 3.2): the five cards, the problems, recent activity and the version. */
export function overviewPage(db: Db, cfg: WebConfig, now: string, csrf: string): string {
  const health = computeHealth(db, cfg, now);
  const rows = listActivity(db, { limit: OVERVIEW_ACTIVITY_ROWS, offset: 0 });
  const problems =
    health.problems.length === 0
      ? ''
      : `<section class="card problems"><h2>Problems</h2><ul>${health.problems.map((p) => line(p)).join('')}</ul></section>`;
  // Refused summaries are shown apart from the problems, because nothing here can clear them.
  const notices =
    health.notices.length === 0
      ? ''
      : `<section class="card"><h2>Notices</h2><ul>${health.notices
          .map((p) => line(p, ` <span class="muted">won't be retried until the session changes</span>`))
          .join('')}</ul></section>`;
  const version =
    cfg.imageTag === null
      ? `<p class="footnote">Server started ${timeTag(cfg.startedAt, 'inline')}</p>`
      : `<p class="footnote">Running <code>${escapeHtml(cfg.imageTag)}</code> · started ${timeTag(cfg.startedAt, 'inline')}</p>`;
  return pageShell({
    title: 'Overview',
    active: 'overview',
    csrf,
    body:
      `<h1>Overview</h1>` +
      cards(health) +
      problems +
      notices +
      `<section class="card"><h2>Recent activity</h2>${activityTable(rows)}<p class="card-foot"><a href="/activity">All activity</a></p></section>` +
      version,
  });
}

/** What the Activity page was asked for. Anything that is not a page or a direction is ignored. */
export interface ActivityQuery {
  direction: Direction | null;
  /** 1 or more; a request for a page past the end is clamped to the last one. */
  page: number;
}

/**
 * Reads `?direction=` and `?page=` leniently: a bad value is the default, never an error, so no
 * hand-typed address can answer anything but a page. Only plain digits are a page number.
 */
export function parseActivityQuery(params: URLSearchParams): ActivityQuery {
  const direction = params.get('direction');
  const page = params.get('page') ?? '';
  const n = /^\d+$/.test(page) ? Number(page) : 1;
  return { direction: direction === 'in' || direction === 'out' ? direction : null, page: n >= 1 ? n : 1 };
}

/** The Activity page (spec 3.3): the direction filter, 50 rows and the pager. */
export function activityPage(db: Db, q: ActivityQuery, csrf: string): string {
  const opts = q.direction === null ? {} : { direction: q.direction };
  const pages = Math.max(1, Math.ceil(countActivity(db, opts) / ACTIVITY_ROWS));
  const page = Math.min(q.page, pages);
  const rows = listActivity(db, { ...opts, limit: ACTIVITY_ROWS, offset: (page - 1) * ACTIVITY_ROWS });

  const at = (n: number): string => {
    const p = new URLSearchParams();
    if (q.direction !== null) p.set('direction', q.direction);
    p.set('page', String(n));
    return `/activity?${p}`;
  };
  const filters = ([[null, 'All'], ['in', 'Saved'], ['out', 'Read']] as const)
    .map(([d, label]) => {
      const href = d === null ? '/activity' : `/activity?direction=${d}`;
      return `<a href="${href}"${d === q.direction ? ' aria-current="page"' : ''}>${label}</a>`;
    })
    .join('');
  const pager =
    pages === 1
      ? ''
      : `<nav class="pager" aria-label="Pages of activity">` +
        (page > 1 ? `<a href="${escapeHtml(at(page - 1))}">Newer</a>` : '') +
        `<span class="muted">Page ${page} of ${pages}</span>` +
        (page < pages ? `<a href="${escapeHtml(at(page + 1))}">Older</a>` : '') +
        `</nav>`;

  return pageShell({
    title: 'Activity',
    active: 'activity',
    csrf,
    body:
      `<h1>Activity</h1>` +
      `<p class="intro">What was saved into the hub and read from it, newest first. Kept for 30 days.</p>` +
      `<nav class="filters" aria-label="Filter by direction">${filters}</nav>` +
      `<section class="card">${activityTable(rows)}</section>` +
      pager,
  });
}

/** The Projects page (spec 3.4): one line per project, linking to its briefing. */
export function projectsPage(db: Db, csrf: string): string {
  const projects = listProjects(db);
  const body =
    projects.length === 0
      ? `<p class="muted">No projects yet.</p>`
      : `<div class="table-wrap"><table><thead><tr><th>Project</th><th class="num">Sessions</th><th class="num">Docs</th><th>Last activity</th>` +
        `<th>Last sync</th><th>Summary</th></tr></thead><tbody>` +
        projects
          .map(
            (p) =>
              `<tr><td class="name"><a href="/projects/${escapeHtml(encodeURIComponent(p.key))}">${escapeHtml(p.name)}</a>` +
              `<span class="sub mono">${escapeHtml(p.key)}</span></td>` +
              `<td class="num">${p.session_count}</td>` +
              `<td class="num">${p.doc_count}</td>` +
              `<td>${p.last_activity_at === null ? '' : timeTag(p.last_activity_at)}</td>` +
              `<td>${timeTag(p.last_synced_at)}</td>` +
              `<td>${p.summary === null ? `<span class="muted">No summary yet</span>` : escapeHtml(p.summary)}</td></tr>`,
          )
          .join('') +
        `</tbody></table></div>`;
  return pageShell({ title: 'Projects', active: 'projects', csrf, body: `<h1>Projects</h1><section class="card">${body}</section>` });
}

/** How a session's or note's summary stands. The statuses are a fixed set, not stored text. */
const DIGEST: Record<string, string> = {
  ok: 'ok',
  pending: 'pending',
  failed: 'failed',
  refused: 'refused',
  none: 'covered by its parent',
};

/**
 * One project's briefing (spec 3.4): the state page rendered from its Markdown, then the recent
 * sessions and notes. Returns null when no project has that key, which the caller answers 404.
 */
export function projectPage(db: Db, key: string, csrf: string): string | null {
  const resolved = resolveProject(db, key);
  if (!resolved.ok) return null;
  const view = getProject(db, resolved.id, PROJECT_SESSIONS);

  const state =
    view.state === null
      ? `<section class="card"><p class="muted">No state page yet. One is written after the first summary.</p></section>`
      : `<section class="card"><p class="lead">${escapeHtml(view.state.summary)}</p>` +
        `<div class="state">${renderMarkdown(view.state.body)}</div>` +
        `<p class="footnote card-foot">Written ${timeTag(view.state.updated_at, 'inline')}${
          view.state.stale ? ` &middot; <span class="bad">out of date since a session changed</span>` : ''
        }</p></section>`;

  const recent =
    view.recent.length === 0
      ? `<p class="muted">Nothing yet.</p>`
      : `<div class="table-wrap"><table><thead><tr><th>Title</th><th>Source</th><th>Date</th><th>Summary</th></tr></thead><tbody>` +
        view.recent
          .map(
            (s) =>
              `<tr><td class="name">${escapeHtml(s.title)}<span class="sub mono">${escapeHtml(s.session_id)}</span></td>` +
              `<td><span class="tag">${escapeHtml(s.source)}</span></td>` +
              `<td>${s.last_activity_at === null ? '' : timeTag(s.last_activity_at)}</td>` +
              `<td>${escapeHtml(DIGEST[s.digest_status] ?? s.digest_status)}</td></tr>`,
          )
          .join('') +
        `</tbody></table></div>`;

  const documents =
    view.document_count === 0
      ? ''
      : `<section class="card"><h2>Documents</h2>` +
        `<div class="table-wrap"><table><thead><tr><th>Path</th><th>Title</th><th>Updated</th></tr></thead><tbody>` +
        view.documents
          .map(
            (d) =>
              `<tr><td class="mono">${escapeHtml(d.path)}</td><td>${escapeHtml(d.title)}</td>` +
              `<td>${d.updated_at === null ? '' : timeTag(d.updated_at)}</td></tr>`,
          )
          .join('') +
        `</tbody></table></div>` +
        (view.document_count > view.documents.length
          ? `<p class="footnote card-foot">The ${view.documents.length} most recently changed of ${view.document_count}.</p>`
          : '') +
        `</section>`;

  return pageShell({
    title: view.name,
    active: 'projects',
    csrf,
    body:
      `<h1>${escapeHtml(view.name)}</h1><p class="intro mono">${escapeHtml(view.key)}</p>` +
      state +
      `<section class="card"><h2>Recent sessions and notes</h2>${recent}</section>` +
      documents +
      `<p class="footnote">Last synced ${timeTag(view.last_synced_at, 'inline')}</p>`,
  });
}

/** What a Claude app is allowed to do, in plain words rather than the stored scope names. */
const PERMISSION: Record<HubScope, string> = {
  'hub.read': 'read',
  'hub.save': 'save notes',
  offline_access: 'stay signed in',
};

/** The kinds of token, named as the PC's `hub` command and an assistant would recognise them. */
const TOKEN_KIND: Record<string, string> = { ingest: 'upload', read: 'read' };

/** A time that may be missing, for a credential that has never been used. */
const maybeTime = (iso: string | null): string => (iso === null ? `<span class="muted">Never</span>` : timeTag(iso));

/** One listed way into the hub. `cells` is trusted HTML the caller has already escaped. */
interface SignInEntry {
  kind: DisconnectKind;
  id: number;
  cells: string[];
  revokedAt: string | null;
}

/**
 * One group of sign-ins as a table. An active entry gets the Disconnect form, which posts the
 * kind and the id and nothing else; a revoked one is greyed, shows when it was revoked and has
 * no button, because there is nothing left to disconnect.
 */
function signInGroup(title: string, headers: string[], entries: SignInEntry[], csrf: string): string {
  if (entries.length === 0) return `<section class="card"><h2>${title}</h2><p class="muted">None.</p></section>`;
  const row = (e: SignInEntry): string => {
    const action =
      e.revokedAt === null
        ? `<form method="post" action="/sign-ins/disconnect">` +
          `<input type="hidden" name="csrf" value="${escapeHtml(csrf)}">` +
          `<input type="hidden" name="kind" value="${e.kind}">` +
          `<input type="hidden" name="id" value="${e.id}">` +
          `<button type="submit" class="danger">Disconnect</button></form>`
        : `<span class="muted">Disconnected ${timeTag(e.revokedAt, 'inline')}</span>`;
    return (
      `<tr${e.revokedAt === null ? '' : ' class="revoked"'}>` +
      e.cells.map((c, i) => `<td${i === 0 ? ' class="name"' : ''}>${c}</td>`).join('') +
      `<td class="actions">${action}</td></tr>`
    );
  };
  const table = (list: SignInEntry[]): string =>
    `<div class="table-wrap"><table><thead><tr>` +
    headers.map((h) => `<th>${h}</th>`).join('') +
    `<th></th></tr></thead><tbody>${list.map(row).join('')}</tbody></table></div>`;
  // Active entries are what matter; disconnected ones fold away under a native toggle (no script).
  const active = entries.filter((e) => e.revokedAt === null);
  const revoked = entries.filter((e) => e.revokedAt !== null);
  const folded =
    revoked.length === 0
      ? ''
      : `<details class="revoked-list"><summary>Show ${revoked.length} disconnected</summary>${table(revoked)}</details>`;
  return (
    `<section class="card"><h2>${title}</h2>` +
    (active.length === 0 ? `<p class="muted">Nothing connected.</p>` : table(active)) +
    folded +
    `</section>`
  );
}

/**
 * The Sign-ins page (spec 3.5): Claude apps, tokens and browsers, each with a Disconnect button.
 * `currentSessionId` is the browser making the request, taken from its cookie, so "this browser"
 * is decided here and never by anything the browser sends.
 */
export function signInsPage(db: Db, csrf: string, currentSessionId: number): string {
  const grants = listGrants(db).map(
    (g): SignInEntry => ({
      kind: 'grant',
      id: g.id,
      cells: [
        escapeHtml(g.clientName),
        g.scopes.map((s) => escapeHtml(PERMISSION[s] ?? s)).join(', '),
        timeTag(g.createdAt),
        maybeTime(g.lastUsedAt),
      ],
      revokedAt: g.revokedAt,
    }),
  );
  const tokens = listTokens(db).map(
    (t): SignInEntry => ({
      kind: 'token',
      id: t.id,
      cells: [
        escapeHtml(t.label),
        `<span class="tag">${escapeHtml(TOKEN_KIND[t.scope] ?? t.scope)}</span>`,
        timeTag(t.created_at),
        maybeTime(t.last_used_at),
      ],
      revokedAt: t.revoked_at,
    }),
  );
  const browsers = listBrowsers(db).map(
    (b): SignInEntry => ({
      kind: 'browser',
      id: b.id,
      cells: [timeTag(b.createdAt), timeTag(b.lastUsedAt), b.id === currentSessionId ? `<span class="tag">this browser</span>` : ''],
      revokedAt: b.revokedAt,
    }),
  );
  return pageShell({
    title: 'Sign-ins',
    active: 'sign-ins',
    csrf,
    body:
      `<h1>Sign-ins</h1><p class="intro">Every way into the hub. Disconnecting asks once more first.</p>` +
      `<form method="post" action="/sign-ins/code" class="actions">` +
      `<input type="hidden" name="csrf" value="${escapeHtml(csrf)}">` +
      `<button type="submit" name="purpose" value="device">Add a computer</button>` +
      `<button type="submit" name="purpose" value="signin">New sign-in code</button></form>` +
      signInGroup('Claude apps', ['Client', 'Permissions', 'Signed in', 'Last used'], grants, csrf) +
      signInGroup('Tokens', ['Label', 'Kind', 'Created', 'Last used'], tokens, csrf) +
      signInGroup('Browsers', ['Signed in', 'Last used', 'Which'], browsers, csrf),
  });
}

/**
 * The page a new one-time code is shown on, once. `hubUrl` is the hub's own origin, or null when
 * none is configured, in which case the install line is left out.
 */
export function codePage(purpose: CodePurpose, code: string, hubUrl: string | null, csrf: string): string {
  const steps =
    purpose === 'device'
      ? (hubUrl === null
          ? `<p>Run <code>hub login --url &lt;this hub's address&gt;</code> on the new computer.</p>`
          : `<p>Run these on the new computer:</p>` +
            `<pre class="copyline">curl -fsSL ${escapeHtml(hubUrl)}/install | sh</pre><pre class="copyline">hub login</pre>`) +
        `<p>Enter this code when hub login asks for it.</p>`
      : `<p>Enter it where claude.ai or another browser asks for a sign-in code.</p>`;
  return pageShell({
    title: purpose === 'device' ? 'Add a computer' : 'New sign-in code',
    active: 'sign-ins',
    csrf,
    body:
      `<h1>${purpose === 'device' ? 'Add a computer' : 'New sign-in code'}</h1>` +
      `<section class="card"><p class="code-value">${escapeHtml(code)}</p>` +
      `<p class="muted">Valid for 10 minutes, for one use.</p>${steps}` +
      `<p><a href="/sign-ins">Back to Sign-ins</a></p></section>`,
  });
}

/** The 400 for a code request that names neither kind of code. */
export function codeRefusedPage(csrf: string): string {
  return pageShell({
    title: 'No code',
    active: 'sign-ins',
    csrf,
    body: `<h1>No code was made</h1><p>Choose Add a computer or New sign-in code. <a href="/sign-ins">Sign-ins</a></p>`,
  });
}

/** The three things a Disconnect can aim at. */
export type DisconnectKind = 'grant' | 'token' | 'browser';

/** A live sign-in a Disconnect may revoke, with the line its confirmation page names. */
export interface DisconnectTarget {
  kind: DisconnectKind;
  id: number;
  /** Whether this is the browser that posted the form, which Disconnect also signs out. */
  isCurrent: boolean;
  /** Trusted HTML: server-owned wording, with only a client name escaped into it. */
  consequence: string;
}

const UPLOAD_CONSEQUENCE = `Your PC's hub sync will stop working until you create a new upload token on the server.`;
const READ_CONSEQUENCE = 'Assistants using this token (for example Claude Code) will lose access to the hub.';

/**
 * Looks up what a Disconnect aims at and what disconnecting it costs. Everything but the kind and
 * the id is read from the database, so a form claiming a different scope changes no wording. Null
 * for an id that is not a plain number, names nothing, or names something already revoked, which
 * the caller answers with the not-found page rather than revoking anything.
 */
export function findDisconnectTarget(db: Db, kind: string, rawId: string, currentSessionId: number): DisconnectTarget | null {
  // Digits only, then matched against rows already read: an id past a safe integer finds nothing
  // rather than reaching a bind parameter. A narrower `WHERE id = ?` here would need its own guard.
  if (!/^\d+$/.test(rawId)) return null;
  const id = Number(rawId);
  if (kind === 'grant') {
    const grant = listGrants(db).find((g) => g.id === id && g.revokedAt === null);
    if (grant === undefined) return null;
    return { kind, id, isCurrent: false, consequence: `${escapeHtml(grant.clientName)} will need to sign in again.` };
  }
  if (kind === 'token') {
    const token = listTokens(db).find((t) => t.id === id && t.revoked_at === null);
    if (token === undefined) return null;
    return { kind, id, isCurrent: false, consequence: token.scope === 'ingest' ? UPLOAD_CONSEQUENCE : READ_CONSEQUENCE };
  }
  if (kind === 'browser') {
    const browser = listBrowsers(db).find((b) => b.id === id && b.revokedAt === null);
    if (browser === undefined) return null;
    const isCurrent = id === currentSessionId;
    return {
      kind,
      id,
      isCurrent,
      consequence: isCurrent ? 'This signs this browser out.' : 'That browser will be signed out.',
    };
  }
  return null;
}

/**
 * The first step of a Disconnect: the consequence, a Disconnect button that carries the same
 * fields plus `confirm`, and a Cancel link back. Nothing is revoked until that second post.
 */
export function disconnectConfirmPage(target: DisconnectTarget, csrf: string): string {
  return pageShell({
    title: 'Disconnect',
    active: 'sign-ins',
    csrf,
    body:
      `<h1>Disconnect this sign-in?</h1>` +
      `<section class="card"><p>${target.consequence}</p>` +
      `<form method="post" action="/sign-ins/disconnect" class="confirm">` +
      `<input type="hidden" name="csrf" value="${escapeHtml(csrf)}">` +
      `<input type="hidden" name="kind" value="${target.kind}">` +
      `<input type="hidden" name="id" value="${target.id}">` +
      `<input type="hidden" name="confirm" value="yes">` +
      `<button type="submit" class="danger">Disconnect</button>` +
      `<a href="/sign-ins">Cancel</a></form></section>`,
  });
}

/** The 404 for a Disconnect that names no live sign-in. It says nothing about what is stored. */
export function disconnectNotFoundPage(csrf: string): string {
  return pageShell({
    title: 'Not found',
    active: 'sign-ins',
    csrf,
    body: `<h1>No such sign-in</h1><p>Nothing was disconnected. <a href="/sign-ins">All sign-ins</a></p>`,
  });
}

/** The 404 for a project key nothing is stored under. It names nothing that is stored. */
export function projectNotFoundPage(csrf: string): string {
  return pageShell({
    title: 'Not found',
    active: 'projects',
    csrf,
    body: `<h1>No such project</h1><p>Nothing is stored under that key. <a href="/projects">All projects</a></p>`,
  });
}
