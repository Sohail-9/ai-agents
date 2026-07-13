import fs from "node:fs";
import path from "node:path";
import { config as loadEnv } from "dotenv";

const envPaths = [
  path.resolve(process.cwd(), "..", ".env"),
  path.resolve(process.cwd(), ".env"),
];

for (const envPath of envPaths) {
  if (fs.existsSync(envPath)) {
    loadEnv({ path: envPath, override: false });
  }
}
