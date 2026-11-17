/**
 * Google Ads client tests — the "no Google needed" test env.
 * The whole Ads API (REST) is faked via the injectable fetchImpl: we assert
 * the exact requests the client would make (URL, headers, GAQL, mutate bodies)
 * and how responses / errors / rate limits are handled.
 */

import { describe, expect, it } from 'vitest';

import {
  EMPTY_METRICS,
  GoogleAdsApiError,
  GoogleAdsClient,
  resolveRange,
} from '../src';

const REFRESH = '1//REFRESHTOKEN123456';
const ACCESS = 'ya29.FAKEACCESSTOKEN1234567890';

interface RecordedCall {
  url: URL;
  init: RequestInit;
}

type Handler = (call: RecordedCall, callIndex: number) => Response;

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function makeClient(handler: Handler, opts: Partial<ConstructorParameters<typeof GoogleAdsClient>[0]> = {}) {
  const calls: RecordedCall[] = [];
  const fetchImpl = ((url: URL, init: RequestInit) => {
    calls.push({ url, init });
    return Promise.resolve(handler({ url, init }, calls.length - 1));
  }) as unknown as typeof fetch;
  const client = new GoogleAdsClient({
    customerId: '123-456-7890',
    refreshToken: REFRESH,
    clientId: 'CLIENT_ID.apps.googleusercontent.com',
    clientSecret: 'CLIENT_SECRET',
    maxRetries: 1,
    ...opts,
    fetchImpl,
  });
  return { client, calls };
}

/** Default handler: OAuth on /token, empty search results otherwise. */
function defaultHandler(extra: (call: RecordedCall, i: number) => Response | undefined = () => undefined): Handler {
  return (call, i) => {
    const viaExtra = extra(call, i);
    if (viaExtra) return viaExtra;
    if (call.url.href === 'https://oauth2.googleapis.com/token') {
      return jsonRes({ access_token: ACCESS, expires_in: 3600 });
    }
    return jsonRes({});
  };
}

function routeOf(call: RecordedCall): string {
  if (call.url.href === 'https://oauth2.googleapis.com/token') return 'oauth';
  const path = call.url.pathname;
  if (path.endsWith('googleAds:search')) return 'search';
  if (path.endsWith('adGroups:mutate')) return 'adgroups-mutate';
  if (path.endsWith('campaignBudgets:mutate')) return 'budgets-mutate';
  if (path.endsWith('customers:listAccessibleCustomers')) return 'accessible';
  return path;
}

const CAMPAIGN_ROWS = {
  results: [
    {
      campaign: { id: '111', name: 'Search — Brand', status: 'ENABLED', advertisingChannelType: 'SEARCH' },
      campaignBudget: { id: '777', amountMicros: '15000000' },
    },
    {
      campaign: { id: '222', name: 'Performance Max', status: 'PAUSED', advertisingChannelType: 'PERFORMANCE_MAX' },
      campaignBudget: { id: '888', amountMicros: '5000000' },
    },
  ],
  fieldMask: 'campaign.id,campaign.name',
};

describe('GoogleAdsClient — construction & auth', () => {
  it('strips dashes from the customer id and rejects invalid ones', () => {
    expect(() => new GoogleAdsClient({
      customerId: '123-456-7890', refreshToken: 'r', clientId: 'c', clientSecret: 's',
    })).not.toThrow();
    expect(() => new GoogleAdsClient({
      customerId: '12345678901', refreshToken: 'r', clientId: 'c', clientSecret: 's',
    })).toThrow(/10 digits/);
    expect(() => new GoogleAdsClient({
      customerId: 'act_123', refreshToken: 'r', clientId: 'c', clientSecret: 's',
    })).toThrow(/10 digits/);
  });

  it('exchanges the refresh token once and caches the access token', async () => {
    const { client, calls } = makeClient(defaultHandler());
    await client.listCampaigns();
    await client.listCampaigns();

    const oauthCalls = calls.filter((c) => routeOf(c) === 'oauth');
    expect(oauthCalls.length).toBe(1);
    const body = String(oauthCalls[0].init.body);
    expect(body).toContain('grant_type=refresh_token');
    expect(body).toContain(`refresh_token=${encodeURIComponent(REFRESH)}`);
    expect(body).toContain('client_id=CLIENT_ID');

    const search = calls.filter((c) => routeOf(c) === 'search');
    expect(search.length).toBe(2);
    expect((search[0].init.headers as Record<string, string>).Authorization).toBe(`Bearer ${ACCESS}`);
  });
});

