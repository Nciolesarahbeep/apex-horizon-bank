// Linked accounts: move money between Apex checking and accounts you have
// elsewhere — Cash App, Venmo, PayPal, Zelle, or a bank account at another
// bank.
//
// Linking saves the account as somewhere you can send money to and add money
// from. Each type is checked the way that service writes it ($cashtag,
// @username, email, US mobile number, or a routing number that passes the
// ABA checksum). Money moves in single statements that update the balance,
// write the ledger row and log the transfer together, so nothing is ever
// half done.
//
// Daily limits (UTC day): add up to $2,500 and send up to $5,000 a day
// across all linked accounts. The running totals live in linked_daily and are
// claimed with a conditional UPDATE inside the same statement that moves the
// money, so two taps at once can't go over.
//
// Ledger rows: money out is a 'debit' and money in is 'ach_in' (these
// services pay out to banks over ACH). Both descriptions start with
// "External transfer", which Budgets and Insights already leave out of
// spending — moving your own money isn't spending.

const PROVIDERS = {
  cashapp: { label: 'Cash App', kind: 'app', icon: 'fa-dollar-sign', speed: 'Usually arrives in minutes' },
  venmo: { label: 'Venmo', kind: 'app', icon: 'fa-v', speed: 'Usually arrives in minutes' },
  paypal: { label: 'PayPal', kind: 'app', icon: 'fa-p', speed: 'Usually arrives in minutes' },
  zelle: { label: 'Zelle', kind: 'app', icon: 'fa-bolt', speed: 'Usually arrives in minutes' },
  bank: { label: 'Bank account', kind: 'bank', icon: 'fa-building-columns', speed: 'Arrives in 1-3 business days' },
};
const MAX_LINKED = 8;
const DAILY_IN_LIMIT = 2500;
const DAILY_OUT_LIMIT = 5000;
const MIN_TRANSFER = 1;

class LinkError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.name = 'LinkError';
    this.status = status;
    if (extra) Object.assign(this, extra);
  }
}

function isGuard(err) {
  return !!err && (err.code === '22012' || err.code === '23502' || /division by zero/i.test(String(err.message || '')));
}

const cents = (v) => Math.round(Number(v || 0) * 100);
const dollars = (c) => Math.round(c) / 100;
const money = (n) => '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const utcDay = (nowMs = Date.now()) => new Date(nowMs).toISOString().slice(0, 10);

let schemaReady = false;
async function ensureLinkedSchema(sql) {
  if (schemaReady) return;
  await sql`
    CREATE TABLE IF NOT EXISTS external_accounts (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      bank_name TEXT NOT NULL,
      account_holder_name TEXT NOT NULL,
      account_type TEXT NOT NULL DEFAULT 'checking',
      routing_number TEXT,
      account_number TEXT,
      status TEXT NOT NULL DEFAULT 'verified',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      verified_at TIMESTAMPTZ
    )
  `;
  await sql`ALTER TABLE external_accounts ALTER COLUMN routing_number DROP NOT NULL`;
  await sql`ALTER TABLE external_accounts ALTER COLUMN account_number DROP NOT NULL`;
  await sql`ALTER TABLE external_accounts ADD COLUMN IF NOT EXISTS provider TEXT NOT NULL DEFAULT 'bank'`;
  await sql`ALTER TABLE external_accounts ADD COLUMN IF NOT EXISTS handle TEXT`;
  await sql`ALTER TABLE external_accounts ADD COLUMN IF NOT EXISTS last_used_at TIMESTAMPTZ`;
  await sql`
    CREATE TABLE IF NOT EXISTS linked_transfers (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      external_account_id INTEGER NOT NULL,
      direction TEXT NOT NULL CHECK (direction IN ('in', 'out')),
      amount NUMERIC(14,2) NOT NULL CHECK (amount > 0),
      transaction_id INTEGER,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS linked_daily (
      user_id INTEGER NOT NULL,
      day DATE NOT NULL,
      amount_in NUMERIC(14,2) NOT NULL DEFAULT 0,
      amount_out NUMERIC(14,2) NOT NULL DEFAULT 0,
      PRIMARY KEY (user_id, day)
    )
  `;
  schemaReady = true;
}

// ---------------------------------------------------------------------------
// Checking what people type
// ---------------------------------------------------------------------------

