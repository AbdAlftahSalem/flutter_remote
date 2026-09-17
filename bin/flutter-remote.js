#!/usr/bin/env node
import { main } from '../src/cli.js';
import { red, bold } from '../src/lib/ui.js';

main(process.argv.slice(2)).catch((err) => {
  console.error(`\n${red(bold('Error:'))} ${err.message}\n`);
  process.exit(1);
});
