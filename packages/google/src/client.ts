/**
 * Thin, typed client for the Google Ads API (REST interface).
 *
 * Spec §8 (adapted for Google): we use direct REST calls (GAQL search for
 * reads, adGroups:mutate / campaignBudgets:mutate for writes) instead of the
 * heavyweight generated gRPC clients — more control, simpler to debug.
 *
 * Auth model (post Sept 2026): access is bound to the Google Cloud project of
 * the OAuth client — a developer-token header is no longer required, but is
 * still sent when one is configured (legacy/compat). Money is MICROS on the
 * wire (1 cent = 10,000 micros); this client converts to cents at the border.
 *
 * Security: the refresh token and access token are sent ONLY in the
 * Authorization header / token exchange and are never logged, never stored in
 * error messages, never included in stored responses.
 */

import { GoogleAdsApiError } from './errors';
import { EMPTY_METRICS, MICROS_PER_CENT, microsToCents, normalizeMetrics } from './normalize';
import type {
  GoogleAdsRow,
  GoogleAdGroupSummary,
  GoogleCampaignSummary,
  MetricsRange,
  NormalizedMetrics,
} from './types';

const API_BASE = 'https://googleads.googleapis.com';
const OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const DEFAULT_API_VERSION = 'v26';

export interface GoogleAdsClientOptions {
  /** Google Ads customer id — 10 digits, dashes allowed and stripped. */
  customerId: string;
  /** OAuth2 refresh token (stored AES-256-GCM encrypted at rest in our DB). */
  refreshToken: string;
  /** OAuth2 client credentials of OUR Cloud project (env, not per user). */
  clientId: string;
  clientSecret: string;
  /** Manager account (MCC) customer id when the token is held by an MCC. */
  loginCustomerId?: string;
  /** Legacy header — optional since the Sept 2026 access-model change. */
  developerToken?: string;
  apiVersion?: string;
  /** Retry with exponential backoff on rate limits (default: 3 attempts). */
  maxRetries?: number;
  /** Injectable fetch for tests. */
  fetchImpl?: typeof fetch;
}

interface RequestOptions {
  method: 'GET' | 'POST';
  json?: unknown;
}

interface CachedToken {
  accessToken: string;
  expiresAt: number;
}

export class GoogleAdsClient {
  private readonly customerId: string;
  private readonly refreshToken: string;
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly loginCustomerId?: string;
  private readonly developerToken?: string;
  private readonly apiVersion: string;
  private readonly maxRetries: number;
  private readonly fetchImpl: typeof fetch;
  private cachedToken: CachedToken | null = null;

