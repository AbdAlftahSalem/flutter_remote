import { randomBytes } from 'node:crypto';
import * as git from '../../core/git.js';
import * as gh from '../../core/gh.js';
import { sleep, open as openUrl } from '../../core/proc.js';
import { getFlutterAppName, detectFlutterVersionRequirement } from '../../core/flutter-project.js';
import { validateAppFile } from '../../core/app-validator.js';
import { scaffold, changed, WORKFLOW_FILE as WORKFLOW, WORKFLOW_PATH } from '../../core/scaffold.js';
import { runUpChecks } from '../../core/preflight.js';
import { saveSession } from '../../core/session.js';
import { r2NotSupported } from '../../core/r2.js';
import * as ghrelease from '../../core/ghrelease.js';
import { FlutterRemoteError, prerequisiteError } from '../../core/errors.js';
import { info, ok, warn, stepper, spinner, bold, dim, cyan, green } from '../../core/ui.js';
import { printScaffoldReport } from './init.js';
import { printChecks } from './doctor.js';

const STREAM_TIMEOUT_MS = 35 * 60 * 1000;

/** Build the workflow_dispatch inputs from CLI flags (wire format: strings). */
export function dispatchInputs(flags, { session, gateToken, mode, flutterVersion, appUrl, appReleaseAsset }) {
  const dartDefines = Array.isArray(flags['dart-define']) ? flags['dart-define'].join(',') : (flags['dart-define'] ?? '');
  const codec = String(flags.codec ?? 'mjpeg').toLowerCase();
  return {
    session,
    gate_token: gateToken,
    minutes: String(flags.minutes ?? 10),
    device: flags.device ?? 'iPhone 17 Pro',
    mode,
    flutter_version: flutterVersion,
    build_mode: flags['build-mode'] ?? 'debug', // the iOS Simulator only runs debug builds
    flavor: flags.flavor ?? '',
    target: flags.target ?? '',
    dart_defines: dartDefines,
    app_url: appUrl,
    app_release_asset: appReleaseAsset,
    export_app: flags.export ? 'true' : 'false',
    agent_device: flags.agent ? 'true' : 'false',
    agent_device_version: '0.20.1',
    transport: flags.transport ?? process.env.FLUTTER_REMOTE_TRANSPORT ?? 'webrtc',
    tunnel_protocol: flags['tunnel-protocol'] ?? 'quic', // falls back to http2 on the runner if UDP is blocked
    codec: codec === 'auto' ? 'mjpeg' : codec,
    // serve-sim streams at native resolution; these three are kept for older workflows.
    max_dimension: String(flags['max-dimension'] ?? 720),
    video_fps: String(flags.fps ?? 20),
    video_quality: String(flags.quality ?? 0.5),
    cache: flags.cache === false ? 'false' : 'true',
    runner: flags.runner ?? 'macos-26',
  };
}

