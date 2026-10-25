import { shx } from '../../core/proc.js';
import * as gh from '../../core/gh.js';
import { usageError } from '../../core/errors.js';
import { ok, step, bold } from '../../core/ui.js';

export async function turn(cwd, flags = {}) {
  const keyId = flags['key-id'];
  const keyToken = flags['key-token'];
  if (!keyId || !keyToken) {
    throw usageError('--key-id and --key-token are both needed', 'flutter-remote turn --key-id <id> --key-token <token>   (Cloudflare Realtime TURN key)');
  }
  const repo = gh.requireRepo(cwd);

  step(`Saving TURN credentials as Actions secrets on ${bold(repo)}`);
  // Values go through stdin, so they never appear in the process list.
  shx('gh', ['secret', 'set', 'FLUTTER_REMOTE_TURN_KEY_ID'], { cwd, input: keyId });
  shx('gh', ['secret', 'set', 'FLUTTER_REMOTE_TURN_KEY_TOKEN'], { cwd, input: keyToken });
  ok('TURN relay configured; the next flutter-remote up uses it');
}