function abaValid(routing) {
  if (!/^\d{9}$/.test(routing)) return false;
  const d = routing.split('').map(Number);
  const sum = 3 * (d[0] + d[3] + d[6]) + 7 * (d[1] + d[4] + d[7]) + (d[2] + d[5] + d[8]);
  return sum % 10 === 0 && routing !== '000000000';
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function normalizePhone(raw) {
  let digits = String(raw || '').replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) digits = digits.slice(1);
  if (!/^[2-9]\d{2}[2-9]\d{6}$/.test(digits)) return null;
  return digits;
}

// Returns the handle as we store it, or throws a LinkError explaining the format.
function normalizeHandle(provider, raw) {
  const value = String(raw || '').trim();
  if (!value) throw new LinkError(400, provider === 'zelle' ? 'Enter the email or US mobile number you use with Zelle.' : provider === 'paypal' ? 'Enter the email on your PayPal account.' : `Enter your ${PROVIDERS[provider].label} ${provider === 'cashapp' ? '$Cashtag' : 'username'}.`);
  if (provider === 'cashapp') {
    const tag = value.replace(/^\$+/, '');
    if (!/^[A-Za-z0-9_-]{1,20}$/.test(tag) || !/[A-Za-z]/.test(tag)) throw new LinkError(400, 'A $Cashtag is up to 20 letters, numbers, dashes or underscores, with at least one letter.');
    return '$' + tag;
  }
  if (provider === 'venmo') {
    const name = value.replace(/^@+/, '');
    if (!/^[A-Za-z0-9_-]{5,30}$/.test(name)) throw new LinkError(400, 'A Venmo username is 5-30 letters, numbers, dashes or underscores.');
    return '@' + name;
  }
  if (provider === 'paypal') {
    if (!EMAIL_RE.test(value) || value.length > 254) throw new LinkError(400, 'Enter a valid email address.');
    return value.toLowerCase();
  }
  if (provider === 'zelle') {
    if (value.includes('@')) {
      if (!EMAIL_RE.test(value) || value.length > 254) throw new LinkError(400, 'Enter a valid email address or US mobile number.');
      return value.toLowerCase();
    }
    const phone = normalizePhone(value);
    if (!phone) throw new LinkError(400, 'Enter a valid email address or 10-digit US mobile number.');
    return phone;
  }
  throw new LinkError(400, 'Choose what to link.');
}

function maskEmail(email) {
  const [user, domain] = String(email).split('@');
  if (!domain) return email;
  const shown = user.length <= 2 ? user.slice(0, 1) : user.slice(0, 2);
  return `${shown}${'•'.repeat(Math.max(1, Math.min(4, user.length - shown.length)))}@${domain}`;
}

function displayHandle(row) {
  const provider = row.provider || 'bank';
  if (provider === 'bank') return `${row.account_type === 'savings' ? 'Savings' : 'Checking'} •••• ${String(row.account_number || '').slice(-4)}`;
  const h = String(row.handle || '');
  if (provider === 'cashapp' || provider === 'venmo') return h;
  if (h.includes('@')) return maskEmail(h);
  return `(•••) •••-${h.slice(-4)}`;
}

function publicAccount(row) {
  const provider = PROVIDERS[row.provider] ? row.provider : 'bank';
  const p = PROVIDERS[provider];
  return {
    id: Number(row.id),
    provider,
    kind: p.kind,
    name: provider === 'bank' ? row.bank_name : p.label,
    display: displayHandle(row),
    holderName: row.account_holder_name,
    icon: p.icon,
    speed: p.speed,
    linkedAt: row.created_at,
    lastUsedAt: row.last_used_at || null,
    // Kept for the older response shape.
    bankName: row.bank_name,
    accountHolderName: row.account_holder_name,
    accountType: row.account_type,
    maskedAccountNumber: provider === 'bank' ? '•••• ' + String(row.account_number || '').slice(-4) : null,
    status: row.status,
    createdAt: row.created_at,
    verifiedAt: row.verified_at,
  };
}

