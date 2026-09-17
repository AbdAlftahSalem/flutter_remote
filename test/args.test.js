import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs } from '../src/cli.js';

describe('CLI argument parsing', () => {
  test('defaults to up command when no command is provided', () => {
    const { command, flags } = parseArgs([]);
    assert.equal(command, 'up');
    assert.deepEqual(flags._positional, []);
  });

  test('parses subcommands properly', () => {
    assert.equal(parseArgs(['doctor']).command, 'doctor');
    assert.equal(parseArgs(['status']).command, 'status');
    assert.equal(parseArgs(['down']).command, 'down');
    assert.equal(parseArgs(['init']).command, 'init');
  });

  test('parses options and types correctly', () => {
    const { flags } = parseArgs([
      '--minutes', '45',
      '--device', 'iPhone 16 Pro',
      '--runner', 'macos-26',
      '--flutter-version', '3.29.0',
      '--build-mode', 'release',
      '--flavor', 'production',
      '--target', 'lib/main_prod.dart',
      '--public',
      '--no-cache',
      '--no-open',
      '--agent',
    ]);

    assert.equal(flags.minutes, 45);
    assert.equal(flags.device, 'iPhone 16 Pro');
    assert.equal(flags.runner, 'macos-26');
    assert.equal(flags['flutter-version'], '3.29.0');
    assert.equal(flags['build-mode'], 'release');
    assert.equal(flags.flavor, 'production');
    assert.equal(flags.target, 'lib/main_prod.dart');
    assert.equal(flags.public, true);
    assert.equal(flags.cache, false);
    assert.equal(flags.open, false);
    assert.equal(flags.agent, true);
  });

  test('collects multiple --dart-define options into array', () => {
    const { flags } = parseArgs([
      '--dart-define', 'API_URL=https://api.example.com',
      '--dart-define', 'ENV=staging',
    ]);
    assert.deepEqual(flags['dart-define'], [
      'API_URL=https://api.example.com',
      'ENV=staging',
    ]);
  });

  test('throws when an option that needs a value is missing one', () => {
    assert.throws(() => parseArgs(['--minutes']), /--minutes requires a value/);
    assert.throws(() => parseArgs(['--device']), /--device requires a value/);
  });
});
