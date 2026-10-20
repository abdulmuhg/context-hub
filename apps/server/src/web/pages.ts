import { listActivity, type ActivityRow } from '../activity.js';
import type { Db } from '../db.js';
import { computeHealth, type Health, type Problem } from './health.js';
import { escapeHtml, pageShell } from './html.js';
import type { WebConfig } from './routes.js';

/** How many activity rows the Overview shows before the link to the Activity page. */
const OVERVIEW_ACTIVITY_ROWS = 10;

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

const DIRECTION: Record<ActivityRow['direction'], string> = { in: 'saved in', out: 'read out' };

function activityTable(rows: ActivityRow[]): string {
  if (rows.length === 0) return `<p class="muted">Nothing yet.</p>`;
  const body = rows
    .map(
      (r) =>
        `<tr><td>${timeTag(r.at)}</td><td>${DIRECTION[r.direction]}</td><td><span class="mono">${escapeHtml(r.action)}</span>${
          r.detail === null ? '' : ` ${escapeHtml(r.detail)}`
        }</td><td>${r.projectKey === null ? '' : escapeHtml(r.projectKey)}</td><td>${escapeHtml(r.actor)}</td></tr>`,
    )
    .join('');
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
