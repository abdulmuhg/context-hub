import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'context-hub-test-'));
}

export function writeRaw(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

export function writeJsonl(path: string, records: unknown[]): void {
  writeRaw(path, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
}
