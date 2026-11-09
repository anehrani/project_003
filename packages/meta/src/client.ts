/**
 * Thin, typed client for the Meta Marketing API (Graph API).
 *
 * Spec §8: we use direct API calls (pause / budget update / insights) instead of
 * POST /act_{id}/adrules_library — more control, simpler to debug.
 *
 * Security: the access token is sent ONLY in the Authorization header and is
 * never logged, never stored in error messages, never included in stored
 * responses (spec §8).
 */

import { redact } from '@budgetguard/db';
import { MetaApiError } from './errors';
import { EMPTY_INSIGHTS, normalizeInsights } from './normalize';
import type {
  MetaAdAccount,
  MetaAdSetSummary,
  MetaCampaignSummary,
  NormalizedInsights,
  RawInsightsRow,
  UsageSnapshot,
} from './types';

const GRAPH_BASE = 'https://graph.facebook.com';

export interface MetaClientOptions {
  apiVersion?: string;
  /** Retry with exponential backoff on rate limits (default: 3 attempts). */
  maxRetries?: number;
  onUsage?: (usage: UsageSnapshot) => void;
  /** Injectable fetch for tests. */
  fetchImpl?: typeof fetch;
}

interface RequestOptions {
  query?: Record<string, string | undefined>;
  form?: Record<string, string | undefined>;
  retries?: number;
}

export class MetaClient {
  private readonly token: string;
  private readonly apiVersion: string;
  private readonly maxRetries: number;
  private readonly onUsage?: (usage: UsageSnapshot) => void;
  private readonly fetchImpl: typeof fetch;

  constructor(accessToken: string, opts: MetaClientOptions = {}) {
    this.token = accessToken;
    this.apiVersion = opts.apiVersion ?? 'v23.0';
    this.maxRetries = opts.maxRetries ?? 3;
    this.onUsage = opts.onUsage;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  // -------------------------------------------------------------------------
  // Tokens
  // -------------------------------------------------------------------------

  /** Exchanges a short-lived OAuth token for a ~60-day long-lived token. */
  static async exchangeLongLivedToken(params: {
    appId: string;
    appSecret: string;
    shortLivedToken: string;
    apiVersion?: string;
  }): Promise<{ accessToken: string; expiresIn: number }> {
    const version = params.apiVersion ?? 'v23.0';
    const url = `${GRAPH_BASE}/${version}/oauth/access_token?${new URLSearchParams({
      grant_type: 'fb_exchange_token',
      client_id: params.appId,
      client_secret: params.appSecret,
      fb_exchange_token: params.shortLivedToken,
    })}`;
    const res = await fetch(url, { method: 'GET' });
    const body = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!res.ok || !body.access_token) {
      throw new MetaApiError(res.status, body, 'oauth/access_token');
    }
    return { accessToken: body.access_token, expiresIn: body.expires_in ?? 0 };
  }

  // -------------------------------------------------------------------------
  // Read: accounts, campaigns, ad sets, insights
  // -------------------------------------------------------------------------

  async listAdAccounts(): Promise<MetaAdAccount[]> {
    const body = await this.get<{ data: any[] }>('me/adaccounts', {
      query: {
        fields: 'id,name,currency,account_status',
        limit: '100',
      },
    });
    return (body.data ?? []).map((a) => ({
      id: a.id,
      name: a.name,
      currency: a.currency,
      accountStatus: a.account_status,
    }));
  }

  async listCampaigns(adAccountId: string): Promise<MetaCampaignSummary[]> {
    const body = await this.get<{ data: any[] }>(`${adAccountId}/campaigns`, {
      query: { fields: 'id,name,status,objective', limit: '100' },
    });
    return (body.data ?? []).map((c) => ({
      id: c.id,
      name: c.name,
      status: c.status,
      objective: c.objective,
    }));
  }

  async listAdSets(campaignId: string): Promise<MetaAdSetSummary[]> {
    const body = await this.get<{ data: any[] }>(`${campaignId}/adsets`, {
      query: { fields: 'id,name,status,daily_budget', limit: '100' },
    });
    return (body.data ?? []).map((s) => ({
      id: s.id,
      name: s.name,
      status: s.status,
      dailyBudget: s.daily_budget,
    }));
  }

