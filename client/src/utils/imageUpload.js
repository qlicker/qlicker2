const RESIZABLE_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const APPROXIMATE_JPEG_BYTES_PER_PIXEL = 0.22;
export const DEFAULT_AVATAR_THUMBNAIL_SIZE_PX = 512;
export const IMAGE_PREPARE_TIMEOUT_MS = 12000;
export const IMAGE_UPLOAD_TIMEOUT_MS = 90000;

export function withTimeout(promise, timeoutMs, message) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message || `Timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function isResizableImageType(type) {
  return RESIZABLE_IMAGE_TYPES.has(type);
}

export function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('Failed to read image file'));
    reader.readAsDataURL(file);
  });
}

export function loadImage(source) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('Failed to decode image'));
    image.src = source;
  });
}

function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) {
        resolve(blob);
        return;
      }
      reject(new Error('Failed to encode image'));
    }, type, quality);
  });
}

function canvasHasVisiblePixels(canvas, ctx) {
  const width = Number(canvas?.width) || 0;
  const height = Number(canvas?.height) || 0;
  if (!width || !height || !ctx?.getImageData) return true;

  const sampleColumns = Math.min(8, width);
  const sampleRows = Math.min(8, height);

  for (let row = 0; row < sampleRows; row += 1) {
    const y = Math.min(height - 1, Math.floor((row * height) / sampleRows));
    for (let col = 0; col < sampleColumns; col += 1) {
      const x = Math.min(width - 1, Math.floor((col * width) / sampleColumns));
      const pixel = ctx.getImageData(x, y, 1, 1).data;
      if ((pixel?.[3] || 0) > 0) {
        return true;
      }
    }
  }

  return false;
}

// Decoding via createImageBitmap avoids the FileReader + data-URL <img> path
// entirely — some Firefox 152.x installs never complete that path for picked
// or dropped files, which used to stall uploads. The FileReader route stays
// as the fallback for browsers or files createImageBitmap cannot handle.
const IMAGE_DECODE_TIMEOUT_MS = 5000;

async function decodeImageForResize(file) {
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await withTimeout(
        createImageBitmap(file, { imageOrientation: 'from-image' }),
        IMAGE_DECODE_TIMEOUT_MS,
        'Timed out decoding image via createImageBitmap',
      );
      return {
        source: bitmap,
        width: bitmap.width || 0,
        height: bitmap.height || 0,
        close: () => bitmap.close?.(),
      };
    } catch {
      // Fall through to the FileReader path.
    }
  }

  const sourceDataUrl = await readFileAsDataUrl(file);
  const sourceImage = await loadImage(sourceDataUrl);
  return {
    source: sourceImage,
    width: sourceImage.naturalWidth || 0,
    height: sourceImage.naturalHeight || 0,
    close: () => {},
  };
}

export async function normalizeImageFile(file, {
  maxWidth,
  quality = 0.92,
} = {}) {
  const safeMaxWidth = Number(maxWidth);
  if (!isResizableImageType(file?.type)) {
    return { file, width: undefined, height: undefined };
  }
  if (!Number.isFinite(safeMaxWidth) || safeMaxWidth <= 0) {
    return { file, width: undefined, height: undefined };
  }

  const decoded = await decodeImageForResize(file);
  try {
    const sourceWidth = decoded.width || 0;
    const sourceHeight = decoded.height || 0;

    if (!sourceWidth || !sourceHeight || sourceWidth <= safeMaxWidth) {
      return {
        file,
        width: sourceWidth || undefined,
        height: sourceHeight || undefined,
      };
    }

    const scale = safeMaxWidth / sourceWidth;
    const targetWidth = Math.max(1, Math.round(sourceWidth * scale));
    const targetHeight = Math.max(1, Math.round(sourceHeight * scale));

    const canvas = document.createElement('canvas');
    canvas.width = targetWidth;
    canvas.height = targetHeight;

    const ctx = canvas.getContext('2d');
    if (!ctx) {
      return {
        file,
        width: sourceWidth || undefined,
        height: sourceHeight || undefined,
      };
    }
    ctx.drawImage(decoded.source, 0, 0, targetWidth, targetHeight);

    // Some browser/image combinations can produce an all-transparent canvas
    // during client-side resizing even when the original file is valid.
    // Fall back to the original file rather than uploading a blank image.
    if (!canvasHasVisiblePixels(canvas, ctx)) {
      return {
        file,
        width: sourceWidth || undefined,
        height: sourceHeight || undefined,
      };
    }

    const resizedBlob = await canvasToBlob(canvas, file.type, quality);
    return {
      file: new File([resizedBlob], file.name, {
        type: file.type,
        lastModified: Date.now(),
      }),
      width: targetWidth,
      height: targetHeight,
    };
  } finally {
    decoded.close();
  }
}

export async function prepareImageFileForUpload(file, {
  maxWidth,
  quality,
  timeoutMs = IMAGE_PREPARE_TIMEOUT_MS,
} = {}) {
  try {
    return await withTimeout(
      normalizeImageFile(file, { maxWidth, quality }),
      timeoutMs,
      `Timed out preparing image "${file?.name || ''}" for upload`,
    );
  } catch (err) {
    // A stalled or failed client-side resize must degrade to uploading the
    // original file, not hang the upload UI (some browser builds never
    // complete FileReader/decode on picked or dropped files).
    console.error('Client-side image resize failed; uploading the original file instead.', err);
    return { file, width: undefined, height: undefined };
  }
}

export function normalizeQuarterTurnRotation(value) {
  const raw = Number(value);
  if (!Number.isFinite(raw)) return 0;
  const normalized = ((Math.round(raw / 90) % 4) + 4) % 4;
  return normalized * 90;
}

export function getRotatedDimensions(width, height, rotation) {
  const normalizedRotation = normalizeQuarterTurnRotation(rotation);
  if (normalizedRotation === 90 || normalizedRotation === 270) {
    return { width: height, height: width };
  }
  return { width, height };
}

export function createCenteredAvatarCrop(width, height, rotation = 0) {
  const rotated = getRotatedDimensions(width, height, rotation);
  const cropSize = Math.max(1, Math.min(rotated.width || 1, rotated.height || 1));
  return {
    rotation: normalizeQuarterTurnRotation(rotation),
    cropSize,
    cropX: Math.max(0, Math.round((rotated.width - cropSize) / 2)),
    cropY: Math.max(0, Math.round((rotated.height - cropSize) / 2)),
  };
}

export function clampAvatarCrop(crop = {}, width, height) {
  const rotation = normalizeQuarterTurnRotation(crop.rotation);
  const rotated = getRotatedDimensions(width, height, rotation);
  const cropSize = Math.max(1, Math.min(rotated.width || 1, rotated.height || 1));
  return {
    rotation,
    cropSize,
    cropX: clamp(Number(crop.cropX) || 0, 0, Math.max(0, rotated.width - cropSize)),
    cropY: clamp(Number(crop.cropY) || 0, 0, Math.max(0, rotated.height - cropSize)),
  };
}

function getRotationTransformStyle(rotation, scaledWidth, scaledHeight) {
  const normalizedRotation = normalizeQuarterTurnRotation(rotation);
  if (normalizedRotation === 90) {
    return `translateX(${scaledHeight}px) rotate(90deg)`;
  }
  if (normalizedRotation === 180) {
    return `translate(${scaledWidth}px, ${scaledHeight}px) rotate(180deg)`;
  }
  if (normalizedRotation === 270) {
    return `translateY(${scaledWidth}px) rotate(270deg)`;
  }
  return 'none';
}

export function getAvatarPreviewLayout({
  width,
  height,
  crop,
  viewportSize,
}) {
  const safeCrop = clampAvatarCrop(crop, width, height);
  const rotated = getRotatedDimensions(width, height, safeCrop.rotation);
  const scale = viewportSize / safeCrop.cropSize;
  return {
    crop: safeCrop,
    viewportSize,
    wrapperWidth: rotated.width * scale,
    wrapperHeight: rotated.height * scale,
    offsetX: -safeCrop.cropX * scale,
    offsetY: -safeCrop.cropY * scale,
    imageWidth: width * scale,
    imageHeight: height * scale,
    transform: getRotationTransformStyle(safeCrop.rotation, width * scale, height * scale),
  };
}

function drawRotatedImageToCanvas(ctx, image, rotation) {
  const normalizedRotation = normalizeQuarterTurnRotation(rotation);
  const width = image.naturalWidth || image.width || 0;
  const height = image.naturalHeight || image.height || 0;

  if (normalizedRotation === 90) {
    ctx.translate(height, 0);
    ctx.rotate(Math.PI / 2);
  } else if (normalizedRotation === 180) {
    ctx.translate(width, height);
    ctx.rotate(Math.PI);
  } else if (normalizedRotation === 270) {
    ctx.translate(0, width);
    ctx.rotate((3 * Math.PI) / 2);
  }

  ctx.drawImage(image, 0, 0, width, height);
}

export async function createAvatarThumbnailFile(source, crop, {
  outputSize = DEFAULT_AVATAR_THUMBNAIL_SIZE_PX,
  fileName = 'profile-thumbnail.jpg',
  type = 'image/jpeg',
  quality = 0.92,
} = {}) {
  const image = await loadImage(source);
  const width = image.naturalWidth || 0;
  const height = image.naturalHeight || 0;
  const safeCrop = clampAvatarCrop(crop, width, height);
  const rotated = getRotatedDimensions(width, height, safeCrop.rotation);

  const rotatedCanvas = document.createElement('canvas');
  rotatedCanvas.width = rotated.width;
  rotatedCanvas.height = rotated.height;
  const rotatedCtx = rotatedCanvas.getContext('2d');
  if (!rotatedCtx) {
    throw new Error('Failed to prepare avatar image');
  }
  drawRotatedImageToCanvas(rotatedCtx, image, safeCrop.rotation);
  if (!canvasHasVisiblePixels(rotatedCanvas, rotatedCtx)) {
    throw new Error('Failed to prepare avatar image');
  }

  const outputCanvas = document.createElement('canvas');
  outputCanvas.width = outputSize;
  outputCanvas.height = outputSize;
  const outputCtx = outputCanvas.getContext('2d');
  if (!outputCtx) {
    throw new Error('Failed to prepare avatar thumbnail');
  }
  outputCtx.drawImage(
    rotatedCanvas,
    safeCrop.cropX,
    safeCrop.cropY,
    safeCrop.cropSize,
    safeCrop.cropSize,
    0,
    0,
    outputSize,
    outputSize,
  );
  if (!canvasHasVisiblePixels(outputCanvas, outputCtx)) {
    throw new Error('Failed to prepare avatar thumbnail');
  }

  const outputBlob = await canvasToBlob(outputCanvas, type, quality);
  return new File([outputBlob], fileName, {
    type,
    lastModified: Date.now(),
  });
}

export function approximate16x9JpegSizeBytes(width) {
  const safeWidth = Number(width);
  if (!Number.isFinite(safeWidth) || safeWidth <= 0) return 0;
  const height = safeWidth * (9 / 16);
  return Math.round(safeWidth * height * APPROXIMATE_JPEG_BYTES_PER_PIXEL);
}

export function approximateSquareJpegSizeBytes(width) {
  const safeWidth = Number(width);
  if (!Number.isFinite(safeWidth) || safeWidth <= 0) return 0;
  return Math.round(safeWidth * safeWidth * APPROXIMATE_JPEG_BYTES_PER_PIXEL);
}

export function formatApproximateFileSize(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 KB';
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}
