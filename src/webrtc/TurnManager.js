/**
 * Flutter Remote WebRTC V2 TURN Manager
 *
 * Fetches time-limited Cloudflare Calls TURN credentials via REST API.
 * Falls back to public STUN if TURN keys are not configured.
 * Credentials are cached for up to 12 hours and permanent secrets are never exposed.
 */

import https from 'node:https';
import { logger } from '../shared/logger.js';

export class TurnManager {
  constructor(options = {}) {
    this.keyId = options.keyId || process.env.FLUTTER_REMOTE_TURN_KEY_ID || null;
    this.keyToken = options.keyToken || process.env.FLUTTER_REMOTE_TURN_KEY_TOKEN || null;
    this.defaultStunUrls = options.defaultStunUrls || ['stun:stun.cloudflare.com:3478'];

    this._cachedConfig = null;
    this._fetchPromise = null;
  }

  isConfigured() {
    return Boolean(this.keyId && this.keyToken);
  }

  async getIceServers() {
    const fallback = {
      iceServers: this.defaultStunUrls.map((url) => ({ urls: url })),
    };

    if (!this.isConfigured()) {
      return fallback;
    }

    if (this._cachedConfig && this._cachedConfig.expiresAt > Date.now()) {
      return this._cachedConfig.data;
    }

    if (this._fetchPromise) {
      return this._fetchPromise;
    }

    this._fetchPromise = new Promise((resolve) => {
      const postData = JSON.stringify({ ttl: 86400 });

      const req = https.request(
        `https://rtc.live.cloudflare.com/v1/turn/keys/${this.keyId}/credentials/generate-ice-servers`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.keyToken}`,
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(postData),
          },
          timeout: 5000,
        },
        (res) => {
          let body = '';
          res.on('data', (chunk) => { body += chunk; });
          res.on('end', () => {
            this._fetchPromise = null;
            try {
              const parsed = JSON.parse(body);
              if (parsed && Array.isArray(parsed.iceServers)) {
                this._cachedConfig = {
                  data: parsed,
                  expiresAt: Date.now() + 12 * 3600 * 1000,
                };
                logger.info('turn.credentials_generated', {
                  serverCount: parsed.iceServers.length,
                });
                resolve(parsed);
                return;
              }
            } catch {}
            resolve(fallback);
          });
        }
      );

      req.on('error', (err) => {
        logger.warn('turn.fetch_failed', { error: err.message });
        this._fetchPromise = null;
        resolve(fallback);
      });

      req.on('timeout', () => {
        req.destroy();
        this._fetchPromise = null;
        resolve(fallback);
      });

      req.write(postData);
      req.end();
    });

    return this._fetchPromise;
  }
}