  /**
   * Fetches insights for any object (campaign or ad set) and normalizes them.
   * Pass either datePreset ("today", "this_month", "last_7d", "last_30d") or
   * an explicit {since, until} range (inclusive, YYYY-MM-DD, account timezone).
   */
  async getInsights(
    objectId: string,
    range: { datePreset?: string; since?: string; until?: string },
  ): Promise<NormalizedInsights> {
    const query: Record<string, string | undefined> = {
      fields: 'spend,impressions,clicks,ctr,reach,actions,action_values',
    };
    if (range.datePreset) query.date_preset = range.datePreset;
    if (range.since && range.until) {
      query.time_range = JSON.stringify({ since: range.since, until: range.until });
    }
    const body = await this.get<{ data: RawInsightsRow[] }>(`${objectId}/insights`, { query });
    const row = body.data?.[0];
    if (!row) return EMPTY_INSIGHTS;
    return normalizeInsights(row);
  }

  // -------------------------------------------------------------------------
  // Write: pause / resume / budget
  // -------------------------------------------------------------------------

  async pauseAdSet(adSetId: string): Promise<{ success: boolean }> {
    return this.post(`${adSetId}`, { form: { status: 'PAUSED' } });
  }

  async activateAdSet(adSetId: string): Promise<{ success: boolean }> {
    return this.post(`${adSetId}`, { form: { status: 'ACTIVE' } });
  }

  /** Sets the ad set daily budget. `cents` = minor units of the account currency. */
  async setAdSetDailyBudget(adSetId: string, cents: number): Promise<{ success: boolean }> {
    return this.post(`${adSetId}`, { form: { daily_budget: String(cents) } });
  }

  // -------------------------------------------------------------------------
  // Transport
  // -------------------------------------------------------------------------

  private async get<T>(path: string, opts: RequestOptions = {}): Promise<T> {
    const url = new URL(`${GRAPH_BASE}/${this.apiVersion}/${path}`);
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v !== undefined) url.searchParams.set(k, v);
    }
    return this.request<T>(url, { method: 'GET', headers: this.headers() }, opts);
  }

  private async post<T>(path: string, opts: RequestOptions = {}): Promise<T> {
    const url = new URL(`${GRAPH_BASE}/${this.apiVersion}/${path}`);
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(opts.form ?? {})) {
      if (v !== undefined) params.set(k, v);
    }
    return this.request<T>(
      url,
      {
        method: 'POST',
        headers: this.headers('application/x-www-form-urlencoded'),
        body: params.toString(),
      },
      opts,
    );
  }

  private headers(contentType?: string): Record<string, string> {
    const h: Record<string, string> = { Authorization: `Bearer ${this.token}` };
    if (contentType) h['Content-Type'] = contentType;
    return h;
  }

  private async request<T>(
    url: URL,
    init: RequestInit,
    opts: RequestOptions,
    attempt = 0,
  ): Promise<T> {
    const res = await this.fetchImpl(url, init);
    this.trackUsage(res);

    if (res.ok) {
      return (await res.json()) as T;
    }

    const body = await res.json().catch(() => ({}));
    const err = new MetaApiError(res.status, body, url.pathname.replace(`/${this.apiVersion}`, ''));

    // Rate limiting → exponential backoff and retry (never hammer Meta).
    if (err.isRateLimit && attempt < (opts.retries ?? this.maxRetries)) {
      const retryAfter = Number(res.headers.get('retry-after'));
      const delayMs = Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : 1000 * 2 ** attempt;
      await sleep(delayMs);
      return this.request<T>(url, init, opts, attempt + 1);
    }

    throw err;
  }

  private trackUsage(res: Response): void {
    if (!this.onUsage) return;
    const raw = res.headers.get('x-business-use-case-usage');
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw) as Record<string, Array<{ call_count: number }>>;
      const accountId = Object.keys(parsed)[0];
      if (accountId) {
        this.onUsage({ accountId, callCount: parsed[accountId][0]?.call_count ?? 0 });
      }
    } catch {
      // usage header is best-effort only
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export { MetaApiError, TOKEN_ERROR_CODES } from './errors';
export { normalizeInsights, EMPTY_INSIGHTS } from './normalize';
export * from './types';
