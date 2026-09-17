import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseYaml,
  assertFlutterProject,
  readFlutterProjectConfig,
  getFlutterAppName,
  getFlutterBundleId,
  detectFlutterVersionRequirement,
  calculateFlutterBuildHash,
} from '../src/lib/flutter-project.js';

describe('Flutter Project Detection and Config', () => {
  let tempDir;

  before(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'flutter-remote-test-'));
  });

  after(() => {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  });

  test('parseYaml parses basic and nested pubspec YAML', () => {
    const yaml = `
name: my_app
description: "A test flutter app"
version: 1.2.3+4
environment:
  sdk: '>=3.0.0 <4.0.0'
  flutter: '>=3.24.0'
dependencies:
  flutter:
    sdk: flutter
flutter:
  uses-material-design: true
`;
    const parsed = parseYaml(yaml);
    assert.equal(parsed.name, 'my_app');
    assert.equal(parsed.description, 'A test flutter app');
    assert.equal(parsed.version, '1.2.3+4');
    assert.equal(parsed.environment?.flutter, '>=3.24.0');
    assert.equal(parsed.flutter?.['uses-material-design'], 'true');
  });

  test('assertFlutterProject throws when missing required files', () => {
    const emptyDir = join(tempDir, 'empty');
    mkdirSync(emptyDir, { recursive: true });

    assert.throws(
      () => assertFlutterProject(emptyDir),
      /This directory does not appear to be a Flutter project/
    );
  });

  test('assertFlutterProject throws when pubspec.yaml is not a Flutter app', () => {
    const nonFlutterDir = join(tempDir, 'non-flutter');
    mkdirSync(join(nonFlutterDir, 'lib'), { recursive: true });
    mkdirSync(join(nonFlutterDir, 'ios'), { recursive: true });
    writeFileSync(join(nonFlutterDir, 'pubspec.yaml'), 'name: plain_dart\nversion: 1.0.0\n');

    assert.throws(
      () => assertFlutterProject(nonFlutterDir),
      /does not configure a Flutter project/
    );
  });

  test('assertFlutterProject succeeds on valid Flutter project structure', () => {
    const validDir = join(tempDir, 'valid-flutter');
    mkdirSync(join(validDir, 'lib'), { recursive: true });
    mkdirSync(join(validDir, 'ios', 'Runner.xcodeproj'), { recursive: true });
    writeFileSync(join(validDir, 'lib', 'main.dart'), 'void main() {}');
    writeFileSync(
      join(validDir, 'pubspec.yaml'),
      'name: sample_flutter\nversion: 2.0.0\nenvironment:\n  flutter: ">=3.27.0"\ndependencies:\n  flutter:\n    sdk: flutter\n'
    );
    writeFileSync(
      join(validDir, 'ios', 'Runner.xcodeproj', 'project.pbxproj'),
      'PRODUCT_BUNDLE_IDENTIFIER = com.company.sample;\n'
    );

    const config = assertFlutterProject(validDir);
    assert.equal(config.name, 'sample_flutter');
    assert.equal(getFlutterAppName(validDir), 'sample_flutter');
    assert.equal(getFlutterBundleId(validDir), 'com.company.sample');
    assert.equal(detectFlutterVersionRequirement(validDir), '3.27.0');

    const hash1 = calculateFlutterBuildHash(validDir, { buildMode: 'debug' });
    assert.ok(hash1 && hash1.length === 16);

    const hash2 = calculateFlutterBuildHash(validDir, { buildMode: 'release' });
    assert.notEqual(hash1, hash2, 'Hash should change when build mode changes');
  });
});
