import { describe, expect, it } from 'vitest';
import { applyReview, GIT_EVIDENCE, sectionBullets, type PageReview } from '../src/page-review.js';

const BODY = [
  '## What this is',
  '',
  'A hub.',
  '',
  '## Current state',
  '',
  '- Part 3 awaits merge.',
  '- Deployed and healthy.',
  '',
  '## Recent decisions',
  '',
  '- Keep history.',
  '',
  '## Open items',
  '',
  '- Confirm the API key is on the server.',
  '- Decide whether to fix the password regex,',
  '  which was slow on large inputs.',
  '- Set up off-box backups.',
  '',
  '## Latest sessions',
  '',
  '- `claude-code:a` (2026-10-20): deploy.',
].join('\n');

const page = { summary: 'Part 3 awaits merge.', body: BODY };
const shown = new Set(['claude-code:a', 'claude-code:b']);
const review = (over: Partial<PageReview>): PageReview => ({ drop_open: [], drop_current: [], summary: '', ...over });

describe('sectionBullets', () => {
  it('lists a section as single lines, joining continuation lines', () => {
    expect(sectionBullets(BODY, 'Open items')).toEqual([
      'Confirm the API key is on the server.',
      'Decide whether to fix the password regex, which was slow on large inputs.',
      'Set up off-box backups.',
    ]);
  });

  it('returns nothing for a missing section', () => {
    expect(sectionBullets(BODY, 'Nope')).toEqual([]);
  });
});

describe('applyReview', () => {
  it('drops the named open items, including their continuation lines, and nothing else', () => {
    const out = applyReview(page, review({ drop_open: [{ item: 1, session_id: 'claude-code:a' }, { item: 2, session_id: 'claude-code:b' }] }), shown);
    expect(sectionBullets(out.body, 'Open items')).toEqual(['Set up off-box backups.']);
    expect(out.body).not.toContain('which was slow');
    expect(out.body).toContain('## Latest sessions');
    expect(out.body).toContain('- Keep history.');
  });

  it('drops contradicted current-state lines', () => {
    const out = applyReview(page, review({ drop_current: [{ item: 1, session_id: 'claude-code:a' }] }), shown);
    expect(sectionBullets(out.body, 'Current state')).toEqual(['Deployed and healthy.']);
  });

  it('replaces the summary with one written from the corrected page', () => {
    expect(applyReview(page, review({ summary: ' Deployed; backups off-box pending. ' }), shown).summary).toBe('Deployed; backups off-box pending.');
  });

  it('keeps the old summary when the review gives none', () => {
    expect(applyReview(page, review({}), shown).summary).toBe('Part 3 awaits merge.');
  });

  it('ignores entries that cite a session it was not shown, or a position that does not exist', () => {
    const out = applyReview(
      page,
      review({ drop_open: [{ item: 1, session_id: 'claude-code:zzz' }, { item: 9, session_id: 'claude-code:a' }, { item: 0, session_id: 'claude-code:a' }] }),
      shown,
    );
    expect(out.body).toBe(BODY);
  });

  it('leaves a page without the sections unchanged', () => {
    const plain = { summary: 's', body: 'No sections here.' };
    expect(applyReview(plain, review({ drop_open: [{ item: 1, session_id: 'claude-code:a' }] }), shown)).toEqual(plain);
  });

  it('keeps a drop that cites git only when git was shown', () => {
    const drop = review({ drop_open: [{ item: 1, session_id: GIT_EVIDENCE }] });
    expect(sectionBullets(applyReview(page, drop, new Set([GIT_EVIDENCE])).body, 'Open items')).toHaveLength(2);
    expect(applyReview(page, drop, shown).body).toBe(BODY);
  });
});
