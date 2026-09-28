// Apex credit card: statements, autopay, payment reminders, cash back,
// spending by category, expiry dates and card replacement.
//
// Everything is worked out from the card's own ledger, so nothing can drift
// out of step with the balance:
//   - Card transactions change the balance by their signed amount
//     (purchases are positive; payments, refunds and cash back credits are
//     negative).
//   - A statement closes at the end of the 25th of each month (UTC). Its
//     balance is the card balance now minus everything that has posted since
//     it closed, so it never changes once closed.
//   - Payment is due on the 20th of the following month. The minimum payment
//     is 2% of the statement balance or $25, whichever is more (never more
//     than the statement balance).
//   - Payments and credits made after the statement closed count toward it.
//
// Cash back is 1.5% of every card purchase, rounded to the cent per purchase.
// Refunds take back the cash back their purchase earned. What you've
// redeemed is kept in card_rewards, and a redemption only goes through if
// redeemed + amount still fits inside what you've earned, checked inside the
// same statement that moves the money (so two taps can't redeem twice).
//
// Reminders and autopay run from the daily cron and also whenever the person
// opens the app (runCardCycleForUser), so they still happen if the cron is
// late. Each notice is recorded once per statement in card_notices, which is
// also what stops autopay from ever paying the same statement twice.

const { categorize } = require('./categories');

const CASH_BACK_RATE = 0.015;
const STATEMENT_CLOSE_DAY = 25;
const PAYMENT_DUE_DAY = 20;
const MIN_PAYMENT_FLOOR = 25;
const MIN_PAYMENT_PCT = 0.02;
const REMINDER_DAYS = 3;
const AUTOPAY_WINDOW_DAYS = 3;
const MIN_REDEEM = 1;
const CARD_VALID_YEARS = 4;
const AUTOPAY_MODES = ['off', 'minimum', 'statement', 'balance'];
const REPLACE_REASONS = ['lost', 'stolen', 'damaged'];
const DAY_MS = 86400000;

class CardError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'CardError';
    this.status = status;
  }
}

function isGuard(err) {
  return !!err && (err.code === '22012' || err.code === '23502' || /division by zero/i.test(String(err.message || '')));
}

const cents = (v) => Math.round(Number(v || 0) * 100);
const dollars = (c) => Math.round(c) / 100;
const iso = (ms) => new Date(ms).toISOString().slice(0, 10);

