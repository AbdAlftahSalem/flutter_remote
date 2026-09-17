import * as r2 from '../lib/r2.js';
import { ok, info, bold } from '../lib/ui.js';

export async function r2Setup(cwd, flags = {}) {
  if (flags.status) {
    const cfg = r2.loadConfig();
    if (!cfg) {
      info('No R2 configuration found');
    } else {
      console.log(`\n${bold('R2 Configuration:')}`);
      console.log(`  Account ID: ${cfg.accountId}`);
      console.log(`  Bucket:     ${cfg.bucket}`);
      console.log(`  Access Key: ${cfg.accessKeyId?.slice(0, 6)}...`);
    }
    return;
  }

  // Set credentials from flags or prompt
  const cfg = {
    accountId: flags['account-id'] || '',
    accessKeyId: flags['access-key-id'] || '',
    secretAccessKey: flags['secret-access-key'] || '',
    bucket: flags.bucket || '',
  };

  r2.saveConfig(cfg);
  ok('Saved R2 credentials');
}
