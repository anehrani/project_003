/**
 * Meta client tests — the "no Meta needed" test env.
 * The whole Graph API is faked via the injectable fetchImpl: we assert the
 * exact requests the client would make (URL, auth header, form body) and how
 * responses / errors / rate limits are handled.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { EMPTY_INSIGHTS, MetaApiError, MetaClient } from '../src';

const TOKEN = 'EAATESTTOKEN1234567890';

interface RecordedCall {
  url: URL;
  init: RequestInit;
}

function jsonRes(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

/** Creates a client whose fetchImpl records every call and replies via `handler`. */
function makeClient(
  handler: (call: RecordedCall, callIndex: number) => Response,
  opts: Partial<ConstructorParameters<typeof MetaClient>[1]> = {},
): { client: MetaClient; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fetchImpl = ((url: URL, init: RequestInit) => {
    calls.push({ url, init });
    return Promise.resolve(handler({ url, init }, calls.length - 1));
  }) as unknown as typeof fetch;
  const client = new MetaClient(TOKEN, { maxRetries: 1, ...opts, fetchImpl });
  return { client, calls };
}

describe('MetaClient — reads', () => {
  it('lists ad accounts and sends the token in the Authorization header only', async () => {
    const { client, calls } = makeClient(() =>
      jsonRes({ data: [{ id: 'act_111', name: 'Test Account', currency: 'USD', account_status: 1 }] }),
    );

    const accounts = await client.listAdAccounts();

    expect(accounts).toEqual([
      { id: 'act_111', name: 'Test Account', currency: 'USD', accountStatus: 1 },
    ]);
    const { url, init } = calls[0];
    expect(url.pathname).toBe('/v23.0/me/adaccounts');
    expect(url.searchParams.get('fields')).toBe('id,name,currency,account_status');
    expect(url.searchParams.get('limit')).toBe('100');
    expect(url.searchParams.get('access_token')).toBeNull();
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it('lists campaigns for an ad account', async () => {
    const { client, calls } = makeClient(() =>
      jsonRes({ data: [{ id: 'c1', name: 'Spring Sale', status: 'ACTIVE', objective: 'OUTCOME_SALES' }] }),
    );

    const campaigns = await client.listCampaigns('act_111');

    expect(campaigns[0]).toEqual({
      id: 'c1',
      name: 'Spring Sale',
      status: 'ACTIVE',
      objective: 'OUTCOME_SALES',
    });
    expect(calls[0].url.pathname).toBe('/v23.0/act_111/campaigns');
  });

  it('lists ad sets with the raw daily budget', async () => {
    const { client, calls } = makeClient(() =>
      jsonRes({ data: [{ id: 's1', name: 'AdSet A', status: 'ACTIVE', daily_budget: '12345' }] }),
    );

    const [adSet] = await client.listAdSets('c1');

    expect(adSet).toEqual({ id: 's1', name: 'AdSet A', status: 'ACTIVE', dailyBudget: '12345' });
    expect(calls[0].url.pathname).toBe('/v23.0/c1/adsets');
    expect(calls[0].url.searchParams.get('fields')).toBe('id,name,status,daily_budget');
  });

  it('normalizes insights rows (cents, CTR fraction, ROAS, CPA)', async () => {
    const { client, calls } = makeClient(() =>
      jsonRes({
        data: [
          {
            spend: '25.50',
            impressions: '1000',
            clicks: '30',
            ctr: '3.0',
            reach: '500',
            actions: [
              { action_type: 'purchase', value: '4' },
              { action_type: 'link_click', value: '25' },
            ],
            action_values: [{ action_type: 'purchase', value: '120.00' }],
          },
        ],
      }),
    );

    const insights = await client.getInsights('c1', { datePreset: 'today' });

    expect(insights.spendCents).toBe(2550);
    expect(insights.revenueCents).toBe(12000);
    expect(insights.purchases).toBe(4);
    expect(insights.cpaCents).toBe(638); // 2550 / 4
    expect(insights.ctr).toBe(0.03); // Meta gives 3.0% → engine wants 0.03
    expect(insights.frequency).toBe(2);
    expect(insights.roas).toBeCloseTo(12000 / 2550);
    expect(calls[0].url.pathname).toBe('/v23.0/c1/insights');
    expect(calls[0].url.searchParams.get('date_preset')).toBe('today');
    expect(calls[0].url.searchParams.get('time_range')).toBeNull();
  });

  it('counts pixel purchase actions and passes explicit time ranges', async () => {
    const { client, calls } = makeClient(() =>
      jsonRes({
        data: [
          {
            spend: '10',
            action_values: [{ action_type: 'offsite_conversion.fb_pixel_purchase', value: '50.00' }],
          },
        ],
      }),
    );

    const insights = await client.getInsights('c1', { since: '2026-01-01', until: '2026-01-07' });

    expect(insights.revenueCents).toBe(5000);
    expect(calls[0].url.searchParams.get('date_preset')).toBeNull();
    expect(calls[0].url.searchParams.get('time_range')).toBe(
      JSON.stringify({ since: '2026-01-01', until: '2026-01-07' }),
    );
  });

  it('returns EMPTY_INSIGHTS when there is no data row', async () => {
    const { client } = makeClient(() => jsonRes({ data: [] }));

    const insights = await client.getInsights('c1', { datePreset: 'today' });

    expect(insights).toEqual(EMPTY_INSIGHTS);
  });
});

describe('MetaClient — writes', () => {
  it('pauses an ad set with a form-encoded POST', async () => {
    const { client, calls } = makeClient(() => jsonRes({ success: true }));

    const res = await client.pauseAdSet('s1');

    expect(res).toEqual({ success: true });
    const { url, init } = calls[0];
    expect(url.pathname).toBe('/v23.0/s1');
    expect(init.method).toBe('POST');
    expect(init.body).toBe('status=PAUSED');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe(
      'application/x-www-form-urlencoded',
    );
  });

  it('resumes (activates) an ad set', async () => {
    const { client, calls } = makeClient(() => jsonRes({ success: true }));

    await client.activateAdSet('s1');

    expect(calls[0].init.body).toBe('status=ACTIVE');
  });

  it('sets the daily budget in minor units', async () => {
    const { client, calls } = makeClient(() => jsonRes({ success: true }));

    await client.setAdSetDailyBudget('s1', 12345);

    expect(calls[0].init.body).toBe('daily_budget=12345');
  });
});

describe('MetaClient — errors, retries, usage', () => {
  it('throws a typed, redacted MetaApiError', async () => {
    const { client } = makeClient(() =>
      jsonRes(
        { error: { message: 'Access denied: token EAABLONGTOKEN12345678 invalid', code: 190, type: 'OAuthException' } },
        400,
      ),
    );

    const err = await client.listAdAccounts().catch((e: unknown) => e);

    expect(err).toBeInstanceOf(MetaApiError);
    const metaErr = err as MetaApiError;
    expect(metaErr.status).toBe(400);
    expect(metaErr.code).toBe(190);
    expect(metaErr.message).toContain('EA…[REDACTED]');
    expect(metaErr.message).not.toContain('EAABLONGTOKEN12345678');
  });

  it('retries once on rate limit and then succeeds', async () => {
    let n = 0;
    const { client, calls } = makeClient(() => {
      n += 1;
      return n === 1
        ? jsonRes({ error: { message: '(#4) Application request limit reached', code: 4 } }, 400)
        : jsonRes({ success: true });
    });

    const res = await client.pauseAdSet('s1');

    expect(res).toEqual({ success: true });
    expect(calls.length).toBe(2);
  });

  it('gives up after maxRetries and reports isRateLimit', async () => {
    const { client, calls } = makeClient(() =>
      jsonRes({ error: { message: '(#4) request limit reached', code: 4 } }, 400),
    );

    const err = await client.pauseAdSet('s1').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(MetaApiError);
    expect((err as MetaApiError).isRateLimit).toBe(true);
    expect(calls.length).toBe(2); // initial + 1 retry (maxRetries: 1)
  });

  it('reports business-use-case usage via the callback', async () => {
    const usage: Array<{ accountId: string; callCount: number }> = [];
    const { client } = makeClient(() =>
      jsonRes(
        { data: [] },
        200,
        { 'x-business-use-case-usage': JSON.stringify({ act_123: [{ call_count: 47 }] }) },
      ),
      { onUsage: (u) => usage.push(u) },
    );

    await client.listCampaigns('act_123');

    expect(usage).toEqual([{ accountId: 'act_123', callCount: 47 }]);
  });
});

describe('MetaClient — token exchange', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('exchanges a short-lived token for a long-lived one', async () => {
    const fetchMock = vi.fn(async () =>
      jsonRes({ access_token: 'EAALONGTOKEN…', expires_in: 5184000 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const res = await MetaClient.exchangeLongLivedToken({
      appId: 'APP123',
      appSecret: 'SECRET',
      shortLivedToken: 'EAASHORT',
    });

    expect(res).toEqual({ accessToken: 'EAALONGTOKEN…', expiresIn: 5184000 });
    const url = new URL(fetchMock.mock.calls[0][0] as string);
    expect(url.pathname).toBe('/v23.0/oauth/access_token');
    expect(url.searchParams.get('grant_type')).toBe('fb_exchange_token');
    expect(url.searchParams.get('client_id')).toBe('APP123');
    expect(url.searchParams.get('fb_exchange_token')).toBe('EAASHORT');
  });

  it('throws MetaApiError when the exchange fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonRes({ error: { message: 'Invalid client_id', code: 101 } }, 400)),
    );

    const err = await MetaClient.exchangeLongLivedToken({
      appId: 'BAD',
      appSecret: 'SECRET',
      shortLivedToken: 'EAASHORT',
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(MetaApiError);
    expect((err as MetaApiError).status).toBe(400);
  });
});
