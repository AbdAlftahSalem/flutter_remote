import test from 'node:test';
import assert from 'node:assert/strict';
import { TurnManager } from '../src/webrtc/TurnManager.js';

test('Phase 10: TurnManager unconfigured STUN fallback', async () => {
  const manager = new TurnManager({ keyId: null, keyToken: null });
  assert.equal(manager.isConfigured(), false);

  const config = await manager.getIceServers();
  assert.ok(config.iceServers);
  assert.equal(config.iceServers.length, 1);
  assert.ok(config.iceServers[0].urls.includes('stun:'));
});

test('Phase 10: TurnManager caching of generated credentials', async () => {
  const manager = new TurnManager({ keyId: 'mock-key', keyToken: 'mock-token' });
  assert.equal(manager.isConfigured(), true);

  // Seed cache manually to verify TTL and no-network hit
  const mockServers = [{ urls: 'turn:turn.cloudflare.com:3478', username: 'temp-u', credential: 'temp-p' }];
  manager._cachedConfig = {
    data: { iceServers: mockServers },
    expiresAt: Date.now() + 10000,
  };

  const cached = await manager.getIceServers();
  assert.deepEqual(cached.iceServers, mockServers);
});
