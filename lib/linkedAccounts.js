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

// Linking is strict, the way real banks do it:
//  1. Before anything can be linked, the customer's profile has to be
//     complete: identity verified (KYC), mobile number and home address on
//     file, and Face ID or an app passcode set up (linkRequirements).
//  2. The name on the other account must match the Apex account's legal name,
//     and Cash App / Venmo also need the email or phone registered with them.
//  3. A new link starts as 'pending_verification' and can't move money until
//     it's verified: two small deposits for a bank account, or a 6-digit code
//     from the other service for Cash App, Venmo, PayPal and Zelle. Three
//     wrong tries and it's 'failed'; after 10 days it's 'expired'. Only a hash
//     of the answer is stored, keyed to the link.
//  4. Our operations team can also verify (or reject) a link after checking it
//     by hand, from the admin panel (adminVerify / adminReject).
// Links made before verification existed go back to 'pending_verification'.

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
const VERIFY_DAYS = 10;
const VERIFY_ATTEMPTS = 3;
const CODE_RESENDS = 2;

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
  await sql`ALTER TABLE external_accounts ADD COLUMN IF NOT EXISTS contact TEXT`;
  await sql`ALTER TABLE external_accounts ADD COLUMN IF NOT EXISTS verify_method TEXT`;
  await sql`ALTER TABLE external_accounts ADD COLUMN IF NOT EXISTS verify_hash TEXT`;
  await sql`ALTER TABLE external_accounts ADD COLUMN IF NOT EXISTS verify_attempts INTEGER NOT NULL DEFAULT 0`;
  await sql`ALTER TABLE external_accounts ADD COLUMN IF NOT EXISTS verify_resends INTEGER NOT NULL DEFAULT 0`;
  await sql`ALTER TABLE external_accounts ADD COLUMN IF NOT EXISTS verify_started_at TIMESTAMPTZ`;
  await sql`ALTER TABLE external_accounts ADD COLUMN IF NOT EXISTS verify_expires_at TIMESTAMPTZ`;
  await sql`ALTER TABLE external_accounts ADD COLUMN IF NOT EXISTS verified_by TEXT`;
  await sql`ALTER TABLE external_accounts ADD COLUMN IF NOT EXISTS review_note TEXT`;
  await sql`ALTER TABLE external_accounts ALTER COLUMN status SET DEFAULT 'pending_verification'`;
  // Links made before verification existed have to be verified like new ones.
  // Their answer is a random value nobody has, so only a review can pass them.
  await sql`
    UPDATE external_accounts
    SET status = 'pending_verification',
        verify_method = CASE WHEN COALESCE(provider, 'bank') = 'bank' THEN 'deposits' ELSE 'code' END,
        verify_hash = 'legacy:' || md5(random()::text || id::text),
        verify_attempts = 0, verify_resends = 0,
        verify_started_at = NOW(), verify_expires_at = NOW() + make_interval(days => ${VERIFY_DAYS}),
        verified_at = NULL
    WHERE status = 'verified' AND verified_by IS NULL
  `;
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
    verified: row.status === 'verified',
    verification: verificationInfo(row, provider),
    createdAt: row.created_at,
    verifiedAt: row.verified_at,
  };
}

