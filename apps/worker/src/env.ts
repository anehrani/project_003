/** Central env access — fail fast, never log secrets. */

function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    throw new Error(`Missing required env var ${name} (see .env.example)`);
  }
  return v;
}

function optional(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

export const env = {
  get databaseUrl(): string {
    return required('DATABASE_URL');
  },
  get appEncryptionKey(): string {
    return required('APP_ENCRYPTION_KEY');
  },
  get workerSecret(): string {
    return optional('WORKER_SECRET', 'dev-worker-secret');
  },
  get metaApiVersion(): string {
    return optional('META_API_VERSION', 'v23.0');
  },
  get port(): number {
    return parseInt(optional('PORT', '3001'), 10);
  },
  /** Global kill switch — when true, no Meta mutation ever happens. */
  get globalDryRun(): boolean {
    return optional('DRY_RUN', 'true').toLowerCase() !== 'false';
  },
  get metaAppId(): string {
    return optional('META_APP_ID', '');
  },
  get metaAppSecret(): string {
    return optional('META_APP_SECRET', '');
  },
};
