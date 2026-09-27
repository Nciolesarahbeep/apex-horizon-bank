// Monthly budgets.
//
// A budget is a monthly limit for one spending category (lib/categories.js).
// Spending is worked out from the ledger for the current calendar month in the
// person's own timezone, so "September" means their September, not UTC's.
//
// Alerts: the first time a category passes 80% and then 100% of its limit in a
// month, the person gets a notification. Each alert is recorded in
// budget_alerts (one row per category, month and threshold), so it is sent
// once, even if the check runs many times. When a budget is created or changed,
// thresholds it has already passed are recorded silently, so setting a budget
// you've already blown through doesn't fire an instant alert, and raising a
// limit re-arms the alerts that no longer apply.

const { SPEND_CATEGORIES, CATEGORY_BY_ID, isSpending, categorize } = require('./categories');

const MAX_LIMIT = 1000000;
const THRESHOLDS = [80, 100];

class BudgetError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'BudgetError';
    this.status = status;
  }
}

let schemaReady = false;
async function ensureBudgetsSchema(sql) {
  if (schemaReady) return;
  await sql`
    CREATE TABLE IF NOT EXISTS budgets (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      category TEXT NOT NULL,
      monthly_limit NUMERIC(14,2) NOT NULL CHECK (monthly_limit > 0),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (user_id, category)
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS budget_alerts (
      user_id INTEGER NOT NULL,
      category TEXT NOT NULL,
      month TEXT NOT NULL,
      threshold INTEGER NOT NULL,
      sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (user_id, category, month, threshold)
    )
  `;
  // The daily check has no browser to ask, so it uses the timezone the app
  // last reported.
  await sql`
    CREATE TABLE IF NOT EXISTS budget_settings (
      user_id INTEGER PRIMARY KEY,
      tz_offset INTEGER NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  schemaReady = true;
}

function parseTzOffset(value) {
  const n = Number(value);
  return Number.isInteger(n) && Math.abs(n) <= 840 ? n : 0;
}

// Month boundaries in the person's timezone. tzOffset is minutes behind UTC,
// the same number the browser's Date#getTimezoneOffset() gives (Lagos is -60).
function monthWindow(tzOffset, nowMs = Date.now()) {
  const local = new Date(nowMs - tzOffset * 60000);
  const y = local.getUTCFullYear();
  const m = local.getUTCMonth();
  const start = Date.UTC(y, m, 1) + tzOffset * 60000;
  const end = Date.UTC(y, m + 1, 1) + tzOffset * 60000;
  const prevStart = Date.UTC(y, m - 1, 1) + tzOffset * 60000;
  const daysInMonth = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const today = local.getUTCDate();
  return {
    month: `${y}-${String(m + 1).padStart(2, '0')}`,
    monthLabel: new Date(Date.UTC(y, m, 1)).toLocaleDateString('en-US', { month: 'long', timeZone: 'UTC' }),
    startIso: new Date(start).toISOString(),
    endIso: new Date(end).toISOString(),
    prevStartIso: new Date(prevStart).toISOString(),
    daysInMonth,
    daysLeft: daysInMonth - today + 1, // today counts
  };
}

// Spend per category for this month and last month.
async function spendingByCategory(sql, userId, win) {
  const rows = await sql`
    SELECT t.type, t.amount, t.description, (t.created_at >= ${win.startIso}::timestamptz) AS this_month
    FROM transactions t
    JOIN accounts a ON a.id = t.account_id
    WHERE a.user_id = ${userId}
      AND t.created_at >= ${win.prevStartIso}::timestamptz
      AND t.created_at < ${win.endIso}::timestamptz
      AND t.type IN ('debit', 'credit_purchase', 'p2p_out', 'wire_out', 'admin_debit')
  `;
  const thisMonth = {};
  const lastMonth = {};
  for (const r of rows) {
    if (!isSpending(r)) continue;
    const cat = categorize(r).id;
    const bucket = r.this_month === true || r.this_month === 't' ? thisMonth : lastMonth;
    bucket[cat] = Math.round(((bucket[cat] || 0) + Math.abs(Number(r.amount))) * 100) / 100;
  }
  return { thisMonth, lastMonth };
}

function budgetStatus(pct) {
  if (pct >= 100) return 'over';
  if (pct >= 80) return 'close';
  return 'ok';
}

function describe(row, spend, win) {
  const cat = CATEGORY_BY_ID[row.category] || CATEGORY_BY_ID.other;
  const limit = Number(row.monthly_limit);
  const spent = spend.thisMonth[row.category] || 0;
  const remaining = Math.round((limit - spent) * 100) / 100;
  const pct = limit > 0 ? Math.round((spent / limit) * 1000) / 10 : 0;
  return {
    id: Number(row.id),
    category: cat.id,
    name: cat.name,
    icon: cat.icon,
    color: cat.color,
    limit,
    spent,
    remaining,
    pct,
    status: budgetStatus(pct),
    safePerDay: remaining > 0 ? Math.floor((remaining / win.daysLeft) * 100) / 100 : 0,
    lastMonth: spend.lastMonth[row.category] || 0,
  };
}

async function readBudgets(sql, userId) {
  return sql`
    SELECT id, category, monthly_limit FROM budgets WHERE user_id = ${userId} ORDER BY created_at, id
  `;
}

function alertMessage(b, threshold, win) {
  if (threshold >= 100) {
    return `You've gone over your ${b.name} budget: ${money(b.spent)} of ${money(b.limit)} spent in ${win.monthLabel}.`;
  }
  return `You've used ${Math.floor(b.pct)}% of your ${b.name} budget: ${money(b.spent)} of ${money(b.limit)} spent in ${win.monthLabel}, ${money(b.remaining)} left.`;
}

