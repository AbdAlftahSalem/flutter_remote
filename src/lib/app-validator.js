import { existsSync, statSync, readFileSync } from 'node:fs';
import { join, extname, basename } from 'node:path';

/**
 * Validates prebuilt application archives or bundles for iOS Simulator compatibility.
 */
export function validateAppFile(filePath) {
  if (!existsSync(filePath)) {
    throw new Error(`App file not found: ${filePath}`);
  }

  const lower = filePath.toLowerCase();

  // Reject device IPA files immediately
  if (lower.endsWith('.ipa')) {
    throw new Error(
      `This is a device iOS build.\n\n` +
      `flutter-remote requires an iOS Simulator build.\n\n` +
      `Build with:\n\n` +
      `flutter build ios --simulator --no-codesign\n\n` +
      `A device IPA cannot be converted into a Simulator application.`
    );
  }

  const isDirectory = statSync(filePath).isDirectory();
  const isApp = lower.endsWith('.app') && isDirectory;
  const isArchive = lower.endsWith('.tar.gz') || lower.endsWith('.tgz') || lower.endsWith('.zip');

  if (!isApp && !isArchive) {
    throw new Error(
      `Unsupported app format: "${basename(filePath)}".\n` +
      `Expected a Simulator .app directory or a .tar.gz / .zip archive containing one.`
    );
  }

  // If inspecting a local .app directory, verify Info.plist if readable
  if (isApp) {
    const plistPath = join(filePath, 'Info.plist');
    if (existsSync(plistPath)) {
      const plistContent = readFileSync(plistPath, 'utf8');
      if (
        plistContent.includes('CFBundleSupportedPlatforms') &&
        plistContent.includes('<string>iPhoneOS</string>') &&
        !plistContent.includes('<string>iPhoneSimulator</string>')
      ) {
        throw new Error(
          `The provided .app was compiled for physical iOS devices (iPhoneOS).\n` +
          `flutter-remote requires an iOS Simulator build (iPhoneSimulator).\n\n` +
          `Build with:\nflutter build ios --simulator --no-codesign`
        );
      }
    }
  }

  return {
    path: filePath,
    isApp,
    isArchive,
    filename: basename(filePath),
  };
}
