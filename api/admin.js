const { neon } = require('@neondatabase/serverless');

const sql = neon(process.env.DATABASE_URL || process.env.POSTGRES_URL);

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function checkAdminAuth(req) {
  const provided = req.headers['x-admin-secret'];
  const expected = process.env.ADMIN_SECRET;
  return Boolean(expected) && Boolean(provided) && provided === expected;
}

module.exports = async function handler(req, res) {
  if (!checkAdminAuth(req)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const action = req.method === 'GET' ? req.query.action : (req.body || {}).action;

  try {
    // ---------- listUsers ----------
    if (action === 'listUsers') {
      const search = normalizeEmail(req.query.search || '');
      const users = search
        ? await sql`
            SELECT u.id, u.email, u.full_name, u.is_active, u.created_at,
                   COALESCE(SUM(a.balance), 0) AS total_balance
            FROM users u
            LEFT JOIN accounts a ON a.user_id = u.id
            WHERE LOWER(u.email) LIKE ${'%' + search + '%'}
            GROUP BY u.id
            ORDER BY u.created_at DESC
            LIMIT 100
          `
        : await sql`
            SELECT u.id, u.email, u.full_name, u.is_active, u.created_at,
                   COALESCE(SUM(a.balance), 0) AS total_balance
            FROM users u
            LEFT JOIN accounts a ON a.user_id = u.id
            GROUP BY u.id
            ORDER BY u.created_at DESC
            LIMIT 100
          `;
      return res.status(200).json({ users });
    }

    // ---------- recentTransactions (site-wide, last 50) ----------
    if (action === 'recentTransactions') {
      const transactions = await sql`
        SELECT t.id, t.type, t.amount, t.description, t.created_at,
               u.email AS user_email, a.account_type
        FROM transactions t
        JOIN accounts a ON a.id = t.account_id
        JOIN users u ON u.id = a.user_id
        ORDER BY t.created_at DESC
        LIMIT 50
      `;
      return res.status(200).json({ transactions });
    }

    // ---------- getAuditLogs(email) ----------
    if (action === 'getAuditLogs') {
      const email = normalizeEmail(req.query.email);
      if (!email) return res.status(400).json({ error: 'email is required' });

      const logs = await sql`
        SELECT id, admin_action, target_email, amount, details, created_at
        FROM admin_audit_log
        WHERE LOWER(target_email) = ${email}
        ORDER BY created_at DESC
        LIMIT 50
      `;
      return res.status(200).json({ logs });
    }

       // ---------- listPendingLoans ----------
    if (action === 'listPendingLoans') {
      const loans = await sql`
        SELECT l.id, l.user_id, l.principal, l.interest_rate, l.term_months, l.monthly_payment,
               l.purpose, l.monthly_income, l.employment_status, l.applicant_name, l.created_at,
               u.email AS user_email
        FROM loans l
        JOIN users u ON u.id = l.user_id
        WHERE l.status = 'pending'
        ORDER BY l.created_at ASC
      `;
      return res.status(200).json({ loans });
    }

 // ---------- getLoginActivity (live sign-in feed) ----------
    if (action === 'getLoginActivity') {
      const activity = await sql`
        SELECT id, email, method, ip_address, city, region, country, user_agent, created_at
        FROM login_activity
        ORDER BY created_at DESC
        LIMIT 50
      `;
      return res.status(200).json({ activity });
    }

    // ---------- Everything below requires POST ----------

    if (req.method !== 'POST') {
      res.setHeader('Allow', 'GET, POST');
      return res.status(405).json({ error: 'Method not allowed' });
    }

    // ---------- addFunds(email, amount) / withdrawFunds(email, amount) ----------
    if (action === 'addFunds' || action === 'withdrawFunds') {
      const email = normalizeEmail(req.body.email);
      const amount = Number(req.body.amount);

      if (!email) return res.status(400).json({ error: 'email is required' });
      if (!Number.isFinite(amount) || amount <= 0) {
        return res.status(400).json({ error: 'amount must be a positive number' });
      }

      const userRows = await sql`SELECT id FROM users WHERE LOWER(email) = ${email} LIMIT 1`;
      if (userRows.length === 0) return res.status(404).json({ error: 'User not found' });
      const userId = userRows[0].id;

      const accountRows = await sql`
        SELECT id, balance FROM accounts
        WHERE user_id = ${userId}
        ORDER BY (account_type = 'checking') DESC, id ASC
        LIMIT 1
      `;
      if (accountRows.length === 0) return res.status(404).json({ error: 'No account found for this user' });
      const account = accountRows[0];

      if (action === 'withdrawFunds' && Number(account.balance) < amount) {
        return res.status(400).json({ error: 'Insufficient funds in user account' });
      }

      const delta = action === 'addFunds' ? amount : -amount;
      const txnType = action === 'addFunds' ? 'admin_credit' : 'admin_debit';
      const description = action === 'addFunds'
        ? `Admin deposit of $${amount.toFixed(2)}`
        : `Admin withdrawal of $${amount.toFixed(2)}`;

      await sql`UPDATE accounts SET balance = balance + ${delta} WHERE id = ${account.id}`;

      await sql`
        INSERT INTO transactions (account_id, type, amount, description, created_at)
        VALUES (${account.id}, ${txnType}, ${amount}, ${description}, NOW())
      `;

      await sql`
        INSERT INTO admin_audit_log (admin_action, target_email, amount, details, created_at)
        VALUES (${action}, ${email}, ${amount}, ${description}, NOW())
      `;

      return res.status(200).json({
        success: true,
        message: `${action === 'addFunds' ? 'Added' : 'Withdrew'} $${amount.toFixed(2)} for ${email}`,
      });
    }

        // ---------- grantLoan(loanId) ----------
    if (action === 'grantLoan') {
      const loanId = Number(req.body.loanId);
      if (!loanId) return res.status(400).json({ error: 'loanId is required' });

      const loanRows = await sql`
        SELECT id, account_id, principal, purpose, term_months, interest_rate, status
        FROM loans WHERE id = ${loanId} LIMIT 1
      `;
      if (loanRows.length === 0) return res.status(404).json({ error: 'Loan not found' });
      const loan = loanRows[0];

      if (loan.status !== 'pending') {
        return res.status(400).json({ error: `This loan is already ${loan.status}, not pending.` });
      }

      const description = `Loan Disbursement — ${loan.purpose} (${loan.term_months} mo @ ${(Number(loan.interest_rate) * 100).toFixed(2)}% APR)`;

      await sql`UPDATE accounts SET balance = balance + ${loan.principal} WHERE id = ${loan.account_id}`;

      await sql`
        INSERT INTO transactions (account_id, type, amount, description, created_at)
        VALUES (${loan.account_id}, 'loan_disbursement', ${loan.principal}, ${description}, NOW())
      `;

      await sql`
        UPDATE loans SET status = 'active', disbursed_at = NOW() WHERE id = ${loan.id}
      `;

      await sql`
        INSERT INTO admin_audit_log (admin_action, target_email, amount, details, created_at)
        VALUES ('grantLoan', NULL, ${loan.principal}, ${description}, NOW())
      `;

      return res.status(200).json({ success: true, message: `Loan #${loan.id} approved and $${Number(loan.principal).toFixed(2)} disbursed.` });
    }

// ---------- toggleAccountStatus(email) ----------
    if (action === 'toggleAccountStatus') {
      const email = normalizeEmail(req.body.email);
      if (!email) return res.status(400).json({ error: 'email is required' });

      const userRows = await sql`SELECT id, is_active FROM users WHERE LOWER(email) = ${email} LIMIT 1`;
      if (userRows.length === 0) return res.status(404).json({ error: 'User not found' });

      const newStatus = !userRows[0].is_active;
      await sql`UPDATE users SET is_active = ${newStatus} WHERE id = ${userRows[0].id}`;

      await sql`
        INSERT INTO admin_audit_log (admin_action, target_email, amount, details, created_at)
        VALUES ('toggleAccountStatus', ${email}, NULL, ${newStatus ? 'Account enabled' : 'Account disabled'}, NOW())
      `;

      return res.status(200).json({ success: true, isActive: newStatus });
    }

    return res.status(400).json({
      error: 'Invalid or missing action. Use "listUsers", "recentTransactions", "getAuditLogs", "addFunds", "withdrawFunds", or "toggleAccountStatus".',
    });
  } catch (err) {
    console.error('Admin API error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
