import { existsSync, statSync, readFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { usageError } from './errors.js';

const SIMULATOR_BUILD = 'flutter build ios --simulator --no-codesign   (the app is in build/ios/iphonesimulator/Runner.app)';

/**
 * Validate a prebuilt app for the iOS Simulator: a Runner.app folder, or a
 * .tar.gz / .tgz / .zip that holds one. Device builds (.ipa, iPhoneOS) are refused.
 */
export function validateAppFile(filePath) {
  if (!existsSync(filePath)) {
    throw usageError(`app not found: ${filePath}`, 'check the path; build one with: ' + SIMULATOR_BUILD);
  }
  const lower = filePath.toLowerCase();
  if (lower.endsWith('.ipa')) {
    throw usageError('an .ipa is a device build; the Simulator needs a simulator build', SIMULATOR_BUILD);
  }

  const isDirectory = statSync(filePath).isDirectory();
  const isApp = lower.endsWith('.app') && isDirectory;
  const isArchive = lower.endsWith('.tar.gz') || lower.endsWith('.tgz') || lower.endsWith('.zip');
  if (!isApp && !isArchive) {
    throw usageError(`"${basename(filePath)}" is not a .app folder or a .tar.gz/.zip archive`, SIMULATOR_BUILD);
  }

  if (isApp) {
    const plistPath = join(filePath, 'Info.plist');
    if (existsSync(plistPath)) {
      const plist = readFileSync(plistPath, 'utf8');
      if (plist.includes('CFBundleSupportedPlatforms') && plist.includes('<string>iPhoneOS</string>')
        && !plist.includes('<string>iPhoneSimulator</string>')) {
        throw usageError('this .app was built for real iPhones (iPhoneOS), not the Simulator', SIMULATOR_BUILD);
      }
    }
  }

  return { path: filePath, isApp, isArchive, filename: basename(filePath) };
}
