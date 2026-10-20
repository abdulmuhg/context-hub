import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SLASH_COMMANDS } from '../src/commands.js';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'integrations', 'claude-code');

describe('SLASH_COMMANDS', () => {
  it('has exactly the five files in integrations/claude-code, byte for byte', () => {
    const files = readdirSync(DIR).filter((f) => f.endsWith('.md')).sort();
    expect(files).toEqual(['hub-catchup.md', 'hub-note.md', 'hub-status.md', 'hub-sync.md', 'hub-track.md']);
    expect(Object.keys(SLASH_COMMANDS).sort()).toEqual(files);
    for (const f of files) expect(SLASH_COMMANDS[f]).toBe(readFileSync(join(DIR, f), 'utf8'));
  });
});
