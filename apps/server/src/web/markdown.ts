import { escapeHtml } from './html.js';

// A private-use pair that cannot appear in escaped text, used to park finished fragments
// (code spans, anchors) so later passes cannot reach into them.
const OPEN = '';
const CLOSE = '';

// One level of balanced parentheses is allowed inside a link target, so `(x)` in a URL survives.
const LINK = /\[([^\]\n]+)\]\(\s*((?:[^()\s]|\([^()\s]*\))*)\s*\)/g;

function inline(escaped: string): string {
  const parked: string[] = [];
  const park = (html: string): string => {
    parked.push(html);
    return `${OPEN}${parked.length - 1}${CLOSE}`;
  };
  const bold = (s: string): string => s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');

  let s = escaped.replace(/`([^`\n]+)`/g, (_m, code: string) => park(`<code>${code}</code>`));
  // The target is already escaped, so it cannot close the attribute. Only http(s) becomes an anchor.
  s = s.replace(LINK, (_m, text: string, url: string) =>
    /^https?:\/\//i.test(url) ? park(`<a href="${url}" rel="noopener noreferrer">${bold(text)}</a>`) : bold(text),
  );
  s = bold(s);
  // Parked fragments may hold earlier parked fragments (a code span in link text), so restore until none are left.
  const restore = new RegExp(`${OPEN}(\\d+)${CLOSE}`, 'g');
  while (s.includes(OPEN)) s = s.replace(restore, (_m, i: string) => parked[Number(i)] ?? '');
  return s;
}

/**
 * Renders stored Markdown as HTML. The text is escaped first, so nothing in it can become a tag;
 * the few constructs below are then built from the escaped text. Supported: `#` to `####`
 * headings, paragraphs, one-level `-`/`*` lists, `**bold**`, `` `code` `` and http(s) links.
 * Any other link shows its text only.
 */
export function renderMarkdown(md: string): string {
  const lines = escapeHtml(md.replace(/[\0]/g, '')).split(/\r?\n/);
  const out: string[] = [];
  let para: string[] = [];
  let items: string[] = [];

  const endPara = (): void => {
    if (para.length > 0) out.push(`<p>${inline(para.join(' '))}</p>`);
    para = [];
  };
  const endList = (): void => {
    if (items.length > 0) out.push(`<ul>${items.map((i) => `<li>${inline(i)}</li>`).join('')}</ul>`);
    items = [];
  };

  for (const line of lines) {
    const heading = /^(#{1,4})\s+(.+?)\s*$/.exec(line);
    const item = /^\s*[-*]\s+(.+?)\s*$/.exec(line);
    if (heading) {
      endPara();
      endList();
      const n = heading[1]!.length;
      out.push(`<h${n}>${inline(heading[2]!)}</h${n}>`);
    } else if (item) {
      endPara();
      items.push(item[1]!);
    } else if (line.trim() === '') {
      endPara();
      endList();
    } else {
      endList();
      para.push(line.trim());
    }
  }
  endPara();
  endList();
  return out.join('\n');
}
