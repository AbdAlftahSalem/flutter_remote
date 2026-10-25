import { statSync, createReadStream, existsSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { sh, shx } from './proc.js';

const TAG = 'flutter-remote-build';

export function isPubliclyReadable(cwd, repo) {
  const r = sh('gh', ['repo', 'view', repo, '--json', 'visibility', '-q', '.visibility'], { cwd });
  return r.ok && r.out.toUpperCase() === 'PUBLIC';
}

/**
 * Ensure release tag exists and upload prebuilt app archive as a release asset.
 */
export function upload(cwd, repo, appPath) {
  let archivePath = appPath;
  const isDir = statSync(appPath).isDirectory();

  if (isDir) {
    const parentDir = dirname(appPath);
    const base = basename(appPath);
    const tarName = `${base}.tar.gz`;
    archivePath = join(parentDir, tarName);
    shx('tar', ['-czf', archivePath, '-C', parentDir, base], { cwd });
  }

  const assetName = basename(archivePath);
  const bytes = statSync(archivePath).size;

  // Check if release exists, if not create draft/release
  const rel = sh('gh', ['release', 'view', TAG], { cwd });
  if (!rel.ok) {
    shx('gh', ['release', 'create', TAG, '--title', 'flutter-remote prebuilt apps', '--notes', 'Temporary prebuilt app builds', '--draft'], { cwd });
  }

  shx('gh', ['release', 'upload', TAG, archivePath, '--clobber'], { cwd });

  return { asset: assetName, bytes };
}
