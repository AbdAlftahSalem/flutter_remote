/**
 * Flutter Remote WebRTC V3 MediaPipeline
 *
 * Coordinates the full video streaming pipeline:
 *   serve-sim MJPEG -> FrameController -> VideoEncoder -> WebRTC VideoTrack
 */

import { EventEmitter } from 'node:events';
import { FrameController } from './FrameController.js';
import { VideoEncoder } from './VideoEncoder.js';

export class MediaPipeline extends EventEmitter {
  constructor(options = {}) {
    super();
    this.fps = options.fps || 30;
    this.bitrateKbps = options.bitrateKbps || 2500;
    this.maxQueueSize = options.maxQueueSize || 2;

    this.frameController = new FrameController({ maxQueueSize: this.maxQueueSize });
    this.videoEncoder = new VideoEncoder({
      fps: this.fps,
      bitrateKbps: this.bitrateKbps,
      payloadType: options.payloadType || 98,
      ssrc: options.ssrc || 12345,
      mtu: options.mtu || 1200,
    });

    this.activeTracks = new Set();
    this._init();
  }

  _init() {
    // When encoder produces RTP packets, broadcast to all active video tracks
    this.videoEncoder.on('packets', (rtpPackets) => {
      this.broadcastPackets(rtpPackets);
    });

    // Forward encoder events
    this.videoEncoder.on('frame_dropped', (data) => this.emit('frame_dropped', data));
    this.videoEncoder.on('keyframe_requested', (data) => this.emit('keyframe_requested', data));
    this.videoEncoder.on('fresh_keyframe_encoded', (data) => this.emit('fresh_keyframe_encoded', data));
  }

  addVideoTrack(track) {
    this.activeTracks.add(track);

    // Send cached keyframe immediately for instant playback (< 2s)
    if (this.videoEncoder.hasKeyframe()) {
      const keyPackets = this.videoEncoder.getKeyframePackets(this.fps);
      for (const kp of keyPackets) {
        try {
          track.sendMessageBinary(kp);
        } catch {}
      }
    }
  }

  removeVideoTrack(track) {
    this.activeTracks.delete(track);
  }

  broadcastPackets(rtpPackets) {
    for (const track of this.activeTracks) {
      try {
        for (const packet of rtpPackets) {
          track.sendMessageBinary(packet);
        }
      } catch {}
    }
  }

  pushRawFrame(jpegBuffer) {
    this.frameController.pushFrame(jpegBuffer);
    const item = this.frameController.popFrame();
    if (item && item.frame) {
      this.videoEncoder.encodeFrame(item.frame);
    }
  }

  requestKeyframe() {
    return this.videoEncoder.requestKeyframe();
  }

  get trackCount() {
    return this.activeTracks.size;
  }

  close() {
    this.activeTracks.clear();
    this.videoEncoder.close();
    this.frameController.clear();
  }
}