// What the customer needs to do next for a link that isn't verified yet.
function verificationInfo(row, provider) {
  if (row.status === 'verified' || row.status === 'removed') return null;
  const method = row.verify_method || (provider === 'bank' ? 'deposits' : 'code');
  const attemptsLeft = Math.max(0, VERIFY_ATTEMPTS - Number(row.verify_attempts || 0));
  const base = {
    method,
    attemptsLeft,
    expiresAt: row.verify_expires_at || null,
    canResend: method === 'code' && row.status === 'pending_verification' && Number(row.verify_resends || 0) < CODE_RESENDS,
  };
  if (row.status === 'failed') return { ...base, state: 'failed', title: "We couldn't verify this account", message: 'The details entered didn\'t match three times, so for your security this link is locked. Remove it and link it again, or contact us.' };
  if (row.status === 'expired') return { ...base, state: 'expired', title: 'Verification timed out', message: `This link wasn't verified within ${VERIFY_DAYS} days. Remove it and link it again, or contact us.` };
  if (row.status === 'rejected') return { ...base, state: 'rejected', title: "We couldn't approve this link", message: row.review_note ? `Our team couldn't approve it: ${row.review_note}` : 'Our team reviewed this link and couldn\'t approve it. Contact us if you think this is a mistake.' };
  const label = PROVIDERS[provider] ? PROVIDERS[provider].label : 'the other service';
  const to = row.handle ? displayHandle(row) : '';
  const contact = row.contact ? (String(row.contact).includes('@') ? maskEmail(row.contact) : `(•••) •••-${String(row.contact).slice(-4)}`) : '';
  let steps;
  if (method === 'deposits') {
    steps = [
      'We send two small deposits, each under $1.00, to this account. They show up as "APEX HORIZON VERIFY".',
      'They take 1-3 business days to arrive. Check your statement or your bank\'s app.',
      'Come back here and enter both amounts.',
    ];
  } else if (provider === 'cashapp' || provider === 'venmo') {
    steps = [
      `${label} sends a 6-digit code to the ${contact ? contact : 'email or phone'} on your ${label} account${to ? ` (${to})` : ''}.`,
      `You can also find it in ${label} under Activity, as a message from Apex Horizon Bank.`,
      'Enter the code here within 10 days.',
    ];
  } else {
    steps = [
      `${label} sends a 6-digit code to ${to || 'your ' + label + ' email or phone'}.`,
      'It can take a few minutes to arrive. Check your spam folder too.',
      'Enter the code here within 10 days.',
    ];
  }
  return { ...base, state: 'pending', title: method === 'deposits' ? 'Confirm two small deposits' : `Enter the code from ${label}`, steps };
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

// ---------------------------------------------------------------------------
// What has to be in place before anything can be linked
// ---------------------------------------------------------------------------

const crypto = require('crypto');

function normName(v) {
  return String(v || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z' -]/g, ' ').replace(/[' -]+/g, ' ').replace(/\s+/g, ' ').trim();
}

async function optional(fn, fallback) {
  try { return await fn(); } catch (_) { return fallback; }
}

async function linkRequirements(sql, userId) {
  const user = await optional(async () => (await sql`
    SELECT full_name, phone, address_street, address_city, address_state, address_zip, passcode_hash IS NOT NULL AS has_passcode
    FROM users WHERE id = ${userId}
  `)[0], null) || await optional(async () => (await sql`SELECT full_name FROM users WHERE id = ${userId}`)[0], null) || {};
  const kyc = await optional(async () => {
    const rows = await sql`SELECT status FROM kyc_verifications WHERE user_id = ${userId} ORDER BY created_at DESC LIMIT 1`;
    return rows.length ? rows[0].status : 'not_started';
  }, 'not_started');
  const faceIds = await optional(async () => Number((await sql`SELECT COUNT(*) AS n FROM webauthn_credentials WHERE user_id = ${userId}`)[0].n), 0);
  const hasPasscode = user.has_passcode === true || user.has_passcode === 't';
  const filled = (v) => typeof v === 'string' ? v.trim().length > 0 : v != null;
  const items = [
    {
      id: 'identity', label: 'Identity verified', ok: kyc === 'verified',
      detail: kyc === 'verified' ? 'Your ID has been checked' : kyc === 'pending' ? "We're checking your ID. This usually takes a day or two." : kyc === 'rejected' ? "Your last ID check wasn't approved. Try again." : 'Upload a photo ID so we know it\'s you',
      fix: kyc === 'verified' || kyc === 'pending' ? null : { label: 'Verify', view: 'profile' },
    },
    {
      id: 'phone', label: 'Mobile number on file', ok: filled(user.phone),
      detail: filled(user.phone) ? `Ending in ${String(user.phone).replace(/\D/g, '').slice(-4)}` : 'We need a number to reach you about your account',
      fix: filled(user.phone) ? null : { label: 'Contact us', help: 'Add a mobile number to my account' },
    },
    {
      id: 'address', label: 'Home address on file', ok: filled(user.address_street) && filled(user.address_city) && filled(user.address_state) && filled(user.address_zip),
      detail: filled(user.address_street) ? `${user.address_city || ''}${user.address_state ? ', ' + user.address_state : ''}`.replace(/^, /, '') || 'On file' : 'Your address has to match your ID',
      fix: filled(user.address_street) ? null : { label: 'Contact us', help: 'Add my home address' },
    },
    {
      id: 'security', label: 'Face ID or app passcode set up', ok: faceIds > 0 || hasPasscode,
      detail: faceIds > 0 ? 'Face ID is on' : hasPasscode ? 'App passcode is set' : 'Needed to confirm money you send to other accounts',
      fix: faceIds > 0 || hasPasscode ? null : { label: 'Set up', view: 'settings-passcode' },
    },
  ];
  return { ready: items.every((i) => i.ok), items, legalName: user.full_name || '' };
}