function money(n) {
  return '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function shortDate(ms) {
  return new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

let schemaReady = false;
async function ensureCardsSchema(sql) {
  if (schemaReady) return;
  await sql`ALTER TABLE credit_card_details ADD COLUMN IF NOT EXISTS expiry_month INTEGER`;
  await sql`ALTER TABLE credit_card_details ADD COLUMN IF NOT EXISTS expiry_year INTEGER`;
  await sql`ALTER TABLE credit_card_details ADD COLUMN IF NOT EXISTS replaced_at TIMESTAMPTZ`;
  await sql`ALTER TABLE credit_card_details ADD COLUMN IF NOT EXISTS replaced_reason TEXT`;
  await sql`
    CREATE TABLE IF NOT EXISTS card_autopay (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      mode TEXT NOT NULL DEFAULT 'off' CHECK (mode IN ('off', 'minimum', 'statement', 'balance')),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS card_rewards (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      redeemed NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (redeemed >= 0),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS card_reward_redemptions (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      amount NUMERIC(14,2) NOT NULL CHECK (amount > 0),
      destination TEXT NOT NULL CHECK (destination IN ('checking', 'statement')),
      transaction_id INTEGER,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS card_notices (
      user_id INTEGER NOT NULL,
      statement_date DATE NOT NULL,
      kind TEXT NOT NULL,
      sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (user_id, statement_date, kind)
    )
  `;
  schemaReady = true;
}

// ---------------------------------------------------------------------------
// Statement cycle
// ---------------------------------------------------------------------------

// The statement that most recently closed, and the dates that hang off it.
function cycleFor(nowMs = Date.now()) {
  const now = new Date(nowMs);
  let y = now.getUTCFullYear();
  let m = now.getUTCMonth();
  if (nowMs < Date.UTC(y, m, STATEMENT_CLOSE_DAY + 1)) m -= 1;
  const closeMs = Date.UTC(y, m, STATEMENT_CLOSE_DAY + 1); // end of the 25th
  const statementMs = Date.UTC(y, m, STATEMENT_CLOSE_DAY);
  const dueMs = Date.UTC(y, m + 1, PAYMENT_DUE_DAY);
  const dueEndMs = Date.UTC(y, m + 1, PAYMENT_DUE_DAY + 1);
  return {
    closeMs,
    statementMs,
    dueMs,
    dueEndMs,
    nextStatementMs: Date.UTC(y, m + 1, STATEMENT_CLOSE_DAY),
    nextDueMs: Date.UTC(y, m + 2, PAYMENT_DUE_DAY),
    statementDate: iso(statementMs),
  };
}

function minimumFor(statementCents) {
  if (statementCents <= 0) return 0;
  const pct = Math.ceil(statementCents * MIN_PAYMENT_PCT);
  return Math.min(statementCents, Math.max(MIN_PAYMENT_FLOOR * 100, pct));
}

// ledger: { balance, since_close_net, credits_since_close, purchases_since_close }
function computeStatement(ledger, cycle, nowMs = Date.now()) {
  const balanceC = cents(ledger.balance);
  const statementC = balanceC - cents(ledger.since_close_net);
  const paidC = Math.max(0, cents(ledger.credits_since_close));
  const minimumC = minimumFor(statementC);
  const remainingC = Math.max(0, statementC - paidC);
  const remainingMinC = Math.max(0, minimumC - paidC);

  let status;
  if (statementC <= 0) status = 'none';
  else if (remainingC === 0) status = 'paid';
  else if (nowMs >= cycle.dueEndMs) status = remainingMinC > 0 ? 'past_due' : 'min_paid';
  else status = remainingMinC > 0 ? 'due' : 'min_paid';

  return {
    statementDate: cycle.statementDate,
    dueDate: iso(cycle.dueMs),
    nextStatementDate: iso(cycle.nextStatementMs),
    statementBalance: dollars(Math.max(0, statementC)),
    creditBalance: statementC < 0 ? dollars(-statementC) : 0,
    minimumDue: dollars(minimumC),
    paidSinceStatement: dollars(paidC),
    remainingStatement: dollars(status === 'none' ? 0 : remainingC),
    remainingMinimum: dollars(status === 'none' ? 0 : remainingMinC),
    newPurchases: dollars(cents(ledger.purchases_since_close)),
    status,
    daysUntilDue: Math.ceil((cycle.dueMs - nowMs) / DAY_MS),
  };
}

async function readLedger(sql, accountId, cycle) {
  const closeIso = new Date(cycle.closeMs).toISOString();
  const rows = await sql`
    SELECT
      (SELECT balance FROM accounts WHERE id = ${accountId}) AS balance,
      COALESCE(SUM(amount) FILTER (WHERE created_at >= ${closeIso}::timestamptz), 0) AS since_close_net,
      COALESCE(-SUM(amount) FILTER (WHERE created_at >= ${closeIso}::timestamptz AND amount < 0), 0) AS credits_since_close,
      COALESCE(SUM(amount) FILTER (WHERE created_at >= ${closeIso}::timestamptz AND type = 'credit_purchase'), 0) AS purchases_since_close,
      COALESCE(SUM(ROUND(amount * ${CASH_BACK_RATE}::numeric, 2)) FILTER (WHERE type = 'credit_purchase' AND amount > 0), 0) AS cash_back_earned,
      COALESCE(SUM(ROUND(-amount * ${CASH_BACK_RATE}::numeric, 2)) FILTER (WHERE type = 'credit_refund' AND amount < 0), 0) AS cash_back_reversed,
      COALESCE(SUM(ROUND(amount * ${CASH_BACK_RATE}::numeric, 2)) FILTER (WHERE type = 'credit_purchase' AND amount > 0 AND created_at >= ${closeIso}::timestamptz), 0) AS cash_back_this_period
    FROM transactions
    WHERE account_id = ${accountId}
  `;
  return rows[0];
}

// ---------------------------------------------------------------------------
// Expiry
// ---------------------------------------------------------------------------

function newExpiry(nowMs = Date.now()) {
  const d = new Date(nowMs);
  return { month: d.getUTCMonth() + 1, year: d.getUTCFullYear() + CARD_VALID_YEARS };
}

async function ensureExpiry(sql, accountId, details, nowMs = Date.now()) {
  if (details && details.expiry_month && details.expiry_year) {
    return { month: Number(details.expiry_month), year: Number(details.expiry_year) };
  }
  const exp = newExpiry(nowMs);
  const rows = await sql`
    UPDATE credit_card_details
    SET expiry_month = COALESCE(expiry_month, ${exp.month}::int), expiry_year = COALESCE(expiry_year, ${exp.year}::int)
    WHERE account_id = ${accountId}
    RETURNING expiry_month, expiry_year
  `;
  if (!rows.length) return exp;
  return { month: Number(rows[0].expiry_month), year: Number(rows[0].expiry_year) };
}

// ---------------------------------------------------------------------------
// Autopay
// ---------------------------------------------------------------------------

async function getAutopayMode(sql, userId) {
  const rows = await sql`SELECT mode FROM card_autopay WHERE user_id = ${userId}`;
  return rows.length && AUTOPAY_MODES.includes(rows[0].mode) ? rows[0].mode : 'off';
}

async function setAutopay(sql, userId, mode) {
  const m = String(mode || '');
  if (!AUTOPAY_MODES.includes(m)) throw new CardError(400, 'Choose off, minimum payment, statement balance or full balance.');
  await sql`
    INSERT INTO card_autopay (user_id, mode, updated_at) VALUES (${userId}, ${m}, NOW())
    ON CONFLICT (user_id) DO UPDATE SET mode = EXCLUDED.mode, updated_at = NOW()
  `;
  return m;
}

function autopayAmountCents(mode, statement, balance) {
  if (mode === 'off' || statement.status === 'none' || statement.status === 'paid') return 0;
  if (mode === 'minimum') return cents(statement.remainingMinimum);
  if (mode === 'statement') return cents(statement.remainingStatement);
  if (mode === 'balance') return Math.max(0, cents(balance));
  return 0;
}

// When autopay will next pay, for the screen.
function autopayNextRun(mode, statement, balance, cycle, nowMs = Date.now()) {
  if (mode === 'off') return null;
  const stillToPay = autopayAmountCents(mode, statement, balance) > 0;
  if (stillToPay && nowMs < cycle.dueMs + AUTOPAY_WINDOW_DAYS * DAY_MS) {
    const d = new Date(nowMs);
    const today = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
    return iso(Math.max(cycle.dueMs, today));
  }
  return iso(cycle.nextDueMs);
}

const AUTOPAY_LABELS = {
  minimum: 'minimum payment',
  statement: 'statement balance',
  balance: 'full balance',
};

// Checking -> card, both ledger rows, all or nothing.
async function payCardFromChecking(sql, { cardAccountId, checkingAccountId, amount, checkingDescription, cardDescription }) {
  const rows = await sql`
    WITH card AS (
      UPDATE accounts SET balance = balance - ${amount}::numeric
      WHERE id = ${cardAccountId} AND balance >= ${amount}::numeric
      RETURNING id, balance
    ),
    debit AS (
      UPDATE accounts SET balance = balance - ${amount}::numeric
      WHERE id = ${checkingAccountId} AND balance >= ${amount}::numeric AND restriction_level IS DISTINCT FROM 'full' AND EXISTS (SELECT 1 FROM card)
      RETURNING id, balance
    ),
    checking_txn AS (
      INSERT INTO transactions (account_id, type, amount, description, created_at)
      VALUES ((SELECT id FROM debit), 'debit', ${amount}::numeric, ${checkingDescription}::text, NOW())
      RETURNING id
    ),
    card_txn AS (
      INSERT INTO transactions (account_id, type, amount, description, created_at)
      VALUES ((SELECT id FROM card), 'credit_payment', ${-amount}::numeric, ${cardDescription}::text, NOW())
      RETURNING id
    )
    SELECT
      (SELECT balance FROM card) AS card_balance,
      (SELECT id FROM checking_txn) AS transaction_id,
      (SELECT COUNT(*) FROM card_txn) AS card_rows,
      1 / ((SELECT COUNT(*) FROM card) * (SELECT COUNT(*) FROM debit)) AS guard
  `;
  return rows[0];
}

async function claimNotice(sql, userId, statementDate, kind) {
  const rows = await sql`
    INSERT INTO card_notices (user_id, statement_date, kind) VALUES (${userId}, ${statementDate}::date, ${kind})
    ON CONFLICT DO NOTHING
    RETURNING kind
  `;
  return rows.length > 0;
}

// Statement-ready notice, reminders, autopay and past-due notice for one
// person. Returns the notifications to send; the caller sends them.
async function runCardCycleForUser(sql, { userId, account, nowMs = Date.now() }) {
  const out = { notifications: [], autopaid: 0, autopayFailed: false };
  if (!account || !account.id) return out;
  const cycle = cycleFor(nowMs);
  let ledger = await readLedger(sql, account.id, cycle);
  let statement = computeStatement(ledger, cycle, nowMs);
  if (statement.status === 'none') return out;

  const key = cycle.statementDate;
  const due = shortDate(cycle.dueMs);

  // 1. Statement ready (only worth saying while something is still owed).
  if (await claimNotice(sql, userId, key, 'statement') && (statement.status === 'due' || statement.status === 'past_due')) {
    out.notifications.push({
      userId,
      title: 'Your card statement is ready',
      message: `Statement balance ${money(statement.statementBalance)}. Minimum payment ${money(statement.remainingMinimum)} due ${due}.`,
    });
  }

  const mode = await getAutopayMode(sql, userId);

  // 2. A few days before the due date: a reminder, or a heads-up that autopay will run.
  if (nowMs >= cycle.dueMs - REMINDER_DAYS * DAY_MS && nowMs < cycle.dueMs) {
    if (mode === 'off') {
      if (statement.remainingMinimum > 0 && await claimNotice(sql, userId, key, 'reminder')) {
        out.notifications.push({
          userId,
          title: `Card payment due ${due}`,
          message: `Your minimum payment of ${money(statement.remainingMinimum)} is due ${due}. Statement balance: ${money(statement.remainingStatement)}.`,
        });
      }
    } else {
      const amountC = autopayAmountCents(mode, statement, ledger.balance);
      if (amountC > 0 && await claimNotice(sql, userId, key, 'autopay_upcoming')) {
        const checking = await sql`SELECT balance FROM accounts WHERE user_id = ${userId} AND account_type = 'checking' LIMIT 1`;
        const low = checking.length && cents(checking[0].balance) < amountC;
        out.notifications.push({
          userId,
          title: `Autopay on ${due}`,
          message: `We'll pay your ${AUTOPAY_LABELS[mode]} of ${money(dollars(amountC))} from checking on ${due}.` + (low ? ' Your checking balance is lower than that right now, so add money before then.' : ''),
        });
      }
    }
  }

  // 3. Autopay on the due date (or within a few days after, if the run was late).
  if (mode !== 'off' && nowMs >= cycle.dueMs && nowMs < cycle.dueMs + AUTOPAY_WINDOW_DAYS * DAY_MS) {
    const amountC = autopayAmountCents(mode, statement, ledger.balance);
    if (amountC > 0 && await claimNotice(sql, userId, key, 'autopay')) {
      const amount = dollars(amountC);
      const checkingRows = await sql`SELECT id, balance, restriction_level FROM accounts WHERE user_id = ${userId} AND account_type = 'checking' LIMIT 1`;
      const checking = checkingRows[0];
      let failure = null;
      if (!checking) failure = "we couldn't find your checking account";
      else if (checking.restriction_level === 'full' || account.restriction_level === 'full') failure = 'there is a hold on your account';
      else if (cents(checking.balance) < amountC) failure = `your checking balance was lower than ${money(amount)}`;
      if (!failure) {
        try {
          await payCardFromChecking(sql, {
            cardAccountId: account.id,
            checkingAccountId: checking.id,
            amount,
            checkingDescription: 'Credit Card Payment (Autopay)',
            cardDescription: 'Autopay Payment - Thank You',
          });
          out.autopaid = amount;
          out.notifications.push({
            userId,
            title: 'Autopay payment made',
            message: `We paid ${money(amount)} to your card from checking (${AUTOPAY_LABELS[mode]}).`,
          });
        } catch (err) {
          if (!isGuard(err)) throw err;
          failure = 'your balances changed while we were paying';
        }
      }
      if (failure) {
        out.autopayFailed = true;
        out.notifications.push({
          userId,
          title: "Autopay couldn't be made",
          message: `Nothing was paid because ${failure}. Make a payment from Cards to stay on track.`,
        });
      } else {
        ledger = await readLedger(sql, account.id, cycle);
        statement = computeStatement(ledger, cycle, nowMs);
      }
    }
  }

  // 4. Past due.
  if (statement.status === 'past_due' && await claimNotice(sql, userId, key, 'past_due')) {
    out.notifications.push({
      userId,
      title: 'Card payment past due',
      message: `We didn't receive your minimum payment of ${money(statement.remainingMinimum)} by ${due}. Pay as soon as you can from Cards.`,
    });
  }
  return out;
}

async function runAllCardCycles(sql, nowMs = Date.now()) {
  await ensureCardsSchema(sql);
  const cards = await sql`
    SELECT a.id, a.user_id, a.balance, a.restriction_level
    FROM accounts a
    JOIN credit_card_details d ON d.account_id = a.id
    WHERE a.account_type = 'credit'
  `;
  const result = { usersChecked: 0, autopayments: 0, autopaidTotal: 0, notifications: [], failed: 0 };
  for (const c of cards) {
    try {
      const r = await runCardCycleForUser(sql, { userId: c.user_id, account: c, nowMs });
      result.usersChecked++;
      if (r.autopaid) { result.autopayments++; result.autopaidTotal = dollars(cents(result.autopaidTotal) + cents(r.autopaid)); }
      result.notifications.push(...r.notifications);
    } catch (err) {
      result.failed++;
      console.error('Card cycle error for user', c.user_id, err);
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Cash back
// ---------------------------------------------------------------------------

function rewardsFrom(ledger, redeemed) {
  const earnedC = Math.max(0, cents(ledger.cash_back_earned) - cents(ledger.cash_back_reversed));
  const redeemedC = cents(redeemed);
  return {
    rate: CASH_BACK_RATE,
    earned: dollars(earnedC),
    redeemed: dollars(redeemedC),
    available: dollars(Math.max(0, earnedC - redeemedC)),
    thisPeriod: dollars(cents(ledger.cash_back_this_period)),
    minRedeem: MIN_REDEEM,
  };
}

function cashBackFor(amount) {
  return dollars(Math.round(Number(amount || 0) * CASH_BACK_RATE * 100));
}

async function redeemRewards(sql, { userId, cardAccountId, amount, destination }) {
  const dest = String(destination || '');
  if (dest !== 'checking' && dest !== 'statement') throw new CardError(400, 'Choose where the cash back should go.');

  const cycle = cycleFor();
  const [ledger, rewardRows] = await Promise.all([
    readLedger(sql, cardAccountId, cycle),
    sql`SELECT redeemed FROM card_rewards WHERE user_id = ${userId}`,
  ]);
  const rewards = rewardsFrom(ledger, rewardRows.length ? rewardRows[0].redeemed : 0);
  const wantC = amount === undefined || amount === null || amount === '' ? cents(rewards.available) : cents(amount);
  if (cents(rewards.available) < MIN_REDEEM * 100) throw new CardError(400, `You can redeem once you have at least ${money(MIN_REDEEM)} in cash back.`);
  if (!Number.isFinite(wantC) || wantC <= 0) throw new CardError(400, 'Enter an amount to redeem.');
  if (wantC < MIN_REDEEM * 100) throw new CardError(400, `The smallest amount you can redeem is ${money(MIN_REDEEM)}.`);
  if (wantC > cents(rewards.available)) throw new CardError(400, `You have ${money(rewards.available)} available to redeem.`);
  const amt = dollars(wantC);

  let checking = null;
  if (dest === 'checking') {
    const rows = await sql`SELECT id, restriction_level FROM accounts WHERE user_id = ${userId} AND account_type = 'checking' LIMIT 1`;
    if (!rows.length) throw new CardError(404, 'Checking account not found.');
    if (rows[0].restriction_level === 'full') throw new CardError(403, 'There is an issue on this account that requires in-person verification at a branch.');
    checking = rows[0];
  } else if (cents(ledger.balance) < wantC) {
    throw new CardError(400, cents(ledger.balance) <= 0
      ? "Your card doesn't have a balance to credit. Send the cash back to checking instead."
      : `Your card balance is ${money(dollars(cents(ledger.balance)))}. Redeem up to that as a statement credit, or send it to checking.`);
  }

  await sql`INSERT INTO card_rewards (user_id) VALUES (${userId}) ON CONFLICT (user_id) DO NOTHING`;

  let row;
  try {
    const rows = dest === 'checking'
      ? await sql`
        WITH earned AS (
          SELECT GREATEST(0,
            COALESCE(SUM(ROUND(amount * ${CASH_BACK_RATE}::numeric, 2)) FILTER (WHERE type = 'credit_purchase' AND amount > 0), 0)
            - COALESCE(SUM(ROUND(-amount * ${CASH_BACK_RATE}::numeric, 2)) FILTER (WHERE type = 'credit_refund' AND amount < 0), 0)) AS total
          FROM transactions WHERE account_id = ${cardAccountId}
        ),
        claim AS (
          UPDATE card_rewards r SET redeemed = r.redeemed + ${amt}::numeric, updated_at = NOW()
          WHERE r.user_id = ${userId} AND r.redeemed + ${amt}::numeric <= (SELECT total FROM earned)
          RETURNING r.user_id
        ),
        moved AS (
          UPDATE accounts SET balance = balance + ${amt}::numeric
          WHERE id = ${checking.id} AND EXISTS (SELECT 1 FROM claim)
          RETURNING id, balance
        ),
        txn AS (
          INSERT INTO transactions (account_id, type, amount, description, created_at)
          VALUES ((SELECT id FROM moved), 'credit', ${amt}::numeric, 'Cash back reward', NOW())
          RETURNING id
        ),
        logged AS (
          INSERT INTO card_reward_redemptions (user_id, amount, destination, transaction_id)
          SELECT user_id, ${amt}::numeric, 'checking', (SELECT id FROM txn) FROM claim
          RETURNING id
        )
        SELECT (SELECT id FROM txn) AS transaction_id, (SELECT balance FROM moved) AS balance, (SELECT COUNT(*) FROM logged) AS logged,
               1 / ((SELECT COUNT(*) FROM claim) * (SELECT COUNT(*) FROM moved)) AS guard
      `
      : await sql`
        WITH earned AS (
          SELECT GREATEST(0,
            COALESCE(SUM(ROUND(amount * ${CASH_BACK_RATE}::numeric, 2)) FILTER (WHERE type = 'credit_purchase' AND amount > 0), 0)
            - COALESCE(SUM(ROUND(-amount * ${CASH_BACK_RATE}::numeric, 2)) FILTER (WHERE type = 'credit_refund' AND amount < 0), 0)) AS total
          FROM transactions WHERE account_id = ${cardAccountId}
        ),
        claim AS (
          UPDATE card_rewards r SET redeemed = r.redeemed + ${amt}::numeric, updated_at = NOW()
          WHERE r.user_id = ${userId} AND r.redeemed + ${amt}::numeric <= (SELECT total FROM earned)
          RETURNING r.user_id
        ),
        moved AS (
          UPDATE accounts SET balance = balance - ${amt}::numeric
          WHERE id = ${cardAccountId} AND balance >= ${amt}::numeric AND EXISTS (SELECT 1 FROM claim)
          RETURNING id, balance
        ),
        txn AS (
          INSERT INTO transactions (account_id, type, amount, description, created_at)
          VALUES ((SELECT id FROM moved), 'credit_reward', ${-amt}::numeric, 'Cash back statement credit', NOW())
          RETURNING id
        ),
        logged AS (
          INSERT INTO card_reward_redemptions (user_id, amount, destination, transaction_id)
          SELECT user_id, ${amt}::numeric, 'statement', (SELECT id FROM txn) FROM claim
          RETURNING id
        )
        SELECT (SELECT id FROM txn) AS transaction_id, (SELECT balance FROM moved) AS balance, (SELECT COUNT(*) FROM logged) AS logged,
               1 / ((SELECT COUNT(*) FROM claim) * (SELECT COUNT(*) FROM moved)) AS guard
      `;
    row = rows[0];
  } catch (err) {
    if (isGuard(err)) throw new CardError(409, 'Your cash back or balance changed. Nothing was redeemed, so please try again.');
    throw err;
  }

  return {
    amount: amt,
    destination: dest,
    transactionId: row.transaction_id != null ? Number(row.transaction_id) : null,
    balance: Number(row.balance),
    notification: {
      title: 'Cash back redeemed',
      message: dest === 'checking'
        ? `${money(amt)} in cash back was deposited to your checking account.`
        : `${money(amt)} in cash back was applied to your card as a statement credit.`,
    },
  };
}

// ---------------------------------------------------------------------------
// Spending this statement period, by category
// ---------------------------------------------------------------------------

async function spendingThisPeriod(sql, accountId, cycle) {
  const closeIso = new Date(cycle.closeMs).toISOString();
  const rows = await sql`
    SELECT type, amount, description FROM transactions
    WHERE account_id = ${accountId} AND type = 'credit_purchase' AND amount > 0 AND created_at >= ${closeIso}::timestamptz
  `;
  const byCat = new Map();
  let totalC = 0;
  for (const t of rows) {
    const cat = categorize(t);
    const c = cents(t.amount);
    totalC += c;
    const cur = byCat.get(cat.id) || { id: cat.id, name: cat.name, icon: cat.icon, color: cat.color, amountC: 0, count: 0 };
    cur.amountC += c;
    cur.count += 1;
    byCat.set(cat.id, cur);
  }
  const categories = [...byCat.values()]
    .sort((a, b) => b.amountC - a.amountC)
    .map((c) => ({ id: c.id, name: c.name, icon: c.icon, color: c.color, amount: dollars(c.amountC), count: c.count, share: totalC ? Math.round((c.amountC / totalC) * 1000) / 1000 : 0 }));
  return { since: iso(cycle.closeMs), total: dollars(totalC), count: rows.length, categories };
}

// ---------------------------------------------------------------------------
// Everything the Cards screen needs beyond the basics
// ---------------------------------------------------------------------------

async function getCardOverview(sql, { userId, account, details, nowMs = Date.now() }) {
  await ensureCardsSchema(sql);
  const cycle = cycleFor(nowMs);
  const [expiry, ledger, extra, spending] = await Promise.all([
    ensureExpiry(sql, account.id, details, nowMs),
    readLedger(sql, account.id, cycle),
    sql`
      SELECT
        (SELECT mode FROM card_autopay WHERE user_id = ${userId}) AS mode,
        (SELECT redeemed FROM card_rewards WHERE user_id = ${userId}) AS redeemed,
        (SELECT balance FROM accounts WHERE user_id = ${userId} AND account_type = 'checking' ORDER BY id LIMIT 1) AS checking_balance,
        (SELECT account_number FROM accounts WHERE user_id = ${userId} AND account_type = 'checking' ORDER BY id LIMIT 1) AS checking_number
    `,
    spendingThisPeriod(sql, account.id, cycle),
  ]);
  const statement = computeStatement(ledger, cycle, nowMs);
  const x = extra[0] || {};
  const mode = AUTOPAY_MODES.includes(x.mode) ? x.mode : 'off';
  const num = x.checking_number ? String(x.checking_number) : '';
  return {
    expiryMonth: expiry.month,
    expiryYear: expiry.year,
    statement,
    autopay: {
      mode,
      label: mode === 'off' ? null : AUTOPAY_LABELS[mode],
      nextRunDate: autopayNextRun(mode, statement, ledger.balance, cycle, nowMs),
      nextAmount: mode === 'off' ? 0 : dollars(autopayAmountCents(mode, statement, ledger.balance)),
    },
    rewards: rewardsFrom(ledger, x.redeemed || 0),
    spending,
    checking: x.checking_balance == null ? null : { balance: Number(x.checking_balance), lastFour: num.slice(-4) || null },
    replacedAt: details && details.replaced_at ? details.replaced_at : null,
    replacedReason: details && details.replaced_reason ? details.replaced_reason : null,
  };
}

// ---------------------------------------------------------------------------
// Replace a card
// ---------------------------------------------------------------------------

function newLastFour(old) {
  let n;
  do { n = String(Math.floor(1000 + Math.random() * 9000)); } while (n === String(old || ''));
  return n;
}

// lost / stolen: new number, new expiry, old number stops working, PIN reset,
//                and the card is unfrozen (the new number is safe to use).
// damaged:       same number, new expiry; PIN and freeze stay as they were.
async function replaceCard(sql, { accountId, details, reason, nowMs = Date.now() }) {
  await ensureCardsSchema(sql);
  const why = reason === undefined || reason === null || reason === '' ? 'lost' : String(reason);
  if (!REPLACE_REASONS.includes(why)) throw new CardError(400, 'Choose lost, stolen or damaged.');
  const exp = newExpiry(nowMs);
  const oldFour = details && details.last_four ? String(details.last_four) : null;
  const stamp = new Date(nowMs).toISOString();

  if (why === 'damaged') {
    const rows = await sql`
      UPDATE credit_card_details
      SET expiry_month = ${exp.month}::int, expiry_year = ${exp.year}::int, replaced_at = ${stamp}::timestamptz, replaced_reason = 'damaged'
      WHERE account_id = ${accountId}
      RETURNING last_four
    `;
    const four = rows.length ? rows[0].last_four : oldFour;
    return {
      reason: why,
      numberChanged: false,
      lastFour: four,
      expiryMonth: exp.month,
      expiryYear: exp.year,
      message: 'Your replacement card is ready. Your card number and PIN stay the same.',
      notification: {
        title: 'Replacement card issued',
        message: `We issued a replacement for your damaged card ending in ${four || '****'}. The number and PIN stay the same; the new expiry date is ${String(exp.month).padStart(2, '0')}/${String(exp.year).slice(-2)}.`,
      },
    };
  }

  const four = newLastFour(oldFour);
  await sql`
    UPDATE credit_card_details
    SET last_four = ${four}, is_frozen = FALSE, pin_hash = NULL,
        expiry_month = ${exp.month}::int, expiry_year = ${exp.year}::int,
        replaced_at = ${stamp}::timestamptz, replaced_reason = ${why}
    WHERE account_id = ${accountId}
  `;
  return {
    reason: why,
    numberChanged: true,
    lastFour: four,
    expiryMonth: exp.month,
    expiryYear: exp.year,
    message: 'A replacement card has been issued. Your old card is now inactive.',
    notification: {
      title: 'New Card Issued',
      message: `Your previous card ending in ${oldFour || '****'} was reported ${why}. A new card ending in ${four} has been issued. Set a new PIN from Cards.`,
    },
  };
}

module.exports = {
  CASH_BACK_RATE,
  AUTOPAY_MODES,
  REPLACE_REASONS,
  MIN_REDEEM,
  CardError,
  ensureCardsSchema,
  cycleFor,
  computeStatement,
  minimumFor,
  cashBackFor,
  getCardOverview,
  setAutopay,
  getAutopayMode,
  redeemRewards,
  replaceCard,
  runCardCycleForUser,
  runAllCardCycles,
  payCardFromChecking,
  spendingThisPeriod,
};
