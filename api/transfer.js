const { neon } = require('@neondatabase/serverless');
const { getQuery } = require('../lib/query');
const { getUserFromRequest } = require('../lib/auth');
const { sendEmail, moneySentEmailHtml, moneyReceivedEmailHtml } = require('../lib/email');
const { flagLargeTransfer } = require('../lib/fraud');
const { requireStepUp } = require('../lib/stepUp');

const sql = neon(process.env.DATABASE_URL || process.env.POSTGRES_URL);
const { withPush } = require('../lib/push');

async function ensureMoneyRequestsTable() {
  await sql`
    CREATE TABLE IF NOT EXISTS money_requests (
      id SERIAL PRIMARY KEY,
      requester_user_id INTEGER NOT NULL REFERENCES users(id),
      payer_user_id INTEGER NOT NULL REFERENCES users(id),
      amount NUMERIC(14,2) NOT NULL,
      note TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      responded_at TIMESTAMPTZ
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS money_requests_payer_idx ON money_requests (payer_user_id, status)`;
  await sql`CREATE INDEX IF NOT EXISTS money_requests_requester_idx ON money_requests (requester_user_id, status)`;
}

const DAILY_P2P_LIMIT = 10000;
const MAX_WIRE_AMOUNT = 25000;
const SPENDABLE_ACCOUNT_TYPES = ['checking', 'savings'];

// ---------------------------------------------------------------------------
// Atomic money movement
//
// Every money movement below runs as ONE SQL statement. Postgres treats a
// single statement as all-or-nothing, so the debit, the credit, and both
// ledger rows either all happen or none of them do.
//
// Each statement ends with a guard like `1 / COUNT(*)`. If any step matched
// zero rows (not enough balance, request already paid, account missing),
// the guard divides by zero, Postgres raises an error, and the whole
// statement rolls back. isGuardFailure() recognises that case.
// ---------------------------------------------------------------------------
function isGuardFailure(err) {
  if (!err) return false;
  // 22012 = division_by_zero (our guard), 23502 = not_null_violation
  // (a ledger insert whose account step matched nothing).
  return err.code === '22012' || err.code === '23502' || /division by zero/i.test(String(err.message || ''));
}

// Debit one Apex account and credit another, with both ledger rows.
async function atomicTransfer({ fromAccountId, toAccountId, amount, outType, outDescription, inType, inDescription }) {
  const rows = await sql`
    WITH debit AS (
      UPDATE accounts SET balance = balance - ${amount}
      WHERE id = ${fromAccountId} AND balance >= ${amount}
      RETURNING id, balance
    ),
    credit AS (
      UPDATE accounts SET balance = balance + ${amount}
      WHERE id = ${toAccountId} AND EXISTS (SELECT 1 FROM debit)
      RETURNING id, balance
    ),
    out_txn AS (
      INSERT INTO transactions (account_id, type, amount, description, created_at)
      VALUES ((SELECT id FROM debit), ${outType}, ${amount}, ${outDescription}, NOW())
      RETURNING id, created_at
    ),
    in_txn AS (
      INSERT INTO transactions (account_id, type, amount, description, created_at)
      VALUES ((SELECT id FROM credit), ${inType}, ${amount}, ${inDescription}, NOW())
      RETURNING id
    )
    SELECT
      (SELECT balance FROM debit) AS from_balance,
      (SELECT balance FROM credit) AS to_balance,
      (SELECT id FROM out_txn) AS transaction_id,
      (SELECT created_at FROM out_txn) AS transaction_timestamp,
      (SELECT COUNT(*) FROM in_txn) AS in_rows,
      1 / ((SELECT COUNT(*) FROM debit) * (SELECT COUNT(*) FROM credit)) AS guard
  `;
  return rows[0];
}

// Debit one Apex account (money leaving the bank, e.g. a wire).
async function atomicDebit({ accountId, amount, type, description }) {
  const rows = await sql`
    WITH debit AS (
      UPDATE accounts SET balance = balance - ${amount}
      WHERE id = ${accountId} AND balance >= ${amount}
      RETURNING id, balance
    ),
    txn AS (
      INSERT INTO transactions (account_id, type, amount, description, created_at)
      VALUES ((SELECT id FROM debit), ${type}, ${amount}, ${description}, NOW())
      RETURNING id, created_at
    )
    SELECT
      (SELECT balance FROM debit) AS from_balance,
      (SELECT id FROM txn) AS transaction_id,
      (SELECT created_at FROM txn) AS transaction_timestamp,
      1 / (SELECT COUNT(*) FROM debit) AS guard
  `;
  return rows[0];
}

