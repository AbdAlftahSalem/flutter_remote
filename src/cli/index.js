import { readFileSync } from 'node:fs';
import { init } from './commands/init.js';
import { up } from './commands/up.js';
import { status } from './commands/status.js';
import { down } from './commands/down.js';
import { doctor } from './commands/doctor.js';
import { upload } from './commands/upload.js';
import { r2Setup } from './commands/r2.js';
import { turn } from './commands/turn.js';
import { benchmark } from './commands/benchmark.js';
import { parseArgs, validateFlags } from './args.js';
import { HELP } from './help.js';
import { usageError } from '../core/errors.js';

export { parseArgs } from './args.js';

const COMMANDS = { up, init, status, down, doctor, upload, r2: r2Setup, turn, benchmark };

export function version() {
  const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
  return pkg.version;
}

/** Closest command name, for "did you mean" hints. */
function suggest(command) {
  const distance = (a, b) => {
    const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
    for (let j = 1; j <= b.length; j++) d[0][j] = j;
    for (let i = 1; i <= a.length; i++) {
      for (let j = 1; j <= b.length; j++) {
        d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      }
    }
    return d[a.length][b.length];
  };
  const [best] = Object.keys(COMMANDS)
    .map((name) => [name, distance(command, name)])
    .sort((x, y) => x[1] - y[1]);
  return best && best[1] <= 2 ? best[0] : null;
}

export async function main(argv) {
  const { command, flags } = parseArgs(argv);

  if (flags.version) {
    console.log(version());
    return;
  }
  if (flags.help || command === 'help') {
    console.log(HELP);
    return;
  }

  const handler = COMMANDS[command];
  if (!handler) {
    const guess = suggest(command);
    throw usageError(
      `Unknown command "${command}"`,
      guess ? `did you mean: flutter-remote ${guess}` : 'see all commands: flutter-remote --help',
    );
  }

  validateFlags(flags);
  await handler(process.cwd(), flags);
}
