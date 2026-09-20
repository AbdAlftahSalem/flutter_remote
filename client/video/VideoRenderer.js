/**
 * Flutter Remote WebRTC V3 VideoRenderer
 *
 * Manages the HTML5 <video> element:
 *   - Autoplay, playsinline, muted attributes
 *   - Aspect ratio letterboxing and object-fit: contain
 *   - First-frame rendering latency detection
 *   - Bounds and intrinsic resolution reporting
 */

export class VideoRenderer {
  constructor(container, { onFirstFrame } = {}) {
    this.container = container;
    this.onFirstFrame = onFirstFrame || (() => {});
    this.video = null;
    this.firstFrameTime = 0;
    this.connectTime = Date.now();
    this._initElement();
  }

  _initElement() {
    let video = document.getElementById('flutter-remote-video');
    if (!video) {
      video = document.createElement('video');
      video.id = 'flutter-remote-video';
      video.autoplay = true;
      video.playsInline = true;
      video.muted = true;
      video.style.cssText = 'width:100%;height:100%;object-fit:contain;background:#000;display:block;';
      this.container.appendChild(video);
    }
    this.video = video;

    this.video.addEventListener('loadeddata', () => {
      if (!this.firstFrameTime) {
        this.firstFrameTime = Date.now() - this.connectTime;
        console.log(`[flutter-remote] First video frame rendered in ${this.firstFrameTime}ms`);
        this.onFirstFrame(this.firstFrameTime);
      }
    });
  }

  attachStream(stream) {
    this.connectTime = Date.now();
    this.firstFrameTime = 0;
    this.video.srcObject = stream;
    this.video.play().catch(() => {});
  }

  getBounds() {
    return this.video.getBoundingClientRect();
  }

  getVideoResolution() {
    return {
      width: this.video.videoWidth || 720,
      height: this.video.videoHeight || 1280,
    };
  }

  destroy() {
    if (this.video) {
      this.video.srcObject = null;
      if (this.video.parentNode) {
        this.video.parentNode.removeChild(this.video);
      }
      this.video = null;
    }
  }
}