export async function up(cwd, flags = {}) {
  const appFile = flags['app-file'];
  const appRelease = flags['app-release'];
  const mode = flags.app || appFile || appRelease ? 'app' : (flags.mode ?? 'build');
  const steps = stepper(5);

  // 1. Preflight: everything that can fail locally fails here, all at once.
  steps.next('Checking prerequisites');
  if (flags.r2) throw r2NotSupported();
  if (appFile) validateAppFile(appFile);
  const checks = runUpChecks(cwd, { needsFlutterProject: mode !== 'app' });
  const failed = checks.filter((c) => c.status === 'fail');
  if (failed.length) {
    printChecks([{ group: 'Prerequisites', checks: failed }]);
    throw prerequisiteError(`${failed.length} prerequisite(s) missing`, failed[0].fix);
  }
  ok('Node.js, Git, GitHub CLI and project look good');

  // 2. Commit and push the project, with the flutter-remote files.
  steps.next('Pushing your project to GitHub');
  if (!git.isRepo(cwd)) {
    git.init(cwd);
    ok('Created a git repository');
  }
  const branch = git.currentBranch(cwd);
  const message = flags.message ?? `flutter-remote: ${new Date().toISOString()}`;
  const report = scaffold(cwd);
  printScaffoldReport(report);

  if (git.isDirty(cwd) || !git.hasCommits(cwd)) {
    const files = git.changedFiles(cwd);
    git.commitAll(cwd, message);
    ok(`Committed ${files.length} changed file(s) on ${bold(branch)}`);
  } else {
    info(`Nothing new to commit on ${bold(branch)}`);
  }

  let repo = gh.nameWithOwner(cwd);
  if (!repo) {
    const name = flags.repo ?? getFlutterAppName(cwd);
    const isPublic = Boolean(flags.public);
    if (isPublic) {
      warn(`Creating a PUBLIC repository ${bold(name)}: anyone can read this code.`);
    } else {
      warn(`Creating a private repository ${bold(name)}: macOS minutes count 10× (add --public for free minutes).`);
    }
    repo = gh.createRepo(cwd, name, { isPublic, branch });
    ok(`Created ${bold(repo)} and pushed ${bold(branch)}`);
  } else {
    git.push(cwd, branch);
    ok(`Pushed ${bold(branch)} to ${bold(repo)}`);
    if (!gh.isPublicRepo(cwd)) warn(`${bold(repo)} is private: macOS minutes count 10× against your quota`);
  }
  if (changed(report)) ok('flutter-remote workflow is on GitHub');

  let appReleaseAsset = appRelease && appRelease !== true ? appRelease : '';
  if (appFile) {
    const s = spinner(`Uploading ${appFile} to ${repo} releases`);
    const uploaded = ghrelease.upload(cwd, repo, appFile);
    appReleaseAsset = uploaded.asset;
    s.succeed(`Uploaded ${(uploaded.bytes / 1048576).toFixed(1)} MB as ${bold(uploaded.asset)}`);
  }

  // 3. Start the macOS runner.
  steps.next('Starting the macOS runner');
  const reg = spinner('Waiting for GitHub to register the workflow');
  if (await gh.waitForWorkflowRegistration(cwd, repo, WORKFLOW_PATH)) {
    reg.succeed('Workflow registered');
  } else {
    reg.warn('GitHub has not listed the workflow yet; dispatching anyway');
  }

  const sha = git.headSha(cwd);
  const session = randomBytes(4).toString('hex');
  const gateToken = randomBytes(24).toString('base64url');
  const context = `flutter-remote/${session}`;
  const flutterVersion = flags['flutter-version'] ?? (mode === 'build' ? detectFlutterVersionRequirement(cwd) : 'stable');

  await gh.dispatch(cwd, WORKFLOW, branch, dispatchInputs(flags, {
    session, gateToken, mode, flutterVersion, appUrl: flags.app ?? '', appReleaseAsset,
  }));

  const runSpin = spinner('Waiting for the runner to pick up the job');
  let run = null;
  for (let i = 0; i < 30 && !run; i++) {
    run = gh.findRun(cwd, WORKFLOW, session);
    if (!run) await sleep(3000);
  }
  if (run) {
    runSpin.succeed(`Runner started: ${cyan(run.url)}`);
    saveSession(cwd, { session, gateToken, runId: run.databaseId, sha, repo, context, url: run.url });
  } else {
    runSpin.warn(`Could not find the run yet; watch it at https://github.com/${repo}/actions`);
  }

  // 4. Wait for the build and the stream.
  steps.next('Building the app and starting the simulator (first run ~8–12 min, cached runs ~3 min)');
  const wait = spinner('Building on the macOS runner');
  const deadline = Date.now() + STREAM_TIMEOUT_MS;
  let liveUrl = null;
  while (Date.now() < deadline) {
    if (run?.databaseId) {
      const current = gh.getRun(cwd, run.databaseId);
      if (current?.status === 'completed' && current?.conclusion !== 'success') {
        wait.fail(`The runner job ended: ${current.conclusion}`);
        throw new FlutterRemoteError('The build or the simulator failed on the macOS runner', {
          hint: `open the log: ${run.url}   (or: gh run view ${run.databaseId} --log-failed)`,
        });
      }
    }
    const status = gh.readStatus(cwd, repo, sha, context);
    if (status?.description) wait.update(status.description);
    if (status?.target_url) liveUrl = status.target_url;
    if (status?.state === 'success' && liveUrl) break;
    await sleep(4000);
  }
  if (!liveUrl) {
    wait.warn('No stream URL after 35 minutes');
    info(`Check the runner: ${run?.url ?? `https://github.com/${repo}/actions`}`);
    return;
  }
  wait.succeed('Simulator is live');

  // 5. Hand over the link.
  steps.next('Open the simulator');
  const fullUrl = `${liveUrl.replace(/\/$/, '')}/?k=${gateToken}`;
  console.log(`\n  ${green('●')} ${bold('Your Flutter app is live in the iOS Simulator')}\n`);
  console.log(`  ${cyan(fullUrl)}\n`);
  console.log(dim('  Anyone with this link can use the simulator. Stop it with: flutter-remote down'));
  if (flags.agent) {
    console.log(`\n  ${bold('Agent access:')} agent-device connect --url "${liveUrl}/agent-device" --token "${gateToken}"`);
  }
  console.log('');
  if (flags.open !== false) openUrl(fullUrl);
}
