/** Typed errors — never leak tokens (spec §8: never log tokens). */

export interface MetaErrorBody {
  error?: {
    message?: string;
    type?: string;
    code?: number;
    error_subcode?: number;
    error_user_title?: string;
    error_user_msg?: string;
    fbtrace_id?: string;
  };
}

/** Local redaction so this package stays dependency-free (mirror of db/crypto.redact). */
function redact(text: string): string {
  return text
    .replace(/access_token=[^&"\s]+/gi, 'access_token=[REDACTED]')
    .replace(/EA[A-Za-z0-9_-]{10,}/g, 'EA…[REDACTED]');
}

export class MetaApiError extends Error {
  readonly status: number;
  readonly code?: number;
  readonly subcode?: number;
  readonly type?: string;
  readonly fbtraceId?: string;
  /** True when the error is Meta rate limiting (retry with backoff makes sense). */
  readonly isRateLimit: boolean;

  constructor(status: number, body: unknown, endpoint: string) {
    const err = (body as MetaErrorBody)?.error;
    const rawMessage =
      err?.message ?? `Meta API request failed (HTTP ${status}) on ${endpoint}`;
    const message = redact(rawMessage);
    super(`Meta API error (HTTP ${status}) on ${endpoint}: ${message}`);
    this.name = 'MetaApiError';
    this.status = status;
    this.code = err?.code;
    this.subcode = err?.error_subcode;
    this.type = err?.type;
    this.fbtraceId = err?.fbtrace_id;
    this.isRateLimit =
      status === 429 || [4, 9, 17, 32, 613].includes(err?.code ?? -1);
  }
}

/** Codes returned by Meta when the access token is invalid/expired. */
export const TOKEN_ERROR_CODES = [190, 102, 463, 467];
