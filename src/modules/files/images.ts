import { createHash } from "node:crypto";
import sharp from "sharp";

// Uploaded images (logo, product photos), blueprint Phase 4/5:
// - PNG, JPEG or WebP only, judged by the file's CONTENT (its first bytes
//   and a real decode), never by its name or the browser's claimed type;
// - at most 2 MB;
// - re-encoded to WebP: strips hidden metadata (camera GPS, comments) and
//   anything appended to the file; at most 1600 x 1600 pixels.

export const MAX_UPLOAD_BYTES = 2 * 1024 * 1024;
const MAX_PIXELS = 24_000_000;

export type ImageErrorCode = "TOO_LARGE" | "EMPTY" | "NOT_AN_IMAGE";

export class ImageError extends Error {
  constructor(public readonly code: ImageErrorCode) {
    super(
      code === "TOO_LARGE"
        ? "The image is larger than 2 MB."
        : code === "EMPTY"
          ? "The file is empty."
          : "This is not a PNG, JPEG or WebP image.",
    );
    this.name = "ImageError";
  }
}

function signature(bytes: Uint8Array): "png" | "jpeg" | "webp" | null {
  const b = Buffer.from(bytes.subarray(0, 12));
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpeg";
  if (b.length >= 12 && b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP") return "webp";
  return null;
}

export interface CleanImage {
  bytes: Buffer;
  contentType: "image/webp";
  width: number;
  height: number;
  sha256: string;
}

export async function cleanImage(input: Uint8Array): Promise<CleanImage> {
  if (input.byteLength === 0) throw new ImageError("EMPTY");
  if (input.byteLength > MAX_UPLOAD_BYTES) throw new ImageError("TOO_LARGE");
  const kind = signature(input);
  if (kind === null) throw new ImageError("NOT_AN_IMAGE");
  try {
    const decoder = sharp(input, { limitInputPixels: MAX_PIXELS, failOn: "error" });
    const meta = await decoder.metadata();
    if (meta.format !== kind) throw new ImageError("NOT_AN_IMAGE");
    const { data, info } = await decoder
      .rotate()
      .resize({ width: 1600, height: 1600, fit: "inside", withoutEnlargement: true })
      .webp({ quality: 85 })
      .toBuffer({ resolveWithObject: true });
    return {
      bytes: data,
      contentType: "image/webp",
      width: info.width,
      height: info.height,
      sha256: createHash("sha256").update(data).digest("hex"),
    };
  } catch (error) {
    if (error instanceof ImageError) throw error;
    throw new ImageError("NOT_AN_IMAGE");
  }
}
