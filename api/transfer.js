const { neon } = require('@neondatabase/serverless');
const { getUserFromRequest } = require('./auth');

const sql = neon(process.env.DATABASE_URL || process.env.POSTGRES_URL);

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const session = getUserFromRequest(req);
    if (!session) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const { fromAccountType, toAccountType, amount, description } = req.body || {};

    if (!fromAccountType || !toAccountType || !amount) {
      return res.status(400).json({ error: 'From account, to account, and amount are required.' });
    }

    if (fromAccountType === toAccountType) {
      return res.status(400).json({ error: 'Choose two different accounts to transfer between.' });
    }

    const transferAmount = Number(amount);
    if (!Number.isFinite(transferAmount) || transferAmount <= 0) {
      return res.status(400).json({ error: 'Enter a valid transfer amount greater than zero.' });
    }

    // Load both of this user's accounts, locking neither (Neon's HTTP driver
    // doesn't support multi-statement transactions), but we re-check the
    // balance right before writing to minimize any race window.
    const fromRows = await sql`
      SELECT id, balance FROM accounts
      WHERE user_id = ${session.userId} AND account_type = ${fromAccountType}
      LIMIT 1
    `;
    const toRows = await sql`
      SELECT id, balance FROM accounts
      WHERE user_id = ${session.userId} AND account_type = ${toAccountType}
      LIMIT 1
    `;

    if (fromRows.length === 0 || toRows.length === 0) {
      return res.status(404).json({ error: 'One of the selected accounts could not be found.' });
    }

    const fromAccount = fromRows[0];
    const toAccount = toRows[0];

    if (Number(fromAccount.balance) < transferAmount) {
      return res.status(400).json({ error: 'Insufficient funds in the source account.' });
    }

    // Debit the source account
    const updatedFrom = await sql`
      UPDATE accounts
      SET balance = balance - ${transferAmount}
      WHERE id = ${fromAccount.id} AND balance >= ${transferAmount}
      RETURNING id, balance
    `;

    if (updatedFrom.length === 0) {
      // Balance changed between our check and the update — bail out safely.
      return res.status(409).json({ error: 'Balance changed before the transfer completed. Please try again.' });
    }

    // Credit the destination account
    const updatedTo = await sql`
      UPDATE accounts
      SET balance = balance + ${transferAmount}
      WHERE id = ${toAccount.id}
      RETURNING id, balance
    `;

    const note = description || `Transfer to ${toAccountType}`;
    const noteIncoming = description || `Transfer from ${fromAccountType}`;

    await sql`
      INSERT INTO transactions (account_id, type, amount, description, created_at)
      VALUES (${fromAccount.id}, 'transfer_out', ${transferAmount}, ${note}, NOW())
    `;
    await sql`
      INSERT INTO transactions (account_id, type, amount, description, created_at)
      VALUES (${toAccount.id}, 'transfer_in', ${transferAmount}, ${noteIncoming}, NOW())
    `;

    return res.status(200).json({
      success: true,
      from: { accountType: fromAccountType, balance: updatedFrom[0].balance },
      to: { accountType: toAccountType, balance: updatedTo[0].balance },
    });
  } catch (err) {
    console.error('Transfer error:', err);
    return res.status(500).json({ error: 'Something went wrong processing the transfer. Please try again.' });
  }
};
