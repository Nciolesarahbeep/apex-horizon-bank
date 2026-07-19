const { neon } = require('@neondatabase/serverless');
const { getUserFromRequest } = require('../lib/auth');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');


const sql = neon(process.env.DATABASE_URL || process.env.POSTGRES_URL);

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

          return res.status(200).json({ success: true, newEmail: row.pending_email, message: 'Your email address has been updated.' });
        }

        return res.status(400).json({ error: 'Invalid emailAction. Use "request" or "confirm".' });
      } catch (err) {
        console.error('Email change error:', err);
        return res.status(500).json({ error: 'Failed to process email change.' });
      }
    }
  }

  return res.status(400).json({ error: 'Invalid or missing resource. Use "kyc", "disputes", "direct-deposit", "passcode", "notifications", "credit-card", or "email-change".' });




};
