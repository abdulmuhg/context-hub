import { countActivity, listActivity, type Action, type ActivityRow, type Direction } from '../activity.js';
import type { Db } from '../db.js';
import { getProject, listProjects, resolveProject } from '../store.js';
import { computeHealth, type Health, type Problem } from './health.js';
import { escapeHtml, pageShell } from './html.js';
import { renderMarkdown } from './markdown.js';
import type { WebConfig } from './routes.js';

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
export function timeTag(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return `<span class="mono">${escapeHtml(iso)}</span>`;
  const s = d.toISOString();
  return `<time datetime="${escapeHtml(s)}">${s.slice(0, 10)} ${s.slice(11, 16)} UTC</time>`;
}

const card = (label: string, value: string, tone = ''): string =>
  `<div class="card stat"><span class="stat-label">${label}</span><span class="stat-value${tone ? ` ${tone}` : ''}">${value}</span></div>`;

/** One problem or notice: the escaped text, then its time where the rule has one. */
const line = (p: Problem, suffix = ''): string =>
  `<li>${escapeHtml(p.text)}${p.at === undefined ? '' : ` ${timeTag(p.at)}`}${suffix}</li>`;

function cards(h: Health): string {
  const sync =
    h.cards.lastSync === null
      ? '<span class="muted">No sync reported yet</span>'
      : `${timeTag(h.cards.lastSync.finishedAt)} <span class="muted">${h.cards.lastSync.uploaded} uploaded</span>`;
  const backup =
    h.cards.lastBackup === null
      ? '<span class="muted">No backup status yet</span>'
      : `${timeTag(h.cards.lastBackup.finished_at)} <span class="muted">${
          !h.cards.lastBackup.offsite_configured
            ? 'no off-site storage'
            : h.cards.lastBackup.offsite_ok === true
              ? 'off-site too'
              : 'not off-site'
        }</span>`;
  return (
    `<section class="cards">` +
    card('Status', h.healthy ? 'Healthy' : 'Needs attention', h.healthy ? 'ok' : 'bad') +
    card('Projects', String(h.cards.projects)) +
    card('Sessions', String(h.cards.sessions)) +
    card('Last sync', sync) +
    card('Last backup', backup) +
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
function activityRow(item: ActivityItem): string {
  const r = item.row;
  const what =
    r.action === 'upload' ? `${item.sessions} session${item.sessions === 1 ? '' : 's'}` : (WHAT[r.action] ?? r.action);
  return (
    `<tr><td>${timeTag(r.at)}</td><td>${DIRECTION[r.direction]}</td>` +
    `<td><span class="mono">${escapeHtml(what)}</span>${r.detail === null ? '' : ` ${escapeHtml(r.detail)}`}</td>` +
    `<td>${r.projectKey === null ? '' : escapeHtml(r.projectKey)}</td><td>${escapeHtml(r.actor)}</td></tr>`
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
      ? `<p class="muted">Started ${timeTag(cfg.startedAt)}</p>`
      : `<p class="muted">running <code>${escapeHtml(cfg.imageTag)}</code>, started ${timeTag(cfg.startedAt)}</p>`;
  return pageShell({
    title: 'Overview',
    active: 'overview',
    csrf,
    body:
      `<h1>Overview</h1>` +
      cards(health) +
      problems +
      notices +
      `<section class="card"><h2>Recent activity</h2>${activityTable(rows)}<p><a href="/activity">All activity</a></p></section>` +
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
        (page > 1 ? `<a href="${at(page - 1)}">Newer</a>` : '') +
        `<span class="muted">Page ${page} of ${pages}</span>` +
        (page < pages ? `<a href="${at(page + 1)}">Older</a>` : '') +
        `</nav>`;

  return pageShell({
    title: 'Activity',
    active: 'activity',
    csrf,
    body:
      `<h1>Activity</h1>` +
      `<p class="muted">What was saved in and read out, newest first. Kept for 30 days.</p>` +
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
      : `<div class="table-wrap"><table><thead><tr><th>Project</th><th class="num">Sessions</th><th>Last activity</th>` +
        `<th>Last sync</th><th>Summary</th></tr></thead><tbody>` +
        projects
          .map(
            (p) =>
              `<tr><td><a href="/projects/${escapeHtml(encodeURIComponent(p.key))}">${escapeHtml(p.name)}</a>` +
              `<div class="muted mono">${escapeHtml(p.key)}</div></td>` +
              `<td class="num">${p.session_count}</td>` +
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
      : `<section class="card"><p>${escapeHtml(view.state.summary)}</p>` +
        `<div class="state">${renderMarkdown(view.state.body)}</div>` +
        `<p class="muted">Written ${timeTag(view.state.updated_at)}${
          view.state.stale ? ` &middot; <span class="bad">out of date since a session changed</span>` : ''
        }</p></section>`;

  const recent =
    view.recent.length === 0
      ? `<p class="muted">Nothing yet.</p>`
      : `<div class="table-wrap"><table><thead><tr><th>Title</th><th>Source</th><th>Date</th><th>Summary</th></tr></thead><tbody>` +
        view.recent
          .map(
            (s) =>
              `<tr><td>${escapeHtml(s.title)}<div class="muted mono">${escapeHtml(s.session_id)}</div></td>` +
              `<td><span class="mono">${escapeHtml(s.source)}</span></td>` +
              `<td>${s.last_activity_at === null ? '' : timeTag(s.last_activity_at)}</td>` +
              `<td><span class="mono">${escapeHtml(DIGEST[s.digest_status] ?? s.digest_status)}</span></td></tr>`,
          )
          .join('') +
        `</tbody></table></div>`;

  return pageShell({
    title: view.name,
    active: 'projects',
    csrf,
    body:
      `<h1>${escapeHtml(view.name)}</h1><p class="muted mono">${escapeHtml(view.key)}</p>` +
      state +
      `<section class="card"><h2>Recent sessions and notes</h2>${recent}</section>` +
      `<p class="muted">Last synced ${timeTag(view.last_synced_at)}</p>`,
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