function label(row) {
  const provider = PROVIDERS[row.provider] ? row.provider : 'bank';
  if (provider === 'bank') return `${row.bank_name} •••• ${String(row.account_number || '').slice(-4)}`;
  return `${PROVIDERS[provider].label} ${displayHandle(row)}`;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

async function limitsFor(sql, userId, nowMs = Date.now()) {
  const rows = await sql`SELECT amount_in, amount_out FROM linked_daily WHERE user_id = ${userId} AND day = ${utcDay(nowMs)}::date`;
  const usedIn = rows.length ? cents(rows[0].amount_in) : 0;
  const usedOut = rows.length ? cents(rows[0].amount_out) : 0;
  return {
    inPerDay: DAILY_IN_LIMIT,
    outPerDay: DAILY_OUT_LIMIT,
    inRemaining: dollars(Math.max(0, DAILY_IN_LIMIT * 100 - usedIn)),
    outRemaining: dollars(Math.max(0, DAILY_OUT_LIMIT * 100 - usedOut)),
    minTransfer: MIN_TRANSFER,
  };
}

async function listLinked(sql, userId, nowMs = Date.now()) {
  await ensureLinkedSchema(sql);
  const [rows, limits, recent] = await Promise.all([
    sql`SELECT * FROM external_accounts WHERE user_id = ${userId} AND status <> 'removed' ORDER BY COALESCE(last_used_at, created_at) DESC, id DESC`,
    limitsFor(sql, userId, nowMs),
    sql`
      SELECT lt.id, lt.external_account_id, lt.direction, lt.amount, lt.transaction_id, lt.created_at
      FROM linked_transfers lt
      WHERE lt.user_id = ${userId}
      ORDER BY lt.created_at DESC, lt.id DESC
      LIMIT 30
    `,
  ]);
  return {
    externalAccounts: rows.map(publicAccount),
    recentTransfers: recent.map((t) => ({ id: Number(t.id), accountId: Number(t.external_account_id), direction: t.direction, amount: Number(t.amount), transactionId: t.transaction_id != null ? Number(t.transaction_id) : null, createdAt: t.created_at })),
    limits,
    maxLinked: MAX_LINKED,
  };
}

// ---------------------------------------------------------------------------
// Link / unlink
// ---------------------------------------------------------------------------

async function linkAccount(sql, userId, body) {
  await ensureLinkedSchema(sql);
  const b = body || {};
  const provider = String(b.provider || (b.routingNumber ? 'bank' : '')).toLowerCase();
  if (!PROVIDERS[provider]) throw new LinkError(400, 'Choose what to link: Cash App, Venmo, PayPal, Zelle or a bank account.');
  const holder = String(b.accountHolderName || '').trim().replace(/\s+/g, ' ');
  if (!holder) throw new LinkError(400, 'Enter the name on the account.');
  if (holder.length > 80) throw new LinkError(400, 'That name is too long.');

  let insert;
  if (provider === 'bank') {
    const bankName = String(b.bankName || '').trim().replace(/\s+/g, ' ');
    const routing = String(b.routingNumber || '').replace(/\D/g, '');
    const account = String(b.accountNumber || '').replace(/\D/g, '');
    const accountType = b.accountType === 'savings' ? 'savings' : 'checking';
    if (!bankName) throw new LinkError(400, 'Enter the bank name.');
    if (bankName.length > 60) throw new LinkError(400, 'That bank name is too long.');
    if (!/^\d{9}$/.test(routing)) throw new LinkError(400, 'A routing number is 9 digits.');
    if (!abaValid(routing)) throw new LinkError(400, "That routing number isn't valid. Check it against a check or your bank's app.");
    if (!/^\d{4,17}$/.test(account)) throw new LinkError(400, 'An account number is 4-17 digits.');
    if (b.confirmAccountNumber !== undefined && String(b.confirmAccountNumber).replace(/\D/g, '') !== account) throw new LinkError(400, "The account numbers don't match.");
    const dup = await sql`SELECT id FROM external_accounts WHERE user_id = ${userId} AND status <> 'removed' AND provider = 'bank' AND routing_number = ${routing} AND account_number = ${account} LIMIT 1`;
    if (dup.length) throw new LinkError(409, 'This account is already linked.');
    insert = { provider, bankName, accountType, routing, account, handle: null };
  } else {
    const handle = normalizeHandle(provider, b.handle);
    const dup = await sql`SELECT id FROM external_accounts WHERE user_id = ${userId} AND status <> 'removed' AND provider = ${provider} AND LOWER(handle) = LOWER(${handle}) LIMIT 1`;
    if (dup.length) throw new LinkError(409, `That ${PROVIDERS[provider].label} account is already linked.`);
    insert = { provider, bankName: PROVIDERS[provider].label, accountType: 'checking', routing: null, account: null, handle };
  }

  const count = await sql`SELECT COUNT(*)::int AS n FROM external_accounts WHERE user_id = ${userId} AND status <> 'removed'`;
  if (Number(count[0].n) >= MAX_LINKED) throw new LinkError(400, `You can link up to ${MAX_LINKED} accounts. Remove one before adding another.`);

  const rows = await sql`
    INSERT INTO external_accounts (user_id, bank_name, account_holder_name, account_type, routing_number, account_number, status, verified_at, provider, handle)
    VALUES (${userId}, ${insert.bankName}, ${holder}, ${insert.accountType}, ${insert.routing}, ${insert.account}, 'verified', NOW(), ${insert.provider}, ${insert.handle})
    RETURNING *
  `;
  const acct = publicAccount(rows[0]);
  return {
    account: acct,
    notification: {
      title: `${acct.name} linked`,
      message: `${acct.name} ${acct.display} is linked. You can send money to it and add money from it on Home.`,
    },
  };
}

async function unlinkAccount(sql, userId, id) {
  await ensureLinkedSchema(sql);
  const n = Number(id);
  if (!Number.isInteger(n) || n <= 0) throw new LinkError(400, 'Choose an account to remove.');
  const rows = await sql`
    UPDATE external_accounts SET status = 'removed'
    WHERE id = ${n} AND user_id = ${userId} AND status <> 'removed'
    RETURNING *
  `;
  if (!rows.length) throw new LinkError(404, 'Linked account not found.');
  const acct = publicAccount(rows[0]);
  return { account: acct, message: `${acct.name} ${acct.display} was removed.` };
}

// ---------------------------------------------------------------------------
// Moving money
// ---------------------------------------------------------------------------

// Everything that can be checked before money moves (so Face ID isn't asked
// for a transfer that was never going to work).
async function precheckTransfer(sql, { userId, id, direction, amount, nowMs = Date.now() }) {
  await ensureLinkedSchema(sql);
  const dir = direction === 'in' ? 'in' : direction === 'out' ? 'out' : null;
  if (!dir) throw new LinkError(400, 'Choose whether to send or add money.');
  const amtC = cents(amount);
  if (!Number.isFinite(Number(amount)) || amtC < MIN_TRANSFER * 100) throw new LinkError(400, `Enter an amount of at least ${money(MIN_TRANSFER)}.`);

  const extRows = await sql`SELECT * FROM external_accounts WHERE id = ${Number(id) || 0} AND user_id = ${userId} AND status <> 'removed' LIMIT 1`;
  if (!extRows.length) throw new LinkError(404, 'Linked account not found.');
  const checkingRows = await sql`SELECT id, balance, restriction_level FROM accounts WHERE user_id = ${userId} AND account_type = 'checking' LIMIT 1`;
  if (!checkingRows.length) throw new LinkError(404, 'Checking account not found.');
  const checking = checkingRows[0];
  if (checking.restriction_level === 'full' || checking.restriction_level === 'transfers_only') {
    throw new LinkError(403, 'There is an issue on this account that requires in-person verification at a branch.', { accountRestricted: true });
  }

  const limits = await limitsFor(sql, userId, nowMs);
  const remaining = dir === 'in' ? limits.inRemaining : limits.outRemaining;
  if (amtC > cents(remaining)) {
    throw new LinkError(400, remaining > 0
      ? `You can ${dir === 'in' ? 'add' : 'send'} up to ${money(remaining)} more today (the daily limit is ${money(dir === 'in' ? DAILY_IN_LIMIT : DAILY_OUT_LIMIT)}).`
      : `You've reached today's ${money(dir === 'in' ? DAILY_IN_LIMIT : DAILY_OUT_LIMIT)} limit for ${dir === 'in' ? 'adding money from' : 'sending money to'} linked accounts. Try again tomorrow.`);
  }
  if (dir === 'out' && cents(checking.balance) < amtC) throw new LinkError(400, `Your checking balance is ${money(checking.balance)}.`);
  return { dir, amt: dollars(amtC), ext: extRows[0], checking };
}

async function transfer(sql, { userId, id, direction, amount, note, nowMs = Date.now() }) {
  const { dir, amt, ext, checking } = await precheckTransfer(sql, { userId, id, direction, amount, nowMs });
  const day = utcDay(nowMs);
  const who = label(ext);
  const cleanNote = String(note || '').trim().slice(0, 60);
  const description = `External transfer ${dir === 'in' ? 'from' : 'to'} ${who}${cleanNote ? ' - ' + cleanNote : ''}`;
  await sql`INSERT INTO linked_daily (user_id, day) VALUES (${userId}, ${day}::date) ON CONFLICT DO NOTHING`;

  let row;
  try {
    const rows = dir === 'out'
      ? await sql`
        WITH claim AS (
          UPDATE linked_daily SET amount_out = amount_out + ${amt}::numeric
          WHERE user_id = ${userId} AND day = ${day}::date AND amount_out + ${amt}::numeric <= ${DAILY_OUT_LIMIT}::numeric
          RETURNING user_id
        ),
        moved AS (
          UPDATE accounts SET balance = balance - ${amt}::numeric
          WHERE id = ${checking.id} AND balance >= ${amt}::numeric
            AND COALESCE(restriction_level, 'none') NOT IN ('full', 'transfers_only')
            AND EXISTS (SELECT 1 FROM claim)
          RETURNING id, balance
        ),
        txn AS (
          INSERT INTO transactions (account_id, type, amount, description, created_at)
          VALUES ((SELECT id FROM moved), 'debit', ${amt}::numeric, ${description}::text, NOW())
          RETURNING id, created_at
        ),
        logged AS (
          INSERT INTO linked_transfers (user_id, external_account_id, direction, amount, transaction_id)
          SELECT ${userId}::int, ${ext.id}::int, 'out', ${amt}::numeric, (SELECT id FROM txn) FROM moved
          RETURNING id
        ),
        touched AS (
          UPDATE external_accounts SET last_used_at = NOW() WHERE id = ${ext.id} AND EXISTS (SELECT 1 FROM moved) RETURNING id
        )
        SELECT (SELECT balance FROM moved) AS balance, (SELECT id FROM txn) AS transaction_id, (SELECT created_at FROM txn) AS created_at,
               (SELECT COUNT(*) FROM logged) AS logged, (SELECT COUNT(*) FROM touched) AS touched,
               1 / ((SELECT COUNT(*) FROM claim) * (SELECT COUNT(*) FROM moved)) AS guard
      `
      : await sql`
        WITH claim AS (
          UPDATE linked_daily SET amount_in = amount_in + ${amt}::numeric
          WHERE user_id = ${userId} AND day = ${day}::date AND amount_in + ${amt}::numeric <= ${DAILY_IN_LIMIT}::numeric
          RETURNING user_id
        ),
        moved AS (
          UPDATE accounts SET balance = balance + ${amt}::numeric
          WHERE id = ${checking.id}
            AND COALESCE(restriction_level, 'none') NOT IN ('full', 'transfers_only')
            AND EXISTS (SELECT 1 FROM claim)
          RETURNING id, balance
        ),
        txn AS (
          INSERT INTO transactions (account_id, type, amount, description, created_at)
          VALUES ((SELECT id FROM moved), 'ach_in', ${amt}::numeric, ${description}::text, NOW())
          RETURNING id, created_at
        ),
        logged AS (
          INSERT INTO linked_transfers (user_id, external_account_id, direction, amount, transaction_id)
          SELECT ${userId}::int, ${ext.id}::int, 'in', ${amt}::numeric, (SELECT id FROM txn) FROM moved
          RETURNING id
        ),
        touched AS (
          UPDATE external_accounts SET last_used_at = NOW() WHERE id = ${ext.id} AND EXISTS (SELECT 1 FROM moved) RETURNING id
        )
        SELECT (SELECT balance FROM moved) AS balance, (SELECT id FROM txn) AS transaction_id, (SELECT created_at FROM txn) AS created_at,
               (SELECT COUNT(*) FROM logged) AS logged, (SELECT COUNT(*) FROM touched) AS touched,
               1 / ((SELECT COUNT(*) FROM claim) * (SELECT COUNT(*) FROM moved)) AS guard
      `;
    row = rows[0];
  } catch (err) {
    if (isGuard(err)) throw new LinkError(409, 'Your balance or daily limit changed before this went through. Nothing was moved, so please try again.');
    throw err;
  }

  const acct = publicAccount(ext);
  return {
    direction: dir,
    amount: amt,
    account: acct,
    transactionId: Number(row.transaction_id),
    transactionTimestamp: row.created_at,
    checkingBalance: Number(row.balance),
    description,
    message: dir === 'out'
      ? `${money(amt)} sent to ${who}. ${acct.speed}.`
      : `${money(amt)} added to checking from ${who}.`,
    notification: dir === 'out'
      ? { title: `Sent to ${acct.name}`, message: `${money(amt)} was sent from checking to ${who}. ${acct.speed}.` }
      : { title: `Added from ${acct.name}`, message: `${money(amt)} from ${who} was added to your checking account.` },
  };
}

module.exports = {
  PROVIDERS,
  MAX_LINKED,
  DAILY_IN_LIMIT,
  DAILY_OUT_LIMIT,
  LinkError,
  ensureLinkedSchema,
  abaValid,
  normalizeHandle,
  displayHandle,
  listLinked,
  limitsFor,
  linkAccount,
  precheckTransfer,
  unlinkAccount,
  transfer,
};
