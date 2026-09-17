import * as gh from '../lib/gh.js';
import { loadSession } from '../lib/session.js';
import { info, ok, warn, dim, bold, cyan, green, red } from '../lib/ui.js';

export async function status(cwd) {
  const session = loadSession(cwd);
  if (!session) {
    info('No flutter-remote session recorded for this project');
    return;
  }

  const run = gh.getRun(cwd, session.runId);
  const commitStatus = gh.readStatus(cwd, session.repo, session.sha, session.context);
  const age = Math.round((Date.now() - session.startedAt) / 60000);

  console.log(`\n${bold('Flutter Remote Simulator')}\n`);
  console.log(`  ${bold('Session:')}     ${session.session} ${dim(`(started ${age}m ago)`)}`);
  console.log(`  ${bold('Repository:')}  ${session.repo}`);
  console.log(`  ${bold('Run:')}         ${cyan(session.url)}`);
  console.log(`  ${bold('State:')}       ${run ? `${run.status}${run.conclusion ? ` / ${run.conclusion}` : ''}` : dim('unknown')}`);

  if (commitStatus?.state === 'success' && commitStatus.target_url) {
    const fullUrl = session.gateToken ? `${commitStatus.target_url.replace(/\/$/, '')}/?k=${session.gateToken}` : commitStatus.target_url;
    console.log(`  ${bold('Status:')}      ${green('● LIVE')}`);
    console.log(`  ${bold('URL:')}         ${fullUrl}`);
  } else if (commitStatus?.state === 'pending') {
    console.log(`  ${bold('Status:')}      ${cyan('◐ STARTING')} ${dim(commitStatus.description || '')}`);
    if (commitStatus.target_url) {
      console.log(`  ${bold('Tunnel:')}      ${commitStatus.target_url}`);
    }
  } else if (commitStatus) {
    console.log(`  ${bold('Status:')}      ${red('○ ' + (commitStatus.description ?? commitStatus.state))}`);
  } else {
    console.log(`  ${bold('Status:')}      ${dim('Waiting for runner initialization...')}`);
  }
  console.log('');
}