function verifySecret() {
  return process.env.LINK_VERIFY_SECRET || process.env.JWT_SECRET || 'apex-horizon-link-verify';
}
function answerHash(id, answer) {
  return crypto.createHmac('sha256', verifySecret()).update(`${id}:${answer}`).digest('hex');
}
function sameHash(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
// Bank links: two deposits of 1-99 cents. The answer is order-free.
function newDepositsAnswer() {
  const a = crypto.randomInt(1, 100);
  let b = crypto.randomInt(1, 100);
  while (b === a) b = crypto.randomInt(1, 100);
  return [a, b].sort((m, n) => m - n).join(',');
}
function newCodeAnswer() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}
function parseCents(v) {
  const t = String(v == null ? '' : v).trim().replace(/^\$/, '');
  if (!/^(0?\.\d{1,2}|0|\d{1,2})$/.test(t)) return null;
  const c = t.includes('.') ? Math.round(Number(t) * 100) : Number(t);
  return Number.isInteger(c) && c >= 1 && c <= 99 ? c : null;
}

// Pending links past their deadline become 'expired'.
async function expireStale(sql, userId) {
  await sql`
    UPDATE external_accounts SET status = 'expired'
    WHERE user_id = ${userId} AND status = 'pending_verification' AND verify_expires_at < NOW()
  `;
}

async function listLinked(sql, userId, nowMs = Date.now()) {
  await ensureLinkedSchema(sql);
  await expireStale(sql, userId);
  const [rows, limits, recent, requirements] = await Promise.all([
    sql`SELECT * FROM external_accounts WHERE user_id = ${userId} AND status <> 'removed' ORDER BY COALESCE(last_used_at, created_at) DESC, id DESC`,
    limitsFor(sql, userId, nowMs),
    sql`
      SELECT lt.id, lt.external_account_id, lt.direction, lt.amount, lt.transaction_id, lt.created_at
      FROM linked_transfers lt
      WHERE lt.user_id = ${userId}
      ORDER BY lt.created_at DESC, lt.id DESC
      LIMIT 30
    `,
    linkRequirements(sql, userId),
  ]);
  return {
    externalAccounts: rows.map(publicAccount),
    requirements,
    recentTransfers: recent.map((t) => ({ id: Number(t.id), accountId: Number(t.external_account_id), direction: t.direction, amount: Number(t.amount), transactionId: t.transaction_id != null ? Number(t.transaction_id) : null, createdAt: t.created_at })),
    limits,
    maxLinked: MAX_LINKED,
  };
}

// ---------------------------------------------------------------------------
// Link / unlink
// ---------------------------------------------------------------------------

function sealAnswer(answer) {
  const nonce = crypto.randomBytes(8).toString('hex');
  return `${nonce}$${answerHash(nonce, answer)}`;
}
function answerMatches(sealed, answer) {
  const [nonce, hash] = String(sealed || '').split('$');
  if (!nonce || !hash) return false;
  return sameHash(hash, answerHash(nonce, answer));
}

