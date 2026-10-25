import * as r2 from '../../core/r2.js';
import { ok, info, bold, dim } from '../../core/ui.js';

export async function r2Setup(cwd, flags = {}) {
  if (flags.status) {
    const cfg = r2.loadConfig();
    if (!cfg) {
      info('No R2 configuration saved');
      return;
    }
    console.log(`\n${bold('R2 configuration')}`);
    console.log(`  Account ID: ${cfg.accountId}`);
    console.log(`  Bucket:     ${cfg.bucket}`);
    console.log(`  Access key: ${cfg.accessKeyId?.slice(0, 6)}…`);
    return;
  }
  const cfg = Object.fromEntries(Object.entries(r2.R2_FIELDS).map(([flag, key]) => [key, flags[flag] || '']));
  r2.saveConfig(cfg);
  ok(`Saved R2 credentials ${dim('(~/.config/flutter-remote/r2.json)')}`);
}