describe('GoogleAdsClient — reads', () => {
  it('lists accessible customers', async () => {
    const { client, calls } = makeClient(defaultHandler((call) => {
      if (routeOf(call) === 'accessible') {
        return jsonRes({ resourceNames: ['customers/1234567890', 'customers/9876543210'] });
      }
      return undefined;
    }));

    const list = await client.listAccessibleCustomers();

    expect(list).toEqual(['customers/1234567890', 'customers/9876543210']);
    expect(calls[1].url.pathname).toBe('/v26/customers:listAccessibleCustomers');
    expect(calls[1].init.method).toBe('GET');
  });

  it('lists campaigns and converts budget micros to cents', async () => {
    const { client, calls } = makeClient(
      defaultHandler((call) => (routeOf(call) === 'search' ? jsonRes(CAMPAIGN_ROWS) : undefined)),
      { loginCustomerId: '3333333333', developerToken: 'DEV-TOKEN' },
    );

    const campaigns = await client.listCampaigns();

    expect(campaigns).toEqual([
      {
        id: '111', name: 'Search — Brand', status: 'ENABLED', advertisingChannelType: 'SEARCH',
        budgetId: '777', dailyBudgetCents: 1500,
      },
      {
        id: '222', name: 'Performance Max', status: 'PAUSED', advertisingChannelType: 'PERFORMANCE_MAX',
        budgetId: '888', dailyBudgetCents: 500,
      },
    ]);
    const { url, init } = calls.filter((c) => routeOf(c) === 'search')[0];
    expect(url.pathname).toBe('/v26/customers/1234567890/googleAds:search');
    expect(url.searchParams.size).toBe(0); // query travels in the POST body
    const headers = init.headers as Record<string, string>;
    expect(headers['login-customer-id']).toBe('3333333333');
    expect(headers['developer-token']).toBe('DEV-TOKEN');
    expect(headers['Content-Type']).toBe('application/json');
    const body = JSON.parse(String(init.body));
    expect(body.query).toContain('FROM campaign');
    expect(body.query).toContain("campaign.status != 'REMOVED'");
  });

  it('omits the developer-token header when none is configured (post-2026 model)', async () => {
    const { client, calls } = makeClient(defaultHandler());
    await client.listCampaigns();
    const search = calls.filter((c) => routeOf(c) === 'search')[0];
    expect((search.init.headers as Record<string, string>)['developer-token']).toBeUndefined();
  });

  it('lists ad groups for a campaign with their campaign budget', async () => {
    const { client, calls } = makeClient(
      defaultHandler((call) =>
        routeOf(call) === 'search'
          ? jsonRes({
              results: [
                {
                  adGroup: { id: '555', name: 'AdGroup A', status: 'ENABLED' },
                  campaign: { id: '111' },
                  campaignBudget: { id: '777', amountMicros: '15000000' },
                },
              ],
            })
          : undefined,
      ),
    );

    const [adGroup] = await client.listAdGroups('111');

    expect(adGroup).toEqual({
      id: '555', name: 'AdGroup A', status: 'ENABLED', campaignId: '111',
      budgetId: '777', dailyBudgetCents: 1500,
    });
    const body = JSON.parse(String(calls[1].init.body));
    expect(body.query).toContain('FROM ad_group');
    expect(body.query).toContain('WHERE campaign.id = 111');
    expect(body.query).toContain("ad_group.status != 'REMOVED'");
  });

  it('rejects non-numeric ids before they ever reach GAQL', async () => {
    const { client } = makeClient(defaultHandler());
    await expect(client.listAdGroups("1' OR 1=1")).rejects.toThrow(/numeric id/);
    await expect(client.getMetrics('campaign', 'abc', { datePreset: 'today' })).rejects.toThrow(/numeric id/);
  });

  it('aggregates daily metric rows into one engine window', async () => {
    const { since: today, until } = resolveRange({ datePreset: 'today' });
    const { client, calls } = makeClient(
      defaultHandler((call) =>
        routeOf(call) === 'search'
          ? jsonRes({
              results: [
                { metrics: { costMicros: '5000000', clicks: '30', impressions: '1000', conversions: 2, conversionsValue: 20 }, segments: { date: today } },
                { metrics: { costMicros: '5000000', clicks: '20', impressions: '800', conversions: 1, conversionsValue: 10 }, segments: { date: today } },
                { metrics: { costMicros: '5000000', clicks: '10', impressions: '700', conversions: 1, conversionsValue: 10 }, segments: { date: today } },
              ],
            })
          : undefined,
      ),
    );

    const m = await client.getMetrics('campaign', '111', { datePreset: 'today' });

    // 15,000,000 micros = 1,500 cents; 4 purchases; 4,000 cents revenue
    expect(m.spendCents).toBe(1500);
    expect(m.revenueCents).toBe(4000);
    expect(m.purchases).toBe(4);
    expect(m.impressions).toBe(2500);
    expect(m.clicks).toBe(60);
    expect(m.ctr).toBeCloseTo(60 / 2500);
    expect(m.roas).toBeCloseTo(4000 / 1500);
    expect(m.cpaCents).toBe(375); // 1500 / 4
    expect(m.reach).toBe(0);
    expect(m.frequency).toBeNull(); // Google exposes no per-window reach

    const body = JSON.parse(String(calls[1].init.body));
    expect(body.query).toContain(`segments.date BETWEEN '${today}' AND '${until}'`);
    expect(body.query).toContain('FROM campaign WHERE campaign.id = 111');
  });

  it('passes explicit date ranges through and validates the format', async () => {
    const { client, calls } = makeClient(
      defaultHandler((call) => (routeOf(call) === 'search' ? jsonRes({}) : undefined)),
    );

    await client.getMetrics('adGroup', '555', { since: '2026-01-01', until: '2026-01-07' });

    const body = JSON.parse(String(calls[1].init.body));
    expect(body.query).toContain("FROM ad_group WHERE ad_group.id = 555");
    expect(body.query).toContain("segments.date BETWEEN '2026-01-01' AND '2026-01-07'");
    await expect(
      client.getMetrics('adGroup', '555', { since: '20260101', until: '2026-01-07' }),
    ).rejects.toThrow(/YYYY-MM-DD/);
  });

  it('resolves date presets: this_month and last_7d', () => {
    const now = new Date();
    const fmt = (d: Date) => d.toISOString().slice(0, 10);
    expect(resolveRange({ datePreset: 'this_month' })).toEqual({
      since: fmt(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))),
      until: fmt(now),
    });
    expect(resolveRange({ datePreset: 'last_7d' })).toEqual({
      since: fmt(new Date(now.getTime() - 6 * 24 * 3600_000)),
      until: fmt(now),
    });
  });

  it('returns EMPTY_METRICS when there are no rows', async () => {
    const { client } = makeClient(defaultHandler());
    const m = await client.getMetrics('campaign', '111', { datePreset: 'today' });
    expect(m).toEqual(EMPTY_METRICS);
  });

  it('follows nextPageToken pagination', async () => {
    let n = 0;
    const { client, calls } = makeClient((call) => {
      if (routeOf(call) === 'oauth') return jsonRes({ access_token: ACCESS, expires_in: 3600 });
      n += 1;
      return n === 1
        ? jsonRes({ results: [{ campaign: { id: '1', name: 'a' } }], nextPageToken: 'PT2' })
        : jsonRes({ results: [{ campaign: { id: '2', name: 'b' } }] });
    });

    const campaigns = await client.listCampaigns();

    expect(campaigns.map((c) => c.id)).toEqual(['1', '2']);
    const searches = calls.filter((c) => routeOf(c) === 'search');
    expect(JSON.parse(String(searches[0].init.body)).page_token).toBeUndefined();
    expect(JSON.parse(String(searches[1].init.body)).page_token).toBe('PT2');
  });
});

