import { describe, expect, it } from 'vitest';
import { createLogger, parseLogLevel, type Level } from '../src/logger.js';

describe('parseLogLevel', () => {
  it('defaults to info', () => {
    expect(parseLogLevel(undefined)).toBe('info');
    expect(parseLogLevel('  ')).toBe('info');
  });
  it('is case-insensitive', () => {
    expect(parseLogLevel('DEBUG')).toBe('debug');
  });
  it('rejects unknown values', () => {
    expect(() => parseLogLevel('loud')).toThrow(/LOG_LEVEL/);
  });
});

describe('createLogger', () => {
  const capture = (level: Level) => {
    const lines: Array<{ line: string; level: Level }> = [];
    const log = createLogger(level, (line, lvl) => lines.push({ line, level: lvl }));
    return { log, lines };
  };

  it('drops lines below the level', () => {
    const { log, lines } = capture('warn');
    log.info('no');
    log.warn('w');
    log.error('e');
    expect(lines.map((l) => l.level)).toEqual(['warn', 'error']);
  });

  it('emits one JSON object with ts, level, msg and fields, and no app key', () => {
    const { log, lines } = capture('warn');
    log.warn('x', { a: 1 });
    const obj = JSON.parse(lines[0]!.line);
    expect(Number.isNaN(Date.parse(obj.ts))).toBe(false);
    expect(obj).toMatchObject({ level: 'warn', msg: 'x', a: 1 });
    expect(obj).not.toHaveProperty('app');
  });

  it('does not let fields override reserved keys', () => {
    const { log, lines } = capture('info');
    log.info('m', { level: 'error', msg: 'z', ts: 'bad' });
    const obj = JSON.parse(lines[0]!.line);
    expect(obj.level).toBe('info');
    expect(obj.msg).toBe('m');
    expect(obj.ts).not.toBe('bad');
  });

  it('setLevel changes filtering', () => {
    const { log, lines } = capture('error');
    log.setLevel('debug');
    log.debug('d');
    expect(lines).toHaveLength(1);
  });
});
