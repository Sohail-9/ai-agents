import sharp from "sharp";
import crypto from "crypto";
import { prisma } from "../lib/prisma";
import { storageService } from "./storageService";

const MAX_DIMENSION = 1568; // Anthropic's recommended max
const MAX_RAW_SIZE = 5 * 1024 * 1024; // 5MB upload limit
const DEFAULT_SIGNED_URL_TTL_SEC = 300; // 5 min
const ALLOWED_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

const MIME_TO_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

export interface UploadedImage {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  width: number | null;
  height: number | null;
}

function buildBucketKey(workspaceId: string, contentHash: string, mimeType: string): string {
  const ext = MIME_TO_EXT[mimeType] ?? "bin";
  return `workspaces/${workspaceId}/${contentHash}.${ext}`;
}

export const imageService = {
  validateFile(file: { mimetype: string; size: number }): string | null {
    if (!ALLOWED_MIME_TYPES.has(file.mimetype)) {
      return `Unsupported file type: ${file.mimetype}. Allowed: png, jpeg, gif, webp.`;
    }
    if (file.size > MAX_RAW_SIZE) {
      return `File too large: ${(file.size / 1024 / 1024).toFixed(1)}MB. Max: 5MB.`;
    }
    return null;
  },

  async processAndStore(
    workspaceId: string,
    file: { buffer: Buffer; originalname: string; mimetype: string },
  ): Promise<UploadedImage> {
    let processed = sharp(file.buffer);
    const metadata = await processed.metadata();

    const { width: origW, height: origH } = metadata;
    if (origW && origH && (origW > MAX_DIMENSION || origH > MAX_DIMENSION)) {
      processed = processed.resize({
        width: MAX_DIMENSION,
        height: MAX_DIMENSION,
        fit: "inside",
        withoutEnlargement: true,
      });
    }

    let outputMime = file.mimetype;
    if (file.buffer.length > 1024 * 1024 && file.mimetype !== "image/webp") {
      processed = processed.webp({ quality: 85 });
      outputMime = "image/webp";
    }

    const outputBuffer = await processed.toBuffer();
    const finalMeta = await sharp(outputBuffer).metadata();
    const contentHash = crypto.createHash("sha256").update(outputBuffer).digest("hex");

    // Dedup: same workspace + same content → reuse the existing row.
    const existing = await prisma.messageImage.findFirst({
      where: { workspaceId, contentHash, deletedAt: null },
    });
    if (existing) {
      console.log(`[ImageService] Dedup hit ws=${workspaceId} hash=${contentHash.slice(0, 8)} → ${existing.id}`);
      return {
        id: existing.id,
        filename: existing.filename,
        mimeType: existing.mimeType,
        sizeBytes: existing.sizeBytes,
        width: existing.width,
        height: existing.height,
      };
    }

    const bucketKey = buildBucketKey(workspaceId, contentHash, outputMime);
    await storageService.put({
      key: bucketKey,
      body: outputBuffer,
      contentType: outputMime,
    });
    console.log(`[ImageService] Uploaded ws=${workspaceId} key=${bucketKey} size=${outputBuffer.length}`);

    const row = await prisma.messageImage.create({
      data: {
        workspaceId,
        filename: file.originalname,
        mimeType: outputMime,
        sizeBytes: outputBuffer.length,
        width: finalMeta.width ?? null,
        height: finalMeta.height ?? null,
        bucketKey,
        contentHash,
      },
    });

    return {
      id: row.id,
      filename: row.filename,
      mimeType: row.mimeType,
      sizeBytes: row.sizeBytes,
      width: row.width,
      height: row.height,
    };
  },

  async getById(id: string) {
    return prisma.messageImage.findUnique({ where: { id } });
  },

  async getActiveById(id: string) {
    const row = await prisma.messageImage.findUnique({ where: { id } });
    return row && !row.deletedAt ? row : null;
  },

  async getByMessageId(messageId: string) {
    return prisma.messageImage.findMany({
      where: { messageId, deletedAt: null },
      orderBy: { createdAt: "asc" },
    });
  },

  async getBytes(id: string): Promise<{ buffer: Buffer; mimeType: string; filename: string } | null> {
    const row = await this.getActiveById(id);
    if (!row) return null;
    const { buffer } = await storageService.download(row.bucketKey);
    return { buffer, mimeType: row.mimeType, filename: row.filename };
  },

  async getSignedUrl(id: string, ttlSec: number = DEFAULT_SIGNED_URL_TTL_SEC): Promise<string | null> {
    const row = await this.getActiveById(id);
    if (!row) return null;
    return storageService.signedUrl(row.bucketKey, ttlSec);
  },

  async linkToMessage(
    imageIds: string[],
    messageId: string,
    workspaceId: string,
  ): Promise<number> {
    if (imageIds.length === 0) return 0;
    const result = await prisma.messageImage.updateMany({
      where: {
        id: { in: imageIds },
        workspaceId,
        messageId: null,
        deletedAt: null,
      },
      data: { messageId },
    });
    return result.count;
  },
};
