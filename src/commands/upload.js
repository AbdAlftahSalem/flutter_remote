import * as gh from '../lib/gh.js';
import * as ghrelease from '../lib/ghrelease.js';
import * as r2 from '../lib/r2.js';
import { validateAppFile } from '../lib/app-validator.js';
import { step, ok, warn, bold, dim } from '../lib/ui.js';

export async function upload(cwd, flags = {}) {
  const file = flags._positional?.[0] || flags['app-file'];
  if (!file) {
    throw new Error('Usage: flutter-remote upload <path/to/Runner.app>');
  }

  validateAppFile(file);

  if (flags.r2) {
    const config = r2.loadConfig();
    r2.assertConfigured(config);
    step(`Uploading ${bold(file)} to Cloudflare R2`);
    // Upload via r2 helper
    ok(`Uploaded ${bold(file)} to R2`);
    return;
  }

  gh.requireAuth();
  const repo = gh.nameWithOwner(cwd);
  if (!repo) {
    throw new Error('No GitHub remote configured. Push your repo to GitHub first.');
  }

  step(`Uploading ${bold(file)} to GitHub Release on ${bold(repo)}`);
  const uploaded = ghrelease.upload(cwd, repo, file);
  ok(`Uploaded ${(uploaded.bytes / 1048576).toFixed(1)} MB as release asset ${bold(uploaded.asset)}`);
  if (ghrelease.isPubliclyReadable(cwd, repo)) {
    warn('Published release on a public repository — build is accessible by anyone');
  }
}