describe('GoogleAdsClient — writes', () => {
  it('pauses an ad group with a mutate operation', async () => {
    const { client, calls } = makeClient(defaultHandler((call) =>
      routeOf(call) === 'adgroups-mutate'
        ? jsonRes({ results: [{ resourceName: 'customers/1234567890/adGroups/555' }] })
        : undefined,
    ));

    const res = await client.pauseAdGroup('555');

    expect(res).toEqual({ success: true });
    const { url, init, body } = shape(calls[1]);
    expect(url.pathname).toBe('/v26/customers/1234567890/adGroups:mutate');
    expect(init.method).toBe('POST');
    expect(body.operations[0].update).toEqual({
      resourceName: 'customers/1234567890/adGroups/555',
      status: 'PAUSED',
    });
    expect(body.operations[0].updateMask).toBe('status');
  });

  it('resumes (enables) an ad group', async () => {
    const { client, calls } = makeClient(defaultHandler());
    await client.activateAdGroup('555');
    const { body } = shape(calls[1]);
    expect(body.operations[0].update.status).toBe('ENABLED');
  });

  it('sets a campaign budget in micros (1 cent = 10,000 micros)', async () => {
    const { client, calls } = makeClient(defaultHandler());
    await client.setCampaignBudgetDailyCents('777', 2500);

    const { url, body } = shape(calls[1]);
    expect(url.pathname).toBe('/v26/customers/1234567890/campaignBudgets:mutate');
    expect(body.operations[0].update).toEqual({
      resourceName: 'customers/1234567890/campaignBudgets/777',
      amountMicros: '25000000',
    });
    expect(body.operations[0].updateMask).toBe('amountMicros');
  });

  it('rejects invalid budgets before calling the API', async () => {
    const { client, calls } = makeClient(defaultHandler());
    await expect(client.setCampaignBudgetDailyCents('777', 0)).rejects.toThrow(/positive integer/);
    await expect(client.setCampaignBudgetDailyCents('777', -5)).rejects.toThrow(/positive integer/);
    await expect(client.setCampaignBudgetDailyCents('777', 12.5)).rejects.toThrow(/positive integer/);
    expect(calls.length).toBe(0); // validation fires before even the OAuth exchange
  });
});

