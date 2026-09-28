// Subscriptions & bills: finds the payments that repeat.
//
// Looks at the last 13 months of money going out (card purchases, bills,
// debits) and groups it by who was paid. A group counts as recurring when:
//  - monthly: one payment in each of at least 3 months in a row, still going
//    (paid this month or last month), and the same amount to the cent (the
//    latest may differ by up to 25%: a price change). Bills and rent may vary.
//  - weekly: at least 4 payments 6-8 days apart, the latest in the last 10 days.
//  - yearly: at least 2 payments 350-380 days apart, the latest within a year.
// Coffee shops and groceries don't qualify: the amounts change and some months
// have several visits.
//
// The next payment date is only given when it's predictable (a monthly charge
// that lands on about the same day each month). People can hide something that
// isn't a subscription, and ask for a reminder 3 days before a charge; the
// daily cron sends those reminders as notifications (which also reach phones
// through lib/push.js).

const { categorize, NOT_SPENDING_PATTERN, CATEGORY_BY_ID } = require('./categories');

const LOOKBACK_DAYS = 400;
const REMIND_DAYS_BEFORE = 3;
const OUT_TYPES = ['debit', 'credit_purchase', 'admin_debit'];
const VARIABLE_OK = new Set(['bills', 'housing', 'loans']);
// Day-to-day spending that happens to repeat isn't a subscription.
const NEVER = new Set(['dining', 'groceries', 'cash']);
const DAY = 864e5;

class SubscriptionError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// ----- Who was paid -----
const GENERIC_PREFIX = /^(card purchase|purchase|pos purchase|pos|debit card purchase|debit card|recurring payment|recurring|autopay|auto pay|payment to|bill pay to|bill payment to|bill pay|online payment to)\s*[:\-–—]?\s*/i;

function merchantName(description) {
  let d = String(description || '').trim();
  d = d.replace(GENERIC_PREFIX, '');
  d = d.split(/\s+[—–]\s+|\s+-\s+|\s*\|\s*/)[0];
  d = d.replace(/[#*]\s*[A-Za-z]*\d[\w-]*/g, ' ').replace(/\b\d{4,}\b/g, ' ').replace(/\s{2,}/g, ' ').trim();
  return d;
}

function merchantKey(description) {
  return merchantName(description).toLowerCase().replace(/[^a-z0-9&+ ]/g, '').replace(/\s+/g, ' ').trim().slice(0, 80);
}

// ----- Date helpers (UTC) -----
const monthIndex = (d) => d.getUTCFullYear() * 12 + d.getUTCMonth();
const isoDay = (d) => d.toISOString().slice(0, 10);
function addMonthsClamped(d, n, day) {
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + n;
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m, Math.min(day, last)));
}
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};
const round2 = (n) => Math.round(n * 100) / 100;
// Subscriptions charge the same amount to the cent; a latest charge up to 25%
// different is a price change. Random spending almost never repeats exactly.
const near = (a, b) => Math.abs(a - b) <= Math.max(0.05, 0.003 * Math.max(a, b));
const withinChange = (a, b) => Math.abs(a - b) <= 0.25 * Math.max(a, b);
function steadyAmounts(rows) {
  if (rows.length < 3) return false;
  const prior = rows.slice(-4, -1).map((r) => r.amount);
  const last = rows[rows.length - 1].amount;
  const p1 = prior[prior.length - 1];
  return prior.every((a) => near(a, prior[0])) && (near(p1, last) || withinChange(p1, last));
}

