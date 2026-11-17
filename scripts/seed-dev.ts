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
 *   DEV_REFRESH_TOKEN   real OAuth refresh token for a Google Ads TEST account
 *                       (default: dummy token — calls fail with HTTP 401, fine for Tier 1)
 *   DEV_CUSTOMER_ID     Google Ads customer id, 10 digits (default: 9999999999)
 *   DEV_CAMPAIGN_ID     numeric Google campaign id (default: 1111111111)
 *   DEV_LOGIN_CUSTOMER_ID  MCC customer id, 10 digits (optional)
 */

import 'dotenv/config';

import { encryptToken } from '@budgetguard/db';
import { PrismaClient } from '@prisma/client';

const DEV_USER_EMAIL = 'dev@budgetguard.local';

async function main(): Promise<void> {
  const encryptionKey = process.env.APP_ENCRYPTION_KEY;
  if (!encryptionKey) {
    console.error('Missing APP_ENCRYPTION_KEY — copy .env.example to .env first.');
    process.exit(1);
  }

  const refreshToken = process.env.DEV_REFRESH_TOKEN ?? 'DEVTEST_DUMMY_REFRESH_TOKEN_NOT_REAL';
  const customerId = (process.env.DEV_CUSTOMER_ID ?? '9999999999').replace(/\D/g, '');
  const googleCampaignId = process.env.DEV_CAMPAIGN_ID ?? '1111111111';
  const loginCustomerId = process.env.DEV_LOGIN_CUSTOMER_ID?.replace(/\D/g, '') || null;
  if (!/^\d{10}$/.test(customerId)) {
    console.error(`Invalid DEV_CUSTOMER_ID "${customerId}" — expected 10 digits.`);
    process.exit(1);
  }

  const db = new PrismaClient();
  try {
    const user = await db.user.upsert({
      where: { email: DEV_USER_EMAIL },
      update: {},
      create: { email: DEV_USER_EMAIL, passwordHash: 'dev-only-no-login' },
    });

    const account = await db.googleAccount.upsert({
      where: {
        userId_customerId: { userId: user.id, customerId },
      },
      update: {
        refreshToken: encryptToken(refreshToken, encryptionKey),
        loginCustomerId,
        status: 'ACTIVE',
      },
      create: {
        userId: user.id,
        customerId,
        customerName: 'Dev Test Ads Account',
        refreshToken: encryptToken(refreshToken, encryptionKey),
        loginCustomerId,
        currency: 'USD',
      },
    });

    const campaign = await db.campaign.upsert({
      where: {
        googleAccountId_googleCampaignId: { googleAccountId: account.id, googleCampaignId },
      },
      // Re-seeding always resets to the SAFE state (dry-run on) — never silently
      // flips a campaign back to live mutation.
      update: { dryRun: true },
      create: {
        googleAccountId: account.id,
        googleCampaignId,
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
    console.info(`  ads account ${account.customerId}${loginCustomerId ? ` (via MCC ${loginCustomerId})` : ''} (status ${account.status})`);
    console.info(`  campaign    ${campaign.name} [${campaign.googleCampaignId}]`);
    console.info(`              strategy=${campaign.strategy} autopilot=${campaign.isAutopilotOn} dryRun=${campaign.dryRun}`);
    console.info(
      process.env.DEV_REFRESH_TOKEN
        ? '  token       real DEV_REFRESH_TOKEN stored (AES-256-GCM encrypted at rest)'
        : '  token       dummy — Google calls will fail with HTTP 401 (fine for Tier-1 dry-run tests)',
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
