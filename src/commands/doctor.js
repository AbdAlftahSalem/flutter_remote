import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { sh, has } from '../lib/proc.js';
import { assertFlutterProject, getFlutterAppName, getFlutterBundleId } from '../lib/flutter-project.js';
import { WORKFLOW_PATH, GATE_PATH } from './init.js';
import { green, red, yellow, dim, bold } from '../lib/ui.js';

const PASS = green('✓');
const FAIL = red('✗');
const WARN = yellow('!');

export async function doctor(cwd) {
  const checks = [];
  const add = (icon, label, detail) => checks.push(`  ${icon} ${label}${detail ? ` ${dim(detail)}` : ''}`);

  console.log(`\n${bold('Flutter Remote Doctor')}\n`);

  // 1. Flutter project checks
  try {
    const config = assertFlutterProject(cwd);
    const appName = getFlutterAppName(cwd);
    add(PASS, 'Flutter project', appName || config.name);
    add(PASS, 'pubspec.yaml', config.version ? `v${config.version}` : 'found');
    const bundleId = getFlutterBundleId(cwd);
    add(PASS, 'iOS project directory', bundleId ? `bundle: ${bundleId}` : 'found');
  } catch (err) {
    add(FAIL, 'Flutter project', err.message.split('\n')[0]);
  }

  // 2. Git check
  add(has('git') ? PASS : FAIL, 'Git installed');

  // 3. GitHub CLI check
  if (!has('gh')) {
    add(FAIL, 'GitHub CLI installed', 'Install: https://cli.github.com or winget install GitHub.cli');
  } else if (!sh('gh', ['auth', 'status']).ok) {
    add(FAIL, 'GitHub authenticated', 'Run: gh auth login');
  } else {
    const user = sh('gh', ['api', 'user', '-q', '.login']);
    add(PASS, 'GitHub authenticated', user.out ? `@${user.out}` : 'logged in');
  }

  // 4. Node.js check
  const [major] = process.versions.node.split('.').map(Number);
  add(major >= 20 ? PASS : FAIL, 'Node.js >= 20', `v${process.versions.node}`);

  // 5. Workflow and gate templates
  add(existsSync(join(cwd, WORKFLOW_PATH)) ? PASS : WARN, WORKFLOW_PATH,
    existsSync(join(cwd, WORKFLOW_PATH)) ? '' : 'run flutter-remote init');
  add(existsSync(join(cwd, GATE_PATH)) ? PASS : WARN, GATE_PATH,
    existsSync(join(cwd, GATE_PATH)) ? '' : 'run flutter-remote init');

  // 6. GitHub remote
  const repo = sh('gh', ['repo', 'view', '--json', 'nameWithOwner,visibility', '-q',
    '.nameWithOwner + " (" + .visibility + ")"'], { cwd });
  if (repo.ok && repo.out) {
    const isPublic = /PUBLIC/i.test(repo.out);
    add(isPublic ? PASS : WARN, 'GitHub remote', isPublic ? repo.out : `${repo.out} — private repos bill macOS minutes at 10×`);
  } else {
    add(WARN, 'GitHub remote', 'none yet — flutter-remote up will create one');
  }

  // 7. Optional local Flutter info
  if (has('flutter')) {
    const flVer = sh('flutter', ['--version']);
    const firstLine = flVer.out.split('\n')[0].replace('•', '-');
    add(PASS, 'Local Flutter (optional)', firstLine);
  } else {
    add(PASS, 'Local Flutter (optional)', 'not installed (not required for remote simulator)');
  }

  console.log(checks.join('\n'));
  console.log('');
}
