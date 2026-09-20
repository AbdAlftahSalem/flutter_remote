/**
 * Flutter Remote WebRTC V3 DebugOverlay
 *
 * Renders real-time diagnostics overlay:
 *   - Connection & ICE states
 *   - RTT, FPS, Bitrate, Jitter
 *   - Accurate delta-based packet loss percentage
 *   - Frames received/dropped
 *   - Reconnects & generation counter
 */

export class DebugOverlay {
  constructor(container) {
    this.container = container;
    this.panelEl = null;
    this._init();
  }

  _init() {
    let panel = document.getElementById('flutter-remote-debug-panel');
    if (!panel) {
      panel = document.createElement('div');
      panel.id = 'flutter-remote-debug-panel';
      panel.style.cssText = 'position:absolute;bottom:10px;left:10px;padding:10px;background:rgba(0,0,0,0.85);color:#0f0;font:11px monospace;border-radius:6px;z-index:30;pointer-events:none;line-height:1.4;';
      this.container.appendChild(panel);
    }
    this.panelEl = panel;
  }

  update(metrics, extra = {}) {
    if (!this.panelEl) return;

    const conn = metrics.connection || {};
    const vid = metrics.video || {};
    const pkt = metrics.packets || {};

    const bitrateDisplay = vid.bitrate >= 1000
      ? `${(vid.bitrate / 1000).toFixed(2)} Mbps`
      : `${vid.bitrate} kbps`;

    this.panelEl.innerHTML = `
      <div><strong>Flutter Remote V3 Diagnostics</strong></div>
      <div>Connection: ${conn.connectionState || 'unknown'}</div>
      <div>ICE: ${conn.iceState || 'unknown'} (${conn.candidateType || 'unknown'})</div>
      <div>RTT: ${conn.rtt || 0} ms</div>
      <div>FPS: ${vid.fps || 0}</div>
      <div>Bitrate: ${bitrateDisplay}</div>
      <div>Jitter: ${vid.jitter || 0} ms</div>
      <div>Packet Loss: ${pkt.lossPercentage || '0.00%'} (total lost: ${pkt.lost || 0})</div>
      <div>Frames: ${vid.framesReceived || 0} rcvd / ${vid.framesDropped || 0} drop</div>
      <div>First Frame: ${extra.firstFrameTime ? extra.firstFrameTime + 'ms' : 'pending'}</div>
      <div>Reconnects: ${extra.reconnects || 0} (Gen ${extra.generation || 1})</div>
    `;
  }

  destroy() {
    if (this.panelEl && this.panelEl.parentNode) {
      this.panelEl.parentNode.removeChild(this.panelEl);
      this.panelEl = null;
    }
  }
}
