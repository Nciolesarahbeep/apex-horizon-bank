const { sql } = require('@vercel/postgres');
const { getUserFromRequest } = require('../lib/auth');

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

    const userResult = await sql`
      SELECT id, email, full_name FROM users WHERE id = ${session.userId} LIMIT 1
    `;
    if (userResult.rows.length === 0) {
      return res.status(401).json({ error: 'Not authenticated' });
    }
    const user = userResult.rows[0];

    const accountsResult = await sql`
      SELECT id, account_type, account_number, balance
      FROM accounts
      WHERE user_id = ${user.id}
    `;

    return res.status(200).json({
      user: { id: user.id, email: user.email, fullName: user.full_name },
      accounts: accountsResult.rows,
    });
  } catch (err) {
    console.error('Me endpoint error:', err);
    return res.status(500).json({ error: 'Something went wrong loading your account.' });
  }
};
