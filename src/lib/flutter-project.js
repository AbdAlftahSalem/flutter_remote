import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { join, resolve, relative, basename } from 'node:path';
import { createHash } from 'node:crypto';

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
    throw new Error(
      `This directory does not appear to be a Flutter project.\n\n` +
      `Expected:\n- pubspec.yaml\n- lib/\n- ios/\n\n` +
      `Missing: ${missing.join(', ')}\n\n` +
      `Run flutter-remote from your Flutter project root.`
    );
  }

  let config;
  try {
    config = readFlutterProjectConfig(cwd);
  } catch (err) {
    throw new Error(`Invalid pubspec.yaml in ${cwd}: ${err.message}`);
  }

  const rawPubspec = readFileSync(pubspecPath, 'utf8');
  const isFlutter = Boolean(
    config.flutter !== undefined ||
    (config.dependencies && config.dependencies.flutter) ||
    /sdk:\s*flutter/i.test(rawPubspec)
  );

  if (!isFlutter) {
    throw new Error(
      `The pubspec.yaml in ${cwd} does not configure a Flutter project.\n` +
      `Ensure it declares "dependencies: flutter:" or a "flutter:" section.`
    );
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

/**
 * Recursively collect files in directory, ignoring common build/vcs noise.
 */
function collectFiles(dir, baseDir, fileList = []) {
  if (!existsSync(dir)) return fileList;
  const entries = readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    const rel = relative(baseDir, fullPath).replace(/\\/g, '/');

    // Skip build outputs, pods, git, cache
    if (
      entry.name === '.git' ||
      entry.name === 'Pods' ||
      entry.name === '.symlinks' ||
      entry.name === '.dart_tool' ||
      entry.name === 'build' ||
      entry.name === 'DerivedData'
    ) {
      continue;
    }

    if (entry.isDirectory()) {
      collectFiles(fullPath, baseDir, fileList);
    } else if (entry.isFile()) {
      fileList.push(fullPath);
    }
  }
  return fileList;
}

/**
 * Calculate deterministic SHA-256 fingerprint of Flutter application sources and build configuration.
 */
export function calculateFlutterBuildHash(cwd, {
  runner = 'macos-26',
  flutterVersion = 'stable',
  buildMode = 'debug',
  flavor = '',
  target = '',
  dartDefines = [],
} = {}) {
  const hasher = createHash('sha256');

  // 1. Build metadata
  hasher.update(`runner:${runner}\n`);
  hasher.update(`flutter:${flutterVersion}\n`);
  hasher.update(`mode:${buildMode}\n`);
  hasher.update(`flavor:${flavor}\n`);
  hasher.update(`target:${target}\n`);
  const sortedDefines = [...dartDefines].sort();
  hasher.update(`defines:${sortedDefines.join(',')}\n`);

  // 2. Critical files: pubspec.yaml and pubspec.lock
  const pubspecPath = join(cwd, 'pubspec.yaml');
  if (existsSync(pubspecPath)) {
    hasher.update('file:pubspec.yaml\n');
    hasher.update(readFileSync(pubspecPath));
  }
  const lockPath = join(cwd, 'pubspec.lock');
  if (existsSync(lockPath)) {
    hasher.update('file:pubspec.lock\n');
    hasher.update(readFileSync(lockPath));
  }

  // 3. Source directories: lib, assets, ios
  const allFiles = [
    ...collectFiles(join(cwd, 'lib'), cwd),
    ...collectFiles(join(cwd, 'assets'), cwd),
    ...collectFiles(join(cwd, 'ios'), cwd),
  ].sort();

  for (const file of allFiles) {
    const relPath = relative(cwd, file).replace(/\\/g, '/');
    hasher.update(`file:${relPath}\n`);
    hasher.update(readFileSync(file));
  }

  return hasher.digest('hex').slice(0, 16);
}
