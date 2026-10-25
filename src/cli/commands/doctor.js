/**
 * `flutter-remote doctor`: every prerequisite, each with a fix.
 * Exits 3 when something blocks `flutter-remote up`, 0 otherwise.
 */
import { runAllChecks } from '../../core/preflight.js';
import { EXIT } from '../../core/errors.js';
import { green, red, yellow, dim, bold, cyan } from '../../core/ui.js';

const ICON = { pass: green('✓'), warn: yellow('!'), fail: red('✗') };

export function printChecks(groups) {
  for (const { group, checks } of groups) {
    console.log(`\n${bold(group)}`);
    for (const c of checks) {
      console.log(`  ${ICON[c.status]} ${c.label}${c.detail ? `  ${dim(c.detail)}` : ''}`);
      if (c.status !== 'pass' && c.fix) console.log(`      ${cyan('→')} ${c.fix}`);
    }
  }
}

export async function doctor(cwd) {
  console.log(`\n${bold('flutter-remote doctor')}`);
  const groups = runAllChecks(cwd);
  printChecks(groups);

  const all = groups.flatMap((g) => g.checks);
  const failed = all.filter((c) => c.status === 'fail').length;
  const warned = all.filter((c) => c.status === 'warn').length;
  console.log('');
  if (failed) {
    console.log(red(bold(`${failed} problem(s) must be fixed before flutter-remote up.`)));
    process.exitCode = EXIT.PREREQUISITE;
  } else {
    console.log(green(bold(`Ready: run flutter-remote up${warned ? ` (${warned} note(s) above)` : ''}`)));
  }
  console.log(dim('The iOS Simulator, Xcode, FFmpeg and WebRTC run on the GitHub macOS runner; nothing to install for them here.'));
  console.log('');
}
