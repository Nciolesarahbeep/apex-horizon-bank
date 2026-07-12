const { neon } = require('@neondatabase/serverless');
const { getUserFromRequest } = require('../lib/auth');

const sql = neon(process.env.DATABASE_URL || process.env.POSTGRES_URL);

module.exports = async function handler(req, res) {
  const session = getUserFromRequest(req);
  if (!session) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

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

    // Get user's checking account
    const account = await sql`
      SELECT id FROM accounts
      WHERE user_id = ${session.userId} AND account_type = 'checking'
      LIMIT 1
    `;

    if (account.length === 0) {
      return res.status(400).json({ error: 'Checking account not found.' });
    }

    // Generate trace number
    const traceNumber = 'AHB' + Math.random().toString().slice(2, 12);

    // Record incoming ACH deposit
    await sql`
      INSERT INTO ach_incoming (
        to_account_id,
        from_bank_name,
        from_account_holder,
        amount,
        description,
        trace_number,
        status,
        effective_date
      )
      VALUES (
        ${account[0].id},
        ${fromBankName},
        ${fromAccountHolder},
        ${depositAmount},
        ${description || 'Direct Deposit'},
        ${traceNumber},
        'settled',
        NOW()
      )
    `;

    // Update account balance
    await sql`
      UPDATE accounts
      SET balance = balance + ${depositAmount}
      WHERE id = ${account[0].id}
    `;

    // Create transaction record
    await sql`
      INSERT INTO transactions (account_id, type, amount, description, created_at)
      VALUES (
        ${account[0].id},
        'ach_in',
        ${depositAmount},
        ${description || 'Direct Deposit'},
        NOW()
      )
    `;

    return res.status(201).json({
      success: true,
      message: `Direct deposit of $${depositAmount.toFixed(2)} received successfully!`,
      traceNumber,
      newBalance: await sql`SELECT balance FROM accounts WHERE id = ${account[0].id}`,
    });
  } catch (err) {
    console.error('Direct deposit simulation error:', err);
    return res.status(500).json({ error: 'Failed to process direct deposit.' });
  }
};
