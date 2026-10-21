import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join, relative, sep } from 'node:path';
import { emptyRaw, isFileEntry, pushText, sessionFile, type RawSession, type SessionFile } from './adapters/types.js';
import type { DocFolder } from './config.js';

/** A part longer than this is cut at a blank line, so search hits and pages stay small. */
export const DOC_PART_MAX = 8000;

/** "<project key>#<label>/<path inside the folder>", with forward slashes on every system. */
export function docId(folder: DocFolder, file: string): string {
  return `${folder.project}#${folder.label}/${relative(folder.path, file).split(sep).join('/')}`;
}

function walk(dir: string, exclude: readonly string[], out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || exclude.includes(entry.name)) continue;
    const p = join(dir, entry.name);
    // Linked folders are not followed, so a link cannot loop back on itself.
    if (entry.isDirectory()) walk(p, exclude, out);
    else if (entry.name.toLowerCase().endsWith('.md') && isFileEntry(dir, entry)) out.push(p);
  }
}

/** Every Markdown file under the folders, each already filed under its folder's project. */
export function discoverDocs(folders: readonly DocFolder[], errors: string[]): SessionFile[] {
  const out: SessionFile[] = [];
  for (const folder of folders) {
    if (!existsSync(folder.path)) {
      errors.push(`doc folder ${folder.path} is missing`);
      continue;
    }
    const paths: string[] = [];
    walk(folder.path, folder.exclude, paths);
    for (const p of paths) out.push({ ...sessionFile('doc', p, docId(folder, p), null), project_key: folder.project });
  }
  return out;
}

/** Splits at headings, then cuts a part that is still too long at blank lines. */
export function splitDoc(text: string): string[] {
  const sections: string[] = [];
  let current: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (/^#{1,3}\s/.test(line) && current.some((l) => l.trim() !== '')) {
      sections.push(current.join('\n'));
      current = [];
    }
    current.push(line);
  }
  sections.push(current.join('\n'));

  const parts: string[] = [];
  for (const section of sections) {
    let part = '';
    for (const block of section.split(/\n(?=\s*\n)/)) {
      if (part !== '' && part.length + block.length > DOC_PART_MAX) {
        parts.push(part);
        part = '';
      }
      part = part === '' ? block : `${part}\n${block}`;
      while (part.length > DOC_PART_MAX) {
        parts.push(part.slice(0, DOC_PART_MAX));
        part = part.slice(DOC_PART_MAX);
      }
    }
    parts.push(part);
  }
  return parts.map((p) => p.trim()).filter((p) => p !== '');
}

export function readDoc(file: SessionFile): RawSession {
  const raw = emptyRaw(file);
  const text = readFileSync(file.path, 'utf8').replace(/^\uFEFF/, '');
  const heading = /^#\s+(.+)$/m.exec(text)?.[1]?.trim();
  const named = /^---\r?\n(?:(?!---).*\r?\n)*?name:\s*(.+)\r?\n/.exec(text)?.[1]?.trim();
  raw.title = heading || named || basename(file.path, '.md');
  const ts = new Date(file.mtimeMs).toISOString();
  for (const part of splitDoc(text)) pushText(raw, 'user', ts, part);
  return raw;
}
