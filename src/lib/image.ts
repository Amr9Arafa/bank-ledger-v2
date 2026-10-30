// Photo sizing for the AI Inbox: phone photos (3-8 MB) are shrunk in the browser before
// upload. Smaller photos also cost fewer tokens; 1600 px still keeps a cheque readable.
export const MAX_IMAGE_SIDE = 1600;
export const JPEG_QUALITY = 0.8;
// Checked again on the server: the safety net if a photo arrives unshrunk.
export const MAX_IMAGE_BYTES = 3 * 1024 * 1024;

// Scales width x height down so the longer side is at most `max`; never scales up.
export function fitWithin(width: number, height: number, max = MAX_IMAGE_SIDE) {
  const scale = Math.min(1, max / Math.max(width, height));
  return { width: Math.round(width * scale), height: Math.round(height * scale) };
}

// 3_400_000 -> "3.2 MB", 240_000 -> "234 KB". Display only.
export function formatBytes(bytes: number): string {
  return bytes >= 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}
