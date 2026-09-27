const { neon } = require('@neondatabase/serverless');
const { getUserFromRequest, clearSessionCookie } = require('../lib/auth');
const { getGoalsTotal } = require('../lib/goals');

const sql = neon(process.env.DATABASE_URL || process.env.POSTGRES_URL);

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const session = await getUserFromRequest(req);
    if (!session) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const userResult = await sql`
      SELECT id, email, full_name, last_login_at, is_active, profile_photo FROM users WHERE id = ${session.userId} LIMIT 1
    `;
    if (userResult.length === 0) {
      return res.status(401).json({ error: 'Not authenticated' });
    }
    const user = userResult[0];

    if (!user.is_active) {
      clearSessionCookie(res);
      return res.status(403).json({ error: 'disabled', message: "Sorry, we can't continue this session." });
    }

    const accountsResult = await sql`
      SELECT id, account_type, balance, account_number, restriction_level, restricted_at, apy_rate, interest_accrued_at
      FROM accounts
      WHERE user_id = ${user.id}
    `;

    // Money set aside in savings goals counts toward the home screen total.
    let goalsSummary = { total: 0, count: 0 };
    try {
      goalsSummary = await getGoalsTotal(sql, user.id);
    } catch (goalErr) {
      console.error('Goals total error (non-fatal):', goalErr);
    }

    return res.status(200).json({
      goalsTotal: goalsSummary.total,
      goalsCount: goalsSummary.count,
      user: {
        id: user.id,
        email: user.email,
        fullName: user.full_name,
        lastLoginAt: user.last_login_at,
        profilePhoto: user.profile_photo,
      },
      accounts: accountsResult,
    });
  } catch (err) {
    console.error('Me endpoint error:', err);
    return res.status(500).json({ error: 'Something went wrong loading your account.' });
  }
};
