/**
 * Vercel Cron entrypoint. Cron paths cannot include query strings.
 * Auth: Bearer CRON_SECRET or x-vercel-cron header from Vercel.
 */
const { neon } = require('@neondatabase/serverless');

const sql = neon(process.env.DATABASE_URL || process.env.POSTGRES_URL);

async function createNotification(userId, title, message) {
  try {
    await sql`
      INSERT INTO notifications (user_id, title, message, is_read, created_at)
      VALUES (${userId}, ${title}, ${message}, FALSE, NOW())
    `;
  } catch (err) {
    console.error('Create notification error:', err);
  }
}

function computeNextRunDate(currentDate, frequency) {
  const d = new Date(currentDate);
  if (frequency === 'weekly') d.setDate(d.getDate() + 7);
  else if (frequency === 'biweekly') d.setDate(d.getDate() + 14);
  else d.setMonth(d.getMonth() + 1);
  return d.toISOString().slice(0, 10);
}

module.exports = async function handler(req, res) {
  const authHeader = req.headers.authorization;
  const cronHeader = req.headers['x-vercel-cron'];
  const authorized =
    (process.env.CRON_SECRET && authHeader === `Bearer ${process.env.CRON_SECRET}`) ||
    cronHeader === '1';

  if (!authorized) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const dueTransfers = await sql`
      SELECT * FROM recurring_transfers
      WHERE status = 'active' AND next_run_date <= CURRENT_DATE
    `;

    let processed = 0;
    let failed = 0;

    for (const rt of dueTransfers) {
      try {
        const fromRows = await sql`SELECT id, balance, restriction_level FROM accounts WHERE id = ${rt.from_account_id} LIMIT 1`;
        if (fromRows.length === 0) throw new Error('Source account not found');
        const fromAccount = fromRows[0];

        if (fromAccount.restriction_level === 'full') throw new Error('Account restricted');
        if (Number(fromAccount.balance) < Number(rt.amount)) throw new Error('Insufficient funds');

        let toAccountId = rt.to_account_id;
        if (rt.destination_type === 'account_number') {
          const toRows = await sql`SELECT id FROM accounts WHERE account_number = ${rt.to_account_number} LIMIT 1`;
          if (toRows.length === 0) throw new Error('Recipient account not found');
          toAccountId = toRows[0].id;
        }

        await sql`UPDATE accounts SET balance = balance - ${rt.amount} WHERE id = ${fromAccount.id}`;
        await sql`UPDATE accounts SET balance = balance + ${rt.amount} WHERE id = ${toAccountId}`;

        await sql`INSERT INTO transactions (account_id, type, amount, description, created_at) VALUES (${fromAccount.id}, 'transfer_out', ${rt.amount}, ${rt.description || 'Recurring Transfer'}, NOW())`;
        await sql`INSERT INTO transactions (account_id, type, amount, description, created_at) VALUES (${toAccountId}, 'transfer_in', ${rt.amount}, ${rt.description || 'Recurring Transfer'}, NOW())`;

        const nextDate = computeNextRunDate(rt.next_run_date, rt.frequency);
        await sql`UPDATE recurring_transfers SET next_run_date = ${nextDate}, consecutive_failures = 0, last_run_at = NOW() WHERE id = ${rt.id}`;

        await createNotification(rt.user_id, 'Recurring Transfer Sent', `Your recurring transfer of $${Number(rt.amount).toFixed(2)} (${rt.description || 'Scheduled Transfer'}) was sent successfully.`);
        processed++;
      } catch (innerErr) {
        failed++;
        const newFailures = (rt.consecutive_failures || 0) + 1;
        const shouldPause = newFailures >= 3;

        await sql`UPDATE recurring_transfers SET consecutive_failures = ${newFailures}, status = ${shouldPause ? 'paused' : 'active'} WHERE id = ${rt.id}`;

        await createNotification(
          rt.user_id,
          shouldPause ? 'Recurring Transfer Paused' : 'Recurring Transfer Failed',
          shouldPause
            ? `Your recurring transfer of $${Number(rt.amount).toFixed(2)} has failed 3 times and was paused. Please review it.`
            : `Your recurring transfer of $${Number(rt.amount).toFixed(2)} failed: ${innerErr.message}. We'll try again next cycle.`
        );
      }
    }

    return res.status(200).json({ success: true, processed, failed });
  } catch (err) {
    console.error('Process recurring transfers error:', err);
    return res.status(500).json({ error: 'Failed to process recurring transfers.' });
  }
};