// ----- Detection (pure, so it's easy to test) -----
function detectRecurring(transactions, { now = new Date() } = {}) {
  const nowMs = now.getTime();
  const groups = new Map();
  for (const t of transactions) {
    if (!OUT_TYPES.includes(t.type)) continue;
    if (NOT_SPENDING_PATTERN.test(String(t.description || ''))) continue;
    const amount = Math.abs(Number(t.amount));
    if (!(amount > 0)) continue;
    const date = new Date(t.created_at);
    if (Number.isNaN(date.getTime()) || nowMs - date.getTime() > LOOKBACK_DAYS * DAY || date.getTime() > nowMs + DAY) continue;
    const key = merchantKey(t.description);
    if (!key || key.length < 2) continue;
    if (!groups.has(key)) groups.set(key, { key, name: merchantName(t.description), sample: t, rows: [] });
    groups.get(key).rows.push({ date, amount });
  }

  const found = [];
  for (const g of groups.values()) {
    const rows = g.rows.sort((a, b) => a.date - b.date);
    if (rows.length < 2) continue;
    const category = categorize({ type: g.sample.type, description: g.sample.description });
    if (NEVER.has(category.id)) continue;
    const hit = detectMonthly(rows, category, nowMs) || detectWeekly(rows, nowMs) || detectYearly(rows, nowMs);
    if (!hit) continue;
    const last = rows[rows.length - 1];
    const recent = hit.rows;
    const amounts = recent.map((r) => r.amount);
    const prev = recent.length >= 2 ? recent[recent.length - 2].amount : null;
    const priceChange = !hit.variable && prev !== null && !near(prev, last.amount) && last.amount > prev
      ? { from: round2(prev), to: round2(last.amount) }
      : null;
    const perMonth = hit.frequency === 'weekly' ? (last.amount * 52) / 12 : hit.frequency === 'yearly' ? last.amount / 12 : last.amount;
    found.push({
      key: g.key,
      name: g.name,
      category: { id: category.id, name: category.name, icon: category.icon, color: category.color },
      frequency: hit.frequency,
      amount: round2(last.amount),
      typicalAmount: round2(median(amounts)),
      variable: hit.variable,
      lastDate: isoDay(last.date),
      nextDate: hit.nextDate ? isoDay(hit.nextDate) : null,
      nextMonth: hit.nextMonth || null,
      count: recent.length,
      monthlyCost: round2(hit.variable ? (median(amounts) * (hit.frequency === 'weekly' ? 52 / 12 : hit.frequency === 'yearly' ? 1 / 12 : 1)) : perMonth),
      yearlyCost: round2((hit.variable ? median(amounts) : last.amount) * (hit.frequency === 'weekly' ? 52 : hit.frequency === 'yearly' ? 1 : 12)),
      priceChange,
      history: recent.slice(-6).reverse().map((r) => ({ date: isoDay(r.date), amount: round2(r.amount) })),
    });
  }
  found.sort((a, b) => b.monthlyCost - a.monthlyCost || a.name.localeCompare(b.name));
  return found;
}

function detectMonthly(rows, category, nowMs) {
  const last = rows[rows.length - 1];
  // Still going: paid this month or last month.
  if (monthIndex(new Date(nowMs)) - monthIndex(last.date) > 1 || nowMs - last.date.getTime() > 62 * DAY) return null;
  // Walk back month by month from the latest payment while every month has
  // exactly one payment.
  const byMonth = new Map();
  rows.forEach((r) => {
    const k = monthIndex(r.date);
    if (!byMonth.has(k)) byMonth.set(k, []);
    byMonth.get(k).push(r);
  });
  // A charge within 2 days of the end or start of a month can post on either
  // side of it. If that leaves one month with two and its neighbour with none,
  // count it in the neighbour.
  for (const [k, list] of [...byMonth.entries()]) {
    if (list.length !== 2) continue;
    const [a, b] = list;
    const monthEnd = Date.UTC(Math.floor(k / 12), (k % 12) + 1, 1);
    const monthStart = Date.UTC(Math.floor(k / 12), k % 12, 1);
    if (!byMonth.has(k + 1) && monthEnd - b.date.getTime() <= 2 * DAY) {
      byMonth.set(k, [a]);
      byMonth.set(k + 1, [b]);
    } else if (!byMonth.has(k - 1) && a.date.getTime() - monthStart <= 2 * DAY) {
      byMonth.set(k, [b]);
      byMonth.set(k - 1, [a]);
    }
  }
  let m = monthIndex(last.date);
  if (!byMonth.has(m) || byMonth.get(m)[byMonth.get(m).length - 1] !== last) m = Math.max(...byMonth.keys());
  const run = [];
  while (byMonth.has(m) && byMonth.get(m).length === 1) {
    run.unshift(byMonth.get(m)[0]);
    m--;
  }
  if (run.length < 3) return null;
  const recent = run.slice(-12);
  const amounts = recent.map((r) => r.amount);
  const variable = !steadyAmounts(recent);
  if (variable && !VARIABLE_OK.has(category.id)) return null;
  if (variable && Math.max(...amounts) > 4 * Math.min(...amounts)) return null;
  // Predictable day? Only then do we promise a date.
  const days = recent.slice(-4).map((r) => r.date.getUTCDate());
  const spread = Math.max(...days) - Math.min(...days);
  let nextDate = null;
  let nextMonth = null;
  if (spread <= 3) {
    const typicalDay = Math.round(median(days));
    nextDate = addMonthsClamped(last.date, 1, typicalDay);
  } else {
    const nm = new Date(Date.UTC(last.date.getUTCFullYear(), last.date.getUTCMonth() + 1, 1));
    nextMonth = nm.toISOString().slice(0, 7);
  }
  return { frequency: 'monthly', rows: recent, variable, nextDate, nextMonth };
}

