/**
 * Flutter Remote WebRTC V3 SignalingClient
 *
 * Dedicated WebSocket signaling client for session negotiation.
 * Handles offers, answers, and ICE candidate trickle with generation ID checks.
 */

export class SignalingClient {
  constructor({ url, sessionId, token, connectionState, onMessage, onOpen, onClose, onError }) {
    this.url = url;
    this.sessionId = sessionId;
    this.token = token;
    this.connectionState = connectionState;
    this.onMessage = onMessage || (() => {});
    this.onOpen = onOpen || (() => {});
    this.onClose = onClose || (() => {});
    this.onError = onError || (() => {});
    this.ws = null;
  }

  connect() {
    this.close();

    const wsUrl = this.url || (() => {
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      return `${proto}//${location.host}/signal?session=${encodeURIComponent(this.sessionId)}&k=${encodeURIComponent(this.token)}`;
    })();

    this.ws = new WebSocket(wsUrl);

    this.ws.onopen = () => {
      this.onOpen();
    };

    this.ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (this.connectionState && this.connectionState.isStale(msg.generation)) {
          return; // Reject stale signaling message from an older generation
        }
        this.onMessage(msg);
      } catch (err) {
        console.warn('[SignalingClient message parse error]', err);
      }
    };

    this.ws.onclose = (e) => {
      this.onClose(e);
    };

    this.ws.onerror = (e) => {
      this.onError(e);
    };
  }

  send(msg) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      if (typeof msg === 'object') {
        if (!msg.generation && this.connectionState) {
          msg.generation = this.connectionState.generation;
        }
        if (!msg.sessionId) {
          msg.sessionId = this.sessionId;
        }
        this.ws.send(JSON.stringify(msg));
      } else {
        this.ws.send(msg);
      }
      return true;
    }
    return false;
  }

  sendOffer(sdp, iceServers = []) {
    return this.send({
      v: 2,
      type: 'offer',
      payload: { sdp, iceServers },
    });
  }

  sendCandidate(candidate) {
    return this.send({
      v: 2,
      type: 'ice-candidate',
      payload: candidate,
    });
  }

  get isOpen() {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  close() {
    if (this.ws) {
      this.ws.onopen = null;
      this.ws.onmessage = null;
      this.ws.onclose = null;
      this.ws.onerror = null;
      try {
        this.ws.close();
      } catch {}
      this.ws = null;
    }
  }
}