function money(n) {
  return Number(n).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

// Records newly crossed thresholds and returns the alerts to send. With
// silent=true (used right after a budget is saved) nothing is returned, the
// thresholds are just marked as already passed.
async function recordThresholds(sql, userId, budgets, win, { silent = false } = {}) {
  const toSend = [];
  for (const b of budgets) {
    // Re-arm thresholds this budget no longer meets (e.g. the limit was raised).
    const unmet = THRESHOLDS.filter((t) => b.pct < t);
    if (unmet.length) {
      await sql`
        DELETE FROM budget_alerts
        WHERE user_id = ${userId} AND category = ${b.category} AND month = ${win.month}
          AND threshold = ANY(${`{${unmet.join(',')}}`}::int[])
      `;
    }
    const met = THRESHOLDS.filter((t) => b.pct >= t);
    if (!met.length) continue;
    const inserted = await sql`
      INSERT INTO budget_alerts (user_id, category, month, threshold)
      SELECT ${userId}::int, ${b.category}::text, ${win.month}::text, t
      FROM unnest(${`{${met.join(',')}}`}::int[]) AS t
      ON CONFLICT DO NOTHING
      RETURNING threshold
    `;
    if (!silent && inserted.length) {
      // Only the highest new threshold is worth telling someone about.
      const top = Math.max(...inserted.map((r) => Number(r.threshold)));
      toSend.push({ userId, category: b.category, threshold: top, title: top >= 100 ? 'Over budget' : 'Budget alert', message: alertMessage(b, top, win) });
    }
  }
  return toSend;
}

async function saveTzOffset(sql, userId, tzOffset) {
  await sql`
    INSERT INTO budget_settings (user_id, tz_offset, updated_at) VALUES (${userId}, ${tzOffset}, NOW())
    ON CONFLICT (user_id) DO UPDATE SET tz_offset = EXCLUDED.tz_offset, updated_at = NOW()
  `;
}

// Everything the Budgets screen needs, plus any alerts that are now due.
async function getBudgetOverview(sql, userId, { tzOffset = 0, nowMs } = {}) {
  const tz = parseTzOffset(tzOffset);
  await saveTzOffset(sql, userId, tz);
  const win = monthWindow(tz, nowMs);
  const [rows, spend] = [await readBudgets(sql, userId), await spendingByCategory(sql, userId, win)];
  const budgets = rows.map((r) => describe(r, spend, win));
  const alerts = await recordThresholds(sql, userId, budgets, win);
  const budgeted = new Set(budgets.map((b) => b.category));
  const totalLimit = Math.round(budgets.reduce((s, b) => s + b.limit, 0) * 100) / 100;
  const totalSpent = Math.round(budgets.reduce((s, b) => s + b.spent, 0) * 100) / 100;
  const totalRemaining = Math.round((totalLimit - totalSpent) * 100) / 100;
  return {
    month: win.month,
    monthLabel: win.monthLabel,
    daysLeft: win.daysLeft,
    daysInMonth: win.daysInMonth,
    budgets,
    totals: {
      limit: totalLimit,
      spent: totalSpent,
      remaining: totalRemaining,
      safePerDay: totalRemaining > 0 ? Math.floor((totalRemaining / win.daysLeft) * 100) / 100 : 0,
    },
    categories: SPEND_CATEGORIES.map((c) => ({
      id: c.id,
      name: c.name,
      icon: c.icon,
      color: c.color,
      budgeted: budgeted.has(c.id),
      spentThisMonth: spend.thisMonth[c.id] || 0,
      spentLastMonth: spend.lastMonth[c.id] || 0,
    })),
    alerts,
  };
}

async function setBudget(sql, userId, { category, limit, tzOffset }, { nowMs } = {}) {
  if (!CATEGORY_BY_ID[category]) throw new BudgetError(400, 'Pick a category.');
  const amount = Math.round(Number(limit) * 100) / 100;
  if (!Number.isFinite(amount) || amount < 1) throw new BudgetError(400, 'Set a monthly limit of at least $1.');
  if (amount > MAX_LIMIT) throw new BudgetError(400, 'Limits can be up to $1,000,000 a month.');
  const rows = await sql`
    INSERT INTO budgets (user_id, category, monthly_limit) VALUES (${userId}, ${category}, ${amount})
    ON CONFLICT (user_id, category) DO UPDATE SET monthly_limit = EXCLUDED.monthly_limit, updated_at = NOW()
    RETURNING id, category, monthly_limit
  `;
  const win = monthWindow(parseTzOffset(tzOffset), nowMs);
  const spend = await spendingByCategory(sql, userId, win);
  const budget = describe(rows[0], spend, win);
  await recordThresholds(sql, userId, [budget], win, { silent: true });
  return budget;
}

async function deleteBudget(sql, userId, { category }) {
  if (!CATEGORY_BY_ID[category]) throw new BudgetError(400, 'Pick a category.');
  const rows = await sql`DELETE FROM budgets WHERE user_id = ${userId} AND category = ${category} RETURNING id`;
  if (!rows.length) throw new BudgetError(404, "That budget wasn't found.");
  await sql`DELETE FROM budget_alerts WHERE user_id = ${userId} AND category = ${category}`;
  return { deleted: true, category };
}

// Daily cron: check everyone who has budgets, in their own timezone.
async function checkAllBudgets(sql, { limit = 1000, nowMs } = {}) {
  const users = await sql`
    SELECT b.user_id, COALESCE(s.tz_offset, 0) AS tz_offset
    FROM (SELECT DISTINCT user_id FROM budgets) b
    LEFT JOIN budget_settings s ON s.user_id = b.user_id
    LIMIT ${limit}
  `;
  const alerts = [];
  let failed = 0;
  for (const u of users) {
    try {
      const userId = Number(u.user_id);
      const win = monthWindow(parseTzOffset(Number(u.tz_offset)), nowMs);
      const [rows, spend] = [await readBudgets(sql, userId), await spendingByCategory(sql, userId, win)];
      const budgets = rows.map((r) => describe(r, spend, win));
      alerts.push(...(await recordThresholds(sql, userId, budgets, win)));
    } catch (err) {
      failed++;
      console.error('Budget check failed for user', u.user_id, err);
    }
  }
  return { usersChecked: users.length, alerts, failed };
}

module.exports = {
  BudgetError,
  ensureBudgetsSchema,
  monthWindow,
  getBudgetOverview,
  setBudget,
  deleteBudget,
  checkAllBudgets,
  THRESHOLDS,
};
