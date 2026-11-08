export type Level = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export function parseLogLevel(raw: string | undefined): Level {
  const v = raw?.trim().toLowerCase();
  if (!v) return 'info';
  if (v in ORDER) return v as Level;
  throw new Error(`LOG_LEVEL must be one of: debug, info, warn, error (got "${raw}")`);
}

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  setLevel(l: Level): void;
}

const defaultWrite = (line: string, level: Level): void => {
  const stream = level === 'warn' || level === 'error' ? process.stderr : process.stdout;
  stream.write(line + '\n');
};

export function createLogger(
  level: Level,
  write: (line: string, level: Level) => void = defaultWrite,
): Logger {
  let current = level;
  const emit = (lvl: Level, msg: string, fields?: Record<string, unknown>): void => {
    if (ORDER[lvl] < ORDER[current]) return;
    const obj: Record<string, unknown> = { ts: '', level: lvl, msg, ...fields };
    obj.ts = new Date().toISOString();
    obj.level = lvl;
    obj.msg = msg;
    write(JSON.stringify(obj), lvl);
  };
  return {
    debug: (m, f) => emit('debug', m, f),
    info: (m, f) => emit('info', m, f),
    warn: (m, f) => emit('warn', m, f),
    error: (m, f) => emit('error', m, f),
    setLevel: (l) => {
      current = l;
    },
  };
}

export const logger: Logger = createLogger('info');

/**
 * For the older plain-string `log(line)` call sites (worker, uploads): picks a
 * level from the wording, so failures reach Grafana as warn/error, not info.
 */
export function levelOfLine(line: string): Level {
  if (/unexpected error|activity log failed/i.test(line)) return 'error';
  if (/\bfailed\b|refused/i.test(line)) return 'warn';
  return 'info';
}

export function lineSink(l: Logger = logger): (line: string) => void {
  return (line) => l[levelOfLine(line)](line);
}
