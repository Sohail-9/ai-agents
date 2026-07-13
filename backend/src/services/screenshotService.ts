import { storageService } from "./storageService";
import { deploymentService } from "./deploymentService";

const SCREENSHOTS_BUCKET = process.env.SUPABASE_SCREENSHOTS_BUCKET || "deployment-screenshots";

function getPublicUrl(key: string): string {
  const supabaseUrl = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
  return `${supabaseUrl}/storage/v1/object/public/${SCREENSHOTS_BUCKET}/${key}`;
}

export const screenshotService = {
  async saveFromBase64(deploymentId: string, base64: string): Promise<void> {
    try {
      const buffer = Buffer.from(base64, "base64");
      const key = `${deploymentId}.png`;

      await storageService.put({ key, body: buffer, contentType: "image/png", bucket: SCREENSHOTS_BUCKET });
      const screenshotUrl = getPublicUrl(key);

      const deployment = await deploymentService.getDeployment(deploymentId);
      const existingConfig = (deployment?.config as Record<string, unknown>) ?? {};

      await deploymentService.updateDeployment(deploymentId, {
        config: { ...existingConfig, screenshotUrl },
      });

      console.log(`[Screenshot] Saved for deployment ${deploymentId}: ${screenshotUrl}`);
    } catch (err: any) {
      console.error(`[Screenshot] Failed for deployment ${deploymentId}:`, err?.message);
    }
  },
};
