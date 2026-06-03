import * as fs from "fs";
import {
  IMAGE_MAX_HEIGHT,
  IMAGE_MAX_WIDTH,
  IMAGE_TARGET_RAW_SIZE,
} from "./limits.js";
import type { ReadImageOutput } from "./types.js";

const MEDIA_BY_EXT: Record<string, ReadImageOutput["file"]["mediaType"]> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

function detectMediaType(ext: string): ReadImageOutput["file"]["mediaType"] {
  return MEDIA_BY_EXT[ext.toLowerCase()] ?? "image/png";
}

/**
 * Resize image buffer if over API limits. Uses sharp when available (optional dep).
 */
async function maybeResizeImageBuffer(
  buffer: Buffer,
  ext: string,
): Promise<{ buffer: Buffer; mediaType: ReadImageOutput["file"]["mediaType"] }> {
  const mediaType = detectMediaType(ext);
  if (buffer.length <= IMAGE_TARGET_RAW_SIZE) {
    return { buffer, mediaType };
  }

  try {
    const sharp = (await import("sharp")).default;
    const resized = await sharp(buffer)
      .resize(IMAGE_MAX_WIDTH, IMAGE_MAX_HEIGHT, { fit: "inside", withoutEnlargement: true })
      .toFormat(ext === "jpg" || ext === "jpeg" ? "jpeg" : ext === "webp" ? "webp" : ext === "gif" ? "gif" : "png")
      .toBuffer();
    return { buffer: resized, mediaType };
  } catch {
    if (buffer.length > IMAGE_TARGET_RAW_SIZE * 1.33) {
      throw new Error(
        `Image is ${(buffer.length / 1024 / 1024).toFixed(1)} MB after encoding — exceeds API limit. Install sharp for auto-resize or use a smaller image.`,
      );
    }
    return { buffer, mediaType };
  }
}

export async function readImageFile(
  absPath: string,
  displayPath: string,
): Promise<ReadImageOutput> {
  if (!fs.existsSync(absPath)) {
    throw new Error(`file not found: ${displayPath}`);
  }
  const stat = fs.statSync(absPath);
  if (stat.size === 0) {
    throw new Error(`image file is empty: ${displayPath}`);
  }

  const ext = displayPath.includes(".")
    ? displayPath.slice(displayPath.lastIndexOf(".") + 1)
    : "png";
  const raw = fs.readFileSync(absPath);
  const { buffer, mediaType } = await maybeResizeImageBuffer(raw, ext);

  return {
    type: "image",
    file: {
      filePath: displayPath,
      base64: buffer.toString("base64"),
      mediaType,
      originalSize: stat.size,
    },
  };
}
