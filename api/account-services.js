const { neon } = require('@neondatabase/serverless');
const { getUserFromRequest } = require('../lib/auth');
const crypto = require('crypto');

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

  return res.status(400).json({ error: 'Invalid or missing resource. Use "kyc", "disputes", or "direct-deposit".' });
};