async function linkAccount(sql, userId, body) {
  await ensureLinkedSchema(sql);
  const b = body || {};
  const provider = String(b.provider || (b.routingNumber ? 'bank' : '')).toLowerCase();
  if (!PROVIDERS[provider]) throw new LinkError(400, 'Choose what to link: Cash App, Venmo, PayPal, Zelle or a bank account.');

  const requirements = await linkRequirements(sql, userId);
  if (!requirements.ready) {
    const missing = requirements.items.filter((i) => !i.ok).map((i) => i.label.toLowerCase());
    throw new LinkError(403, `Before you can link an account we need: ${missing.join(', ')}.`, { requirements });
  }

  const holder = String(b.accountHolderName || '').trim().replace(/\s+/g, ' ');
  if (!holder) throw new LinkError(400, 'Enter the name on the account.');
  if (holder.length > 80) throw new LinkError(400, 'That name is too long.');
  const where = provider === 'bank' ? 'bank account' : `${PROVIDERS[provider].label} account`;
  if (requirements.legalName && normName(holder) !== normName(requirements.legalName)) {
    throw new LinkError(400, `The name on the ${where} has to match the name on your Apex account exactly: ${requirements.legalName}. We can only link accounts in your own name.`);
  }

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
    let contact = null;
    if (provider === 'cashapp' || provider === 'venmo') {
      const raw = String(b.contact || '').trim();
      if (!raw) throw new LinkError(400, `Enter the email or mobile number on your ${PROVIDERS[provider].label} account. ${PROVIDERS[provider].label} sends the verification code there.`);
      if (raw.includes('@')) {
        if (!EMAIL_RE.test(raw) || raw.length > 254) throw new LinkError(400, 'Enter a valid email address or US mobile number.');
        contact = raw.toLowerCase();
      } else {
        contact = normalizePhone(raw);
        if (!contact) throw new LinkError(400, 'Enter a valid email address or 10-digit US mobile number.');
      }
    }
    const dup = await sql`SELECT id FROM external_accounts WHERE user_id = ${userId} AND status <> 'removed' AND provider = ${provider} AND LOWER(handle) = LOWER(${handle}) LIMIT 1`;
    if (dup.length) throw new LinkError(409, `That ${PROVIDERS[provider].label} account is already linked.`);
    insert = { provider, bankName: PROVIDERS[provider].label, accountType: 'checking', routing: null, account: null, handle, contact };
  }

  const count = await sql`SELECT COUNT(*)::int AS n FROM external_accounts WHERE user_id = ${userId} AND status <> 'removed'`;
  if (Number(count[0].n) >= MAX_LINKED) throw new LinkError(400, `You can link up to ${MAX_LINKED} accounts. Remove one before adding another.`);

  const method = provider === 'bank' ? 'deposits' : 'code';
  // The answer is never stored or shown, only a salted hash of it.
  const sealed = sealAnswer(method === 'deposits' ? newDepositsAnswer() : newCodeAnswer());
  const rows = await sql`
    INSERT INTO external_accounts (user_id, bank_name, account_holder_name, account_type, routing_number, account_number, status, verified_at, provider, handle, contact,
                                   verify_method, verify_hash, verify_attempts, verify_resends, verify_started_at, verify_expires_at)
    VALUES (${userId}, ${insert.bankName}, ${holder}, ${insert.accountType}, ${insert.routing}, ${insert.account}, 'pending_verification', NULL, ${insert.provider}, ${insert.handle}, ${insert.contact || null},
            ${method}, ${sealed}, 0, 0, NOW(), NOW() + make_interval(days => ${VERIFY_DAYS}))
    RETURNING *
  `;
  const acct = publicAccount(rows[0]);
  return {
    account: acct,
    notification: {
      title: `Verify ${acct.name} to finish linking`,
      message: method === 'deposits'
        ? `We're sending two small deposits to ${acct.name} ${acct.display}. When they arrive, enter the amounts in the app to finish linking. You have ${VERIFY_DAYS} days.`
        : `Enter the 6-digit code from ${acct.name} to finish linking ${acct.display}. You have ${VERIFY_DAYS} days.`,
    },
  };
}

