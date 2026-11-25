import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ANTIGRAVITY_SKILLS, SLASH_COMMANDS } from '../src/commands.js';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'integrations', 'claude-code');
const AGY_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'integrations', 'antigravity', 'skills');

describe('SLASH_COMMANDS', () => {
  it('has exactly the six files in integrations/claude-code, byte for byte', () => {
    const files = readdirSync(DIR).filter((f) => f.endsWith('.md')).sort();
    expect(files).toEqual(['hub-auto.md', 'hub-catchup.md', 'hub-note.md', 'hub-status.md', 'hub-sync.md', 'hub-track.md']);
    expect(Object.keys(SLASH_COMMANDS).sort()).toEqual(files);
    for (const f of files) expect(SLASH_COMMANDS[f]).toBe(readFileSync(join(DIR, f), 'utf8'));
  });

  it('/hub-auto may only run hub auto on, off or status, and /hub-status reports automatic sync', () => {
    const auto = SLASH_COMMANDS['hub-auto.md']!;
    const allowed = /allowed-tools: (.*)/.exec(auto)![1]!;
    expect(allowed.split(', ').sort()).toEqual(['Bash(hub auto off:*)', 'Bash(hub auto on:*)', 'Bash(hub auto status:*)']);
    expect(auto).toContain('run nothing');
    expect(SLASH_COMMANDS['hub-status.md']).toContain('hub auto status');
  });

  it('/hub-sync runs plain hub sync, saying it is the slash command, with no project argument', () => {
    const text = SLASH_COMMANDS['hub-sync.md']!;
    expect(text).toContain('Run `hub sync --trigger slash`.');
    expect(text).not.toContain('--project');
    expect(text).not.toContain('$ARGUMENTS');
  });
});

describe('ANTIGRAVITY_SKILLS', () => {
  it('has exactly the six skills in integrations/antigravity/skills, byte for byte', () => {
    const dirs = readdirSync(AGY_DIR).sort();
    expect(dirs).toEqual(['hub-auto', 'hub-catchup', 'hub-note', 'hub-status', 'hub-sync', 'hub-track']);
    expect(Object.keys(ANTIGRAVITY_SKILLS).sort()).toEqual(dirs);
    for (const d of dirs) expect(ANTIGRAVITY_SKILLS[d]).toBe(readFileSync(join(AGY_DIR, d, 'SKILL.md'), 'utf8'));
  });
});
