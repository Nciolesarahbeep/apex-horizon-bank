const { neon } = require('@neondatabase/serverless');
const { getUserFromRequest } = require('../lib/auth');

const sql = neon(process.env.DATABASE_URL || process.env.POSTGRES_URL);
const MAX_ACH_DAILY_LIMIT = 25000;

module.exports = async function handler(req, res) {
  const session = getUserFromRequest(req);
  if (!session) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  const resource = req.method === 'GET' ? req.query.resource : (req.body || {}).resource;

  // ---------- Account Numbers ----------
  if (resource === 'account-numbers') {
    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET');
      return res.status(405).json({ error: 'Method not allowed' });
    }
    try {
      const accounts = await sql`
        SELECT id, account_type, account_number, routing_number, balance
        FROM accounts
        WHERE user_id = ${session.userId}
        ORDER BY account_type
      `;

      const formattedAccounts = accounts.map(account => ({
        id: account.id,
        accountType: account.account_type,
        accountNumber: account.account_number,
        accountNumberLastFour: account.account_number.slice(-4),
        routingNumber: account.routing_number,
        displayName: `${account.account_type.charAt(0).toUpperCase() + account.account_type.slice(1)} Account`,
        balance: account.balance,
      }));

      return res.status(200).json({
        accounts: formattedAccounts,
        bankName: 'Apex Horizon Bank',
        message: 'Share these account and routing numbers to receive ACH transfers (direct deposits).',
      });
    } catch (err) {
      console.error('Account numbers error:', err);
      return res.status(500).json({ error: 'Failed to fetch account numbers.' });
    }
  }

  // ---------- Linked Accounts ----------
  if (resource === 'linked-accounts') {
    if (req.method === 'GET') {
      try {
        const linkedAccounts = await sql`
          SELECT id, bank_name, account_holder_name, account_number, routing_number,
                 account_type, verification_status, created_at, verified_at
          FROM linked_accounts
          WHERE user_id = ${session.userId}
          ORDER BY created_at DESC
        `;
        return res.status(200).json({ linkedAccounts });
      } catch (err) {
        console.error('Get linked accounts error:', err);
        return res.status(500).json({ error: 'Failed to fetch linked accounts.' });
      }
    }

    if (req.method === 'POST') {
      try {
        const { bankName, accountHolderName, accountNumber, routingNumber, accountType } = req.body || {};

        if (!bankName || !accountHolderName || !accountNumber || !routingNumber || !accountType) {
          return res.status(400).json({ error: 'All fields are required.' });
        }
        if (!['checking', 'savings'].includes(accountType)) {
          return res.status(400).json({ error: 'Invalid account type.' });
        }
        if (!/^\d{9}$/.test(routingNumber)) {
          return res.status(400).json({ error: 'Routing number must be 9 digits.' });
        }

        const verificationCode = Math.random().toString().slice(2, 8);

        const linkedAccountResult = await sql`
          INSERT INTO linked_accounts (
            user_id, bank_name, account_holder_name, account_number,
            routing_number, account_type, verification_status, verification_code
          )
          VALUES (
            ${session.userId}, ${bankName}, ${accountHolderName}, ${accountNumber},
            ${routingNumber}, ${accountType}, 'pending', ${verificationCode}
          )
          RETURNING id, bank_name, account_holder_name, account_number, routing_number, account_type, verification_status, created_at
        `;

        return res.status(201).json({
          linkedAccount: linkedAccountResult[0],
          message: 'Linked account added. In demo mode, verification code is: ' + verificationCode,
        });
      } catch (err) {
        console.error('Add linked account error:', err);
        if (err.message.includes('unique')) {
          return res.status(409).json({ error: 'This account is already linked.' });
        }
        return res.status(500).json({ error: 'Failed to add linked account.' });
      }
    }

    if (req.method === 'PUT') {
      try {
        const { id, micro_deposit_1, micro_deposit_2 } = req.body || {};

        if (!id || !micro_deposit_1 || !micro_deposit_2) {
          return res.status(400).json({ error: 'Linked account ID and micro-deposit amounts are required.' });
        }

        const result = await sql`
          SELECT * FROM verify_linked_account_micro_deposits(
            ${id}::uuid, ${session.userId}::uuid,
            ${parseFloat(micro_deposit_1)}::numeric, ${parseFloat(micro_deposit_2)}::numeric
          )
        `;

        if (!result[0].success) {
          return res.status(400).json({ error: result[0].err });
        }

        return res.status(200).json({ success: true, message: 'Linked account verified successfully.' });
      } catch (err) {
        console.error('Verify linked account error:', err);
        return res.status(500).json({ error: 'Failed to verify linked account.' });
      }
    }

    if (req.method === 'DELETE') {
      try {
        const { id } = req.body || {};

        if (!id) {
          return res.status(400).json({ error: 'Linked account ID is required.' });
        }

        const result = await sql`
          DELETE FROM linked_accounts
          WHERE id = ${id}::uuid AND user_id = ${session.userId}
          RETURNING id
        `;

        if (result.length === 0) {
          return res.status(404).json({ error: 'Linked account not found.' });
        }

        return res.status(200).json({ success: true, message: 'Linked account removed.' });
      } catch (err) {
        console.error('Delete linked account error:', err);
        return res.status(500).json({ error: 'Failed to delete linked account.' });
      }
    }
  }

  // ---------- ACH Transfers ----------
  if (resource === 'ach-transfers') {
    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET');
      return res.status(405).json({ error: 'Method not allowed' });
    }
    try {
      const limit = Math.min(Number(req.query?.limit) || 25, 100);

      const transfers = await sql`
        SELECT at.id, at.to_external_account_holder, at.to_external_bank_name, at.amount,
               at.status, at.description, at.settlement_date, at.trace_number, at.created_at,
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

  if (resource === 'ach-transfer') {
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return res.status(405).json({ error: 'Method not allowed' });
    }
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

      const result = await sql`
        SELECT * FROM initiate_ach_debit_transfer(
          ${session.userId}::uuid, ${fromAccountType}, ${toLinkedAccountId}::uuid,
          ${transferAmount}::numeric, ${description || 'ACH Transfer'}
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

  // ---------- Daily Limit (now actually reachable) ----------
  if (resource === 'daily-limit') {
    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET');
      return res.status(405).json({ error: 'Method not allowed' });
    }
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

  return res.status(400).json({ error: 'Invalid or missing resource.' });
};
