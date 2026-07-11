const { neon } = require('@neondatabase/serverless');
const { getUserFromRequest } = require('./auth');

const sql = neon(process.env.DATABASE_URL || process.env.POSTGRES_URL);

// Real-bank-style daily P2P sending limit. Adjust as needed.
const DAILY_P2P_LIMIT = 2500;

// Real-bank-style per-transaction wire limit for standard online banking
// (larger wires typically require phone/branch verification in real banks).
const MAX_WIRE_AMOUNT = 25000;

module.exports = async function handler(req, res) {
  // ===== Recipient lookup (for the "Send $50 to Sarah J.?" confirm step) =====
  // GET /api/transfer?lookupEmail=someone@example.com
  if (req.method === 'GET') {
    try {
      const session = getUserFromRequest(req);
      if (!session) {
        return res.status(401).json({ error: 'Not authenticated' });
      }

      const lookupEmail = (req.query && req.query.lookupEmail || '').trim().toLowerCase();
      if (!lookupEmail) {
        return res.status(400).json({ error: 'lookupEmail is required.' });
      }

      const rows = await sql`
        SELECT id, full_name, email FROM users
        WHERE LOWER(email) = ${lookupEmail}
        LIMIT 1
      `;

      if (rows.length === 0) {
        return res.status(404).json({ error: 'No Apex Horizon account found for that email.' });
      }

      const recipient = rows[0];

      if (recipient.id === session.userId) {
        return res.status(400).json({ error: "You can't send money to yourself." });
      }

      // Never leak the full name or account details — only first name + last initial,
      // same principle real banks use for Zelle-style recipient confirmation.
      const nameParts = (recipient.full_name || '').trim().split(/\s+/);
      const firstName = nameParts[0] || 'Apex';
      const lastInitial = nameParts.length > 1 ? nameParts[nameParts.length - 1][0] : '';

      return res.status(200).json({
        found: true,
        displayName: lastInitial ? `${firstName} ${lastInitial}.` : firstName,
      });
    } catch (err) {
      console.error('Recipient lookup error:', err);
      return res.status(500).json({ error: 'Something went wrong looking up that recipient.' });
    }
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const session = getUserFromRequest(req);
    if (!session) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const { fromAccountType, toAccountType, recipientEmail, routingNumber, beneficiaryNumber, targetBank, amount, description } = req.body || {};

    if (!fromAccountType || !amount) {
      return res.status(400).json({ error: 'From account and amount are required.' });
    }

    const transferAmount = Number(amount);
    if (!Number.isFinite(transferAmount) || transferAmount <= 0) {
      return res.status(400).json({ error: 'Enter a valid transfer amount greater than zero.' });
    }

    const isP2P = !!recipientEmail;
    const isWire = !!routingNumber;

    if (isP2P && isWire) {
      return res.status(400).json({ error: 'Choose either a wire or a P2P transfer, not both.' });
    }

    if (isWire) {
      const cleanRouting = String(routingNumber).trim();
      if (!/^\d{9}$/.test(cleanRouting)) {
        return res.status(400).json({ error: 'Routing number must be exactly 9 digits.' });
      }
      if (!beneficiaryNumber || !String(beneficiaryNumber).trim()) {
        return res.status(400).json({ error: 'Beneficiary account number is required.' });
      }
      if (transferAmount > MAX_WIRE_AMOUNT) {
        return res.status(400).json({
          error: `Online wires are limited to $${MAX_WIRE_AMOUNT.toLocaleString()} per transaction. For larger amounts, contact support.`,
        });
      }
    }

    if (!isP2P && !isWire && !toAccountType) {
      return res.status(400).json({ error: 'To account is required for internal transfers.' });
    }

    if (!isP2P && !isWire && fromAccountType === toAccountType) {
      return res.status(400).json({ error: 'Choose two different accounts to transfer between.' });
    }

    // Load the sender's source account (owned by the authenticated user)
    const fromRows = await sql`
      SELECT id, balance FROM accounts
      WHERE user_id = ${session.userId} AND account_type = ${fromAccountType}
      LIMIT 1
    `;

    if (fromRows.length === 0) {
      return res.status(404).json({ error: 'Your source account could not be found.' });
    }

    const fromAccount = fromRows[0];

    let toAccount;
    let recipientUserId = null;
    let note;
    let noteIncoming;

    if (isP2P) {
      const email = String(recipientEmail).trim().toLowerCase();

      const recipientRows = await sql`
        SELECT id, full_name, email FROM users
        WHERE LOWER(email) = ${email}
        LIMIT 1
      `;

      if (recipientRows.length === 0) {
        return res.status(404).json({ error: 'No Apex Horizon account found for that email.' });
      }

      const recipient = recipientRows[0];

      if (recipient.id === session.userId) {
        return res.status(400).json({ error: "You can't send money to yourself." });
      }

      recipientUserId = recipient.id;

      // P2P always lands in the recipient's checking account — same as how
      // Zelle/interbank P2P works in practice.
      const toRows = await sql`
        SELECT id, balance FROM accounts
        WHERE user_id = ${recipientUserId} AND account_type = 'checking'
        LIMIT 1
      `;

      if (toRows.length === 0) {
        return res.status(404).json({ error: 'That recipient does not have an eligible account.' });
      }

      toAccount = toRows[0];

      // Daily P2P sending limit — sum today's outbound P2P transactions from this account
      const sentTodayRows = await sql`
        SELECT COALESCE(SUM(amount), 0) AS total
        FROM transactions
        WHERE account_id = ${fromAccount.id}
          AND type = 'p2p_out'
          AND created_at >= date_trunc('day', NOW())
      `;
      const sentToday = Number(sentTodayRows[0].total);

      if (sentToday + transferAmount > DAILY_P2P_LIMIT) {
        return res.status(400).json({
          error: `This would exceed your daily P2P sending limit of $${DAILY_P2P_LIMIT.toLocaleString()}. You've sent $${sentToday.toLocaleString()} today.`,
        });
      }

      const nameParts = (recipient.full_name || '').trim().split(/\s+/);
      const firstName = nameParts[0] || 'Apex user';
      note = description || `P2P transfer to ${firstName}`;
      noteIncoming = description || `P2P transfer received`;
    } else if (isWire) {
      // External wire — money leaves Apex Horizon entirely, so there is no
      // internal destination account to credit, only a single outbound entry.
      const bankLabel = (targetBank && String(targetBank).trim()) || 'External Bank';
      note = description || `Outbound Wire | ${bankLabel}`;
    } else {
      const toRows = await sql`
        SELECT id, balance FROM accounts
        WHERE user_id = ${session.userId} AND account_type = ${toAccountType}
        LIMIT 1
      `;

      if (toRows.length === 0) {
        return res.status(404).json({ error: 'One of the selected accounts could not be found.' });
      }

      toAccount = toRows[0];
      note = description || `Transfer to ${toAccountType}`;
      noteIncoming = description || `Transfer from ${fromAccountType}`;
    }

    if (Number(fromAccount.balance) < transferAmount) {
      return res.status(400).json({ error: 'Insufficient funds in the source account.' });
    }

    // Debit the source account (guarded re-check against the race window,
    // same pattern as the existing internal-transfer path)
    const updatedFrom = await sql`
      UPDATE accounts
      SET balance = balance - ${transferAmount}
      WHERE id = ${fromAccount.id} AND balance >= ${transferAmount}
      RETURNING id, balance
    `;

    if (updatedFrom.length === 0) {
      return res.status(409).json({ error: 'Balance changed before the transfer completed. Please try again.' });
    }

    const outType = isWire ? 'wire_out' : (isP2P ? 'p2p_out' : 'transfer_out');

    await sql`
      INSERT INTO transactions (account_id, type, amount, description, created_at)
      VALUES (${fromAccount.id}, ${outType}, ${transferAmount}, ${note}, NOW())
    `;

    let updatedTo = null;

    // Wires are external — money leaves the bank, so there's no internal
    // destination account to credit or log an incoming transaction for.
    if (!isWire) {
      updatedTo = await sql`
        UPDATE accounts
        SET balance = balance + ${transferAmount}
        WHERE id = ${toAccount.id}
        RETURNING id, balance
      `;

      const inType = isP2P ? 'p2p_in' : 'transfer_in';

      await sql`
        INSERT INTO transactions (account_id, type, amount, description, created_at)
        VALUES (${toAccount.id}, ${inType}, ${transferAmount}, ${noteIncoming}, NOW())
      `;
    }

    return res.status(200).json({
      success: true,
      isP2P,
      isWire,
      from: { accountType: fromAccountType, balance: updatedFrom[0].balance },
      to: (isP2P || isWire)
        ? { balance: undefined } // don't leak recipient's balance back to sender; wires have no internal recipient
        : { accountType: toAccountType, balance: updatedTo[0].balance },
    });
  } catch (err) {
    console.error('Transfer error:', err);
    return res.status(500).json({ error: 'Something went wrong processing the transfer. Please try again.' });
  }
};
