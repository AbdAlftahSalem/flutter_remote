/**
 * Flutter Remote Doctor Command
 *
 * Verifies system prerequisites:
 *   - Node, Git, GitHub CLI & Auth
 *   - Flutter & iOS project integrity
 *   - Xcode & iOS Simulator environment
 *   - serve-sim availability
 *   - FFmpeg & H.264 Encoder (VideoToolbox / libx264 detection)
 *   - WebRTC (node-datachannel) & TURN configuration
 *   - Cloudflare tunnel
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { sh, has } from '../lib/proc.js';
import { assertFlutterProject, getFlutterAppName, getFlutterBundleId } from '../lib/flutter-project.js';
import { WORKFLOW_PATH, GATE_PATH } from './init.js';
import { detectH264Encoder } from '../media/EncoderDetector.js';
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
  } else if (!sh('gh', ['auth', 'status'], { timeout: 4000 }).ok) {
    add(FAIL, 'GitHub authenticated', 'Run: gh auth login');
  } else {
    const user = sh('gh', ['api', 'user', '-q', '.login'], { timeout: 4000 });
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
    '.nameWithOwner + " (" + .visibility + ")"'], { cwd, timeout: 4000 });
  if (repo.ok && repo.out) {
    const isPublic = /PUBLIC/i.test(repo.out);
    add(isPublic ? PASS : WARN, 'GitHub remote', isPublic ? repo.out : `${repo.out} — private repos bill macOS minutes at 10×`);
  } else {
    add(WARN, 'GitHub remote', 'none yet — flutter-remote up will create one');
  }

  // 7. Xcode & Simulator environment
  if (process.platform === 'darwin') {
    if (has('xcodebuild')) {
      const xcVer = sh('xcodebuild', ['-version']);
      add(PASS, 'Xcode', xcVer.out ? xcVer.out.split('\n')[0] : 'installed');
    } else {
      add(FAIL, 'Xcode', 'not installed (required on local macOS)');
    }
    if (has('xcrun')) {
      const simCheck = sh('xcrun', ['simctl', 'help']);
      add(simCheck.ok ? PASS : FAIL, 'iOS Simulator (simctl)', simCheck.ok ? 'available' : 'not found');
    }
  } else {
    add(PASS, 'Xcode & iOS Simulator', 'managed by remote macOS GitHub Actions runner');
  }

  // 8. serve-sim
  if (has('serve-sim')) {
    add(PASS, 'serve-sim', 'installed globally');
  } else {
    add(PASS, 'serve-sim', 'cached & executed via npx on macOS runner');
  }

  // 9. FFmpeg & H.264 Encoder capability detection
  let ffmpegBin = 'ffmpeg';
  try {
    const ffmpegStatic = await import('ffmpeg-static');
    ffmpegBin = ffmpegStatic.default || ffmpegStatic || 'ffmpeg';
  } catch {}

  try {
    const enc = await detectH264Encoder(ffmpegBin);
    if (enc.isHardware && enc.verified) {
      add(PASS, 'H.264 Encoder', `${enc.name} (Apple VideoToolbox Hardware Accelerated — Runtime Verified)`);
    } else if (enc.isHardware) {
      add(PASS, 'H.264 Encoder', `${enc.name} (Apple VideoToolbox Hardware Accelerated)`);
    } else if (enc.hardwareUnavailableReason) {
      add(WARN, 'H.264 Encoder', `libx264 software fallback (VideoToolbox unverified: ${enc.hardwareUnavailableReason})`);
    } else {
      add(PASS, 'H.264 Encoder', `${enc.name} (software libx264 zerolatency)`);
    }
  } catch (err) {
    add(WARN, 'H.264 Encoder', 'libx264 fallback');
  }

  // 10. WebRTC & TURN checks
  try {
    await import('node-datachannel');
    add(PASS, 'WebRTC (node-datachannel)', 'available');
  } catch (err) {
    add(WARN, 'WebRTC (node-datachannel)', 'installed automatically on macOS runner');
  }

  const turnConfigured = Boolean(process.env.FLUTTER_REMOTE_TURN_KEY_ID && process.env.FLUTTER_REMOTE_TURN_KEY_TOKEN);
  if (turnConfigured) {
    add(PASS, 'TURN relay credentials', 'configured');
  } else {
    add(WARN, 'TURN relay credentials', 'unconfigured (using free Cloudflare STUN fallback, run: flutter-remote turn)');
  }

  // 11. Cloudflare tunnel check
  if (has('cloudflared') || existsSync(join(cwd, 'cloudflared'))) {
    add(PASS, 'Cloudflare tunnel (cloudflared)', 'available');
  } else {
    add(PASS, 'Cloudflare tunnel (cloudflared)', 'cached & downloaded on macOS runner');
  }

  // 12. Local Flutter info (optional)
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