  constructor(opts: GoogleAdsClientOptions) {
    this.customerId = opts.customerId.replace(/\D/g, '');
    if (!/^\d{10}$/.test(this.customerId)) {
      throw new Error(
        `Invalid Google Ads customer id "${opts.customerId}" — expected 10 digits, e.g. 1234567890`,
      );
    }
    this.refreshToken = opts.refreshToken;
    this.clientId = opts.clientId;
    this.clientSecret = opts.clientSecret;
    this.loginCustomerId = opts.loginCustomerId?.replace(/\D/g, '') || undefined;
    this.developerToken = opts.developerToken || undefined;
    this.apiVersion = opts.apiVersion ?? DEFAULT_API_VERSION;
    this.maxRetries = opts.maxRetries ?? 3;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  // -------------------------------------------------------------------------
  // Auth — refresh token → short-lived access token (cached, 5 min buffer)
  // -------------------------------------------------------------------------

  async getAccessToken(): Promise<string> {
    if (this.cachedToken && Date.now() < this.cachedToken.expiresAt) {
      return this.cachedToken.accessToken;
    }
    const res = await this.fetchImpl(new URL(OAUTH_TOKEN_URL), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: this.refreshToken,
        client_id: this.clientId,
        client_secret: this.clientSecret,
      }).toString(),
    });
    const body = (await res.json().catch(() => ({}))) as {
      access_token?: string;
      expires_in?: number;
    };
    if (!res.ok || !body.access_token) {
      throw new GoogleAdsApiError(res.status, body, 'oauth2.googleapis.com/token');
    }
    // Refresh 5 minutes before actual expiry — clock skew safety.
    const ttl = ((body.expires_in ?? 3600) - 300) * 1000;
    this.cachedToken = { accessToken: body.access_token, expiresAt: Date.now() + Math.max(ttl, 60_000) };
    return body.access_token;
  }

  // -------------------------------------------------------------------------
  // Read: accounts, campaigns, ad groups, metrics
  // -------------------------------------------------------------------------

  /** Google Ads customer accounts the OAuth user can access (Week 1 connect flow). */
  async listAccessibleCustomers(): Promise<string[]> {
    const body = await this.request<{ resourceNames?: string[] }>(
      'customers:listAccessibleCustomers',
      { method: 'GET' },
    );
    return body.resourceNames ?? [];
  }

  async listCampaigns(): Promise<GoogleCampaignSummary[]> {
    const rows = await this.search(
      `SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type, ` +
        `campaign_budget.id, campaign_budget.amount_micros ` +
        `FROM campaign WHERE campaign.status != 'REMOVED'`,
    );
    return rows.map((r) => ({
      id: r.campaign?.id ?? '',
      name: r.campaign?.name ?? '',
      status: r.campaign?.status ?? '',
      advertisingChannelType: r.campaign?.advertisingChannelType ?? '',
      budgetId: r.campaignBudget?.id ?? '',
      dailyBudgetCents: microsToCents(r.campaignBudget?.amountMicros),
    }));
  }

  async listAdGroups(campaignId: string): Promise<GoogleAdGroupSummary[]> {
    assertNumericId(campaignId, 'campaign id');
    const rows = await this.search(
      `SELECT ad_group.id, ad_group.name, ad_group.status, campaign.id, ` +
        `campaign_budget.id, campaign_budget.amount_micros ` +
        `FROM ad_group WHERE campaign.id = ${campaignId} AND ad_group.status != 'REMOVED'`,
    );
    return rows.map((r) => ({
      id: r.adGroup?.id ?? '',
      name: r.adGroup?.name ?? '',
      status: r.adGroup?.status ?? '',
      campaignId: r.campaign?.id ?? String(campaignId),
      budgetId: r.campaignBudget?.id ?? '',
      dailyBudgetCents: microsToCents(r.campaignBudget?.amountMicros),
    }));
  }

  /**
   * Aggregated metrics for a campaign or ad group over a date window.
   * Date ranges resolve client-side ('today', 'this_month', 'last_Nd');
   * Google reports in the account's timezone — date strings pass through as-is.
   */
  async getMetrics(
    objectKind: 'campaign' | 'adGroup',
    id: string,
    range: MetricsRange,
  ): Promise<NormalizedMetrics> {
    assertNumericId(id, `${objectKind} id`);
    const { since, until } = resolveRange(range);
    const resource = objectKind === 'campaign' ? 'campaign' : 'ad_group';
    const where = objectKind === 'campaign' ? `campaign.id = ${id}` : `ad_group.id = ${id}`;
    const query =
      `SELECT segments.date, metrics.cost_micros, metrics.clicks, metrics.impressions, ` +
      `metrics.conversions, metrics.conversions_value, metrics.ctr ` +
      `FROM ${resource} WHERE ${where} AND segments.date BETWEEN '${since}' AND '${until}'`;
    return normalizeMetrics(await this.search(query));
  }

  // -------------------------------------------------------------------------
  // Write: pause / resume ad groups, campaign budget changes
  // -------------------------------------------------------------------------

  async pauseAdGroup(adGroupId: string): Promise<{ success: boolean }> {
    return this.mutateAdGroupStatus(adGroupId, 'PAUSED');
  }

  async activateAdGroup(adGroupId: string): Promise<{ success: boolean }> {
    return this.mutateAdGroupStatus(adGroupId, 'ENABLED');
  }

  /**
   * Sets the daily budget of a CAMPAIGN BUDGET in cents.
   * Google ad groups have no own budget — every ad group inherits its
   * campaign's budget, so budget actions from the engine target the budget
   * the ad group's campaign is linked to (summary.budgetId).
   */
  async setCampaignBudgetDailyCents(budgetId: string, cents: number): Promise<{ success: boolean }> {
    assertNumericId(budgetId, 'campaign budget id');
    if (!Number.isInteger(cents) || cents <= 0) {
      throw new Error(`Invalid daily budget ${cents} — expected a positive integer number of cents`);
    }
    await this.request(`customers/${this.customerId}/campaignBudgets:mutate`, {
      method: 'POST',
      json: {
        operations: [
          {
            update: {
              resourceName: `customers/${this.customerId}/campaignBudgets/${budgetId}`,
              amountMicros: String(cents * MICROS_PER_CENT),
            },
            updateMask: 'amountMicros',
          },
        ],
      },
    });
    return { success: true };
  }

  private async mutateAdGroupStatus(adGroupId: string, status: string): Promise<{ success: boolean }> {
    assertNumericId(adGroupId, 'ad group id');
    await this.request(`customers/${this.customerId}/adGroups:mutate`, {
      method: 'POST',
      json: {
        operations: [
          {
            update: {
              resourceName: `customers/${this.customerId}/adGroups/${adGroupId}`,
              status,
            },
            updateMask: 'status',
          },
        ],
      },
    });
    return { success: true };
  }

  // -------------------------------------------------------------------------
  // Transport
  // -------------------------------------------------------------------------

  /** Paginated GAQL search — collects every page into one row array. */
  private async search(query: string): Promise<GoogleAdsRow[]> {
    const rows: GoogleAdsRow[] = [];
    let pageToken: string | undefined;
    do {
      const json: Record<string, unknown> = { query };
      if (pageToken) json.page_token = pageToken;
      const res = await this.request<{ results?: GoogleAdsRow[]; nextPageToken?: string }>(
        `customers/${this.customerId}/googleAds:search`,
        { method: 'POST', json },
      );
      rows.push(...(res.results ?? []));
      pageToken = res.nextPageToken;
    } while (pageToken);
    return rows;
  }

  private async request<T>(
    path: string,
    opts: RequestOptions,
    attempt = 0,
  ): Promise<T> {
    const url = new URL(`${API_BASE}/${this.apiVersion}/${path}`);
    const token = await this.getAccessToken();
    const res = await this.fetchImpl(url, {
      method: opts.method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...(this.developerToken ? { 'developer-token': this.developerToken } : {}),
        ...(this.loginCustomerId ? { 'login-customer-id': this.loginCustomerId } : {}),
      },
      body: opts.json === undefined ? undefined : JSON.stringify(opts.json),
    });

    if (res.ok) {
      return (await res.json().catch(() => ({}))) as T;
    }

    const body = await res.json().catch(() => ({}));
    const err = new GoogleAdsApiError(res.status, body, path);

    // Throttling / transient failure → exponential backoff and retry.
    if (err.isRateLimit && attempt < this.maxRetries) {
      await sleep(1000 * 2 ** attempt);
      return this.request<T>(path, opts, attempt + 1);
    }

    throw err;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** GAQL ids are interpolated into queries — only digits are ever allowed. */
