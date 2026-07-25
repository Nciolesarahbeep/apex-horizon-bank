const { neon } = require('@neondatabase/serverless');
const { getUserFromRequest } = require('../lib/auth');
const { sendEmail, moneySentEmailHtml, moneyReceivedEmailHtml } = require('../lib/email');

const sql = neon(process.env.DATABASE_URL || process.env.POSTGRES_URL);

// Real-bank-style daily P2P sending limit. Adjust as needed.
const DAILY_P2P_LIMIT = Infinity;

// Real-bank-style per-transaction wire limit for standard online banking
// (larger wires typically require phone/branch verification in real banks).
const MAX_WIRE_AMOUNT = 25000;

module.exports = async function handler(req, res) {
  // ===== Recipient lookup (for the "Send $50 to Sarah J.?" confirm step) =====
  // GET /api/transfer?lookupIdentifier=someone@example.com  OR  ?lookupIdentifier=1234567890
  if (req.method === 'GET') {
    try {
      const session = getUserFromRequest(req);
      if (!session) {
        return res.status(401).json({ error: 'Not authenticated' });
      }

      const lookupIdentifier = (req.query && req.query.lookupIdentifier || '').trim();
      if (!lookupIdentifier) {
        return res.status(400).json({ error: 'lookupIdentifier is required.' });
      }

      const isEmail = lookupIdentifier.includes('@');
      const isAccountNumber = /^\d{10}$/.test(lookupIdentifier);

      if (!isEmail && !isAccountNumber) {
        return res.status(400).json({ error: 'Enter a valid email address or 10-digit account number.' });
      }

      let rows;
      if (isEmail) {
        const lookupEmail = lookupIdentifier.toLowerCase();
        rows = await sql`
          SELECT u.id, u.full_name, u.email, a.account_number
          FROM accounts a
          JOIN users u ON u.id = a.user_id
          WHERE LOWER(u.email) = ${lookupEmail} AND a.account_type = 'checking'
          LIMIT 1
        `;
      } else {
        rows = await sql`
          SELECT u.id, u.full_name, u.email, a.account_number
          FROM accounts a
          JOIN users u ON u.id = a.user_id
          WHERE a.account_number = ${lookupIdentifier} AND a.account_type = 'checking'
          LIMIT 1
        `;
      }

      if (rows.length === 0) {
        return res.status(404).json({ error: 'No Apex Horizon account found for that email or account number.' });
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

    const { fromAccountType, toAccountType, recipientIdentifier, routingNumber, beneficiaryNumber, targetBank, amount, description } = req.body || {};

    if (!fromAccountType || !amount) {
      return res.status(400).json({ error: 'From account and amount are required.' });
    }

    const transferAmount = Number(amount);
    if (!Number.isFinite(transferAmount) || transferAmount <= 0) {
      return res.status(400).json({ error: 'Enter a valid transfer amount greater than zero.' });
    }

    const isP2P = !!recipientIdentifier;
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
    let recipientInfo = null;
    let note;
    let noteIncoming;

    if (isP2P) {
      const cleanIdentifier = String(recipientIdentifier).trim();
      const isEmail = cleanIdentifier.includes('@');
      const isAccountNumber = /^\d{10}$/.test(cleanIdentifier);

      if (!isEmail && !isAccountNumber) {
        return res.status(400).json({ error: 'Enter a valid recipient email or 10-digit account number.' });
      }

      let recipientRows;
      if (isEmail) {
        const cleanEmail = cleanIdentifier.toLowerCase();
        recipientRows = await sql`
          SELECT u.id, u.full_name, u.email, a.id AS account_id, a.account_number, a.balance
          FROM accounts a
          JOIN users u ON u.id = a.user_id
          WHERE LOWER(u.email) = ${cleanEmail} AND a.account_type = 'checking'
          LIMIT 1
        `;
      } else {
        recipientRows = await sql`
          SELECT u.id, u.full_name, u.email, a.id AS account_id, a.account_number, a.balance
          FROM accounts a
          JOIN users u ON u.id = a.user_id
          WHERE a.account_number = ${cleanIdentifier} AND a.account_type = 'checking'
          LIMIT 1
        `;
      }

      if (recipientRows.length === 0) {
        return res.status(404).json({ error: 'No Apex Horizon account found for that email or account number.' });
      }

      const recipient = recipientRows[0];

      if (recipient.id === session.userId) {
        return res.status(400).json({ error: "You can't send money to yourself." });
      }

      recipientUserId = recipient.id;
      recipientInfo = recipient;

      // P2P always lands in the recipient's checking account — already resolved above.
      toAccount = { id: recipient.account_id, balance: recipient.balance };

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

      // Fetch the sender's own name now so it can be embedded directly into
      // the recipient's transaction description — not just a notification —
      // so the recipient sees who paid them everywhere: transaction list,
      // receipt, and notification, not just one of those places.
      const senderRowsForNote = await sql`SELECT full_name, email FROM users WHERE id = ${session.userId} LIMIT 1`;
      const senderFullName = senderRowsForNote[0]?.full_name || 'an Apex Horizon user';
      const senderEmailForNotify = senderRowsForNote[0]?.email;
      const senderNameParts = senderFullName.trim().split(/\s+/);
      const senderFirstName = senderNameParts[0] || 'Apex';
      const senderLastInitial = senderNameParts.length > 1 ? senderNameParts[senderNameParts.length - 1][0] + '.' : '';
      const senderDisplayName = senderLastInitial ? `${senderFirstName} ${senderLastInitial}` : senderFirstName;

      note = description ? `${description} — to ${firstName}` : `P2P transfer to ${firstName}`;
      noteIncoming = description ? `${description} — from ${senderDisplayName}` : `P2P transfer from ${senderDisplayName}`;
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

    const outboundTxnRows = await sql`
      INSERT INTO transactions (account_id, type, amount, description, created_at)
      VALUES (${fromAccount.id}, ${outType}, ${transferAmount}, ${note}, NOW())
      RETURNING id, created_at
    `;
    const outboundTransactionId = outboundTxnRows[0].id;

    let updatedTo = null;
    let inboundTransactionId = null;

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

      const inboundTxnRows = await sql`
        INSERT INTO transactions (account_id, type, amount, description, created_at)
        VALUES (${toAccount.id}, ${inType}, ${transferAmount}, ${noteIncoming}, NOW())
        RETURNING id
      `;
      inboundTransactionId = inboundTxnRows[0].id;
    }

    // ---------- Notifications + Email (best-effort, never fails the transfer) ----------
    // NOTE: is_read and created_at are set explicitly on every insert below so
    // this can't silently fail if the notifications table lacks defaults for them.
    if (isWire) {
      try {
        const amountFormatted = transferAmount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        const bankLabel = (targetBank && String(targetBank).trim()) || 'External Bank';

        await sql`
          INSERT INTO notifications (user_id, title, message, is_read, created_at)
          VALUES (${session.userId}, 'Wire Sent', ${'You sent a $' + amountFormatted + ' wire to ' + bankLabel + '.'}, FALSE, NOW())
        `;
      } catch (notifyErr) {
        console.error('Wire notification dispatch error (non-fatal):', notifyErr);
      }
    } else if (isP2P && recipientInfo) {
      try {
        const senderName = senderFullName;
        const senderEmail = senderEmailForNotify;
        const amountFormatted = transferAmount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        const nowStr = new Date().toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });

        await sql`
          INSERT INTO notifications (user_id, title, message, is_read, created_at)
          VALUES (${session.userId}, 'Payment Sent', ${'You sent $' + amountFormatted + ' to ' + recipientInfo.full_name + '.'}, FALSE, NOW())
        `;
        await sql`
          INSERT INTO notifications (user_id, title, message, is_read, created_at)
          VALUES (${recipientInfo.id}, 'Payment Received', ${'You received $' + amountFormatted + ' from ' + senderName + '.'}, FALSE, NOW())
        `;

        if (senderEmail) {
          await sendEmail({
            to: senderEmail,
            subject: `You sent $${amountFormatted} - Apex Horizon Bank`,
            html: moneySentEmailHtml({ senderName, recipientName: recipientInfo.full_name, amount: amountFormatted, note: description, date: nowStr }),
          });
        }
        if (recipientInfo.email) {
          await sendEmail({
            to: recipientInfo.email,
            subject: `You received $${amountFormatted} - Apex Horizon Bank`,
            html: moneyReceivedEmailHtml({ recipientName: recipientInfo.full_name, senderName, amount: amountFormatted, note: description, date: nowStr }),
          });
        }
      } catch (notifyErr) {
        console.error('Notification/email dispatch error (non-fatal):', notifyErr);
      }
    } else {
      // Internal transfer between the user's own accounts (e.g. checking <-> savings).
      // This branch previously had no notification at all.
      try {
        const amountFormatted = transferAmount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

        await sql`
          INSERT INTO notifications (user_id, title, message, is_read, created_at)
          VALUES (${session.userId}, 'Internal Transfer', ${'You moved $' + amountFormatted + ' from ' + fromAccountType + ' to ' + toAccountType + '.'}, FALSE, NOW())
        `;
      } catch (notifyErr) {
        console.error('Internal transfer notification dispatch error (non-fatal):', notifyErr);
      }
    }

    // Masked beneficiary account for wire receipts — same last-4 convention
    // used elsewhere in the app (never show a full account number back).
    const maskedBeneficiary = isWire && beneficiaryNumber
      ? '••••' + String(beneficiaryNumber).trim().slice(-4)
      : undefined;

    return res.status(200).json({
      success: true,
      isP2P,
      isWire,
      transactionId: outboundTransactionId,
      transactionTimestamp: outboundTxnRows[0].created_at,
      description: note,
      recipientDisplayName: isP2P && recipientInfo
        ? (() => {
            const parts = (recipientInfo.full_name || '').trim().split(/\s+/);
            const first = parts[0] || 'Apex user';
            const lastInitial = parts.length > 1 ? parts[parts.length - 1][0] + '.' : '';
            return lastInitial ? `${first} ${lastInitial}` : first;
          })()
        : undefined,
      wireBankName: isWire ? ((targetBank && String(targetBank).trim()) || 'External Bank') : undefined,
      wireMaskedBeneficiary: maskedBeneficiary,
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
