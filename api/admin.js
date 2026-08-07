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
            SELECT u.id, u.email, u.full_name, u.is_active, u.approval_status, u.created_at,
                   COALESCE(SUM(a.balance), 0) AS total_balance
            FROM users u
            LEFT JOIN accounts a ON a.user_id = u.id
            WHERE LOWER(u.email) LIKE ${'%' + search + '%'}
            GROUP BY u.id
            ORDER BY u.created_at DESC
            LIMIT 100
          `
        : await sql`
            SELECT u.id, u.email, u.full_name, u.is_active, u.approval_status, u.created_at,
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

    // ---------- listPendingAccounts (new signup approval queue) ----------
    if (action === 'listPendingAccounts') {
      const accounts = await sql`
        SELECT id, email, full_name, created_at
        FROM users
        WHERE approval_status = 'pending'
        ORDER BY created_at ASC
      `;
      return res.status(200).json({ accounts });
    }

    // ---------- listPendingKyc (enhanced verification review queue) ----------
    if (action === 'listPendingKyc') {
      const kycRequests = await sql`
        SELECT k.id, k.user_id, k.ssn_last_four, k.date_of_birth, k.street_address, k.city, k.state, k.zip_code,
               k.id_type, k.id_number, k.id_expiry_date, k.id_issuing_state, k.created_at,
               u.email AS user_email, u.full_name AS user_full_name
        FROM kyc_verifications k
        JOIN users u ON u.id = k.user_id
        WHERE k.status = 'pending'
        ORDER BY k.created_at ASC
      `;
      return res.status(200).json({ kycRequests });
    }

    // ---------- listDisputes (transaction dispute review queue) ----------
    if (action === 'listDisputes') {
      const disputes = await sql`
        SELECT d.id, d.dispute_type, d.reason, d.status, d.resolution, d.resolution_amount, d.created_at,
               t.id AS transaction_id, t.type AS transaction_type, t.amount,
               t.description AS transaction_description, t.created_at AS transaction_created_at,
               d.account_id,
               u.id AS user_id, u.email AS user_email, u.full_name AS user_full_name
        FROM transaction_disputes d
        JOIN transactions t ON t.id = d.transaction_id
        JOIN users u ON u.id = d.user_id
        WHERE d.status IN ('open', 'investigating')
        ORDER BY d.created_at ASC
      `;
      return res.status(200).json({ disputes });
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
        UPDATE loans SET status = 'active', disbursed_at = NOW(), remaining_balance = ${loan.principal} WHERE id = ${loan.id}
      `;

      await sql`
        INSERT INTO admin_audit_log (admin_action, target_email, amount, details, created_at)
        VALUES ('grantLoan', NULL, ${loan.principal}, ${description}, NOW())
      `;

      return res.status(200).json({ success: true, message: `Loan #${loan.id} approved and $${Number(loan.principal).toFixed(2)} disbursed.` });
    }

    // ---------- approveAccount(userId) ----------
    if (action === 'approveAccount') {
      const userId = Number(req.body.userId);
      if (!userId) return res.status(400).json({ error: 'userId is required' });

      const userRows = await sql`
        SELECT id, email, approval_status FROM users WHERE id = ${userId} LIMIT 1
      `;
      if (userRows.length === 0) return res.status(404).json({ error: 'User not found' });
      const user = userRows[0];

      if (user.approval_status !== 'pending') {
        return res.status(400).json({ error: `This account is already ${user.approval_status}, not pending.` });
      }

      await sql`
        UPDATE users
        SET approval_status = 'approved', approved_at = NOW(), approved_by = 'admin'
        WHERE id = ${userId}
      `;

      await sql`
        INSERT INTO admin_audit_log (admin_action, target_email, amount, details, created_at)
        VALUES ('approveAccount', ${user.email}, NULL, 'Account approved and can now sign in', NOW())
      `;

      // Best-effort welcome notification — never fails the approval itself.
      try {
        await sql`
          INSERT INTO notifications (user_id, title, message, is_read, created_at)
          VALUES (${userId}, 'Account Approved', 'Your Apex Horizon Bank account has been approved. You can now sign in.', FALSE, NOW())
        `;
      } catch (notifyErr) {
        console.error('Approve account notification error (non-fatal):', notifyErr);
      }

      return res.status(200).json({ success: true, message: `Account for ${user.email} approved.` });
    }

    // ---------- rejectAccount(userId, reason) ----------
    if (action === 'rejectAccount') {
      const userId = Number(req.body.userId);
      const reason = (req.body.reason || '').trim();
      if (!userId) return res.status(400).json({ error: 'userId is required' });

      const userRows = await sql`
        SELECT id, email, approval_status FROM users WHERE id = ${userId} LIMIT 1
      `;
      if (userRows.length === 0) return res.status(404).json({ error: 'User not found' });
      const user = userRows[0];

      if (user.approval_status !== 'pending') {
        return res.status(400).json({ error: `This account is already ${user.approval_status}, not pending.` });
      }

      await sql`
        UPDATE users
        SET approval_status = 'rejected', approval_reason = ${reason || null}, approved_at = NOW(), approved_by = 'admin'
        WHERE id = ${userId}
      `;

      await sql`
        INSERT INTO admin_audit_log (admin_action, target_email, amount, details, created_at)
        VALUES ('rejectAccount', ${user.email}, NULL, ${reason || 'Account application rejected'}, NOW())
      `;

      return res.status(200).json({ success: true, message: `Account for ${user.email} rejected.` });
    }

    // ---------- approveKyc(kycId) ----------
    if (action === 'approveKyc') {
      const kycId = Number(req.body.kycId);
      if (!kycId) return res.status(400).json({ error: 'kycId is required' });

      const rows = await sql`SELECT id, user_id, status FROM kyc_verifications WHERE id = ${kycId} LIMIT 1`;
      if (rows.length === 0) return res.status(404).json({ error: 'Verification request not found' });
      const kyc = rows[0];

      if (kyc.status !== 'pending') {
        return res.status(400).json({ error: `This request is already ${kyc.status}.` });
      }

      await sql`UPDATE kyc_verifications SET status = 'verified', verified_at = NOW() WHERE id = ${kycId}`;

      try {
        await sql`
          INSERT INTO notifications (user_id, title, message, is_read, created_at)
          VALUES (${kyc.user_id}, 'Identity Verified', 'Your enhanced identity verification has been approved. You can now send wire transfers.', FALSE, NOW())
        `;
      } catch (notifyErr) {
        console.error('KYC approval notification error (non-fatal):', notifyErr);
      }

      await sql`
        INSERT INTO admin_audit_log (admin_action, target_email, amount, details, created_at)
        VALUES ('approveKyc', NULL, NULL, ${'KYC #' + kycId + ' approved'}, NOW())
      `;

      return res.status(200).json({ success: true, message: `Verification #${kycId} approved.` });
    }

    // ---------- rejectKyc(kycId, reason) ----------
    if (action === 'rejectKyc') {
      const kycId = Number(req.body.kycId);
      const reason = (req.body.reason || '').trim();
      if (!kycId) return res.status(400).json({ error: 'kycId is required' });

      const rows = await sql`SELECT id, user_id, status FROM kyc_verifications WHERE id = ${kycId} LIMIT 1`;
      if (rows.length === 0) return res.status(404).json({ error: 'Verification request not found' });
      const kyc = rows[0];

      if (kyc.status !== 'pending') {
        return res.status(400).json({ error: `This request is already ${kyc.status}.` });
      }

      await sql`UPDATE kyc_verifications SET status = 'rejected', rejected_reason = ${reason || null} WHERE id = ${kycId}`;

      try {
        await sql`
          INSERT INTO notifications (user_id, title, message, is_read, created_at)
          VALUES (${kyc.user_id}, 'Verification Update', ${reason ? `Your verification was not approved: ${reason}` : 'Your verification was not approved.'}, FALSE, NOW())
        `;
      } catch (notifyErr) {
        console.error('KYC rejection notification error (non-fatal):', notifyErr);
      }

      await sql`
        INSERT INTO admin_audit_log (admin_action, target_email, amount, details, created_at)
        VALUES ('rejectKyc', NULL, NULL, ${'KYC #' + kycId + ' rejected'}, NOW())
      `;

      return res.status(200).json({ success: true, message: `Verification #${kycId} rejected.` });
    }

    // ---------- resolveDispute(disputeId, resolution, resolutionAmount) ----------
    if (action === 'resolveDispute') {
      const disputeId = Number(req.body.disputeId);
      const resolution = (req.body.resolution || '').trim();
      const resolutionAmount = req.body.resolutionAmount != null && req.body.resolutionAmount !== ''
        ? Number(req.body.resolutionAmount)
        : null;
      if (!disputeId) return res.status(400).json({ error: 'disputeId is required' });
      if (resolutionAmount != null && (!Number.isFinite(resolutionAmount) || resolutionAmount <= 0)) {
        return res.status(400).json({ error: 'Refund amount must be a positive number.' });
      }

      const rows = await sql`
        SELECT id, user_id, account_id, status FROM transaction_disputes WHERE id = ${disputeId} LIMIT 1
      `;
      if (rows.length === 0) return res.status(404).json({ error: 'Dispute not found' });
      const dispute = rows[0];

      if (dispute.status === 'resolved' || dispute.status === 'rejected') {
        return res.status(400).json({ error: `This dispute is already ${dispute.status}.` });
      }

      await sql`
        UPDATE transaction_disputes
        SET status = 'resolved', resolution = ${resolution || null}, resolution_amount = ${resolutionAmount}
        WHERE id = ${disputeId}
      `;

      // If a refund amount was entered, actually credit the customer's account —
      // this is what makes "resolving in the customer's favor" mean something real.
      if (resolutionAmount) {
        await sql`UPDATE accounts SET balance = balance + ${resolutionAmount} WHERE id = ${dispute.account_id}`;
        await sql`
          INSERT INTO transactions (account_id, type, amount, description, created_at)
          VALUES (${dispute.account_id}, 'credit', ${resolutionAmount}, ${'Dispute Refund — Case #' + disputeId}, NOW())
        `;
      }

      try {
        const notifMessage = resolutionAmount
          ? `Your dispute has been resolved in your favor. $${resolutionAmount.toFixed(2)} has been credited to your account.${resolution ? ' ' + resolution : ''}`
          : (resolution ? `Your dispute has been resolved: ${resolution}` : 'Your dispute has been resolved.');
        await sql`
          INSERT INTO notifications (user_id, title, message, is_read, created_at)
          VALUES (${dispute.user_id}, 'Dispute Resolved', ${notifMessage}, FALSE, NOW())
        `;
      } catch (notifyErr) {
        console.error('Dispute resolution notification error (non-fatal):', notifyErr);
      }

      await sql`
        INSERT INTO admin_audit_log (admin_action, target_email, amount, details, created_at)
        VALUES ('resolveDispute', NULL, ${resolutionAmount}, ${'Dispute #' + disputeId + ' resolved'}, NOW())
      `;

      return res.status(200).json({
        success: true,
        message: resolutionAmount
          ? `Dispute #${disputeId} resolved and $${resolutionAmount.toFixed(2)} refunded to the customer.`
          : `Dispute #${disputeId} marked as resolved.`
      });
    }

    // ---------- rejectDispute(disputeId, resolution) ----------
    if (action === 'rejectDispute') {
      const disputeId = Number(req.body.disputeId);
      const resolution = (req.body.resolution || '').trim();
      if (!disputeId) return res.status(400).json({ error: 'disputeId is required' });

      const rows = await sql`SELECT id, user_id, status FROM transaction_disputes WHERE id = ${disputeId} LIMIT 1`;
      if (rows.length === 0) return res.status(404).json({ error: 'Dispute not found' });
      const dispute = rows[0];

      if (dispute.status === 'resolved' || dispute.status === 'rejected') {
        return res.status(400).json({ error: `This dispute is already ${dispute.status}.` });
      }

      await sql`
        UPDATE transaction_disputes SET status = 'rejected', resolution = ${resolution || null}
        WHERE id = ${disputeId}
      `;

      try {
        await sql`
          INSERT INTO notifications (user_id, title, message, is_read, created_at)
          VALUES (${dispute.user_id}, 'Dispute Update', ${resolution ? `Your dispute was reviewed: ${resolution}` : 'Your dispute was reviewed and closed.'}, FALSE, NOW())
        `;
      } catch (notifyErr) {
        console.error('Dispute rejection notification error (non-fatal):', notifyErr);
      }

      await sql`
        INSERT INTO admin_audit_log (admin_action, target_email, amount, details, created_at)
        VALUES ('rejectDispute', NULL, NULL, ${'Dispute #' + disputeId + ' rejected'}, NOW())
      `;

      return res.status(200).json({ success: true, message: `Dispute #${disputeId} rejected.` });
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
      error: 'Invalid or missing action. Use "listUsers", "recentTransactions", "getAuditLogs", "listPendingLoans", "listPendingAccounts", "listPendingKyc", "listDisputes", "getLoginActivity", "addFunds", "withdrawFunds", "grantLoan", "approveAccount", "rejectAccount", "approveKyc", "rejectKyc", "resolveDispute", "rejectDispute", or "toggleAccountStatus".',
    });
  } catch (err) {
    console.error('Admin API error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
