import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateAppFile } from '../src/lib/app-validator.js';

describe('App Bundle and Archive Validator', () => {
  let tempDir;

  before(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'flutter-remote-validator-test-'));
  });

  after(() => {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  });

  test('rejects device IPA with helpful error explaining simulator requirement', () => {
    const ipaPath = join(tempDir, 'MyApp.ipa');
    writeFileSync(ipaPath, 'fake-ipa-content');

    assert.throws(
      () => validateAppFile(ipaPath),
      /This is a device iOS build[\s\S]*flutter-remote requires an iOS Simulator build/
    );
  });

  test('accepts valid .app directory', () => {
    const appDir = join(tempDir, 'Runner.app');
    mkdirSync(appDir, { recursive: true });
    writeFileSync(join(appDir, 'Info.plist'), '<plist><dict><key>CFBundleSupportedPlatforms</key><array><string>iPhoneSimulator</string></array></dict></plist>');

    const res = validateAppFile(appDir);
    assert.equal(res.isApp, true);
    assert.equal(res.filename, 'Runner.app');
  });

  test('accepts .tar.gz and .zip archives', () => {
    const tarPath = join(tempDir, 'Runner.app.tar.gz');
    writeFileSync(tarPath, 'fake-tar');
    const resTar = validateAppFile(tarPath);
    assert.equal(resTar.isArchive, true);

    const zipPath = join(tempDir, 'Runner.zip');
    writeFileSync(zipPath, 'fake-zip');
    const resZip = validateAppFile(zipPath);
    assert.equal(resZip.isArchive, true);
  });

  test('rejects unsupported extensions', () => {
    const apkPath = join(tempDir, 'app.apk');
    writeFileSync(apkPath, 'fake-apk');
    assert.throws(
      () => validateAppFile(apkPath),
      /Unsupported app format/
    );
  });
});