// The customer enters the code or the two deposit amounts.
async function verifyLinked(sql, userId, body) {
  await ensureLinkedSchema(sql);
  await expireStale(sql, userId);
  const b = body || {};
  const id = Number(b.externalAccountId);
  if (!Number.isInteger(id) || id <= 0) throw new LinkError(400, 'Choose an account to verify.');
  const rows = await sql`SELECT * FROM external_accounts WHERE id = ${id} AND user_id = ${userId} AND status <> 'removed' LIMIT 1`;
  if (!rows.length) throw new LinkError(404, 'Linked account not found.');
  const row = rows[0];
  const acct = publicAccount(row);
  if (row.status === 'verified') return { account: acct, alreadyVerified: true, message: `${acct.name} ${acct.display} is already verified.` };
  if (row.status !== 'pending_verification') throw new LinkError(409, acct.verification ? acct.verification.message : 'This link can\'t be verified.', { linkStatus: row.status });

  let answer;
  if (row.verify_method === 'deposits') {
    const c1 = parseCents(b.amount1);
    const c2 = parseCents(b.amount2);
    if (c1 === null || c2 === null) throw new LinkError(400, 'Enter both deposit amounts, like 0.32. Each one is under $1.00.');
    answer = [c1, c2].sort((m, n) => m - n).join(',');
  } else {
    const code = String(b.code || '').replace(/\D/g, '');
    if (code.length !== 6) throw new LinkError(400, 'Enter the 6-digit code.');
    answer = code;
  }

  // Count the try first (atomically), so racing requests can't get extra goes.
  const claimed = await sql`
    UPDATE external_accounts SET verify_attempts = verify_attempts + 1
    WHERE id = ${id} AND user_id = ${userId} AND status = 'pending_verification' AND verify_attempts < ${VERIFY_ATTEMPTS}
    RETURNING verify_attempts, verify_hash
  `;
  if (!claimed.length) throw new LinkError(409, "This link can't be verified any more. Remove it and link it again, or contact us.");
  const used = Number(claimed[0].verify_attempts);

  if (answerMatches(claimed[0].verify_hash, answer)) {
    const done = await sql`
      UPDATE external_accounts SET status = 'verified', verified_at = NOW(), verified_by = ${row.verify_method === 'deposits' ? 'deposits' : 'code'}, verify_hash = NULL
      WHERE id = ${id} AND status = 'pending_verification'
      RETURNING *
    `;
    const v = publicAccount(done[0] || row);
    return {
      account: v,
      verified: true,
      message: `${v.name} ${v.display} is verified. You can now add money from it and send money to it.`,
      notification: { title: `${v.name} is ready`, message: `${v.name} ${v.display} is verified and linked to your Apex account.` },
    };
  }

  const left = VERIFY_ATTEMPTS - used;
  if (left <= 0) {
    await sql`UPDATE external_accounts SET status = 'failed', verify_hash = NULL WHERE id = ${id} AND status = 'pending_verification'`;
    throw new LinkError(400, "That doesn't match, and that was the last try. For your security this link is now locked. Remove it and link it again, or contact us.", { linkStatus: 'failed', attemptsLeft: 0 });
  }
  throw new LinkError(400, row.verify_method === 'deposits'
    ? `Those amounts don't match what we sent. ${left} ${left === 1 ? 'try' : 'tries'} left.`
    : `That code isn't right. ${left} ${left === 1 ? 'try' : 'tries'} left.`, { attemptsLeft: left });
}

// A fresh code (Cash App, Venmo, PayPal, Zelle), at most twice per link.
async function resendCode(sql, userId, body) {
  await ensureLinkedSchema(sql);
  await expireStale(sql, userId);
  const id = Number((body || {}).externalAccountId);
  if (!Number.isInteger(id) || id <= 0) throw new LinkError(400, 'Choose an account.');
  const rows = await sql`
    UPDATE external_accounts
    SET verify_hash = ${sealAnswer(newCodeAnswer())}, verify_resends = verify_resends + 1
    WHERE id = ${id} AND user_id = ${userId} AND status = 'pending_verification' AND verify_method = 'code' AND verify_resends < ${CODE_RESENDS}
    RETURNING *
  `;
  if (!rows.length) {
    const any = await sql`SELECT status, verify_method, verify_resends FROM external_accounts WHERE id = ${id} AND user_id = ${userId} AND status <> 'removed'`;
    if (!any.length) throw new LinkError(404, 'Linked account not found.');
    if (any[0].status !== 'pending_verification') throw new LinkError(409, "This link isn't waiting for a code.");
    if (any[0].verify_method !== 'code') throw new LinkError(400, 'Bank accounts are verified with two small deposits, not a code.');
    throw new LinkError(429, "You've asked for a new code the most times we allow. If it still hasn't arrived, contact us.");
  }
  const acct = publicAccount(rows[0]);
  return { account: acct, message: `We've asked ${acct.name} to send a new code. The old one no longer works.` };
}

// ----- Operations team (admin panel) -----
async function adminList(sql) {
  await ensureLinkedSchema(sql);
  await sql`UPDATE external_accounts SET status = 'expired' WHERE status = 'pending_verification' AND verify_expires_at < NOW()`;
  const rows = await sql`
    SELECT e.*, u.email AS user_email, u.full_name AS user_full_name
    FROM external_accounts e JOIN users u ON u.id = e.user_id
    WHERE e.status IN ('pending_verification', 'failed', 'expired')
    ORDER BY e.created_at ASC
    LIMIT 200
  `;
  return rows.map((r) => ({
    ...publicAccount(r),
    userId: Number(r.user_id),
    userEmail: r.user_email,
    userFullName: r.user_full_name,
    nameMatches: normName(r.account_holder_name) === normName(r.user_full_name),
    contact: r.contact ? (String(r.contact).includes('@') ? maskEmail(r.contact) : `(•••) •••-${String(r.contact).slice(-4)}`) : null,
    attempts: Number(r.verify_attempts || 0),
    routingNumber: r.routing_number || null,
  }));
}

