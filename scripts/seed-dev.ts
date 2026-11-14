/**
 * Seed the local dev/test database — idempotent (safe to re-run).
 *
 *   npm run db:seed
 *
 * Requires DATABASE_URL + APP_ENCRYPTION_KEY (see .env.example). Quick local setup:
 *   npm run db:up                                  # Postgres in Docker
 *   npm run db:push --workspace @budgetguard/db    # create tables
 *   npm run db:seed
 *
 * Optional env overrides (Tier 2/3 testing — see README "Testing"):
 *   DEV_META_TOKEN      real token for a Meta TEST ad account (default: dummy token)
 *   DEV_AD_ACCOUNT_ID   act_xxx of the TEST ad account (default: act_TEST)
 *   DEV_CAMPAIGN_ID     numeric Meta campaign id (default: 999999999999999)
 */

import 'dotenv/config';

import { encryptToken } from '@budgetguard/db';
import { PrismaClient } from '@prisma/client';

const DEV_USER_EMAIL = 'dev@budgetguard.local';

function in60Days(): Date {
  return new Date(Date.now() + 60 * 24 * 60 * 60 * 1000);
}

async function main(): Promise<void> {
  const encryptionKey = process.env.APP_ENCRYPTION_KEY;
  if (!encryptionKey) {
    console.error('Missing APP_ENCRYPTION_KEY — copy .env.example to .env first.');
    process.exit(1);
  }

  const token = process.env.DEV_META_TOKEN ?? 'DEVTEST_DUMMY_TOKEN_NOT_REAL';
  const adAccountId = process.env.DEV_AD_ACCOUNT_ID ?? 'act_TEST';
  const metaCampaignId = process.env.DEV_CAMPAIGN_ID ?? '999999999999999';

  const db = new PrismaClient();
  try {
    const user = await db.user.upsert({
      where: { email: DEV_USER_EMAIL },
      update: {},
      create: { email: DEV_USER_EMAIL, passwordHash: 'dev-only-no-login' },
    });

    const account = await db.metaAccount.upsert({
      where: {
        userId_metaAdAccountId: { userId: user.id, metaAdAccountId: adAccountId },
      },
      update: {
        accessToken: encryptToken(token, encryptionKey),
        tokenExpiresAt: in60Days(),
        status: 'ACTIVE',
      },
      create: {
        userId: user.id,
        metaAdAccountId: adAccountId,
        metaAccountName: 'Dev Test Ad Account',
        accessToken: encryptToken(token, encryptionKey),
        tokenExpiresAt: in60Days(),
        currency: 'USD',
      },
    });

    const campaign = await db.campaign.upsert({
      where: {
        metaAccountId_metaCampaignId: { metaAccountId: account.id, metaCampaignId },
      },
      // Re-seeding always resets to the SAFE state (dry-run on) — never silently
      // flips a campaign back to live mutation.
      update: { dryRun: true },
      create: {
        metaAccountId: account.id,
        metaCampaignId,
        name: 'Dev Test Campaign',
        strategy: 'balanced',
        monthlyBudgetCents: 150000, // $1,500
        dailyCapCents: 10000, // $100
        targetCpaCents: 2500, // $25
        isAutopilotOn: true,
        dryRun: true,
      },
    });

    console.info('Seeded dev environment:');
    console.info(`  user        ${user.email}`);
    console.info(`  ad account  ${account.metaAdAccountId} (status ${account.status})`);
    console.info(`  campaign    ${campaign.name} [${campaign.metaCampaignId}]`);
    console.info(`              strategy=${campaign.strategy} autopilot=${campaign.isAutopilotOn} dryRun=${campaign.dryRun}`);
    console.info(
      process.env.DEV_META_TOKEN
        ? '  token       real DEV_META_TOKEN stored (AES-256-GCM encrypted at rest)'
        : '  token       dummy — Meta calls will fail with code 190 (fine for Tier-1 dry-run tests)',
    );
    console.info('\nNext:  npm run worker:check-once');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Seed failed: ${message}`);
    console.error('Is Postgres up?  npm run db:up');
    process.exit(1);
  } finally {
    await db.$disconnect();
  }
}

void main();