function detectWeekly(rows, nowMs) {
  const last = rows[rows.length - 1];
  if (nowMs - last.date.getTime() > 10 * DAY) return null;
  const run = [last];
  for (let i = rows.length - 2; i >= 0; i--) {
    const gap = (run[0].date - rows[i].date) / DAY;
    if (gap < 6 || gap > 8) break;
    run.unshift(rows[i]);
  }
  if (run.length < 4) return null;
  const recent = run.slice(-8);
  if (!recent.slice(0, -1).every((r) => near(r.amount, recent[0].amount)) || !steadyAmounts(recent)) return null;
  return { frequency: 'weekly', rows: recent, variable: false, nextDate: new Date(last.date.getTime() + 7 * DAY) };
}

function detectYearly(rows, nowMs) {
  const last = rows[rows.length - 1];
  if (nowMs - last.date.getTime() > 380 * DAY) return null;
  const before = rows.filter((r) => {
    const gap = (last.date - r.date) / DAY;
    return gap >= 350 && gap <= 380;
  });
  if (!before.length) return null;
  const prev = before[before.length - 1];
  // Only two payments to go on, so they must match exactly.
  if (!near(prev.amount, last.amount)) return null;
  // Nothing else from them in between, or it's not really yearly.
  if (rows.some((r) => r.date > prev.date && r.date < last.date)) return null;
  const next = new Date(Date.UTC(last.date.getUTCFullYear() + 1, last.date.getUTCMonth(), last.date.getUTCDate()));
  return { frequency: 'yearly', rows: [prev, last], variable: false, nextDate: next };
}

// ----- Storage -----
const schemaReady = new WeakMap();
function ensureSubscriptionSchema(sql) {
  let p = schemaReady.get(sql);
  if (!p) {
    p = (async () => {
      await sql`
        CREATE TABLE IF NOT EXISTS subscription_prefs (
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          merchant_key TEXT NOT NULL,
          hidden BOOLEAN NOT NULL DEFAULT FALSE,
          remind BOOLEAN NOT NULL DEFAULT FALSE,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY (user_id, merchant_key)
        )
      `;
      await sql`
        CREATE TABLE IF NOT EXISTS subscription_reminders (
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          merchant_key TEXT NOT NULL,
          due_date DATE NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY (user_id, merchant_key, due_date)
        )
      `;
    })();
    p.catch(() => schemaReady.delete(sql));
    schemaReady.set(sql, p);
  }
  return p;
}

async function loadOutflows(sql, userId) {
  return sql`
    SELECT t.type, t.amount, t.description, t.created_at
    FROM transactions t
    JOIN accounts a ON a.id = t.account_id
    WHERE a.user_id = ${userId}
      AND t.type IN ('debit', 'credit_purchase', 'admin_debit')
      AND t.created_at >= NOW() - make_interval(days => ${LOOKBACK_DAYS})
    ORDER BY t.created_at ASC
    LIMIT 5000
  `;
}

