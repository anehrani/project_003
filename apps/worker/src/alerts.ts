/**
 * Alert delivery — Slack webhook (real) + email (pluggable stub).
 * Spec Screen 4: users configure Email + Slack Webhook URL in Settings.
 */

export interface AlertPayload {
  rule: string;
  severity: 'info' | 'warning' | 'critical';
  message: string;
  slackWebhookUrl?: string | null;
}

export async function sendAlert(payload: AlertPayload): Promise<void> {
  const text = `🛡️ *BudgetGuard* [${payload.severity.toUpperCase()}] (${payload.rule})\n${payload.message}`;

  // Slack — fire and forget, never crash the check loop on webhook failure.
  if (payload.slackWebhookUrl) {
    try {
      await fetch(payload.slackWebhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
    } catch (err) {
      console.warn(`[alerts] Slack delivery failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  // Email — plug Resend/SES here in week 3 (spec build order).
  // Weekly report email (Mondays 9am) will reuse this channel.
  console.info(`[alerts] ${text}`);
}
