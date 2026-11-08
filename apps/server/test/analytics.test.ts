import { createHash } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { describe, expect, it } from 'vitest';
import { createPageviewCapture, type PageviewEvent } from '../src/analytics.js';

const req = (url: string, method = 'GET'): IncomingMessage => ({ url, method }) as IncomingMessage;
const HTML = 'text/html; charset=utf-8';

function setup(key: string | undefined = 'phc_test') {
  const sent: PageviewEvent[] = [];
  const capture = createPageviewCapture({ key, send: (e) => sent.push(e) });
  return { sent, capture };
}

describe('createPageviewCapture', () => {
  it('sends a pageview for a GET 200 HTML page, with no query string anywhere', () => {
    const { sent, capture } = setup();
    capture(req('/projects?q=secret'), 200, HTML, 'csrf-a');
    expect(sent).toHaveLength(1);
    expect(sent[0]?.event).toBe('$pageview');
    expect(sent[0]?.properties).toEqual({ app: 'context-hub', $current_url: '/projects', $pathname: '/projects' });
  });

  it('collapses a project key so it never leaves the server', () => {
    const { sent, capture } = setup();
    capture(req('/projects/local%3Asecret-app?x=1'), 200, HTML, 'csrf-a');
    expect(sent[0]?.properties).toEqual({ app: 'context-hub', $current_url: '/projects/:key', $pathname: '/projects/:key' });
  });

  it('hashes the per-session random value; signed-out views carry no person profile', () => {
    const { sent, capture } = setup();
    capture(req('/'), 200, HTML, 'random-csrf-value');
    capture(req('/login'), 200, HTML, null);
    expect(sent[0]?.distinctId).toBe(createHash('sha256').update('context-hub:random-csrf-value').digest('hex'));
    expect(JSON.stringify(sent[0])).not.toContain('random-csrf-value');
    expect(sent[0]?.properties.$process_person_profile).toBeUndefined();
    expect(sent[1]?.distinctId).toBe('anonymous');
    expect(sent[1]?.properties.$process_person_profile).toBe(false);
  });

  it('sends nothing for POST, redirects, JSON or without a key', () => {
    const a = setup();
    a.capture(req('/projects', 'POST'), 200, HTML, 'k');
    a.capture(req('/projects'), 302, HTML, 'k');
    a.capture(req('/projects'), 200, 'application/json', 'k');
    a.capture(req('/projects'), 404, HTML, 'k');
    expect(a.sent).toEqual([]);
    const b = setup('');
    b.capture(req('/projects'), 200, HTML, 'k');
    expect(b.sent).toEqual([]);
  });

  it('never throws when sending fails', () => {
    const capture = createPageviewCapture({
      key: 'phc_test',
      send: () => {
        throw new Error('down');
      },
    });
    expect(() => capture(req('/'), 200, HTML, 'k')).not.toThrow();
  });
});
