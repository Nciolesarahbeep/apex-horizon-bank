const { neon } = require('@neondatabase/serverless');
const { getUserFromRequest } = require('../lib/auth');

const sql = neon(process.env.DATABASE_URL || process.env.POSTGRES_URL);

module.exports = async function handler(req, res) {
  const session = getUserFromRequest(req);
  if (!session) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  // GET /api/linked-accounts - List all linked accounts for the user
  if (req.method === 'GET') {
    try {
      const linkedAccounts = await sql`
        SELECT 
          id,
          bank_name,
          account_holder_name,
          account_number,
          routing_number,
          account_type,
          verification_status,
          created_at,
          verified_at
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

  // POST /api/linked-accounts - Add a new linked account
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

      // In a real bank, we'd send micro-deposits to the external account
      // For demo, we generate verification codes
      const verificationCode = Math.random().toString().slice(2, 8);

      const linkedAccountResult = await sql`
        INSERT INTO linked_accounts (
          user_id,
          bank_name,
          account_holder_name,
          account_number,
          routing_number,
          account_type,
          verification_status,
          verification_code
        )
        VALUES (
          ${session.userId},
          ${bankName},
          ${accountHolderName},
          ${accountNumber},
          ${routingNumber},
          ${accountType},
          'pending',
          ${verificationCode}
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

  // PUT /api/linked-accounts/:id - Verify a linked account
  if (req.method === 'PUT') {
    try {
      const { id } = req.query;
      const { micro_deposit_1, micro_deposit_2 } = req.body || {};

      if (!id || !micro_deposit_1 || !micro_deposit_2) {
        return res.status(400).json({ error: 'Linked account ID and micro-deposit amounts are required.' });
      }

      const result = await sql`
        SELECT * FROM verify_linked_account_micro_deposits(
          ${id}::uuid,
          ${session.userId}::uuid,
          ${parseFloat(micro_deposit_1)}::numeric,
          ${parseFloat(micro_deposit_2)}::numeric
        )
      `;

      if (!result[0].success) {
        return res.status(400).json({ error: result[0].err });
      }

      return res.status(200).json({
        success: true,
        message: 'Linked account verified successfully.',
      });
    } catch (err) {
      console.error('Verify linked account error:', err);
      return res.status(500).json({ error: 'Failed to verify linked account.' });
    }
  }

  // DELETE /api/linked-accounts/:id - Remove a linked account
  if (req.method === 'DELETE') {
    try {
      const { id } = req.query;

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

  res.setHeader('Allow', 'GET, POST, PUT, DELETE');
  return res.status(405).json({ error: 'Method not allowed' });
};