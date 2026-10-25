import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { FlutterRemoteError } from './errors.js';

/**
 * Lightweight, zero-dependency parser for standard Flutter pubspec.yaml files.
 */
export function parseYaml(content) {
  const result = {};
  const lines = content.split(/\r?\n/);
  const stack = [{ indent: -1, obj: result }];

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    // Remove comments
    const lineWithoutComment = rawLine.replace(/#.*$/, '');
    if (!lineWithoutComment.trim()) continue;

    const indent = rawLine.search(/\S/);
    const trimmed = lineWithoutComment.trim();

    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) {
      stack.pop();
    }

    const currentObj = stack[stack.length - 1].obj;

    // List item (e.g. - item)
    if (trimmed.startsWith('-')) {
      // List parsing if needed
      continue;
    }

    const colonIdx = trimmed.indexOf(':');
    if (colonIdx === -1) continue;

    const key = trimmed.slice(0, colonIdx).trim();
    let val = trimmed.slice(colonIdx + 1).trim();

    if (val === '') {
      // Nested map
      const newObj = {};
      currentObj[key] = newObj;
      stack.push({ indent, obj: newObj });
    } else {
      // Strip surrounding quotes
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      currentObj[key] = val;
    }
  }

  return result;
}

/**
 * Read and parse pubspec.yaml from a given directory.
 */
export function readFlutterProjectConfig(cwd) {
  const pubspecPath = join(cwd, 'pubspec.yaml');
  if (!existsSync(pubspecPath)) {
    throw new Error(`pubspec.yaml not found in ${cwd}`);
  }
  const content = readFileSync(pubspecPath, 'utf8');
  return parseYaml(content);
}

/**
 * Throws if cwd does not appear to be a valid Flutter project.
 */
export function assertFlutterProject(cwd) {
  const pubspecPath = join(cwd, 'pubspec.yaml');
  const libDir = join(cwd, 'lib');
  const iosDir = join(cwd, 'ios');

  const missing = [];
  if (!existsSync(pubspecPath)) missing.push('pubspec.yaml');
  if (!existsSync(libDir) || !statSync(libDir).isDirectory()) missing.push('lib/');
  if (!existsSync(iosDir) || !statSync(iosDir).isDirectory()) missing.push('ios/');

  if (missing.length > 0) {
    throw new FlutterRemoteError(`This folder is not a Flutter project (missing: ${missing.join(', ')})`, {
      code: 'E_NOT_FLUTTER_PROJECT',
      exitCode: 3,
      hint: missing.includes('ios/') && !missing.includes('pubspec.yaml')
        ? 'add iOS support: flutter create --platforms=ios .'
        : 'cd into your Flutter app (the folder with pubspec.yaml, lib/ and ios/) and run it again',
    });
  }

  let config;
  try {
    config = readFlutterProjectConfig(cwd);
  } catch (err) {
    throw new FlutterRemoteError(`pubspec.yaml could not be read: ${err.message}`, { exitCode: 3, hint: 'run flutter pub get to see what is wrong with it' });
  }

  const rawPubspec = readFileSync(pubspecPath, 'utf8');
  const isFlutter = Boolean(
    config.flutter !== undefined ||
    (config.dependencies && config.dependencies.flutter) ||
    /sdk:\s*flutter/i.test(rawPubspec)
  );

  if (!isFlutter) {
    throw new FlutterRemoteError('pubspec.yaml is not a Flutter app (no flutter dependency)', {
      code: 'E_NOT_FLUTTER_PROJECT',
      exitCode: 3,
      hint: 'add "flutter:\n    sdk: flutter" under dependencies, or run this in your Flutter app folder',
    });
  }

  return config;
}

/**
 * Return Flutter app name declared in pubspec.yaml.
 */
export function getFlutterAppName(cwd) {
  try {
    const config = readFlutterProjectConfig(cwd);
    if (config.name) return config.name;
  } catch {
    // Fall back to directory basename
  }
  return basename(resolve(cwd));
}

/**
 * Attempt to detect the iOS bundle identifier from the iOS directory.
 */
export function getFlutterBundleId(cwd) {
  // Check project.pbxproj for PRODUCT_BUNDLE_IDENTIFIER
  const pbxprojPath = join(cwd, 'ios', 'Runner.xcodeproj', 'project.pbxproj');
  if (existsSync(pbxprojPath)) {
    const content = readFileSync(pbxprojPath, 'utf8');
    const matches = [...content.matchAll(/PRODUCT_BUNDLE_IDENTIFIER\s*=\s*([^;]+);/g)];
    for (const match of matches) {
      const id = match[1].trim().replace(/^["']|["']$/g, '');
      if (id && !id.includes('$') && id !== 'com.example.RunnerTests') {
        return id;
      }
    }
  }

  // Check Info.plist
  const plistPath = join(cwd, 'ios', 'Runner', 'Info.plist');
  if (existsSync(plistPath)) {
    const plist = readFileSync(plistPath, 'utf8');
    const idMatch = plist.match(/<key>CFBundleIdentifier<\/key>\s*<string>([^<]+)<\/string>/);
    if (idMatch && !idMatch[1].includes('$')) {
      return idMatch[1].trim();
    }
  }

  return null;
}

/**
 * Detect Flutter version requirement from pubspec.yaml environment section.
 */
export function detectFlutterVersionRequirement(cwd) {
  try {
    const config = readFlutterProjectConfig(cwd);
    if (config.environment?.flutter) {
      const cleaned = config.environment.flutter.replace(/[^0-9.]/g, '');
      if (cleaned) return cleaned;
    }
  } catch {
    // ignore
  }
  return 'stable';
}
