const { neon } = require('@neondatabase/serverless');
const { getUserFromRequest } = require('../lib/auth');

const sql = neon(process.env.DATABASE_URL || process.env.POSTGRES_URL);

module.exports = async function handler(req, res) {
  const session = getUserFromRequest(req);
  if (!session) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  // GET /api/disputes - List disputes
  if (req.method === 'GET') {
    try {
      const disputes = await sql`
        SELECT 
          id,
          dispute_type,
          reason,
          status,
          resolution,
          resolution_amount,
          created_at
        FROM transaction_disputes
        WHERE user_id = ${session.userId}
        ORDER BY created_at DESC
        LIMIT 50
      `;

      return res.status(200).json({ disputes });
    } catch (err) {
      console.error('Get disputes error:', err);
      return res.status(500).json({ error: 'Failed to fetch disputes.' });
    }
  }

  // POST /api/disputes - File a dispute on a transaction
  if (req.method === 'POST') {
    try {
      const { transactionId, disputeType, reason } = req.body || {};

      if (!transactionId || !disputeType || !reason) {
        return res.status(400).json({ error: 'Transaction ID, dispute type, and reason are required.' });
      }

      if (!['unauthorized', 'duplicate', 'incorrect_amount', 'other'].includes(disputeType)) {
        return res.status(400).json({ error: 'Invalid dispute type.' });
      }

      // Verify transaction belongs to user
      const transaction = await sql`
        SELECT t.id, t.amount, a.user_id, a.id as account_id
        FROM transactions t
        JOIN accounts a ON a.id = t.account_id
        WHERE t.id = ${transactionId} AND a.user_id = ${session.userId}
      `;

      if (transaction.length === 0) {
        return res.status(404).json({ error: 'Transaction not found.' });
      }

      // Check for duplicate dispute
      const existing = await sql`
        SELECT id FROM transaction_disputes
        WHERE transaction_id = ${transactionId} AND status IN ('open', 'investigating')
      `;

      if (existing.length > 0) {
        return res.status(409).json({ error: 'A dispute is already open for this transaction.' });
      }

      // Create dispute
      const dispute = await sql`
        INSERT INTO transaction_disputes (
          transaction_id,
          user_id,
          account_id,
          dispute_type,
          reason,
          status
        )
        VALUES (
          ${transactionId},
          ${session.userId},
          ${transaction[0].account_id},
          ${disputeType},
          ${reason},
          'open'
        )
        RETURNING id, status, created_at
      `;

      return res.status(201).json({
        success: true,
        disputeId: dispute[0].id,
        status: 'open',
        message: 'Dispute filed successfully. Our team will investigate within 5-10 business days.',
      });
    } catch (err) {
      console.error('File dispute error:', err);
      return res.status(500).json({ error: 'Failed to file dispute.' });
    }
  }

  res.setHeader('Allow', 'GET, POST');
  return res.status(405).json({ error: 'Method not allowed' });
};
