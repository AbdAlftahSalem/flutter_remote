#!/usr/bin/env node
import { main } from '../src/cli/index.js';
import { red, bold, cyan } from '../src/core/ui.js';

main(process.argv.slice(2)).catch((err) => {
  console.error(`\n${red(bold('Error:'))} ${err.message}`);
  if (err.hint) console.error(`${cyan(bold('Fix:'))}   ${err.hint}`);
  if (process.env.FLUTTER_REMOTE_DEBUG && err.stack) console.error(`\n${err.stack}`);
  console.error('');
  process.exit(err.exitCode ?? 1);
});