// Demo account (set via the DEMO_EMAIL env var) can't send money to or
// request money from real users.
async function isDemoUser(userId) {
  const demoEmail = String(process.env.DEMO_EMAIL || '').trim().toLowerCase();
  if (!demoEmail) return false;
  const rows = await sql`SELECT email FROM users WHERE id = ${userId} LIMIT 1`;
  return rows.length > 0 && String(rows[0].email || '').trim().toLowerCase() === demoEmail;
}

const DEMO_BLOCKED_MESSAGE = 'Sending or requesting money from other people is turned off on the demo account. Try a transfer between your own accounts instead.';

module.exports = withPush(async function handler(req, res) {
  const query = getQuery(req);
  if (req.method === 'GET') {
    try {
      const session = await getUserFromRequest(req);
      if (!session) return res.status(401).json({ error: 'Not authenticated' });

      if (query && (query.moneyRequests === '1' || query.moneyRequests === 'true')) {
        await ensureMoneyRequestsTable();
        const rows = await sql`
          SELECT mr.id, mr.amount, mr.note, mr.status, mr.created_at, mr.responded_at,
            mr.requester_user_id, mr.payer_user_id,
            req_u.full_name AS requester_name, req_u.email AS requester_email,
            pay_u.full_name AS payer_name, pay_u.email AS payer_email
          FROM money_requests mr
          JOIN users req_u ON req_u.id = mr.requester_user_id
          JOIN users pay_u ON pay_u.id = mr.payer_user_id
          WHERE mr.requester_user_id = ${session.userId} OR mr.payer_user_id = ${session.userId}
          ORDER BY mr.created_at DESC LIMIT 50`;
        return res.status(200).json({
          incoming: rows.filter((r) => r.payer_user_id === session.userId),
          outgoing: rows.filter((r) => r.requester_user_id === session.userId),
        });
      }

      const lookupIdentifier = (query && query.lookupIdentifier || '').trim();
      if (!lookupIdentifier) return res.status(400).json({ error: 'lookupIdentifier is required.' });
      const isEmail = lookupIdentifier.includes('@');
      const isAccountNumber = /^\d{10}$/.test(lookupIdentifier);
      if (!isEmail && !isAccountNumber) return res.status(400).json({ error: 'Enter a valid email address or 10-digit account number.' });

      let rows;
      if (isEmail) {
        const lookupEmail = lookupIdentifier.toLowerCase();
        rows = await sql`
          SELECT u.id, u.full_name, u.email, a.account_number FROM accounts a
          JOIN users u ON u.id = a.user_id
          WHERE LOWER(u.email) = ${lookupEmail} AND a.account_type = 'checking' LIMIT 1`;
      } else {
        rows = await sql`
          SELECT u.id, u.full_name, u.email, a.account_number FROM accounts a
          JOIN users u ON u.id = a.user_id
          WHERE a.account_number = ${lookupIdentifier} AND a.account_type = 'checking' LIMIT 1`;
      }
      if (rows.length === 0) return res.status(404).json({ error: 'No Apex Horizon account found for that email or account number.' });
      const recipient = rows[0];
      if (recipient.id === session.userId) return res.status(400).json({ error: "You can't send money to yourself." });
      const nameParts = (recipient.full_name || '').trim().split(/\s+/);
      const firstName = nameParts[0] || 'Apex';
      const lastInitial = nameParts.length > 1 ? nameParts[nameParts.length - 1][0] : '';
      return res.status(200).json({ found: true, displayName: lastInitial ? `${firstName} ${lastInitial}.` : firstName });
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
    const session = await getUserFromRequest(req);
    if (!session) return res.status(401).json({ error: 'Not authenticated' });

    const body = req.body || {};
    const { action } = body;

    if (action === 'create_money_request') {
      if (await isDemoUser(session.userId)) return res.status(403).json({ error: DEMO_BLOCKED_MESSAGE, demoAccount: true });
      await ensureMoneyRequestsTable();
      const { recipientIdentifier, amount, note } = body;
      const requestAmount = Number(amount);
      if (!recipientIdentifier || !Number.isFinite(requestAmount) || requestAmount <= 0) {
        return res.status(400).json({ error: 'Recipient and a valid amount are required.' });
      }
      if (requestAmount > 10000) return res.status(400).json({ error: 'Money requests are limited to $10,000.' });
      const cleanIdentifier = String(recipientIdentifier).trim();
      const isEmail = cleanIdentifier.includes('@');
      const isAccountNumber = /^\d{10}$/.test(cleanIdentifier);
      if (!isEmail && !isAccountNumber) return res.status(400).json({ error: 'Enter a valid email address or 10-digit account number.' });
      let payeeRows;
      if (isEmail) {
        const lookupEmail = cleanIdentifier.toLowerCase();
        payeeRows = await sql`SELECT u.id, u.full_name, u.email FROM users u WHERE LOWER(u.email) = ${lookupEmail} LIMIT 1`;
      } else {
        payeeRows = await sql`
          SELECT u.id, u.full_name, u.email FROM accounts a JOIN users u ON u.id = a.user_id
          WHERE a.account_number = ${cleanIdentifier} AND a.account_type = 'checking' LIMIT 1`;
      }
      if (payeeRows.length === 0) return res.status(404).json({ error: 'No Apex Horizon account found for that email or account number.' });
      const payer = payeeRows[0];
      if (payer.id === session.userId) return res.status(400).json({ error: "You can't request money from yourself." });
      const inserted = await sql`
        INSERT INTO money_requests (requester_user_id, payer_user_id, amount, note, status, created_at)
        VALUES (${session.userId}, ${payer.id}, ${requestAmount}, ${note || null}, 'pending', NOW())
        RETURNING id, amount, note, status, created_at`;
      const requesterRows = await sql`SELECT full_name FROM users WHERE id = ${session.userId} LIMIT 1`;
      const requesterName = requesterRows[0]?.full_name || 'An Apex user';
      const amountFormatted = requestAmount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      try {
        await sql`
          INSERT INTO notifications (user_id, title, message, is_read, created_at)
          VALUES (${payer.id}, 'Money Request',
            ${requesterName + ' requested $' + amountFormatted + (note ? (' — ' + note) : '') + '. Open Transfers to pay or decline.'},
            FALSE, NOW())`;
      } catch (e) { console.error('Money request notification error (non-fatal):', e); }
      return res.status(200).json({ success: true, request: inserted[0], payerName: payer.full_name });
    }

    if (action === 'respond_money_request') {
      await ensureMoneyRequestsTable();
      const { requestId, decision } = body;
      if (!requestId || !['accept', 'decline'].includes(decision)) {
        return res.status(400).json({ error: 'requestId and decision (accept|decline) are required.' });
      }
      const reqRows = await sql`SELECT * FROM money_requests WHERE id = ${Number(requestId)} LIMIT 1`;
      if (reqRows.length === 0) return res.status(404).json({ error: 'Money request not found.' });
      const moneyReq = reqRows[0];
      if (moneyReq.payer_user_id !== session.userId) return res.status(403).json({ error: 'Only the person who was asked can respond.' });
      if (moneyReq.status !== 'pending') return res.status(400).json({ error: 'This request was already ' + moneyReq.status + '.' });

      if (decision === 'decline') {
        const declined = await sql`UPDATE money_requests SET status = 'declined', responded_at = NOW() WHERE id = ${moneyReq.id} AND status = 'pending' RETURNING id`;
        if (declined.length === 0) return res.status(409).json({ error: 'This request was already handled.' });
        try {
          await sql`INSERT INTO notifications (user_id, title, message, is_read, created_at)
            VALUES (${moneyReq.requester_user_id}, 'Request Declined', 'Your money request was declined.', FALSE, NOW())`;
        } catch (e) {}
        return res.status(200).json({ success: true, status: 'declined' });
      }

      if (await isDemoUser(session.userId)) return res.status(403).json({ error: DEMO_BLOCKED_MESSAGE, demoAccount: true });

      const amount = Number(moneyReq.amount);
      const fromRows = await sql`SELECT id, balance, restriction_level FROM accounts WHERE user_id = ${session.userId} AND account_type = 'checking' LIMIT 1`;
      if (fromRows.length === 0) return res.status(404).json({ error: 'Your checking account was not found.' });
      const fromAccount = fromRows[0];
      if (fromAccount.restriction_level && fromAccount.restriction_level !== 'none') {
        return res.status(403).json({ error: 'There is an issue on this account that blocks transfers.' });
      }
      if (Number(fromAccount.balance) < amount) return res.status(400).json({ error: 'Insufficient funds to pay this request.' });
      // Large payments need Face ID / passcode confirmation.
      if (!(await requireStepUp(sql, { req, res, session, amount }))) return;
      const toRows = await sql`SELECT id, balance FROM accounts WHERE user_id = ${moneyReq.requester_user_id} AND account_type = 'checking' LIMIT 1`;
      if (toRows.length === 0) return res.status(404).json({ error: 'Requester checking account not found.' });
      const toAccount = toRows[0];
      const payerUserRows = await sql`SELECT id, full_name, email FROM users WHERE id = ${session.userId} LIMIT 1`;
      const requesterUserRows = await sql`SELECT id, full_name, email FROM users WHERE id = ${moneyReq.requester_user_id} LIMIT 1`;
      const payerName = (payerUserRows[0] && payerUserRows[0].full_name) || 'Apex user';
      const requesterName = (requesterUserRows[0] && requesterUserRows[0].full_name) || 'Apex user';
      const note = moneyReq.note ? `Paid request: ${moneyReq.note}` : `Paid money request to ${requesterName.split(' ')[0]}`;
      const noteIn = moneyReq.note ? `Request paid by ${payerName.split(' ')[0]}: ${moneyReq.note}` : `Money request paid by ${payerName.split(' ')[0]}`;

      // Mark the request paid AND move the money in one statement, so a
      // double-tap can never pay the same request twice.
      let paidRows;
      try {
        paidRows = await sql`
          WITH claim AS (
            UPDATE money_requests SET status = 'paid', responded_at = NOW()
            WHERE id = ${moneyReq.id} AND status = 'pending' AND payer_user_id = ${session.userId}
            RETURNING id
          ),
          debit AS (
            UPDATE accounts SET balance = balance - ${amount}
            WHERE id = ${fromAccount.id} AND balance >= ${amount} AND EXISTS (SELECT 1 FROM claim)
            RETURNING id, balance
          ),
          credit AS (
            UPDATE accounts SET balance = balance + ${amount}
            WHERE id = ${toAccount.id} AND EXISTS (SELECT 1 FROM debit)
            RETURNING id, balance
          ),
          out_txn AS (
            INSERT INTO transactions (account_id, type, amount, description, created_at)
            VALUES ((SELECT id FROM debit), 'p2p_out', ${amount}, ${note}, NOW())
            RETURNING id, created_at
          ),
          in_txn AS (
            INSERT INTO transactions (account_id, type, amount, description, created_at)
            VALUES ((SELECT id FROM credit), 'p2p_in', ${amount}, ${noteIn}, NOW())
            RETURNING id
          )
          SELECT
            (SELECT id FROM out_txn) AS transaction_id,
            (SELECT COUNT(*) FROM in_txn) AS in_rows,
            1 / ((SELECT COUNT(*) FROM claim) * (SELECT COUNT(*) FROM debit) * (SELECT COUNT(*) FROM credit)) AS guard
        `;
      } catch (moveErr) {
        if (isGuardFailure(moveErr)) {
          console.error('Money request payment guard tripped:', moveErr.message);
          return res.status(409).json({ error: 'This request was already handled or your balance changed. Nothing was sent.' });
        }
        throw moveErr;
      }

      const amountFormatted = amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      try {
        await sql`INSERT INTO notifications (user_id, title, message, is_read, created_at)
          VALUES (${moneyReq.requester_user_id}, 'Request Paid', ${payerName + ' paid your $' + amountFormatted + ' request.'}, FALSE, NOW())`;
        await sql`INSERT INTO notifications (user_id, title, message, is_read, created_at)
          VALUES (${session.userId}, 'Payment Sent', ${'You paid $' + amountFormatted + ' to ' + requesterName + '.'}, FALSE, NOW())`;
      } catch (e) {}
      return res.status(200).json({ success: true, status: 'paid', transactionId: paidRows[0].transaction_id, amount });
    }

    const { fromAccountType, toAccountType, recipientIdentifier, routingNumber, beneficiaryNumber, targetBank, amount, description } = body;
    if (!fromAccountType || !amount) return res.status(400).json({ error: 'From account and amount are required.' });
    if (!SPENDABLE_ACCOUNT_TYPES.includes(fromAccountType)) return res.status(400).json({ error: 'Transfers can only be sent from checking or savings.' });
    const transferAmount = Number(amount);
    if (!Number.isFinite(transferAmount) || transferAmount <= 0) return res.status(400).json({ error: 'Enter a valid transfer amount greater than zero.' });
    const isP2P = !!recipientIdentifier;
    const isWire = !!routingNumber;
    if (isP2P && isWire) return res.status(400).json({ error: 'Choose either a wire or a P2P transfer, not both.' });
    if (isP2P && await isDemoUser(session.userId)) return res.status(403).json({ error: DEMO_BLOCKED_MESSAGE, demoAccount: true });
    if (isWire) {
      const cleanRouting = String(routingNumber).trim();
      if (!/^\d{9}$/.test(cleanRouting)) return res.status(400).json({ error: 'Routing number must be exactly 9 digits.' });
      if (!beneficiaryNumber || !String(beneficiaryNumber).trim()) return res.status(400).json({ error: 'Beneficiary account number is required.' });
      if (transferAmount > MAX_WIRE_AMOUNT) return res.status(400).json({ error: `Online wires are limited to $${MAX_WIRE_AMOUNT.toLocaleString()} per transaction. For larger amounts, contact support.` });
    }
    if (!isP2P && !isWire && !toAccountType) return res.status(400).json({ error: 'To account is required for internal transfers.' });
    if (!isP2P && !isWire && !SPENDABLE_ACCOUNT_TYPES.includes(toAccountType)) return res.status(400).json({ error: 'Internal transfers can only go between checking and savings. To pay your card, use Cards → Make a Payment.' });
    if (!isP2P && !isWire && fromAccountType === toAccountType) return res.status(400).json({ error: 'Choose two different accounts to transfer between.' });

    const fromRows = await sql`SELECT id, balance, restriction_level FROM accounts WHERE user_id = ${session.userId} AND account_type = ${fromAccountType} LIMIT 1`;
    if (fromRows.length === 0) return res.status(404).json({ error: 'Your source account could not be found.' });
    const fromAccount = fromRows[0];
    if (fromAccount.restriction_level && fromAccount.restriction_level !== 'none') {
      return res.status(403).json({ error: 'There is an issue on this account that requires in-person verification at a branch. Please visit any of our branches with a valid ID to resolve this issue.', accountRestricted: true, restrictionLevel: fromAccount.restriction_level });
    }

    let toAccount, recipientUserId = null, recipientInfo = null, note, noteIncoming, senderFullName, senderEmailForNotify;

    if (isP2P) {
      const cleanIdentifier = String(recipientIdentifier).trim();
      const isEmail = cleanIdentifier.includes('@');
      const isAccountNumber = /^\d{10}$/.test(cleanIdentifier);
      if (!isEmail && !isAccountNumber) return res.status(400).json({ error: 'Enter a valid recipient email or 10-digit account number.' });
      let recipientRows;
      if (isEmail) {
        const cleanEmail = cleanIdentifier.toLowerCase();
        recipientRows = await sql`SELECT u.id, u.full_name, u.email, a.id AS account_id, a.account_number, a.balance FROM accounts a JOIN users u ON u.id = a.user_id WHERE LOWER(u.email) = ${cleanEmail} AND a.account_type = 'checking' LIMIT 1`;
      } else {
        recipientRows = await sql`SELECT u.id, u.full_name, u.email, a.id AS account_id, a.account_number, a.balance FROM accounts a JOIN users u ON u.id = a.user_id WHERE a.account_number = ${cleanIdentifier} AND a.account_type = 'checking' LIMIT 1`;
      }
      if (recipientRows.length === 0) return res.status(404).json({ error: 'No Apex Horizon account found for that email or account number.' });
      const recipient = recipientRows[0];
      if (recipient.id === session.userId) return res.status(400).json({ error: "You can't send money to yourself." });
      recipientUserId = recipient.id; recipientInfo = recipient;
      toAccount = { id: recipient.account_id, balance: recipient.balance };
      const sentTodayRows = await sql`SELECT COALESCE(SUM(amount), 0) AS total FROM transactions WHERE account_id = ${fromAccount.id} AND type = 'p2p_out' AND created_at >= date_trunc('day', NOW())`;
      const sentToday = Number(sentTodayRows[0].total);
      if (sentToday + transferAmount > DAILY_P2P_LIMIT) return res.status(400).json({ error: `This would exceed your daily P2P sending limit of $${DAILY_P2P_LIMIT.toLocaleString()}. You've sent $${sentToday.toLocaleString()} today.` });
      const nameParts = (recipient.full_name || '').trim().split(/\s+/);
      const firstName = nameParts[0] || 'Apex user';
      const senderRowsForNote = await sql`SELECT full_name, email FROM users WHERE id = ${session.userId} LIMIT 1`;
      senderFullName = senderRowsForNote[0]?.full_name || 'an Apex Horizon user';
      senderEmailForNotify = senderRowsForNote[0]?.email;
      const senderNameParts = senderFullName.trim().split(/\s+/);
      const senderFirstName = senderNameParts[0] || 'Apex';
      const senderLastInitial = senderNameParts.length > 1 ? senderNameParts[senderNameParts.length - 1][0] + '.' : '';
      const senderDisplayName = senderLastInitial ? `${senderFirstName} ${senderLastInitial}` : senderFirstName;
      note = description ? `${description} — to ${firstName}` : `P2P transfer to ${firstName}`;
      noteIncoming = description ? `${description} — from ${senderDisplayName}` : `P2P transfer from ${senderDisplayName}`;
    } else if (isWire) {
      const bankLabel = (targetBank && String(targetBank).trim()) || 'External Bank';
      note = description || `Outbound Wire | ${bankLabel}`;
    } else {
      const toRows = await sql`SELECT id, balance FROM accounts WHERE user_id = ${session.userId} AND account_type = ${toAccountType} LIMIT 1`;
      if (toRows.length === 0) return res.status(404).json({ error: 'One of the selected accounts could not be found.' });
      toAccount = toRows[0];
      note = description || `Transfer to ${toAccountType}`;
      noteIncoming = description || `Transfer from ${fromAccountType}`;
    }

    if (Number(fromAccount.balance) < transferAmount) return res.status(400).json({ error: 'Insufficient funds in the source account.' });

    // Money leaving your own accounts (P2P or wire) at or above the confirmation
    // threshold needs Face ID / passcode. Moving between your own accounts doesn't.
    if ((isP2P || isWire) && !(await requireStepUp(sql, { req, res, session, amount: transferAmount }))) return;

    const outType = isWire ? 'wire_out' : (isP2P ? 'p2p_out' : 'transfer_out');
    let moved;
    try {
      if (isWire) {
        moved = await atomicDebit({ accountId: fromAccount.id, amount: transferAmount, type: outType, description: note });
      } else {
        const inType = isP2P ? 'p2p_in' : 'transfer_in';
        moved = await atomicTransfer({
          fromAccountId: fromAccount.id,
          toAccountId: toAccount.id,
          amount: transferAmount,
          outType,
          outDescription: note,
          inType,
          inDescription: noteIncoming,
        });
      }
    } catch (moveErr) {
      if (isGuardFailure(moveErr)) {
        console.error('Transfer guard tripped:', moveErr.message);
        return res.status(409).json({ error: 'Your balance changed before the transfer completed. Nothing was sent. Please try again.' });
      }
      throw moveErr;
    }

    const outboundTransactionId = moved.transaction_id;
    await flagLargeTransfer({ userId: session.userId, amount: transferAmount, transactionId: outboundTransactionId, transferType: isWire ? 'wire' : (isP2P ? 'P2P' : 'internal') });

    if (isWire) {
      try {
        const amountFormatted = transferAmount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        const bankLabel = (targetBank && String(targetBank).trim()) || 'External Bank';
        await sql`INSERT INTO notifications (user_id, title, message, is_read, created_at) VALUES (${session.userId}, 'Wire Sent', ${'You sent a $' + amountFormatted + ' wire to ' + bankLabel + '.'}, FALSE, NOW())`;
      } catch (notifyErr) { console.error('Wire notification dispatch error (non-fatal):', notifyErr); }
    } else if (isP2P && recipientInfo) {
      try {
        const senderName = senderFullName;
        const senderEmail = senderEmailForNotify;
        const amountFormatted = transferAmount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        const nowStr = new Date().toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
        await sql`INSERT INTO notifications (user_id, title, message, is_read, created_at) VALUES (${session.userId}, 'Payment Sent', ${'You sent $' + amountFormatted + ' to ' + recipientInfo.full_name + '.'}, FALSE, NOW())`;
        await sql`INSERT INTO notifications (user_id, title, message, is_read, created_at) VALUES (${recipientInfo.id}, 'Payment Received', ${'You received $' + amountFormatted + ' from ' + senderName + '.'}, FALSE, NOW())`;
        // "Email receipts" in Settings > Notifications. The column only exists
        // once someone has opened those settings; until then everyone gets them.
        let emailOff = new Set();
        try {
          const offRows = await sql`SELECT id FROM users WHERE id IN (${session.userId}, ${recipientInfo.id}) AND notif_email = FALSE`;
          emailOff = new Set(offRows.map((r) => Number(r.id)));
        } catch (_) { /* no preference column yet */ }
        if (senderEmail && !emailOff.has(Number(session.userId))) await sendEmail({ to: senderEmail, subject: `You sent $${amountFormatted} - Apex Horizon Bank`, html: moneySentEmailHtml({ senderName, recipientName: recipientInfo.full_name, amount: amountFormatted, note: description, date: nowStr }) });
        if (recipientInfo.email && !emailOff.has(Number(recipientInfo.id))) await sendEmail({ to: recipientInfo.email, subject: `You received $${amountFormatted} - Apex Horizon Bank`, html: moneyReceivedEmailHtml({ recipientName: recipientInfo.full_name, senderName, amount: amountFormatted, note: description, date: nowStr }) });
      } catch (notifyErr) { console.error('Notification/email dispatch error (non-fatal):', notifyErr); }
    } else {
      try {
        const amountFormatted = transferAmount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        await sql`INSERT INTO notifications (user_id, title, message, is_read, created_at) VALUES (${session.userId}, 'Internal Transfer', ${'You moved $' + amountFormatted + ' from ' + fromAccountType + ' to ' + toAccountType + '.'}, FALSE, NOW())`;
      } catch (notifyErr) { console.error('Internal transfer notification dispatch error (non-fatal):', notifyErr); }
    }

    const maskedBeneficiary = isWire && beneficiaryNumber ? '••••' + String(beneficiaryNumber).trim().slice(-4) : undefined;
    return res.status(200).json({
      success: true, isP2P, isWire,
      transactionId: outboundTransactionId,
      transactionTimestamp: moved.transaction_timestamp,
      description: note,
      recipientDisplayName: isP2P && recipientInfo ? (() => { const parts = (recipientInfo.full_name || '').trim().split(/\s+/); const first = parts[0] || 'Apex user'; const lastInitial = parts.length > 1 ? parts[parts.length - 1][0] + '.' : ''; return lastInitial ? `${first} ${lastInitial}` : first; })() : undefined,
      wireBankName: isWire ? ((targetBank && String(targetBank).trim()) || 'External Bank') : undefined,
      wireMaskedBeneficiary: maskedBeneficiary,
      from: { accountType: fromAccountType, balance: moved.from_balance },
      to: (isP2P || isWire) ? { balance: undefined } : { accountType: toAccountType, balance: moved.to_balance },
    });
  } catch (err) {
    console.error('Transfer error:', err);
    return res.status(500).json({ error: 'Something went wrong processing the transfer. Please try again.' });
  }
}, sql);
