const { neon } = require('@neondatabase/serverless');
const { getUserFromRequest } = require('../lib/auth');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');


const sql = neon(process.env.DATABASE_URL || process.env.POSTGRES_URL);

// Creates an in-app notification row for a user. Call this any time an
// event happens that the user should be alerted about (KYC decisions,
// loan updates, card charges, deposits, disputes, etc).
async function createNotification(userId, title, message) {
  try {
    await sql`
      INSERT INTO notifications (user_id, title, message, is_read, created_at)
      VALUES (${userId}, ${title}, ${message}, FALSE, NOW())
    `;
  } catch (err) {
    // Never let a notification failure break the parent action.
    console.error('Create notification error:', err);
  }
}

module.exports = async function handler(req, res) {
  const session = getUserFromRequest(req);
  if (!session) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  const resource = req.method === 'GET' ? req.query.resource : (req.body || {}).resource;

  // ---------- KYC ----------
  if (resource === 'kyc') {
    if (req.method === 'GET') {
      try {
        const kyc = await sql`
          SELECT id, status, verified_at, rejected_reason
          FROM kyc_verifications
          WHERE user_id = ${session.userId}
          ORDER BY created_at DESC
          LIMIT 1
        `;

        if (kyc.length === 0) {
          return res.status(200).json({
            status: 'not_started',
            message: 'KYC not started yet. Begin the verification process.',
          });
        }

        return res.status(200).json({
          kycId: kyc[0].id,
          status: kyc[0].status,
          verifiedAt: kyc[0].verified_at,
          rejectedReason: kyc[0].rejected_reason,
        });
      } catch (err) {
        console.error('Get KYC status error:', err);
        return res.status(500).json({ error: 'Failed to fetch KYC status.' });
      }
    }

    if (req.method === 'POST') {
      try {
        const {
          dateOfBirth, ssn, streetAddress, city, state, zipCode,
          idType, idNumber, idExpiryDate, idIssuingState,
        } = req.body || {};

        if (!dateOfBirth || !ssn || !streetAddress || !city || !state || !zipCode) {
          return res.status(400).json({ error: 'All personal information fields are required.' });
        }
        if (!idType || !idNumber || !idExpiryDate || !idIssuingState) {
          return res.status(400).json({ error: 'All ID fields are required.' });
        }

        const cleanSSN = ssn.replace(/-/g, '');
        if (!/^\d{9}$/.test(cleanSSN)) {
          return res.status(400).json({ error: 'Invalid SSN format. Must be 9 digits.' });
        }

        const dob = new Date(dateOfBirth);
        const age = new Date().getFullYear() - dob.getFullYear();
        if (age < 18) {
          return res.status(400).json({ error: 'Must be at least 18 years old.' });
        }

        const ssnHash = crypto.createHash('sha256').update(cleanSSN).digest('hex');
        const ssnLastFour = cleanSSN.slice(-4);

        const existing = await sql`
          SELECT id, status FROM kyc_verifications
          WHERE user_id = ${session.userId}
          ORDER BY created_at DESC LIMIT 1
        `;

        if (existing.length > 0 && existing[0].status !== 'rejected') {
          return res.status(400).json({
            error: 'KYC already submitted. Please wait for review or contact support if rejected.',
          });
        }

        const kycResult = await sql`
          INSERT INTO kyc_verifications (
            user_id, ssn_hash, ssn_last_four, date_of_birth, street_address,
            city, state, zip_code, id_type, id_number, id_expiry_date, id_issuing_state, status
          )
          VALUES (
            ${session.userId}, ${ssnHash}, ${ssnLastFour}, ${dateOfBirth}, ${streetAddress},
            ${city}, ${state}, ${zipCode}, ${idType}, ${idNumber}, ${idExpiryDate}, ${idIssuingState}, 'pending'
          )
          RETURNING id, status, created_at
        `;

        await createNotification(
          session.userId,
          'KYC Submitted',
          'Your identity verification has been submitted and is under review. This typically completes within 24 hours.'
        );

        return res.status(201).json({
          success: true,
          kycId: kycResult[0].id,
          status: 'pending',
          message: 'KYC submitted successfully. Verification typically completes within 24 hours.',
        });
      } catch (err) {
        console.error('Submit KYC error:', err);
        return res.status(500).json({ error: 'Failed to submit KYC.' });
      }
    }
  }

  // ---------- Disputes ----------
  if (resource === 'disputes') {
    if (req.method === 'GET') {
      try {
        const disputes = await sql`
          SELECT id, dispute_type, reason, status, resolution, resolution_amount, created_at
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

    if (req.method === 'POST') {
      try {
        const { transactionId, disputeType, reason } = req.body || {};

        if (!transactionId || !disputeType || !reason) {
          return res.status(400).json({ error: 'Transaction ID, dispute type, and reason are required.' });
        }
        if (!['unauthorized', 'duplicate', 'incorrect_amount', 'other'].includes(disputeType)) {
          return res.status(400).json({ error: 'Invalid dispute type.' });
        }

        const transaction = await sql`
          SELECT t.id, t.amount, a.user_id, a.id as account_id
          FROM transactions t
          JOIN accounts a ON a.id = t.account_id
          WHERE t.id = ${transactionId} AND a.user_id = ${session.userId}
        `;

        if (transaction.length === 0) {
          return res.status(404).json({ error: 'Transaction not found.' });
        }

        const existing = await sql`
          SELECT id FROM transaction_disputes
          WHERE transaction_id = ${transactionId} AND status IN ('open', 'investigating')
        `;

        if (existing.length > 0) {
          return res.status(409).json({ error: 'A dispute is already open for this transaction.' });
        }

        const dispute = await sql`
          INSERT INTO transaction_disputes (
            transaction_id, user_id, account_id, dispute_type, reason, status
          )
          VALUES (
            ${transactionId}, ${session.userId}, ${transaction[0].account_id},
            ${disputeType}, ${reason}, 'open'
          )
          RETURNING id, status, created_at
        `;

        await createNotification(
          session.userId,
          'Dispute Filed',
          `Your dispute for transaction #${transactionId} has been filed. We'll investigate within 5-10 business days.`
        );

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
  }

  // ---------- Direct Deposit Simulation ----------
  if (resource === 'direct-deposit') {
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return res.status(405).json({ error: 'Method not allowed' });
    }

    try {
      const { amount, fromBankName, fromAccountHolder, description } = req.body || {};

      if (!amount || !fromBankName || !fromAccountHolder) {
        return res.status(400).json({ error: 'Amount, bank name, and account holder are required.' });
      }

      const depositAmount = Number(amount);
      if (!Number.isFinite(depositAmount) || depositAmount <= 0) {
        return res.status(400).json({ error: 'Enter a valid deposit amount greater than zero.' });
      }

      const account = await sql`
        SELECT id FROM accounts
        WHERE user_id = ${session.userId} AND account_type = 'checking'
        LIMIT 1
      `;

      if (account.length === 0) {
        return res.status(400).json({ error: 'Checking account not found.' });
      }

      const traceNumber = 'AHB' + Math.random().toString().slice(2, 12);

      await sql`
        INSERT INTO ach_incoming (
          to_account_id, from_bank_name, from_account_holder, amount,
          description, trace_number, status, effective_date
        )
        VALUES (
          ${account[0].id}, ${fromBankName}, ${fromAccountHolder}, ${depositAmount},
          ${description || 'Direct Deposit'}, ${traceNumber}, 'settled', NOW()
        )
      `;

      await sql`
        UPDATE accounts SET balance = balance + ${depositAmount} WHERE id = ${account[0].id}
      `;

      await sql`
        INSERT INTO transactions (account_id, type, amount, description, created_at)
        VALUES (${account[0].id}, 'ach_in', ${depositAmount}, ${description || 'Direct Deposit'}, NOW())
      `;

      await createNotification(
        session.userId,
        'Direct Deposit Received',
        `A direct deposit of $${depositAmount.toFixed(2)} from ${fromBankName} has been credited to your account.`
      );

      return res.status(201).json({
        success: true,
        message: `Direct deposit of $${depositAmount.toFixed(2)} received successfully!`,
        traceNumber,
      });
    } catch (err) {
      console.error('Direct deposit simulation error:', err);
      return res.status(500).json({ error: 'Failed to process direct deposit.' });
    }
  }
  // ---------- Notifications ----------
  if (resource === 'notifications') {
    if (req.method === 'GET') {
      try {
        const notifications = await sql`
          SELECT id, title, message, is_read, created_at
          FROM notifications
          WHERE user_id = ${session.userId}
          ORDER BY created_at DESC
          LIMIT 20
        `;
        return res.status(200).json({ notifications });
      } catch (err) {
        console.error('Get notifications error:', err);
        return res.status(500).json({ error: 'Failed to fetch notifications.' });
      }
    }

    if (req.method === 'POST') {
      try {
        const { notifAction, notificationId } = req.body || {};

        if (notifAction === 'markRead' && notificationId) {
          await sql`
            UPDATE notifications SET is_read = TRUE
            WHERE id = ${notificationId} AND user_id = ${session.userId}
          `;
          return res.status(200).json({ success: true });
        }

        if (notifAction === 'markAllRead') {
          await sql`
            UPDATE notifications SET is_read = TRUE WHERE user_id = ${session.userId}
          `;
          return res.status(200).json({ success: true });
        }

        if (notifAction === 'clearAll') {
          await sql`DELETE FROM notifications WHERE user_id = ${session.userId}`;
          return res.status(200).json({ success: true });
        }

        if (notifAction === 'dismiss' && notificationId) {
          await sql`DELETE FROM notifications WHERE id = ${notificationId} AND user_id = ${session.userId}`;
          return res.status(200).json({ success: true });
        }

        return res.status(400).json({ error: 'Invalid notifAction.' });
      } catch (err) {
        console.error('Update notifications error:', err);
        return res.status(500).json({ error: 'Failed to update notifications.' });
      }
    }
  }

  // ---------- Credit Card ----------
  if (resource === 'credit-card') {
    // Every user gets exactly one credit account, auto-provisioned on first touch.
    async function getOrCreateCardAccount(userId) {
      let accountRows = await sql`
        SELECT id, balance FROM accounts
        WHERE user_id = ${userId} AND account_type = 'credit'
        LIMIT 1
      `;

      let account;
      if (accountRows.length === 0) {
        const inserted = await sql`
          INSERT INTO accounts (user_id, account_type, balance, account_number)
          VALUES (${userId}, 'credit', 0, LPAD(FLOOR(RANDOM() * 10000000000)::TEXT, 10, '0'))
          RETURNING id, balance
        `;
        account = inserted[0];
      } else {
        account = accountRows[0];
      }

      let detailsRows = await sql`
        SELECT * FROM credit_card_details WHERE account_id = ${account.id} LIMIT 1
      `;

      let details;
      if (detailsRows.length === 0) {
        const lastFour = String(Math.floor(1000 + Math.random() * 9000));
        const inserted = await sql`
          INSERT INTO credit_card_details (account_id, last_four)
          VALUES (${account.id}, ${lastFour})
          RETURNING *
        `;
        details = inserted[0];
      } else {
        details = detailsRows[0];
      }

      return { account, details };
    }

    if (req.method === 'GET') {
      try {
        const { account, details } = await getOrCreateCardAccount(session.userId);

        const balanceOwed = Number(account.balance);
        const creditLimit = Number(details.credit_limit);

        const transactions = await sql`
          SELECT id, type, amount, description, created_at
          FROM transactions
          WHERE account_id = ${account.id}
          ORDER BY created_at DESC
          LIMIT 30
        `;

        return res.status(200).json({
          balance: balanceOwed,
          creditLimit,
          availableCredit: creditLimit - balanceOwed,
          isFrozen: details.is_frozen,
          velocityLimit: Number(details.velocity_limit),
          lastFour: details.last_four,
          cardTier: details.card_tier,
          hasPin: !!details.pin_hash,
          transactions,
        });
      } catch (err) {
        console.error('Get credit card error:', err);
        return res.status(500).json({ error: 'Failed to fetch card details.' });
      }
    }

    if (req.method === 'POST') {
      try {
        const { cardAction } = req.body || {};
        const { account, details } = await getOrCreateCardAccount(session.userId);

        if (cardAction === 'toggleFreeze') {
          const updated = await sql`
            UPDATE credit_card_details SET is_frozen = NOT is_frozen
            WHERE account_id = ${account.id}
            RETURNING is_frozen
          `;

          await createNotification(
            session.userId,
            updated[0].is_frozen ? 'Card Frozen' : 'Card Unfrozen',
            updated[0].is_frozen
              ? 'Your credit card has been frozen. No new purchases can be made until you unfreeze it.'
              : 'Your credit card has been unfrozen and is ready to use.'
          );

          return res.status(200).json({ success: true, isFrozen: updated[0].is_frozen });
        }

        if (cardAction === 'setVelocityLimit') {
          const { velocityLimit } = req.body || {};
          const val = Number(velocityLimit);
          if (!Number.isFinite(val) || val < 500 || val > 15000) {
            return res.status(400).json({ error: 'Velocity limit must be between $500 and $15,000.' });
          }
          await sql`
            UPDATE credit_card_details SET velocity_limit = ${val}
            WHERE account_id = ${account.id}
          `;
          return res.status(200).json({ success: true, velocityLimit: val });
        }

        if (cardAction === 'setPin') {
          const { pin } = req.body || {};
          if (!pin || !/^\d{4,6}$/.test(String(pin))) {
            return res.status(400).json({ error: 'PIN must be 4-6 digits.' });
          }
          const pinHash = await bcrypt.hash(String(pin), 10);
          await sql`
            UPDATE credit_card_details SET pin_hash = ${pinHash}
            WHERE account_id = ${account.id}
          `;
          return res.status(200).json({ success: true });
        }

        if (cardAction === 'charge') {
          const { amount, merchant } = req.body || {};
          const chargeAmount = Number(amount);

          if (!Number.isFinite(chargeAmount) || chargeAmount <= 0) {
            return res.status(400).json({ error: 'Enter a valid charge amount.' });
          }
          if (details.is_frozen) {
            return res.status(400).json({ error: 'This card is frozen. Unfreeze it to make purchases.' });
          }
          if (chargeAmount > Number(details.velocity_limit)) {
            return res.status(400).json({ error: `This exceeds your single transaction limit of $${Number(details.velocity_limit).toLocaleString()}.` });
          }
          const currentBalance = Number(account.balance);
          const creditLimit = Number(details.credit_limit);
          if (currentBalance + chargeAmount > creditLimit) {
            return res.status(400).json({ error: 'This charge would exceed your available credit.' });
          }

          const updated = await sql`
            UPDATE accounts SET balance = balance + ${chargeAmount}
            WHERE id = ${account.id}
            RETURNING balance
          `;

          await sql`
            INSERT INTO transactions (account_id, type, amount, description, created_at)
            VALUES (${account.id}, 'credit_purchase', ${chargeAmount}, ${merchant || 'Card Purchase'}, NOW())
          `;

          await createNotification(
            session.userId,
            'Card Charge',
            `A charge of $${chargeAmount.toFixed(2)} at ${merchant || 'a merchant'} was made on your credit card.`
          );

          return res.status(200).json({ success: true, balance: Number(updated[0].balance) });
        }

        if (cardAction === 'makePayment') {
          const { amount } = req.body || {};
          const paymentAmount = Number(amount);

          if (!Number.isFinite(paymentAmount) || paymentAmount <= 0) {
            return res.status(400).json({ error: 'Enter a valid payment amount.' });
          }

          const checkingRows = await sql`
            SELECT id, balance FROM accounts
            WHERE user_id = ${session.userId} AND account_type = 'checking'
            LIMIT 1
          `;
          if (checkingRows.length === 0) {
            return res.status(404).json({ error: 'Checking account not found.' });
          }
          const checking = checkingRows[0];

          if (Number(checking.balance) < paymentAmount) {
            return res.status(400).json({ error: 'Insufficient funds in checking to make this payment.' });
          }
          if (paymentAmount > Number(account.balance)) {
            return res.status(400).json({ error: 'Payment exceeds your current card balance.' });
          }

          await sql`
            UPDATE accounts SET balance = balance - ${paymentAmount} WHERE id = ${checking.id}
          `;
          const updatedCard = await sql`
            UPDATE accounts SET balance = balance - ${paymentAmount}
            WHERE id = ${account.id}
            RETURNING balance
          `;

          await sql`
            INSERT INTO transactions (account_id, type, amount, description, created_at)
            VALUES (${checking.id}, 'debit', ${paymentAmount}, 'Credit Card Payment', NOW())
          `;
          await sql`
            INSERT INTO transactions (account_id, type, amount, description, created_at)
            VALUES (${account.id}, 'credit_payment', ${-paymentAmount}, 'Payment Received - Thank You', NOW())
          `;

          await createNotification(
            session.userId,
            'Credit Card Payment',
            `Your payment of $${paymentAmount.toFixed(2)} was applied to your credit card balance.`
          );

          return res.status(200).json({ success: true, cardBalance: Number(updatedCard[0].balance) });
        }

        return res.status(400).json({ error: 'Invalid cardAction.' });
      } catch (err) {
        console.error('Credit card action error:', err);
        return res.status(500).json({ error: 'Failed to process card action.' });
      }
    }
  }


  // ---------- Email Change ----------
  if (resource === 'email-change') {
    if (req.method === 'POST') {
      try {
        const { emailAction, newEmail, token } = req.body || {};

        if (emailAction === 'request') {
          const normalizedNewEmail = String(newEmail || '').trim().toLowerCase();
          if (!normalizedNewEmail || !normalizedNewEmail.includes('@') || !normalizedNewEmail.includes('.')) {
            return res.status(400).json({ error: 'Enter a valid email address.' });
          }

          const existing = await sql`SELECT id FROM users WHERE LOWER(email) = ${normalizedNewEmail} AND id != ${session.userId} LIMIT 1`;
          if (existing.length > 0) {
            return res.status(409).json({ error: 'That email is already in use by another account.' });
          }

          const changeToken = crypto.randomBytes(24).toString('hex');
          const expiresAt = new Date(Date.now() + 30 * 60 * 1000);

          await sql`
            UPDATE users
            SET pending_email = ${normalizedNewEmail}, pending_email_token = ${changeToken}, pending_email_expires_at = ${expiresAt.toISOString()}
            WHERE id = ${session.userId}
          `;

          const confirmUrl = `https://apex-horizon-bank-eight.vercel.app/?emailChangeToken=${changeToken}`;

          await sendEmail({
            to: normalizedNewEmail,
            subject: 'Confirm your new email - Apex Horizon Bank',
            html: emailChangeConfirmationHtml(confirmUrl),
          });

          return res.status(200).json({ success: true, message: 'A confirmation link has been sent to your new email address.' });
        }

        if (emailAction === 'confirm') {
          const cleanToken = String(token || '').trim();
          if (!cleanToken) {
            return res.status(400).json({ error: 'Missing confirmation token.' });
          }

          const rows = await sql`
            SELECT id, pending_email, pending_email_expires_at FROM users
            WHERE id = ${session.userId} AND pending_email_token = ${cleanToken}
            LIMIT 1
          `;

          if (rows.length === 0) {
            return res.status(400).json({ error: 'This confirmation link is invalid or was already used.' });
          }

          const row = rows[0];
          if (!row.pending_email_expires_at || new Date(row.pending_email_expires_at) < new Date()) {
            return res.status(400).json({ error: 'This confirmation link has expired. Please request a new email change.' });
          }

          await sql`
            UPDATE users
            SET email = ${row.pending_email}, pending_email = NULL, pending_email_token = NULL, pending_email_expires_at = NULL
            WHERE id = ${session.userId}
          `;

          await createNotification(
            session.userId,
            'Email Address Updated',
            `Your account email has been changed to ${row.pending_email}.`
          );

          return res.status(200).json({ success: true, newEmail: row.pending_email, message: 'Your email address has been updated.' });
        }

        return res.status(400).json({ error: 'Invalid emailAction. Use "request" or "confirm".' });
      } catch (err) {
        console.error('Email change error:', err);
        return res.status(500).json({ error: 'Failed to process email change.' });
      }
    }
  }

  // ---------- Loans ----------
  if (resource === 'loans') {
    function calculateAmortization(principal, annualRate, termMonths) {
      const monthlyRate = annualRate / 12;
      const monthlyPayment = monthlyRate === 0
        ? principal / termMonths
        : (principal * monthlyRate * Math.pow(1 + monthlyRate, termMonths)) / (Math.pow(1 + monthlyRate, termMonths) - 1);
      const totalPaid = monthlyPayment * termMonths;
      const totalInterest = totalPaid - principal;
      return { monthlyPayment, totalInterest, totalPaid };
    }

    if (req.method === 'GET') {
      try {
        const loans = await sql`
          SELECT id, principal, remaining_balance, interest_rate, term_months, monthly_payment, status, purpose, created_at, disbursed_at, paid_off_at
          FROM loans WHERE user_id = ${session.userId} ORDER BY created_at DESC
        `;
        return res.status(200).json({ loans });
      } catch (err) {
        console.error('Get loans error:', err);
        return res.status(500).json({ error: 'Failed to fetch loans.' });
      }
    }

    if (req.method === 'POST') {
      try {
        const { loanAction } = req.body || {};

        if (loanAction === 'apply') {
          const principal = Number(req.body.principal);
          const annualRate = Number(req.body.annualRate);
          const termMonths = Number(req.body.termMonths);
          const purpose = String(req.body.purpose || '').trim();
          const monthlyIncome = Number(req.body.monthlyIncome);
          const employmentStatus = String(req.body.employmentStatus || '').trim();

          if (!Number.isFinite(principal) || principal < 1000 || principal > 250000) {
            return res.status(400).json({ error: 'Loan amount must be between $1,000 and $250,000.' });
          }
          if (!Number.isFinite(termMonths) || termMonths < 6 || termMonths > 84) {
            return res.status(400).json({ error: 'Term must be between 6 and 84 months.' });
          }
          if (!Number.isFinite(annualRate) || annualRate <= 0 || annualRate > 0.30) {
            return res.status(400).json({ error: 'Invalid interest rate.' });
          }
          if (!purpose) {
            return res.status(400).json({ error: 'Please tell us the purpose of this loan.' });
          }
          if (!Number.isFinite(monthlyIncome) || monthlyIncome <= 0) {
            return res.status(400).json({ error: 'Please enter a valid monthly income.' });
          }
          if (!employmentStatus) {
            return res.status(400).json({ error: 'Please select your employment status.' });
          }

          const accountRows = await sql`
            SELECT COALESCE(SUM(balance), 0) AS total_balance
            FROM accounts WHERE user_id = ${session.userId}
          `;
          const totalBalance = Number(accountRows[0].total_balance);
          if (totalBalance < principal * 0.10) {
            return res.status(400).json({
              error: `Based on your current balances, you're not eligible for a loan this large. Try a lower amount or check back after your balance grows.`
            });
          }

          const { monthlyPayment, totalInterest, totalPaid } = calculateAmortization(principal, annualRate, termMonths);

          const checkingRows = await sql`
            SELECT id FROM accounts WHERE user_id = ${session.userId} AND account_type = 'checking' LIMIT 1
          `;
          if (checkingRows.length === 0) {
            return res.status(400).json({ error: 'No checking account found to attach this loan to.' });
          }

          const userRows = await sql`SELECT full_name FROM users WHERE id = ${session.userId} LIMIT 1`;
          const applicantName = userRows[0]?.full_name || null;

          const loanRows = await sql`
            INSERT INTO loans (user_id, account_id, principal, interest_rate, term_months, monthly_payment, status, purpose, monthly_income, employment_status, applicant_name)
            VALUES (${session.userId}, ${checkingRows[0].id}, ${principal}, ${annualRate}, ${termMonths}, ${monthlyPayment}, 'pending', ${purpose}, ${monthlyIncome}, ${employmentStatus}, ${applicantName})
            RETURNING id, principal, interest_rate, term_months, monthly_payment, status, purpose, created_at
          `;

          await createNotification(
            session.userId,
            'Loan Application Submitted',
            `Your application for a $${principal.toLocaleString()} loan is pending review. We'll notify you once a decision is made.`
          );

          return res.status(200).json({
            success: true,
            message: 'Application submitted successfully. Your loan is pending review and you\'ll be notified once a decision is made.',
            loan: loanRows[0],
            summary: { monthlyPayment, totalInterest, totalPaid }
          });
        }

        if (loanAction === 'makePayment') {
          const amount = Number(req.body.amount);
          if (!Number.isFinite(amount) || amount <= 0) {
            return res.status(400).json({ error: 'Enter a valid payment amount.' });
          }

          const loanRows = await sql`
            SELECT id, account_id, remaining_balance, status
            FROM loans WHERE id = ${req.body.loanId} AND user_id = ${session.userId} LIMIT 1
          `;
          if (loanRows.length === 0) return res.status(404).json({ error: 'Loan not found.' });
          const loan = loanRows[0];

          if (loan.status !== 'active') {
            return res.status(400).json({ error: 'This loan is not active.' });
          }
          if (amount > Number(loan.remaining_balance)) {
            return res.status(400).json({ error: 'Payment exceeds remaining loan balance.' });
          }

          const checkingRows = await sql`
            SELECT id, balance FROM accounts WHERE user_id = ${session.userId} AND account_type = 'checking' LIMIT 1
          `;
          if (checkingRows.length === 0) return res.status(404).json({ error: 'Checking account not found.' });
          const checking = checkingRows[0];

          if (Number(checking.balance) < amount) {
            return res.status(400).json({ error: 'Insufficient funds in checking to make this payment.' });
          }

          const newRemaining = Number(loan.remaining_balance) - amount;
          const newStatus = newRemaining <= 0 ? 'paid_off' : 'active';

          await sql`UPDATE accounts SET balance = balance - ${amount} WHERE id = ${checking.id}`;
          await sql`
            UPDATE loans SET remaining_balance = ${newRemaining}, status = ${newStatus}, paid_off_at = ${newRemaining <= 0 ? new Date().toISOString() : null}
            WHERE id = ${loan.id}
          `;

          const paymentDescription = `Loan Payment — Loan #${loan.id}`;
          await sql`
            INSERT INTO transactions (account_id, type, amount, description, created_at)
            VALUES (${checking.id}, 'debit', ${amount}, ${paymentDescription}, NOW())
          `;

          await createNotification(
            session.userId,
            newStatus === 'paid_off' ? 'Loan Paid Off' : 'Loan Payment Applied',
            newStatus === 'paid_off'
              ? `Congratulations! Loan #${loan.id} has been fully paid off.`
              : `Your payment of $${amount.toFixed(2)} was applied to Loan #${loan.id}. Remaining balance: $${newRemaining.toFixed(2)}.`
          );

          return res.status(200).json({
            success: true,
            message: newStatus === 'paid_off' ? 'Payment successful — loan fully paid off!' : `Payment of $${amount.toFixed(2)} applied. Remaining balance: $${newRemaining.toFixed(2)}.`,
            remainingBalance: newRemaining,
            status: newStatus
          });
        }

        return res.status(400).json({ error: 'Invalid loanAction. Use "apply" or "makePayment".' });
      } catch (err) {
        console.error('Loan action error:', err);
        return res.status(500).json({ error: 'Failed to process loan action.' });
      }
    }
  }

  return res.status(400).json({ error: 'Invalid or missing resource. Use "kyc", "disputes", "direct-deposit", "passcode", "notifications", "credit-card", "email-change", or "loans".' });




};
