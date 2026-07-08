const { neon } = require('@neondatabase/serverless');
const { getUserFromRequest } = require('../lib/auth');

const sql = neon(process.env.DATABASE_URL || process.env.POSTGRES_URL);

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const session = getUserFromRequest(req);
    if (!session) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const limit = Math.min(Number(req.query?.limit) || 25, 100);

    const rows = await sql`
      SELECT
        t.id,
        t.type,
        t.amount,
        t.description,
        t.created_at,
        a.account_type
      FROM transactions t
      JOIN accounts a ON a.id = t.account_id
      WHERE a.user_id = ${session.userId}
      ORDER BY t.created_at DESC
      LIMIT ${limit}
    `;

    return res.status(200).json({ transactions: rows });
  } catch (err) {
    console.error('Transactions endpoint error:', err);
    return res.status(500).json({ error: 'Something went wrong loading your transactions.' });
  }
};
