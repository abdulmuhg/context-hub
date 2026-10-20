import { homedir } from 'node:os';
import { createInterface } from 'node:readline/promises';
import { run, type Io } from './cli.js';
import { hubDir } from './config.js';

const io: Io = {
  home: homedir(),
  hubDir: hubDir(),
  out: (line) => console.log(line),
  err: (line) => console.error(line),
  interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
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
