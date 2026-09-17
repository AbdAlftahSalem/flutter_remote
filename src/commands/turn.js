import { shx, has } from '../lib/proc.js';
import * as gh from '../lib/gh.js';
import { ok, warn, step, bold } from '../lib/ui.js';

export async function turn(cwd, flags = {}) {
  gh.requireAuth();

  const repo = gh.nameWithOwner(cwd);
  if (!repo) {
    throw new Error('No GitHub repository remote configured.');
  }

  const keyId = flags['key-id'];
  const keyToken = flags['key-token'];

  if (!keyId || !keyToken) {
    throw new Error('Usage: flutter-remote turn --key-id <id> --key-token <token>');
  }

  step(`Setting Cloudflare Realtime TURN secrets on ${bold(repo)}`);
  shx('gh', ['secret', 'set', 'FLUTTER_REMOTE_TURN_KEY_ID', '--body', keyId], { cwd });
  shx('gh', ['secret', 'set', 'FLUTTER_REMOTE_TURN_KEY_TOKEN', '--body', keyToken], { cwd });
  ok('Configured TURN secrets');
}
