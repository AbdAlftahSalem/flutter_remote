import { randomBytes } from 'node:crypto';
import * as git from '../lib/git.js';
import * as gh from '../lib/gh.js';
import { sh, sleep, open as openUrl } from '../lib/proc.js';
import { assertFlutterProject, getFlutterAppName, detectFlutterVersionRequirement } from '../lib/flutter-project.js';
import { validateAppFile } from '../lib/app-validator.js';
import { scaffold, WORKFLOW_PATH } from './init.js';
import { saveSession } from '../lib/session.js';
import * as r2 from '../lib/r2.js';
import * as ghrelease from '../lib/ghrelease.js';
import { info, ok, warn, step, spinner, bold, dim, cyan, green, red } from '../lib/ui.js';

const WORKFLOW = 'flutter-remote.yml';

export async function up(cwd, flags = {}) {
  const appFile = flags['app-file'];
  const appRelease = flags['app-release'];
  const mode = flags.app || appFile || appRelease ? 'app' : (flags.mode ?? 'build');

  if (appFile) {
    validateAppFile(appFile);
  }

  let appUrl = flags.app ?? '';
  let appReleaseAsset = appRelease && appRelease !== true ? appRelease : '';

  if (appFile && flags.r2) {
    const config = r2.loadConfig();
    r2.assertConfigured(config);
    step(`Uploading ${bold(appFile)} to Cloudflare R2`);
    // R2 upload
    ok(`Uploaded ${bold(appFile)} to R2`);
  }

  if (mode !== 'app') {
    assertFlutterProject(cwd);
  }

  gh.requireAuth();

  step('Preparing Flutter project & repository');

  if (!git.isRepo(cwd)) {
    git.init(cwd);
    ok('git init (initialized git repository)');
  }

  const branch = git.currentBranch(cwd);
  const message = flags.message ?? `flutter-remote: ${new Date().toISOString()}`;

  if (git.isDirty(cwd) || !git.hasCommits(cwd)) {
    git.commitAll(cwd, message);
    ok(`Committed changes on ${bold(branch)}`);
  } else {
    info(`Working tree clean on ${bold(branch)}`);
  }

  let repo = gh.nameWithOwner(cwd);

  if (!repo) {
    const name = flags.repo ?? getFlutterAppName(cwd);
    const isPublic = Boolean(flags.public);

    if (isPublic) {
      warn(`You are about to push this Flutter project to a PUBLIC GitHub repository (${bold(name)}).`);
      warn('Your source code will be publicly accessible.');
    } else {
      warn(`Private repos bill macOS minutes at ${bold('10×')} — use ${dim('--public')} for free minutes.`);
    }

    step(`Creating ${isPublic ? 'public' : 'private'} repository ${bold(name)}`);
    repo = gh.createRepo(cwd, name, { isPublic, branch });
    ok(`Created and connected to ${bold(repo)}`);
  } else {
    git.push(cwd, branch);
    ok(`Pushed branch ${bold(branch)} to ${bold(repo)}`);
    if (!gh.isPublicRepo(cwd)) {
      warn(`${bold(repo)} is private — GitHub Actions macOS minutes bill at 10× against quota`);
    }
  }

  // Ensure workflow & gate templates are in the repo
  if (scaffold(cwd) || git.isDirty(cwd)) {
    git.commitAll(cwd, 'flutter-remote: configure remote iOS simulator workflow and auth gate');
    git.push(cwd, branch);
    ok('Pushed flutter-remote workflow & gate to GitHub');
  }

  // If local .app upload needed and not R2
  if (appFile && !flags.r2) {
    step(`Uploading ${bold(appFile)} to ${bold(repo)} releases`);
    const uploaded = ghrelease.upload(cwd, repo, appFile);
    appReleaseAsset = uploaded.asset;
    ok(`Uploaded ${(uploaded.bytes / 1048576).toFixed(1)} MB as release asset ${bold(uploaded.asset)}`);
  }

  const s = spinner('Registering workflow with GitHub Actions');
  const registered = await gh.waitForWorkflowRegistration(cwd, repo, WORKFLOW_PATH);
  if (!registered) {
    s.stop(warn('Registration polling timed out; attempting dispatch anyway'));
  } else {
    s.stop(ok('GitHub Actions workflow registered'));
  }

  const sha = git.headSha(cwd);
  const session = randomBytes(4).toString('hex');
  const gateToken = randomBytes(24).toString('base64url');
  const context = `flutter-remote/${session}`;

  const flutterVersion = flags['flutter-version'] ?? (mode === 'build' ? detectFlutterVersionRequirement(cwd) : 'stable');
  const dartDefines = Array.isArray(flags['dart-define'])
    ? flags['dart-define'].join(',')
    : (flags['dart-define'] ?? '');

  step('Dispatching GitHub macOS runner job');
  await gh.dispatch(cwd, WORKFLOW, branch, {
    session,
    gate_token: gateToken,
    minutes: String(flags.minutes ?? 30),
    device: flags.device ?? 'iPhone 17 Pro',
    mode,
    flutter_version: flutterVersion,
    build_mode: flags['build-mode'] ?? 'debug',
    flavor: flags.flavor ?? '',
    target: flags.target ?? '',
    dart_defines: dartDefines,
    app_url: appUrl,
    app_release_asset: appReleaseAsset,
    export_app: flags.export ? 'true' : 'false',
    agent_device: flags.agent ? 'true' : 'false',
    agent_device_version: '0.20.1',
    transport: flags.transport ?? 'http',
    codec: flags.codec ?? 'mjpeg',
    max_dimension: String(flags['max-dimension'] ?? 900),
    video_fps: String(flags.fps ?? 30),
    video_quality: String(flags.quality ?? 0.7),
    cache: flags.cache === false ? 'false' : 'true',
    runner: flags.runner ?? 'macos-26',
  });

  const runSpin = spinner('Waiting for macOS runner to start');
  let run = null;
  for (let i = 0; i < 30; i++) {
    run = gh.findRun(cwd, WORKFLOW, session);
    if (run) break;
    await sleep(3000);
  }

  if (!run) {
    runSpin.stop(warn('Could not locate run in list; check GitHub Actions tab'));
  } else {
    runSpin.stop(ok(`Runner started: ${cyan(run.url)}`));
    saveSession(cwd, { session, gateToken, runId: run.databaseId, sha, repo, context, url: run.url });
  }

  // Poll for commit status to obtain live tunnel URL
  const waitSpin = spinner('Building Flutter iOS app & establishing simulator stream');
  const deadline = Date.now() + 1000 * 60 * 35; // 35 min timeout
  let liveUrl = null;

  while (Date.now() < deadline) {
    if (run?.databaseId) {
      const currentRun = gh.getRun(cwd, run.databaseId);
      if (currentRun?.status === 'completed' && currentRun?.conclusion !== 'success') {
        waitSpin.stop(error(`Runner job failed (${currentRun.conclusion}). View logs: ${run.url}`));
        throw new Error(`Flutter Simulator build or run failed on macOS runner. Check logs at ${run.url}`);
      }
    }

    const status = gh.readStatus(cwd, repo, sha, context);
    if (status?.target_url) {
      liveUrl = status.target_url;
      if (status.state === 'success' || status.state === 'pending') {
        waitSpin.update(`Stream ready: ${liveUrl}`);
        if (status.state === 'success') break;
      }
    }
    await sleep(4000);
  }

  if (!liveUrl) {
    waitSpin.stop(warn('Timed out waiting for simulator stream URL'));
    info(`Check progress at: ${run?.url || 'GitHub Actions tab'}`);
    return;
  }

  waitSpin.stop(ok('Simulator is live and streaming!'));

  const fullUrl = `${liveUrl.replace(/\/$/, '')}/?k=${gateToken}`;

  console.log('');
  console.log(`  ${green('●')} ${bold('Flutter iOS Simulator is live')}`);
  console.log('');
  console.log(`  ${cyan(fullUrl)}`);
  console.log('');
  console.log(dim(`  Anyone with this link can interact with the iOS Simulator from their browser.`));
  console.log(dim(`  Stop it with: flutter-remote down`));
  console.log('');

  if (flags.agent) {
    console.log(`  ${bold('Agent Device proxy active:')}`);
    console.log(`  agent-device connect --url "${liveUrl}/agent-device" --token "${gateToken}"\n`);
  }

  if (flags.open !== false) {
    openUrl(fullUrl);
  }
}
