class GroqKeyPool {
  private keys: string[];
  private currentIndex: number = 0;
  private rotatingPromise: Promise<void> | null = null;

  constructor(keysEnv?: string) {
    this.keys = [];

    if (keysEnv) {
      console.log(`[GROQ] Loading keys from GROQ_API_KEYS (comma-separated)`);
      // Support comma-separated format: GROQ_API_KEYS="key1,key2,key3"
      this.keys = keysEnv
        .split(",")
        .map((k) => k.trim())
        .filter((k) => k.length > 0);
    } else {
      console.log(`[GROQ] Loading keys from individual env vars (GROQ_API_KEY, GROQ_API_KEY_2..5)`);
      // Support individual env vars: GROQ_API_KEY, GROQ_API_KEY_2, ..., GROQ_API_KEY_5
      for (let i = 1; i <= 5; i++) {
        const varName = i === 1 ? "GROQ_API_KEY" : `GROQ_API_KEY_${i}`;
        const key = i === 1
          ? process.env.GROQ_API_KEY
          : process.env[`GROQ_API_KEY_${i}`];
        if (key) {
          console.log(`[GROQ]   ✓ Found ${varName} (${key.substring(0, 20)}...)`);
          this.keys.push(key);
        } else {
          console.log(`[GROQ]   ✗ ${varName} not found`);
        }
      }
    }

    console.log(`[GROQ] Pool initialized with ${this.keys.length} keys total`);
    if (this.keys.length === 0) {
      console.warn(`[GROQ] WARNING: No Groq API keys found! Skill routing will be disabled.`);
    }
  }

  getCurrentKey(): string {
    return this.keys[this.currentIndex];
  }

  rotateKey(): void {
    if (this.keys.length === 0) return;
    this.currentIndex = (this.currentIndex + 1) % this.keys.length;
    console.log(`[GROQ] Rotated to key #${this.currentIndex + 1}/${this.keys.length}`);
  }

  hasMoreKeys(): boolean {
    return this.keys.length > 1;
  }

  getPoolSize(): number {
    return this.keys.length;
  }
}

let _pool: GroqKeyPool | null = null;

export function initGroqPool(keysEnv?: string): void {
  _pool = new GroqKeyPool(keysEnv);
}

export function getGroqPool(): GroqKeyPool {
  if (!_pool) {
    const commaSeparated = process.env.GROQ_API_KEYS;
    _pool = new GroqKeyPool(commaSeparated);
  }
  return _pool;
}
