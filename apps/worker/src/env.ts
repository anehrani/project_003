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
  get googleAdsApiVersion(): string {
    return optional('GOOGLE_ADS_API_VERSION', 'v26');
  },
  /** Legacy header — optional since the Sept 2026 Cloud-project access model. */
  get googleAdsDeveloperToken(): string {
    return optional('GOOGLE_ADS_DEVELOPER_TOKEN', '');
  },
  /** OAuth2 client of OUR Google Cloud project (same for all users). */
  get googleAdsClientId(): string {
    return required('GOOGLE_ADS_CLIENT_ID');
  },
  get googleAdsClientSecret(): string {
    return required('GOOGLE_ADS_CLIENT_SECRET');
  },
  get port(): number {
    return parseInt(optional('PORT', '3001'), 10);
  },
  /** Global kill switch — when true, no Google Ads mutation ever happens. */
  get globalDryRun(): boolean {
    return optional('DRY_RUN', 'true').toLowerCase() !== 'false';
  },
};