function money(n) {
  return '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

async function listSubscriptions(sql, userId, { now = new Date() } = {}) {
  await ensureSubscriptionSchema(sql);
  const [txns, prefs] = await Promise.all([
    loadOutflows(sql, userId),
    sql`SELECT merchant_key, hidden, remind FROM subscription_prefs WHERE user_id = ${userId}`,
  ]);
  const prefByKey = new Map(prefs.map((p) => [p.merchant_key, p]));
  const truthy = (v) => v === true || v === 't' || v === 'true';
  const all = detectRecurring(txns, { now }).map((s) => {
    const p = prefByKey.get(s.key);
    return { ...s, hidden: !!p && truthy(p.hidden), remind: !!p && truthy(p.remind) && !!s.nextDate };
  });
  const active = all.filter((s) => !s.hidden);
  const hidden = all.filter((s) => s.hidden);
  const today = isoDay(now);
  const in30 = isoDay(new Date(now.getTime() + 30 * DAY));
  const upcoming = active
    .filter((s) => s.nextDate && s.nextDate >= today && s.nextDate <= in30)
    .sort((a, b) => a.nextDate.localeCompare(b.nextDate))
    .map((s) => ({ key: s.key, name: s.name, amount: s.amount, nextDate: s.nextDate, category: s.category }));
  return {
    subscriptions: active,
    hidden,
    upcoming,
    totals: {
      monthly: round2(active.reduce((sum, s) => sum + s.monthlyCost, 0)),
      yearly: round2(active.reduce((sum, s) => sum + s.yearlyCost, 0)),
      count: active.length,
    },
    remindDaysBefore: REMIND_DAYS_BEFORE,
    lookbackMonths: 13,
  };
}

async function setPreference(sql, userId, { key, hidden, remind } = {}) {
  await ensureSubscriptionSchema(sql);
  const k = String(key || '').trim().toLowerCase().slice(0, 80);
  if (!k) throw new SubscriptionError(400, 'Say which subscription.');
  // Only for things we actually found for this person.
  const found = detectRecurring(await loadOutflows(sql, userId));
  const sub = found.find((s) => s.key === k);
  if (!sub) throw new SubscriptionError(404, "We couldn't find that subscription any more.");
  if (remind === true && !sub.nextDate) throw new SubscriptionError(400, `${sub.name} doesn't charge on a set day, so we can't time a reminder.`);
  const hiddenVal = typeof hidden === 'boolean' ? hidden : null;
  const remindVal = typeof remind === 'boolean' ? remind : null;
  if (hiddenVal === null && remindVal === null) throw new SubscriptionError(400, 'Nothing to change.');
  await sql`
    INSERT INTO subscription_prefs (user_id, merchant_key, hidden, remind, updated_at)
    VALUES (${userId}, ${k}, ${hiddenVal === null ? false : hiddenVal}, ${remindVal === null ? false : remindVal}, NOW())
    ON CONFLICT (user_id, merchant_key) DO UPDATE SET
      hidden = COALESCE(${hiddenVal}::boolean, subscription_prefs.hidden),
      remind = COALESCE(${remindVal}::boolean, subscription_prefs.remind),
      updated_at = NOW()
  `;
  return listSubscriptions(sql, userId);
}

// Daily cron: a notification 3 days (or fewer) before each charge people asked
// to be reminded about. The reminders table makes it once per charge.
async function runSubscriptionReminders(sql, { now = new Date() } = {}) {
  await ensureSubscriptionSchema(sql);
  const users = await sql`SELECT DISTINCT user_id FROM subscription_prefs WHERE remind = TRUE AND hidden = FALSE`;
  let sent = 0;
  const today = isoDay(now);
  const horizon = isoDay(new Date(now.getTime() + REMIND_DAYS_BEFORE * DAY));
  for (const u of users) {
    const userId = Number(u.user_id);
    try {
      const data = await listSubscriptions(sql, userId, { now });
      for (const s of data.subscriptions) {
        if (!s.remind || !s.nextDate || s.nextDate < today || s.nextDate > horizon) continue;
        const claimed = await sql`
          INSERT INTO subscription_reminders (user_id, merchant_key, due_date)
          VALUES (${userId}, ${s.key}, ${s.nextDate})
          ON CONFLICT DO NOTHING
          RETURNING due_date
        `;
        if (!claimed.length) continue;
        const when = s.nextDate === today ? 'today' : `on ${new Date(`${s.nextDate}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric', timeZone: 'UTC' })}`;
        const amountText = s.variable ? `about ${money(s.typicalAmount)}` : money(s.amount);
        await sql`
          INSERT INTO notifications (user_id, title, message, is_read, created_at)
          VALUES (${userId}, ${`${s.name} is coming up`}, ${`${s.name} usually takes ${amountText} ${when}. Make sure there's enough in your account.`}, FALSE, NOW())
        `;
        sent++;
      }
    } catch (err) {
      console.error('Subscription reminders failed for a user (non-fatal):', err && err.message);
    }
  }
  return { users: users.length, sent };
}

module.exports = {
  SubscriptionError,
  merchantName,
  merchantKey,
  detectRecurring,
  ensureSubscriptionSchema,
  listSubscriptions,
  setPreference,
  runSubscriptionReminders,
  REMIND_DAYS_BEFORE,
  CATEGORY_BY_ID,
};