describe('GoogleAdsClient — errors & retries', () => {
  it('throws a typed, redacted GoogleAdsApiError', async () => {
    const { client } = makeClient(
      defaultHandler((call) =>
        routeOf(call) === 'search'
          ? jsonRes(
              {
                error: {
                  code: 403,
                  message: 'The caller does not have permission ya29.LEAKEDTOKEN12345 for developer-token',
                  status: 'PERMISSION_DENIED',
                },
              },
              403,
            )
          : undefined,
      ),
    );

    const err = await client.listCampaigns().catch((e: unknown) => e);

    expect(err).toBeInstanceOf(GoogleAdsApiError);
    const gErr = err as GoogleAdsApiError;
    expect(gErr.status).toBe(403);
    expect(gErr.code).toBe(403);
    expect(gErr.rpcStatus).toBe('PERMISSION_DENIED');
    expect(gErr.message).toContain('ya29…[REDACTED]');
    expect(gErr.message).not.toContain('ya29.LEAKEDTOKEN12345');
  });

  it('retries once on rate limit and then succeeds', async () => {
    let n = 0;
    const { client, calls } = makeClient((call) => {
      if (routeOf(call) === 'oauth') return jsonRes({ access_token: ACCESS, expires_in: 3600 });
      n += 1;
      return n === 1
        ? jsonRes({ error: { code: 8, message: 'Resource exhausted', status: 'RESOURCE_EXHAUSTED' } }, 429)
        : jsonRes({ results: [] });
    });

    const campaigns = await client.listCampaigns();

    expect(campaigns).toEqual([]);
    const searches = calls.filter((c) => routeOf(c) === 'search');
    expect(searches.length).toBe(2);
  });

  it('gives up after maxRetries and reports isRateLimit', async () => {
    const { client, calls } = makeClient((call) => {
      if (routeOf(call) === 'oauth') return jsonRes({ access_token: ACCESS, expires_in: 3600 });
      return jsonRes({ error: { code: 8, message: 'Resource exhausted', status: 'RESOURCE_EXHAUSTED' } }, 429);
    });

    const err = await client.listCampaigns().catch((e: unknown) => e);

    expect(err).toBeInstanceOf(GoogleAdsApiError);
    expect((err as GoogleAdsApiError).isRateLimit).toBe(true);
    const searches = calls.filter((c) => routeOf(c) === 'search');
    expect(searches.length).toBe(2); // initial + 1 retry (maxRetries: 1)
  });

  it('does NOT retry auth failures (401/403 are terminal)', async () => {
    const { client, calls } = makeClient((call) => {
      if (routeOf(call) === 'oauth') return jsonRes({ access_token: ACCESS, expires_in: 3600 });
      return jsonRes({ error: { code: 401, message: 'Bad access token', status: 'UNAUTHENTICATED' } }, 401);
    });

    const err = await client.listCampaigns().catch((e: unknown) => e);

    expect((err as GoogleAdsApiError).status).toBe(401);
    expect((err as GoogleAdsApiError).isRateLimit).toBe(false);
    expect(calls.filter((c) => routeOf(c) === 'search').length).toBe(1);
  });
});

/** Convenience unpacker: path-checked shape of a recorded API call. */
function shape(call: RecordedCall): { url: URL; init: RequestInit; body: any } {
  return { url: call.url, init: call.init, body: JSON.parse(String(call.init.body ?? '{}')) };
}