function assertNumericId(id: string, label: string): void {
  if (!/^\d+$/.test(id)) {
    throw new Error(`Invalid Google Ads ${label} "${id}" — expected a numeric id`);
  }
}

/**
 * Resolves a MetricsRange to an inclusive {since, until} pair of YYYY-MM-DD
 * strings (UTC calendar days — Google shifts to the account's timezone).
 */
export function resolveRange(range: MetricsRange): { since: string; until: string } {
  if ('since' in range) {
    for (const d of [range.since, range.until]) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) {
        throw new Error(`Invalid date "${d}" — expected YYYY-MM-DD`);
      }
    }
    return { since: range.since, until: range.until };
  }
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  const now = new Date();
  const daysAgo = (n: number) => new Date(now.getTime() - n * 24 * 3600_000);
  switch (range.datePreset) {
    case 'today':
      return { since: fmt(now), until: fmt(now) };
    case 'this_month':
      return { since: fmt(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))), until: fmt(now) };
    case 'last_3d':
    case 'last_7d':
    case 'last_30d': {
      // 'last_7d'.slice(5) = '7d' → parseInt stops at the digits = 7
      const n = Number.parseInt(range.datePreset.slice(5), 10);
      return { since: fmt(daysAgo(n - 1)), until: fmt(now) };
    }
    default: {
      const never: never = range.datePreset;
      throw new Error(`Unknown date preset: ${never}`);
    }
  }
}

export { GoogleAdsApiError, TOKEN_ERROR_STATUSES } from './errors';
export { EMPTY_METRICS, MICROS_PER_CENT, microsToCents, normalizeMetrics } from './normalize';
export * from './types';
