const { neon } = require('@neondatabase/serverless');
const { getUserFromRequest } = require('../lib/auth');

const sql = neon(process.env.DATABASE_URL || process.env.POSTGRES_URL);

// Real-bank-style daily ACH limit
const MAX_ACH_DAILY_LIMIT = 25000;

module.exports = async function handler(req, res) {
  const session = getUserFromRequest(req);
  if (!session) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  // GET /api/ach-transfer - List ACH transfers for the user
  if (req.method === 'GET') {
    try {
      const limit = Math.min(Number(req.query?.limit) || 25, 100);

      const transfers = await sql`
        SELECT
          at.id,
          at.to_external_account_holder,
          at.to_external_bank_name,
          at.amount,
          at.status,
          at.description,
          at.settlement_date,
          at.trace_number,
          at.created_at,
          a.account_type
        FROM ach_transfers at
        JOIN accounts a ON a.id = at.from_account_id
        WHERE a.user_id = ${session.userId}
        ORDER BY at.created_at DESC
        LIMIT ${limit}
      `;

      return res.status(200).json({ transfers });
    } catch (err) {
      console.error('Get ACH transfers error:', err);
      return res.status(500).json({ error: 'Failed to fetch ACH transfers.' });
    }
  }

  // POST /api/ach-transfer - Initiate a new ACH transfer
  if (req.method === 'POST') {
    try {
      const { fromAccountType, toLinkedAccountId, amount, description } = req.body || {};

      if (!fromAccountType || !toLinkedAccountId || !amount) {
        return res.status(400).json({ error: 'From account type, linked account ID, and amount are required.' });
      }

      const transferAmount = Number(amount);
      if (!Number.isFinite(transferAmount) || transferAmount <= 0) {
        return res.status(400).json({ error: 'Enter a valid transfer amount greater than zero.' });
      }

      if (transferAmount > MAX_ACH_DAILY_LIMIT) {
        return res.status(400).json({ error: `Single ACH transfer cannot exceed $${MAX_ACH_DAILY_LIMIT}.` });
      }

      // Call the database function
      const result = await sql`
        SELECT * FROM initiate_ach_debit_transfer(
          ${session.userId}::uuid,
          ${fromAccountType},
          ${toLinkedAccountId}::uuid,
          ${transferAmount}::numeric,
          ${description || 'ACH Transfer'}
        )
      `;

      if (!result[0].success) {
        return res.status(400).json({ error: result[0].err });
      }

      return res.status(201).json({
        success: true,
        transferId: result[0].transfer_id,
        settlementDate: result[0].settlement_date,
        message: 'ACH transfer initiated. Funds will settle in 1-2 business days.',
      });
    } catch (err) {
      console.error('ACH transfer error:', err);
      return res.status(500).json({ error: 'Failed to initiate ACH transfer.' });
    }
  }

  // GET /api/ach-transfer/daily-limit - Check remaining daily limit
  if (req.method === 'GET' && req.query?.action === 'daily-limit') {
    try {
      const dailyLimit = await sql`
        SELECT COALESCE(outgoing_amount, 0) as used FROM ach_daily_limits
        WHERE user_id = ${session.userId} AND date = CURRENT_DATE
      `;

      const used = dailyLimit.length > 0 ? Number(dailyLimit[0].used) : 0;
      const remaining = MAX_ACH_DAILY_LIMIT - used;

      return res.status(200).json({
        dailyLimit: MAX_ACH_DAILY_LIMIT,
        used,
        remaining: Math.max(remaining, 0),
      });
    } catch (err) {
      console.error('Get daily limit error:', err);
      return res.status(500).json({ error: 'Failed to fetch daily limit.' });
    }
  }

  res.setHeader('Allow', 'GET, POST');
  return res.status(405).json({ error: 'Method not allowed' });
};