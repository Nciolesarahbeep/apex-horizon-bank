const { neon } = require('@neondatabase/serverless');
const { getUserFromRequest } = require('../lib/auth');

const sql = neon(process.env.DATABASE_URL || process.env.POSTGRES_URL);

async function createNotification(userId, title, message) {
  try {
    await sql`
      INSERT INTO notifications (user_id, title, message, is_read, created_at)
      VALUES (${userId}, ${title}, ${message}, FALSE, NOW())
    `;
  } catch (err) {
    console.error('Create notification error:', err);
  }
}

async function ensureBillPayTables() {
  await sql`
    CREATE TABLE IF NOT EXISTS bill_payees (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      name TEXT NOT NULL,
      account_number TEXT,
      category TEXT DEFAULT 'other',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS bill_payments (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      payee_id INTEGER REFERENCES bill_payees(id) ON DELETE SET NULL,
      payee_name TEXT NOT NULL,
      amount NUMERIC(14,2) NOT NULL,
      memo TEXT,
      status TEXT NOT NULL DEFAULT 'completed',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS bill_payees_user_idx ON bill_payees (user_id)`;
  await sql`CREATE INDEX IF NOT EXISTS bill_payments_user_idx ON bill_payments (user_id, created_at DESC)`;
}

module.exports = async function handler(req, res) {
  const session = await getUserFromRequest(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });

  await ensureBillPayTables();

  if (req.method === 'GET') {
    try {
      const payees = await sql`
        SELECT id, name, account_number, category, created_at
        FROM bill_payees WHERE user_id = ${session.userId}
        ORDER BY name ASC
      `;
      const payments = await sql`
        SELECT id, payee_id, payee_name, amount, memo, status, created_at
        FROM bill_payments WHERE user_id = ${session.userId}
        ORDER BY created_at DESC LIMIT 40
      `;
      return res.status(200).json({ payees, payments });
    } catch (err) {
      console.error('Bill pay GET error:', err);
      return res.status(500).json({ error: 'Failed to load bill pay data.' });
    }
  }

  if (req.method === 'POST') {
    try {
      const { billAction } = req.body || {};

      if (billAction === 'addPayee') {
        const { name, accountNumber, category } = req.body || {};
        const cleanName = String(name || '').trim();
        if (!cleanName || cleanName.length < 2) {
          return res.status(400).json({ error: 'Payee name is required.' });
        }
        const inserted = await sql`
          INSERT INTO bill_payees (user_id, name, account_number, category, created_at)
          VALUES (
            ${session.userId},
            ${cleanName},
            ${accountNumber ? String(accountNumber).trim() : null},
            ${category || 'other'},
            NOW()
          )
          RETURNING id, name, account_number, category, created_at
        `;
        return res.status(200).json({ success: true, payee: inserted[0] });
      }

      if (billAction === 'deletePayee') {
        const { payeeId } = req.body || {};
        await sql`DELETE FROM bill_payees WHERE id = ${Number(payeeId)} AND user_id = ${session.userId}`;
        return res.status(200).json({ success: true });
      }

      if (billAction === 'pay') {
        const { payeeId, amount, memo } = req.body || {};
        const payAmount = Number(amount);
        if (!Number.isFinite(payAmount) || payAmount <= 0) {
          return res.status(400).json({ error: 'Enter a valid payment amount.' });
        }
        if (payAmount > 25000) {
          return res.status(400).json({ error: 'Online bill payments are limited to $25,000.' });
        }
        const payeeRows = await sql`
          SELECT id, name FROM bill_payees
          WHERE id = ${Number(payeeId)} AND user_id = ${session.userId} LIMIT 1
        `;
        if (payeeRows.length === 0) return res.status(404).json({ error: 'Payee not found.' });
        const payee = payeeRows[0];

        const checkingRows = await sql`
          SELECT id, balance, restriction_level FROM accounts
          WHERE user_id = ${session.userId} AND account_type = 'checking' LIMIT 1
        `;
        if (checkingRows.length === 0) return res.status(404).json({ error: 'Checking account not found.' });
        const checking = checkingRows[0];
        if (checking.restriction_level && checking.restriction_level !== 'none') {
          return res.status(403).json({ error: 'There is an issue on this account that blocks payments.' });
        }
        if (Number(checking.balance) < payAmount) {
          return res.status(400).json({ error: 'Insufficient funds in checking.' });
        }

        const updated = await sql`
          UPDATE accounts SET balance = balance - ${payAmount}
          WHERE id = ${checking.id} AND balance >= ${payAmount}
          RETURNING balance
        `;
        if (updated.length === 0) return res.status(409).json({ error: 'Balance changed. Please try again.' });

        const desc = memo ? `Bill pay to ${payee.name} — ${memo}` : `Bill pay to ${payee.name}`;
        await sql`
          INSERT INTO transactions (account_id, type, amount, description, created_at)
          VALUES (${checking.id}, 'debit', ${payAmount}, ${desc}, NOW())
        `;
        const payment = await sql`
          INSERT INTO bill_payments (user_id, payee_id, payee_name, amount, memo, status, created_at)
          VALUES (${session.userId}, ${payee.id}, ${payee.name}, ${payAmount}, ${memo || null}, 'completed', NOW())
          RETURNING id, payee_name, amount, memo, status, created_at
        `;
        const amountFormatted = payAmount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        await createNotification(session.userId, 'Bill Paid', `You paid $${amountFormatted} to ${payee.name}.`);

        return res.status(200).json({
          success: true,
          payment: payment[0],
          checkingBalance: Number(updated[0].balance),
        });
      }

      return res.status(400).json({ error: 'Invalid billAction.' });
    } catch (err) {
      console.error('Bill pay POST error:', err);
      return res.status(500).json({ error: 'Failed to process bill pay action.' });
    }
  }

  res.setHeader('Allow', 'GET, POST');
  return res.status(405).json({ error: 'Method not allowed' });
};
