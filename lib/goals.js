// Savings goals with round-ups.
//
// A goal is money set aside from checking or savings toward something specific
// ("Laptop, $1,200 by December"). Goal balances live in savings_goals, separate
// from the accounts table, so nothing else in the app mistakes a goal for an
// account.
//
// Every money move here is ONE SQL statement, the same pattern as
// api/account-services.js: the account balance, the goal balance, the ledger
// row and the goal activity row change together or not at all. Each statement
// ends with a `1 / COUNT(*)` guard. If a step matched no rows (not enough money,
// goal closed, balance changed underneath us), the guard divides by zero and
// Postgres rolls the whole statement back.
//
// Round-ups: one goal at a time collects round-ups. Every card purchase posted
// after round-ups were turned on is rounded up to the next dollar, and the
// spare change moves from checking into that goal. Each purchase is claimed in
// savings_goal_roundups (primary key = transaction id), so a purchase can never
// be rounded up twice, even if two sweeps run at the same moment. The daily
// cron sweeps everyone, and people can also move pending round-ups right away.

const MAX_ACTIVE_GOALS = 10;
const MIN_TARGET = 1;
const MAX_TARGET = 1000000;
const MAX_NAME_LENGTH = 40;
const GOAL_ICONS = ['piggy', 'plane', 'laptop', 'car', 'house', 'school', 'gift', 'heart', 'ring', 'shield'];
const MONEY_ACCOUNT_TYPES = ['checking', 'savings'];
const ACCOUNT_LABELS = { checking: 'checking', savings: 'savings' };
const SWEEP_BATCH = 500;

class GoalError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.name = 'GoalError';
    this.status = status;
    this.extra = extra || {};
  }
}

function isGuardFailure(err) {
  if (!err) return false;
  // 22012 = division_by_zero (our guard), 23502 = not_null_violation (a ledger
  // insert whose account step matched nothing).
  return err.code === '22012' || err.code === '23502' || /division by zero/i.test(String(err.message || ''));
}

let schemaReady = false;

