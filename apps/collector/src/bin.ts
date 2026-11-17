import { homedir } from 'node:os';
import { createInterface } from 'node:readline/promises';
import { run, type Io } from './cli.js';
import { hubDir } from './config.js';
import { createInterruptRegistry } from './interrupt.js';

// One SIGINT listener serves every registered handler, so a nested command cannot exit before the others clean up.
const interrupts = createInterruptRegistry(
  (code) => process.exit(code),
  // The progress line has no newline yet; end it so the message starts on its own line.
  () => {
    if (process.stdout.isTTY) process.stdout.write('\n');
  },
);
process.once('SIGINT', () => interrupts.fire());

const io: Io = {
  home: homedir(),
  hubDir: hubDir(),
  cwd: process.cwd(),
  out: (line) => console.log(line),
  err: (line) => console.error(line),
  interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
  progress: process.stdout.isTTY
    ? (line) => {
        process.stdout.cursorTo(0);
        process.stdout.clearLine(1);
        process.stdout.write(line);
      }
    : undefined,
  onInterrupt: (handler) => interrupts.register(handler),
  ask: async (question) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      return await rl.question(question);
    } finally {
      rl.close();
    }
  },
};

run(process.argv.slice(2), io).then((code) => process.exit(code));
