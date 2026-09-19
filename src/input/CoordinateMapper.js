/**
 * Flutter Remote WebRTC V2 Coordinate Mapper
 *
 * Maps browser client coordinates to normalized (0.0 - 1.0) simulator coordinates,
 * taking into account letterboxing, pillarboxing, aspect ratio, and orientation.
 */

export class CoordinateMapper {
  static mapClientToNormalized({
    clientX,
    clientY,
    containerRect,
    videoWidth = 720,
    videoHeight = 1280,
    fit = 'contain',
  }) {
    const { left, top, width: containerWidth, height: containerHeight } = containerRect;

    // Relative to container
    const rawX = clientX - left;
    const rawY = clientY - top;

    let displayedWidth = containerWidth;
    let displayedHeight = containerHeight;
    let offsetX = 0;
    let offsetY = 0;

    if (fit === 'contain') {
      const containerAspect = containerWidth / containerHeight;
      const videoAspect = videoWidth / videoHeight;

      if (containerAspect > videoAspect) {
        // Pillarboxed (black bars on left/right)
        displayedHeight = containerHeight;
        displayedWidth = containerHeight * videoAspect;
        offsetX = (containerWidth - displayedWidth) / 2;
      } else {
        // Letterboxed (black bars on top/bottom)
        displayedWidth = containerWidth;
        displayedHeight = containerWidth / videoAspect;
        offsetY = (containerHeight - displayedHeight) / 2;
      }
    }

    const inside = (
      rawX >= offsetX &&
      rawX <= offsetX + displayedWidth &&
      rawY >= offsetY &&
      rawY <= offsetY + displayedHeight
    );

    // Normalize within the displayed video rect and clamp between 0.0 and 1.0
    const normalizedX = Math.max(0, Math.min(1, (rawX - offsetX) / displayedWidth));
    const normalizedY = Math.max(0, Math.min(1, (rawY - offsetY) / displayedHeight));

    return {
      x: Number(normalizedX.toFixed(5)),
      y: Number(normalizedY.toFixed(5)),
      inside,
      displayedWidth,
      displayedHeight,
      offsetX,
      offsetY,
    };
  }

  static denormalize(normalizedX, normalizedY, targetWidth, targetHeight) {
    return {
      x: Math.round(normalizedX * targetWidth),
      y: Math.round(normalizedY * targetHeight),
    };
  }
}