async function adminDecide(sql, id, { approve, reason }) {
  await ensureLinkedSchema(sql);
  const n = Number(id);
  if (!Number.isInteger(n) || n <= 0) throw new LinkError(400, 'externalAccountId is required.');
  const note = String(reason || '').trim().slice(0, 200) || null;
  const rows = approve
    ? await sql`
        UPDATE external_accounts SET status = 'verified', verified_at = NOW(), verified_by = 'review', verify_hash = NULL, review_note = ${note}
        WHERE id = ${n} AND status IN ('pending_verification', 'failed', 'expired')
        RETURNING *
      `
    : await sql`
        UPDATE external_accounts SET status = 'rejected', verify_hash = NULL, review_note = ${note}
        WHERE id = ${n} AND status IN ('pending_verification', 'failed', 'expired')
        RETURNING *
      `;
  if (!rows.length) throw new LinkError(404, 'That link is not waiting for a decision.');
  const acct = publicAccount(rows[0]);
  return {
    userId: Number(rows[0].user_id),
    account: acct,
    notification: approve
      ? { title: `${acct.name} is ready`, message: `We've verified ${acct.name} ${acct.display}. You can now add money from it and send money to it.` }
      : { title: `${acct.name} couldn't be linked`, message: note ? `We couldn't approve ${acct.name} ${acct.display}: ${note}` : `We couldn't approve ${acct.name} ${acct.display}. Contact us if you think this is a mistake.` },
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

  await expireStale(sql, userId);
  const extRows = await sql`SELECT * FROM external_accounts WHERE id = ${Number(id) || 0} AND user_id = ${userId} AND status <> 'removed' LIMIT 1`;
  if (!extRows.length) throw new LinkError(404, 'Linked account not found.');
  if (extRows[0].status !== 'verified') {
    const a = publicAccount(extRows[0]);
    throw new LinkError(403, extRows[0].status === 'pending_verification'
      ? `Finish verifying ${a.name} ${a.display} before moving money.`
      : `${a.name} ${a.display} isn't verified, so money can't move to or from it. ${a.verification ? a.verification.message : ''}`.trim(), { verificationRequired: true, linkStatus: extRows[0].status });
  }
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
          UPDATE external_accounts SET last_used_at = NOW() WHERE id = ${ext.id} AND status = 'verified' AND EXISTS (SELECT 1 FROM moved) RETURNING id
        )
        SELECT (SELECT balance FROM moved) AS balance, (SELECT id FROM txn) AS transaction_id, (SELECT created_at FROM txn) AS created_at,
               (SELECT COUNT(*) FROM logged) AS logged, (SELECT COUNT(*) FROM touched) AS touched,
               1 / ((SELECT COUNT(*) FROM claim) * (SELECT COUNT(*) FROM moved) * (SELECT COUNT(*) FROM touched)) AS guard
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
          UPDATE external_accounts SET last_used_at = NOW() WHERE id = ${ext.id} AND status = 'verified' AND EXISTS (SELECT 1 FROM moved) RETURNING id
        )
        SELECT (SELECT balance FROM moved) AS balance, (SELECT id FROM txn) AS transaction_id, (SELECT created_at FROM txn) AS created_at,
               (SELECT COUNT(*) FROM logged) AS logged, (SELECT COUNT(*) FROM touched) AS touched,
               1 / ((SELECT COUNT(*) FROM claim) * (SELECT COUNT(*) FROM moved) * (SELECT COUNT(*) FROM touched)) AS guard
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
  linkRequirements,
  verifyLinked,
  resendCode,
  adminList,
  adminDecide,
  VERIFY_ATTEMPTS,
  VERIFY_DAYS,
  // Tests only: seal a known answer so the success path can be exercised.
  _sealAnswerForTests: (answer) => sealAnswer(answer),
  precheckTransfer,
  unlinkAccount,
  transfer,
};
