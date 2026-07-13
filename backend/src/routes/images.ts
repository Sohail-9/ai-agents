import { Router } from "express";
import multer from "multer";
import { imageService } from "../services/imageService";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
});

const router = Router();

// POST /api/workspaces/:workspaceId/images — Upload an image
router.post("/:workspaceId/images", (req, res) => {
  upload.single("image")(req, res, async (err) => {
    if (err instanceof multer.MulterError) {
      if (err.code === "LIMIT_FILE_SIZE") {
        return res.status(400).json({ error: "File too large. Maximum size allowed is 5MB." });
      }
      return res.status(400).json({ error: `Upload error: ${err.message}` });
    } else if (err) {
      return res.status(500).json({ error: "Image upload failed due to an unknown error." });
    }

    try {
      const workspaceId = req.params.workspaceId as string;
      const file = req.file;

      if (!workspaceId) {
        return res.status(400).json({ error: "workspaceId is required" });
      }
      if (!file) {
        return res.status(400).json({ error: "No image file provided" });
      }

      const validationError = imageService.validateFile(file);
      if (validationError) {
        return res.status(400).json({ error: validationError });
      }

      const result = await imageService.processAndStore(workspaceId, file);
      return res.status(201).json(result);
    } catch (error) {
      console.error("[Images] Upload failed:", error);
      return res.status(500).json({ error: "Image upload failed" });
    }
  });
});

// GET /api/images/:id — Serve an image. Default: 307 redirect to a short-lived
// Supabase signed URL so bytes flow Browser ↔ CDN directly. Pass ?proxy=1 to
// stream the bytes through this server (escape hatch for clients that can't
// follow cross-origin redirects).
router.get("/:id", async (req, res) => {
  try {
    if (req.query.proxy === "1") {
      const result = await imageService.getBytes(req.params.id as string);
      if (!result) return res.status(404).json({ error: "Image not found" });
      res.setHeader("Content-Type", result.mimeType);
      res.setHeader("Content-Length", result.buffer.length);
      res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      return res.send(result.buffer);
    }

    const url = await imageService.getSignedUrl(req.params.id as string);
    if (!url) return res.status(404).json({ error: "Image not found" });
    return res.redirect(307, url);
  } catch (error) {
    console.error("[Images] Serve failed:", error);
    return res.status(500).json({ error: "Failed to serve image" });
  }
});

export default router;
