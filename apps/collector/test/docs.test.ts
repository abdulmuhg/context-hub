import { symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { DocFolder } from '../src/config.js';
import { DOC_PART_MAX, discoverDocs, docId, readDoc, splitDoc } from '../src/docs.js';
import { tempDir, writeRaw } from './helpers.js';

const folderAt = (path: string, exclude: string[] = []): DocFolder => ({ project: 'github.com/me/alpha', path, label: 'knowledge', exclude });

describe('discoverDocs', () => {
  it('finds Markdown files at any depth, skipping hidden and excluded names', () => {
    const dir = tempDir();
    writeRaw(join(dir, 'INDEX.md'), '# Index');
    writeRaw(join(dir, 'tickets', 'T-1.md'), '# T-1');
    writeRaw(join(dir, 'tickets', 'notes.txt'), 'not markdown');
    writeRaw(join(dir, '.git', 'x.md'), 'hidden');
    writeRaw(join(dir, 'archive', 'old.md'), 'excluded');
    const errors: string[] = [];
    const files = discoverDocs([folderAt(dir, ['archive'])], errors);
    expect(files.map((f) => [f.source, f.id, f.project_key]).sort()).toEqual([
      ['doc', 'github.com/me/alpha#knowledge/INDEX.md', 'github.com/me/alpha'],
      ['doc', 'github.com/me/alpha#knowledge/tickets/T-1.md', 'github.com/me/alpha'],
    ]);
    expect(errors).toEqual([]);
  });

  // Windows lets only administrators and Developer Mode create links.
  it.skipIf(process.platform === 'win32')('follows a link to a file but not to a folder', () => {
    const dir = tempDir();
    const elsewhere = tempDir();
    writeRaw(join(elsewhere, 'shared.md'), '# Shared');
    symlinkSync(join(elsewhere, 'shared.md'), join(dir, 'shared.md'));
    symlinkSync(dir, join(dir, 'loop'));
    expect(discoverDocs([folderAt(dir)], []).map((f) => f.id)).toEqual(['github.com/me/alpha#knowledge/shared.md']);
  });

  it('reports a missing folder instead of failing', () => {
    const errors: string[] = [];
    expect(discoverDocs([folderAt('/no/such/folder')], errors)).toEqual([]);
    expect(errors).toEqual(['doc folder /no/such/folder is missing']);
  });

  it('builds the same id from the same folder on every system', () => {
    const f = folderAt(join('/notes', 'kb'));
    expect(docId(f, join('/notes', 'kb', 'tickets', 'T-1.md'))).toBe('github.com/me/alpha#knowledge/tickets/T-1.md');
  });
});

describe('splitDoc', () => {
  it('starts a new part at each heading', () => {
    expect(splitDoc('# Title\nintro\n\n## One\nfirst\n## Two\nsecond')).toEqual(['# Title\nintro', '## One\nfirst', '## Two\nsecond']);
  });

  it('keeps text before the first heading', () => {
    expect(splitDoc('preamble\n# Title\nbody')).toEqual(['preamble', '# Title\nbody']);
  });

  it('cuts a long section at blank lines, then hard, keeping every character', () => {
    const para = 'x'.repeat(DOC_PART_MAX - 10);
    const parts = splitDoc(`## Long\n${para}\n\n${para}\n\n${'y'.repeat(DOC_PART_MAX * 2)}`);
    expect(parts.every((p) => p.length <= DOC_PART_MAX)).toBe(true);
    expect(parts.join('').replace(/\s/g, '').length).toBe(`##Long${para}${para}${'y'.repeat(DOC_PART_MAX * 2)}`.length);
  });

  it('returns nothing for an empty file', () => {
    expect(splitDoc('\n  \n')).toEqual([]);
  });
});

describe('readDoc', () => {
  const read = (name: string, text: string) => {
    const dir = tempDir();
    writeRaw(join(dir, name), text);
    return readDoc(discoverDocs([folderAt(dir)], [])[0]!);
  };

  it('titles the document by its first heading and dates every part by the file', () => {
    const raw = read('T-1.md', '﻿# T-1 login loop\nbody\n## Fix\nchanged the cookie check');
    expect(raw.title).toBe('T-1 login loop');
    expect(raw.messages.map((m) => (m.kind === 'text' ? [m.role, m.text] : null))).toEqual([
      ['user', '# T-1 login loop\nbody'],
      ['user', '## Fix\nchanged the cookie check'],
    ]);
    expect(new Set(raw.messages.map((m) => m.ts)).size).toBe(1);
  });

  it('falls back to the front matter name, then the file name', () => {
    expect(read('memo.md', '---\nname: release-flow\ndescription: x\n---\nbody').title).toBe('release-flow');
    expect(read('plain.md', 'no heading here').title).toBe('plain');
  });
});
