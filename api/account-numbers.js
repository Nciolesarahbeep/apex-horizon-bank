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

    const accounts = await sql`
      SELECT 
        id,
        account_type,
        account_number,
        routing_number,
        balance
      FROM accounts
      WHERE user_id = ${session.userId}
      ORDER BY account_type
    `;

    // Format account numbers for display (show last 4 digits)
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
};