async function ensureGoalsSchema(sql) {
  if (schemaReady) return;
  await sql`
    CREATE TABLE IF NOT EXISTS savings_goals (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      icon TEXT NOT NULL DEFAULT 'piggy',
      target_amount NUMERIC(14,2) NOT NULL CHECK (target_amount > 0),
      balance NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (balance >= 0),
      target_date DATE,
      roundups_enabled BOOLEAN NOT NULL DEFAULT FALSE,
      roundups_started_at TIMESTAMPTZ,
      reached_at TIMESTAMPTZ,
      closed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS savings_goals_user_idx ON savings_goals (user_id, created_at)`;
  // At most one goal per person collects round-ups.
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS savings_goals_one_roundup_goal
    ON savings_goals (user_id) WHERE roundups_enabled AND closed_at IS NULL
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS savings_goal_activity (
      id SERIAL PRIMARY KEY,
      goal_id INTEGER NOT NULL REFERENCES savings_goals(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL,
      kind TEXT NOT NULL,
      amount NUMERIC(14,2) NOT NULL,
      balance_after NUMERIC(14,2) NOT NULL,
      account_type TEXT,
      purchase_count INTEGER,
      transaction_id INTEGER,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS savings_goal_activity_goal_idx ON savings_goal_activity (goal_id, created_at DESC)`;
  await sql`
    CREATE TABLE IF NOT EXISTS savings_goal_roundups (
      transaction_id INTEGER PRIMARY KEY,
      goal_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      purchase_amount NUMERIC(14,2) NOT NULL,
      spare NUMERIC(14,2) NOT NULL,
      swept_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS savings_goal_roundups_user_idx ON savings_goal_roundups (user_id, swept_at DESC)`;
  schemaReady = true;
}

// ---------- Input helpers ----------

function toCents(value) {
  if (value === null || value === undefined || value === '') return NaN;
  const n = Number(value);
  if (!Number.isFinite(n)) return NaN;
  return Math.round(n * 100) / 100;
}

function money(n) {
  return Number(n).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

function cleanName(name) {
  return String(name == null ? '' : name)
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function validateName(raw) {
  const name = cleanName(raw);
  if (!name) throw new GoalError(400, 'Give your goal a name.');
  if (name.length > MAX_NAME_LENGTH) throw new GoalError(400, `Keep the name to ${MAX_NAME_LENGTH} characters or fewer.`);
  return name;
}

function validateTarget(raw) {
  const target = toCents(raw);
  if (!Number.isFinite(target) || target < MIN_TARGET) throw new GoalError(400, 'Set a target of at least $1.');
  if (target > MAX_TARGET) throw new GoalError(400, 'Targets can be up to $1,000,000.');
  return target;
}

// Target dates are optional calendar dates (YYYY-MM-DD). "Today" is accepted in
// any timezone, so the check allows one day of slack behind UTC.
function parseTargetDate(value) {
  if (value === null || value === undefined || value === '') return null;
  const s = String(value);
  const d = new Date(`${s}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) {
    throw new GoalError(400, 'Pick a valid target date.');
  }
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  if (d.getTime() < today.getTime() - 86400000) throw new GoalError(400, 'Pick a target date that is still ahead.');
  const latest = new Date(today);
  latest.setUTCFullYear(latest.getUTCFullYear() + 30);
  if (d > latest) throw new GoalError(400, 'Pick a target date within the next 30 years.');
  return s;
}

function parseGoalId(value) {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) throw new GoalError(404, 'That goal was not found.');
  return id;
}

function serializeGoal(r) {
  const balance = Number(r.balance);
  const targetAmount = Number(r.target_amount);
  return {
    id: Number(r.id),
    name: r.name,
    icon: GOAL_ICONS.includes(r.icon) ? r.icon : 'piggy',
    balance,
    targetAmount,
    targetDate: r.target_date || null,
    roundupsEnabled: r.roundups_enabled === true,
    reachedAt: r.reached_at || null,
    createdAt: r.created_at,
    progress: targetAmount > 0 ? Math.min(1, balance / targetAmount) : 0,
  };
}

// ---------- Lookups ----------

async function getActiveGoal(sql, userId, goalId) {
  const id = parseGoalId(goalId);
  const rows = await sql`
    SELECT id, name, icon, balance, target_amount, to_char(target_date, 'YYYY-MM-DD') AS target_date,
           roundups_enabled, reached_at, created_at
    FROM savings_goals
    WHERE id = ${id} AND user_id = ${userId} AND closed_at IS NULL
    LIMIT 1
  `;
  if (rows.length === 0) throw new GoalError(404, 'That goal was not found.');
  return serializeGoal(rows[0]);
}

async function getMoneyAccount(sql, userId, accountType) {
  const type = accountType || 'checking';
  if (!MONEY_ACCOUNT_TYPES.includes(type)) throw new GoalError(400, 'Choose checking or savings.');
  const rows = await sql`
    SELECT id, balance, restriction_level
    FROM accounts
    WHERE user_id = ${userId} AND account_type = ${type}
    ORDER BY id
    LIMIT 1
  `;
  if (rows.length === 0) throw new GoalError(400, `You don't have a ${ACCOUNT_LABELS[type]} account.`);
  const account = rows[0];
  if (account.restriction_level && account.restriction_level !== 'none') {
    throw new GoalError(403, 'There is an issue on this account that requires in-person verification at a branch. Please visit any of our branches with a valid ID to resolve this issue.', {
      accountRestricted: true,
      restrictionLevel: account.restriction_level,
    });
  }
  return { id: Number(account.id), balance: Number(account.balance), type };
}

// ---------- Reading ----------

async function pendingRoundups(sql, userId) {
  const rows = await sql`
    SELECT g.id AS goal_id, g.name AS goal_name, g.roundups_started_at,
           COALESCE(SUM(CEIL(t.amount) - t.amount), 0) AS amount,
           COUNT(t.id)::int AS purchases
    FROM savings_goals g
    LEFT JOIN accounts a ON a.user_id = g.user_id AND a.account_type = 'credit'
    LEFT JOIN transactions t
      ON t.account_id = a.id
     AND t.type = 'credit_purchase'
     AND t.amount > 0
     AND t.amount <> CEIL(t.amount)
     AND t.created_at >= g.roundups_started_at
     AND NOT EXISTS (SELECT 1 FROM savings_goal_roundups r WHERE r.transaction_id = t.id)
    WHERE g.user_id = ${userId} AND g.roundups_enabled AND g.closed_at IS NULL
    GROUP BY g.id, g.name, g.roundups_started_at
    LIMIT 1
  `;
  const lifetime = await sql`
    SELECT COALESCE(SUM(spare), 0) AS total FROM savings_goal_roundups WHERE user_id = ${userId}
  `;
  const lifetimeSaved = Number((lifetime[0] || {}).total || 0);
  if (rows.length === 0) {
    return { enabled: false, goalId: null, goalName: null, since: null, pendingAmount: 0, pendingPurchases: 0, lifetimeSaved };
  }
  const r = rows[0];
  return {
    enabled: true,
    goalId: Number(r.goal_id),
    goalName: r.goal_name,
    since: r.roundups_started_at,
    pendingAmount: Number(r.amount),
    pendingPurchases: Number(r.purchases),
    lifetimeSaved,
  };
}

async function listGoals(sql, userId) {
  const rows = await sql`
    SELECT id, name, icon, balance, target_amount, to_char(target_date, 'YYYY-MM-DD') AS target_date,
           roundups_enabled, reached_at, created_at
    FROM savings_goals
    WHERE user_id = ${userId} AND closed_at IS NULL
    ORDER BY created_at, id
  `;
  const goals = rows.map(serializeGoal);
  const totalSaved = Math.round(goals.reduce((sum, g) => sum + g.balance, 0) * 100) / 100;
  const roundups = await pendingRoundups(sql, userId);
  return { goals, totalSaved, roundups, maxGoals: MAX_ACTIVE_GOALS };
}

async function getGoalActivity(sql, userId, goalId, limit = 20) {
  const id = parseGoalId(goalId);
  const rows = await sql`
    SELECT a.id, a.kind, a.amount, a.balance_after, a.account_type, a.purchase_count, a.created_at
    FROM savings_goal_activity a
    JOIN savings_goals g ON g.id = a.goal_id
    WHERE a.goal_id = ${id} AND g.user_id = ${userId}
    ORDER BY a.created_at DESC, a.id DESC
    LIMIT ${Math.min(Math.max(Number(limit) || 20, 1), 100)}
  `;
  return rows.map((r) => ({
    id: Number(r.id),
    kind: r.kind,
    amount: Number(r.amount),
    balanceAfter: Number(r.balance_after),
    accountType: r.account_type || null,
    purchaseCount: r.purchase_count == null ? null : Number(r.purchase_count),
    createdAt: r.created_at,
  }));
}

// Used by /api/me so the home screen total includes money in goals. Before
// anyone has made a goal the table may not exist yet; that simply means $0.
async function getGoalsTotal(sql, userId) {
  try {
    const rows = await sql`
      SELECT COALESCE(SUM(balance), 0) AS total, COUNT(*)::int AS goals
      FROM savings_goals
      WHERE user_id = ${userId} AND closed_at IS NULL
    `;
    return { total: Number(rows[0].total) || 0, count: Number(rows[0].goals) || 0 };
  } catch (err) {
    if (err && err.code === '42P01') return { total: 0, count: 0 };
    throw err;
  }
}

// ---------- Creating and editing ----------

async function createGoal(sql, userId, input) {
  const name = validateName(input.name);
  const target = validateTarget(input.targetAmount);
  const targetDate = parseTargetDate(input.targetDate);
  const icon = GOAL_ICONS.includes(input.icon) ? input.icon : 'piggy';

  const rows = await sql`
    INSERT INTO savings_goals (user_id, name, icon, target_amount, target_date)
    SELECT ${userId}::int, ${name}::text, ${icon}::text, ${target}::numeric, ${targetDate}::date
    WHERE (SELECT COUNT(*) FROM savings_goals WHERE user_id = ${userId} AND closed_at IS NULL) < ${MAX_ACTIVE_GOALS}
    RETURNING id, name, icon, balance, target_amount, to_char(target_date, 'YYYY-MM-DD') AS target_date,
              roundups_enabled, reached_at, created_at
  `;
  if (rows.length === 0) {
    throw new GoalError(400, `You can have up to ${MAX_ACTIVE_GOALS} goals at a time. Close one to start another.`);
  }
  return serializeGoal(rows[0]);
}

async function updateGoal(sql, userId, input) {
  const current = await getActiveGoal(sql, userId, input.goalId);
  const name = input.name !== undefined ? validateName(input.name) : current.name;
  const target = input.targetAmount !== undefined ? validateTarget(input.targetAmount) : current.targetAmount;
  const targetDate = input.targetDate !== undefined ? parseTargetDate(input.targetDate) : current.targetDate;
  const icon = input.icon !== undefined && GOAL_ICONS.includes(input.icon) ? input.icon : current.icon;

  const rows = await sql`
    UPDATE savings_goals
    SET name = ${name},
        icon = ${icon},
        target_amount = ${target},
        target_date = ${targetDate}::date,
        reached_at = CASE WHEN balance >= ${target} THEN COALESCE(reached_at, NOW()) ELSE NULL END,
        updated_at = NOW()
    WHERE id = ${current.id} AND user_id = ${userId} AND closed_at IS NULL
    RETURNING id, name, icon, balance, target_amount, to_char(target_date, 'YYYY-MM-DD') AS target_date,
              roundups_enabled, reached_at, created_at
  `;
  if (rows.length === 0) throw new GoalError(404, 'That goal was not found.');
  return serializeGoal(rows[0]);
}

// ---------- Moving money ----------

function validateMoveAmount(raw) {
  const amount = toCents(raw);
  if (!Number.isFinite(amount) || amount <= 0) throw new GoalError(400, 'Enter an amount.');
  if (amount > MAX_TARGET) throw new GoalError(400, 'Moves are limited to $1,000,000 at a time.');
  return amount;
}

async function moveIntoGoal(sql, userId, input) {
  const amount = validateMoveAmount(input.amount);
  const goal = await getActiveGoal(sql, userId, input.goalId);
  const account = await getMoneyAccount(sql, userId, input.accountType || 'checking');
  if (account.balance < amount) {
    throw new GoalError(400, `You have ${money(account.balance)} in ${ACCOUNT_LABELS[account.type]}. Enter a smaller amount.`);
  }

  let rows;
  try {
    rows = await sql`
      WITH debit AS (
        UPDATE accounts
        SET balance = balance - ${amount}
        WHERE id = ${account.id} AND user_id = ${userId} AND balance >= ${amount}
        RETURNING id, balance
      ),
      credit AS (
        UPDATE savings_goals
        SET balance = balance + ${amount},
            reached_at = CASE WHEN reached_at IS NULL AND balance + ${amount} >= target_amount THEN NOW() ELSE reached_at END,
            updated_at = NOW()
        WHERE id = ${goal.id} AND user_id = ${userId} AND closed_at IS NULL
          AND EXISTS (SELECT 1 FROM debit)
        RETURNING id, name, balance, target_amount, reached_at
      ),
      ledger AS (
        INSERT INTO transactions (account_id, type, amount, description, created_at)
        SELECT d.id, 'transfer_out', ${amount}::numeric, 'To goal: ' || c.name, NOW()
        FROM debit d CROSS JOIN credit c
        RETURNING id
      ),
      activity AS (
        INSERT INTO savings_goal_activity (goal_id, user_id, kind, amount, balance_after, account_type, transaction_id)
        SELECT c.id, ${userId}::int, 'deposit', ${amount}::numeric, c.balance, ${account.type}::text, (SELECT id FROM ledger)
        FROM credit c
        RETURNING id
      )
      SELECT
        (SELECT balance FROM debit) AS account_balance,
        (SELECT balance FROM credit) AS goal_balance,
        (SELECT name FROM credit) AS goal_name,
        (SELECT target_amount FROM credit) AS target_amount,
        (SELECT reached_at = NOW() FROM credit) AS just_reached,
        (SELECT id FROM ledger) AS transaction_id,
        1 / ((SELECT COUNT(*) FROM debit) * (SELECT COUNT(*) FROM credit) * (SELECT COUNT(*) FROM activity)) AS guard
    `;
  } catch (err) {
    if (isGuardFailure(err)) {
      throw new GoalError(409, 'Your balance changed before the move finished. Nothing was moved. Please try again.');
    }
    throw err;
  }
  const r = rows[0];
  return {
    goalId: goal.id,
    goalName: r.goal_name,
    goalBalance: Number(r.goal_balance),
    targetAmount: Number(r.target_amount),
    accountType: account.type,
    accountBalance: Number(r.account_balance),
    justReached: r.just_reached === true,
    transactionId: Number(r.transaction_id),
  };
}

async function moveOutOfGoal(sql, userId, input) {
  const amount = validateMoveAmount(input.amount);
  const goal = await getActiveGoal(sql, userId, input.goalId);
  if (goal.balance < amount) {
    throw new GoalError(400, `This goal has ${money(goal.balance)}. Enter a smaller amount.`);
  }
  const account = await getMoneyAccount(sql, userId, input.accountType || 'checking');

  let rows;
  try {
    rows = await sql`
      WITH debit AS (
        UPDATE savings_goals
        SET balance = balance - ${amount}, updated_at = NOW()
        WHERE id = ${goal.id} AND user_id = ${userId} AND closed_at IS NULL AND balance >= ${amount}
        RETURNING id, name, balance
      ),
      credit AS (
        UPDATE accounts
        SET balance = balance + ${amount}
        WHERE id = ${account.id} AND user_id = ${userId}
          AND EXISTS (SELECT 1 FROM debit)
        RETURNING id, balance
      ),
      ledger AS (
        INSERT INTO transactions (account_id, type, amount, description, created_at)
        SELECT c.id, 'transfer_in', ${amount}::numeric, 'From goal: ' || d.name, NOW()
        FROM credit c CROSS JOIN debit d
        RETURNING id
      ),
      activity AS (
        INSERT INTO savings_goal_activity (goal_id, user_id, kind, amount, balance_after, account_type, transaction_id)
        SELECT d.id, ${userId}::int, 'withdrawal', ${amount}::numeric, d.balance, ${account.type}::text, (SELECT id FROM ledger)
        FROM debit d
        RETURNING id
      )
      SELECT
        (SELECT balance FROM credit) AS account_balance,
        (SELECT balance FROM debit) AS goal_balance,
        (SELECT name FROM debit) AS goal_name,
        (SELECT id FROM ledger) AS transaction_id,
        1 / ((SELECT COUNT(*) FROM debit) * (SELECT COUNT(*) FROM credit) * (SELECT COUNT(*) FROM activity)) AS guard
    `;
  } catch (err) {
    if (isGuardFailure(err)) {
      throw new GoalError(409, 'Your goal balance changed before the move finished. Nothing was moved. Please try again.');
    }
    throw err;
  }
  const r = rows[0];
  return {
    goalId: goal.id,
    goalName: r.goal_name,
    goalBalance: Number(r.goal_balance),
    accountType: account.type,
    accountBalance: Number(r.account_balance),
    transactionId: Number(r.transaction_id),
  };
}

// Closing moves everything left in the goal back to an account. The statement
// only succeeds if the goal still holds exactly the balance we read, so money
// that lands at the same moment (say, a round-up sweep) is never lost; the
// person just gets asked to try again.
async function closeGoal(sql, userId, input) {
  const goal = await getActiveGoal(sql, userId, input.goalId);
  const expected = goal.balance;

  if (expected <= 0) {
    const rows = await sql`
      UPDATE savings_goals
      SET closed_at = NOW(), roundups_enabled = FALSE, roundups_started_at = NULL, updated_at = NOW()
      WHERE id = ${goal.id} AND user_id = ${userId} AND closed_at IS NULL AND balance = 0
      RETURNING id
    `;
    if (rows.length === 0) throw new GoalError(409, 'Your goal balance just changed. Please try again.');
    return { goalId: goal.id, goalName: goal.name, movedAmount: 0, accountType: null, accountBalance: null };
  }

  const account = await getMoneyAccount(sql, userId, input.accountType || 'checking');
  let rows;
  try {
    rows = await sql`
      WITH closed AS (
        UPDATE savings_goals
        SET balance = 0, closed_at = NOW(), roundups_enabled = FALSE, roundups_started_at = NULL, updated_at = NOW()
        WHERE id = ${goal.id} AND user_id = ${userId} AND closed_at IS NULL AND balance = ${expected}
        RETURNING id, name
      ),
      credit AS (
        UPDATE accounts
        SET balance = balance + ${expected}
        WHERE id = ${account.id} AND user_id = ${userId}
          AND EXISTS (SELECT 1 FROM closed)
        RETURNING id, balance
      ),
      ledger AS (
        INSERT INTO transactions (account_id, type, amount, description, created_at)
        SELECT c.id, 'transfer_in', ${expected}::numeric, 'Goal closed: ' || k.name, NOW()
        FROM credit c CROSS JOIN closed k
        RETURNING id
      ),
      activity AS (
        INSERT INTO savings_goal_activity (goal_id, user_id, kind, amount, balance_after, account_type, transaction_id)
        SELECT k.id, ${userId}::int, 'closed', ${expected}::numeric, 0, ${account.type}::text, (SELECT id FROM ledger)
        FROM closed k
        RETURNING id
      )
      SELECT
        (SELECT balance FROM credit) AS account_balance,
        1 / ((SELECT COUNT(*) FROM closed) * (SELECT COUNT(*) FROM credit) * (SELECT COUNT(*) FROM activity)) AS guard
    `;
  } catch (err) {
    if (isGuardFailure(err)) throw new GoalError(409, 'Your goal balance just changed. Nothing was moved. Please try again.');
    throw err;
  }
  return {
    goalId: goal.id,
    goalName: goal.name,
    movedAmount: expected,
    accountType: account.type,
    accountBalance: Number(rows[0].account_balance),
  };
}

// ---------- Round-ups ----------

async function setRoundups(sql, userId, input) {
  const enabled = input.enabled === true || input.enabled === 'true';

  if (enabled) {
    const goal = await getActiveGoal(sql, userId, input.goalId);
    const current = await sql`
      SELECT id, roundups_started_at FROM savings_goals
      WHERE user_id = ${userId} AND roundups_enabled AND closed_at IS NULL
      LIMIT 1
    `;
    if (current.length && Number(current[0].id) === goal.id) {
      return { enabled: true, goalId: goal.id, switchedFrom: null };
    }
    // Purchases still waiting to be swept follow round-ups to the new goal.
    const carryFrom = current.length ? current[0].roundups_started_at : null;
    try {
      await sql`
        UPDATE savings_goals
        SET roundups_enabled = FALSE, roundups_started_at = NULL, updated_at = NOW()
        WHERE user_id = ${userId} AND roundups_enabled AND id <> ${goal.id}
      `;
      const rows = await sql`
        UPDATE savings_goals
        SET roundups_enabled = TRUE,
            roundups_started_at = COALESCE(${carryFrom}::timestamptz, NOW()),
            updated_at = NOW()
        WHERE id = ${goal.id} AND user_id = ${userId} AND closed_at IS NULL
        RETURNING id
      `;
      if (rows.length === 0) throw new GoalError(404, 'That goal was not found.');
    } catch (err) {
      if (err && err.code === '23505') throw new GoalError(409, 'Round-ups were just changed on another device. Please try again.');
      throw err;
    }
    return { enabled: true, goalId: goal.id, switchedFrom: current.length ? Number(current[0].id) : null };
  }

  // Turning round-ups off moves anything already pending first, so spare change
  // from purchases that already happened still lands in the goal.
  let swept = null;
  try {
    swept = await sweepRoundups(sql, userId);
  } catch (err) {
    if (!(err instanceof GoalError)) throw err;
  }
  await sql`
    UPDATE savings_goals
    SET roundups_enabled = FALSE, roundups_started_at = NULL, updated_at = NOW()
    WHERE user_id = ${userId} AND roundups_enabled
  `;
  return { enabled: false, goalId: null, swept };
}

async function sweepRoundups(sql, userId) {
  const pending = await pendingRoundups(sql, userId);
  if (!pending.enabled || pending.pendingAmount < 0.01) {
    return { moved: 0, purchases: 0, goalId: pending.goalId, goalName: pending.goalName, justReached: false };
  }

  const checkingRows = await sql`
    SELECT id, balance, restriction_level FROM accounts
    WHERE user_id = ${userId} AND account_type = 'checking'
    ORDER BY id
    LIMIT 1
  `;
  const checking = checkingRows[0];
  if (!checking) throw new GoalError(400, "You don't have a checking account to take round-ups from.");
  if (checking.restriction_level && checking.restriction_level !== 'none') {
    throw new GoalError(403, 'Round-ups are paused while your checking account has an issue that needs a branch visit.', { accountRestricted: true });
  }

  let rows;
  try {
    rows = await sql`
      WITH goal AS (
        SELECT id, roundups_started_at FROM savings_goals
        WHERE user_id = ${userId} AND roundups_enabled AND closed_at IS NULL
        LIMIT 1
      ),
      eligible AS (
        SELECT t.id, t.amount, (CEIL(t.amount) - t.amount) AS spare
        FROM transactions t
        JOIN accounts a ON a.id = t.account_id
        CROSS JOIN goal g
        WHERE a.user_id = ${userId}
          AND a.account_type = 'credit'
          AND t.type = 'credit_purchase'
          AND t.amount > 0
          AND t.amount <> CEIL(t.amount)
          AND t.created_at >= g.roundups_started_at
          AND NOT EXISTS (SELECT 1 FROM savings_goal_roundups r WHERE r.transaction_id = t.id)
        ORDER BY t.id
        LIMIT ${SWEEP_BATCH}
      ),
      claimed AS (
        INSERT INTO savings_goal_roundups (transaction_id, goal_id, user_id, purchase_amount, spare)
        SELECT e.id, g.id, ${userId}::int, e.amount, e.spare
        FROM eligible e CROSS JOIN goal g
        ON CONFLICT (transaction_id) DO NOTHING
        RETURNING spare
      ),
      total AS (
        SELECT COALESCE(SUM(spare), 0)::numeric(14,2) AS amount, COUNT(*)::int AS purchases FROM claimed
      ),
      debit AS (
        UPDATE accounts
        SET balance = balance - (SELECT amount FROM total)
        WHERE id = ${checking.id} AND user_id = ${userId}
          AND (SELECT amount FROM total) > 0
          AND balance >= (SELECT amount FROM total)
        RETURNING id, balance
      ),
      credit AS (
        UPDATE savings_goals s
        SET balance = s.balance + (SELECT amount FROM total),
            reached_at = CASE WHEN s.reached_at IS NULL AND s.balance + (SELECT amount FROM total) >= s.target_amount THEN NOW() ELSE s.reached_at END,
            updated_at = NOW()
        WHERE s.id = (SELECT id FROM goal) AND EXISTS (SELECT 1 FROM debit)
        RETURNING s.id, s.name, s.balance, s.target_amount, s.reached_at
      ),
      ledger AS (
        INSERT INTO transactions (account_id, type, amount, description, created_at)
        SELECT d.id, 'transfer_out', (SELECT amount FROM total), 'Round-ups: ' || c.name, NOW()
        FROM debit d CROSS JOIN credit c
        RETURNING id
      ),
      activity AS (
        INSERT INTO savings_goal_activity (goal_id, user_id, kind, amount, balance_after, account_type, purchase_count, transaction_id)
        SELECT c.id, ${userId}::int, 'roundup', (SELECT amount FROM total), c.balance, 'checking', (SELECT purchases FROM total), (SELECT id FROM ledger)
        FROM credit c
        RETURNING id
      )
      SELECT
        (SELECT amount FROM total) AS moved,
        (SELECT purchases FROM total) AS purchases,
        (SELECT id FROM credit) AS goal_id,
        (SELECT name FROM credit) AS goal_name,
        (SELECT balance FROM credit) AS goal_balance,
        (SELECT target_amount FROM credit) AS target_amount,
        (SELECT reached_at = NOW() FROM credit) AS just_reached,
        (SELECT balance FROM debit) AS checking_balance,
        1 / ((SELECT COUNT(*) FROM debit) * (SELECT COUNT(*) FROM credit) * (SELECT COUNT(*) FROM activity)) AS guard
    `;
  } catch (err) {
    if (!isGuardFailure(err)) throw err;
    // Either another sweep got there first (nothing left to move) or checking
    // is short. Nothing was moved either way.
    const again = await pendingRoundups(sql, userId);
    if (!again.enabled || again.pendingAmount < 0.01) {
      return { moved: 0, purchases: 0, goalId: again.goalId, goalName: again.goalName, justReached: false };
    }
    throw new GoalError(409, `There isn't enough in checking to move ${money(again.pendingAmount)} of round-ups right now. We'll try again tomorrow.`);
  }

  const r = rows[0];
  return {
    moved: Number(r.moved),
    purchases: Number(r.purchases),
    goalId: Number(r.goal_id),
    goalName: r.goal_name,
    goalBalance: Number(r.goal_balance),
    targetAmount: Number(r.target_amount),
    checkingBalance: Number(r.checking_balance),
    justReached: r.just_reached === true,
  };
}

// Daily cron: sweep everyone with round-ups waiting. One person's failure (say,
// checking is short) never stops the others.
async function sweepAllRoundups(sql, { limit = SWEEP_BATCH } = {}) {
  const users = await sql`
    SELECT DISTINCT g.user_id
    FROM savings_goals g
    JOIN accounts a ON a.user_id = g.user_id AND a.account_type = 'credit'
    JOIN transactions t
      ON t.account_id = a.id
     AND t.type = 'credit_purchase'
     AND t.amount > 0
     AND t.amount <> CEIL(t.amount)
     AND t.created_at >= g.roundups_started_at
    WHERE g.roundups_enabled AND g.closed_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM savings_goal_roundups r WHERE r.transaction_id = t.id)
    LIMIT ${Math.max(1, Number(limit) || SWEEP_BATCH)}
  `;

  let usersSwept = 0;
  let totalMoved = 0;
  let failed = 0;
  const reached = [];
  for (const row of users) {
    const userId = Number(row.user_id);
    try {
      const result = await sweepRoundups(sql, userId);
      if (result.moved > 0) {
        usersSwept++;
        totalMoved += result.moved;
      }
      if (result.justReached) reached.push({ userId, goalName: result.goalName, targetAmount: result.targetAmount });
    } catch (err) {
      failed++;
      if (!(err instanceof GoalError)) console.error('Round-up sweep failed for user', userId, err);
    }
  }
  return { usersSwept, totalMoved: Math.round(totalMoved * 100) / 100, failed, reached };
}

function goalReachedMessage(goalName, targetAmount) {
  return `You've saved ${money(targetAmount)} for "${goalName}". Nice work! Keep it there, or move it whenever you're ready.`;
}

module.exports = {
  GoalError,
  GOAL_ICONS,
  MAX_ACTIVE_GOALS,
  ensureGoalsSchema,
  listGoals,
  getGoalActivity,
  getGoalsTotal,
  pendingRoundups,
  createGoal,
  updateGoal,
  moveIntoGoal,
  moveOutOfGoal,
  closeGoal,
  setRoundups,
  sweepRoundups,
  sweepAllRoundups,
  goalReachedMessage,
};
