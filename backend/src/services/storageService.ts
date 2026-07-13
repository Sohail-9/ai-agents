import { createClient, SupabaseClient } from "@supabase/supabase-js";

// Provider-agnostic blob store contract. Add an S3 driver by writing a new
// `createS3Store()` that returns this same interface, then switch via the
// STORAGE_DRIVER env var below — no caller changes needed.
export interface BlobStore {
  put(input: { key: string; body: Buffer; contentType: string; bucket?: string }): Promise<void>;
  download(key: string): Promise<{ buffer: Buffer; contentType: string }>;
  signedUrl(key: string, expiresInSec: number): Promise<string>;
  remove(key: string): Promise<void>;
}

function createSupabaseStore(): BlobStore {
  let client: SupabaseClient | null = null;

  const getClient = (): SupabaseClient => {
    if (client) return client;
    const url = process.env.SUPABASE_URL;
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !serviceKey) {
      throw new Error(
        "Supabase storage is not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the backend env.",
      );
    }
    client = createClient(url, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    return client;
  };

  const getBucket = (): string => process.env.SUPABASE_STORAGE_BUCKET || "chat-images";

  return {
    async put({ key, body, contentType, bucket }) {
      const { error } = await getClient()
        .storage.from(bucket ?? getBucket())
        .upload(key, body, {
          contentType,
          cacheControl: "31536000",
          upsert: true,
        });
      if (error) throw new Error(`Supabase upload failed (${key}): ${error.message}`);
    },

    async download(key) {
      const { data, error } = await getClient().storage.from(getBucket()).download(key);
      if (error || !data) {
        throw new Error(`Supabase download failed (${key}): ${error?.message ?? "no data"}`);
      }
      const arrayBuffer = await data.arrayBuffer();
      return { buffer: Buffer.from(arrayBuffer), contentType: data.type };
    },

    async signedUrl(key, expiresInSec) {
      const { data, error } = await getClient()
        .storage.from(getBucket())
        .createSignedUrl(key, expiresInSec);
      if (error || !data?.signedUrl) {
        throw new Error(`Supabase signed URL failed (${key}): ${error?.message ?? "no url"}`);
      }
      return data.signedUrl;
    },

    async remove(key) {
      const { error } = await getClient().storage.from(getBucket()).remove([key]);
      if (error) throw new Error(`Supabase remove failed (${key}): ${error.message}`);
    },
  };
}

function selectDriver(): BlobStore {
  const driver = (process.env.STORAGE_DRIVER || "supabase").toLowerCase();
  switch (driver) {
    case "supabase":
      return createSupabaseStore();
    // case "s3":
    //   return createS3Store(); // implement in ./storage/s3.ts when needed
    default:
      throw new Error(`Unknown STORAGE_DRIVER: ${driver}`);
  }
}

let cached: BlobStore | null = null;

export const storageService: BlobStore = {
  put: (input) => (cached ??= selectDriver()).put(input),
  download: (key) => (cached ??= selectDriver()).download(key),
  signedUrl: (key, ttl) => (cached ??= selectDriver()).signedUrl(key, ttl),
  remove: (key) => (cached ??= selectDriver()).remove(key),
};
