/** Typed errors — never leak tokens (spec §8: never log credentials). */

export interface GoogleErrorBody {
  error?: {
    /** Google RPC numeric code (e.g. 8 = RESOURCE_EXHAUSTED). */
    code?: number;
    message?: string;
    /** gRPC status string, e.g. PERMISSION_DENIED, INVALID_ARGUMENT. */
    status?: string;
    details?: unknown[];
  };
}

/** Local redaction so this package stays dependency-free (mirror of db/crypto.redact). */
function redact(text: string): string {
  return text
    .replace(/access_token=[^&"\s]+/gi, 'access_token=[REDACTED]')
    .replace(/ya29\.[A-Za-z0-9_-]{10,}/g, 'ya29…[REDACTED]')
    .replace(/Bearer\s+[A-Za-z0-9._-]{15,}/g, 'Bearer [REDACTED]');
}

export class GoogleAdsApiError extends Error {
  /** HTTP status of the failed request. */
  readonly status: number;
  /** Google RPC numeric code, when the body carried one. */
  readonly code?: number;
  /** gRPC status string (PERMISSION_DENIED, RESOURCE_EXHAUSTED, …). */
  readonly rpcStatus?: string;
  /** True when retrying with backoff makes sense (throttling / transient). */
  readonly isRateLimit: boolean;

  constructor(status: number, body: unknown, endpoint: string) {
    const err = (body as GoogleErrorBody)?.error;
    const rawMessage =
      err?.message ?? `Google Ads API request failed (HTTP ${status}) on ${endpoint}`;
    super(`Google Ads API error (HTTP ${status}) on ${endpoint}: ${redact(rawMessage)}`);
    this.name = 'GoogleAdsApiError';
    this.status = status;
    this.code = err?.code;
    this.rpcStatus = err?.status;
    this.isRateLimit = status === 429 || status === 503 || err?.code === 8;
  }
}

/** HTTP statuses that mean the credentials are bad — the user must reconnect. */
export const TOKEN_ERROR_STATUSES = [401, 403];
