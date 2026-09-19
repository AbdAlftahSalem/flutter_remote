/**
 * Flutter Remote WebRTC V2 Offer Handler
 */

import { SignalingError } from '../shared/errors.js';

export class OfferHandler {
  static validateOffer(sdp) {
    if (!sdp || typeof sdp !== 'string') {
      throw new SignalingError('SDP offer must be a non-empty string');
    }

    if (!sdp.includes('v=0')) {
      throw new SignalingError('Invalid SDP offer: missing v=0');
    }

    const hasDataChannel = sdp.includes('m=application');
    const hasVideo = sdp.includes('m=video');

    return {
      valid: true,
      hasDataChannel,
      hasVideo,
    };
  }
}
