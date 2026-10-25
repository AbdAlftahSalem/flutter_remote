import * as gh from '../../core/gh.js';
import * as ghrelease from '../../core/ghrelease.js';
import { r2NotSupported } from '../../core/r2.js';
import { validateAppFile } from '../../core/app-validator.js';
import { usageError } from '../../core/errors.js';
import { spinner, warn, bold } from '../../core/ui.js';

export async function upload(cwd, flags = {}) {
  const file = flags._positional?.[0] || flags['app-file'];
  if (!file) throw usageError('no app given', 'flutter-remote upload path/to/Runner.app');
  if (flags.r2) throw r2NotSupported();
  validateAppFile(file);

  const repo = gh.requireRepo(cwd);

  const s = spinner(`Uploading ${file} to a release on ${repo}`);
  const uploaded = ghrelease.upload(cwd, repo, file);
  s.succeed(`Uploaded ${(uploaded.bytes / 1048576).toFixed(1)} MB as ${bold(uploaded.asset)}`);
  if (ghrelease.isPubliclyReadable(cwd, repo)) {
    warn('This repository is public: once the release is published, anyone can download this build');
  }
}
