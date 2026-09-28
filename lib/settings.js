// Settings that need the server: account alerts, auto-lock, the security
// checkup and "Download my data".
//
// Account alerts are enforced by database triggers, so every way money moves
// (card purchases, P2P, wires, bill pay, admin adjustments...) is covered
// without each endpoint having to remember to check:
//   - Low balance: checking drops below the customer's amount (alerts once per
//     crossing; it re-arms when the balance goes back above).
//   - Large transaction: money going out at or above the customer's amount.
// The trigger functions catch their own errors, so an alert can never block
// or roll back a payment.

const { getStepUpSettings } = require('./stepUp');

const AUTO_LOCK_CHOICES = [1, 2, 5, 10, 15];
const DEFAULT_AUTO_LOCK = 10;
const ALERT_MIN = 1;
const ALERT_MAX = 1000000;
const ALERTS_VERSION = 'ahb-alerts-v1';

class SettingsError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

let schemaReady = false;

async function ensureSettingsSchema(sql) {
  if (schemaReady) return;
  await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS auto_lock_minutes INTEGER NOT NULL DEFAULT 10`;
  await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS notif_push BOOLEAN NOT NULL DEFAULT TRUE`;
  await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS notif_txn BOOLEAN NOT NULL DEFAULT TRUE`;
  await sql`
    CREATE TABLE IF NOT EXISTS account_alert_settings (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      low_balance_enabled BOOLEAN NOT NULL DEFAULT FALSE,
      low_balance_threshold NUMERIC(14,2) NOT NULL DEFAULT 100,
      large_txn_enabled BOOLEAN NOT NULL DEFAULT FALSE,
      large_txn_threshold NUMERIC(14,2) NOT NULL DEFAULT 500,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await ensureAlertTriggers(sql);
  schemaReady = true;
}

// Installs (or upgrades) the alert triggers. Skipped when this version is
// already in place, so normal requests don't rewrite them.
async function ensureAlertTriggers(sql) {
  const existing = await sql`
    SELECT
      (SELECT COUNT(*) FROM pg_proc WHERE proname IN ('ahb_low_balance_alert', 'ahb_large_txn_alert')
         AND obj_description(oid, 'pg_proc') = ${ALERTS_VERSION}) AS functions,
      (SELECT COUNT(*) FROM pg_trigger WHERE tgname IN ('ahb_low_balance_alert', 'ahb_large_txn_alert') AND NOT tgisinternal) AS triggers
  `;
  if (Number(existing[0].functions) === 2 && Number(existing[0].triggers) === 2) return;

  await sql`
    CREATE OR REPLACE FUNCTION ahb_money(n NUMERIC) RETURNS TEXT LANGUAGE sql STABLE AS $$
      SELECT CASE WHEN n < 0 THEN '-' ELSE '' END || to_char(ABS(n), 'FM$999,999,999,990.00')
    $$
  `;
  await sql`
    CREATE OR REPLACE FUNCTION ahb_low_balance_alert() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE
      s RECORD;
    BEGIN
      BEGIN
        IF NEW.account_type = 'checking' AND NEW.balance < OLD.balance THEN
          SELECT low_balance_enabled, low_balance_threshold INTO s
          FROM account_alert_settings WHERE user_id = NEW.user_id;
          IF FOUND AND s.low_balance_enabled
             AND OLD.balance >= s.low_balance_threshold AND NEW.balance < s.low_balance_threshold THEN
            INSERT INTO notifications (user_id, title, message, is_read, created_at)
            VALUES (NEW.user_id, 'Low balance',
              'Your checking balance is ' || ahb_money(NEW.balance) || ', below the ' || ahb_money(s.low_balance_threshold) ||
              ' alert you set. Move money in from savings or pause upcoming payments if you need to.',
              FALSE, NOW());
          END IF;
        END IF;
      EXCEPTION WHEN OTHERS THEN
        -- An alert must never block a payment.
        RAISE WARNING 'low balance alert skipped: %', SQLERRM;
      END;
      RETURN NEW;
    END
    $$
  `;
  await sql`
    CREATE OR REPLACE FUNCTION ahb_large_txn_alert() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE
      s RECORD;
      owner_id INTEGER;
      acct_type TEXT;
    BEGIN
      BEGIN
        -- Money leaving to someone else. Moving money between your own accounts,
        -- into goals, or paying off the Apex card doesn't count.
        IF NEW.type IN ('debit', 'credit_purchase', 'p2p_out', 'wire_out', 'admin_debit')
           AND COALESCE(NEW.description, '') !~* '^(to goal|from goal|round-ups|goal closed):|^credit card payment' THEN
          SELECT a.user_id, a.account_type INTO owner_id, acct_type FROM accounts a WHERE a.id = NEW.account_id;
          SELECT large_txn_enabled, large_txn_threshold INTO s
          FROM account_alert_settings WHERE user_id = owner_id;
          IF FOUND AND s.large_txn_enabled AND ABS(NEW.amount) >= s.large_txn_threshold THEN
            INSERT INTO notifications (user_id, title, message, is_read, created_at)
            VALUES (owner_id, 'Large transaction',
              ahb_money(ABS(NEW.amount)) || CASE WHEN acct_type = 'credit' THEN ' on your card' ELSE ' from checking' END ||
              ': ' || LEFT(COALESCE(NULLIF(NEW.description, ''), 'Transaction'), 80) ||
              '. Not you? Freeze your card and dispute it from Help.',
              FALSE, NOW());
          END IF;
        END IF;
      EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'large transaction alert skipped: %', SQLERRM;
      END;
      RETURN NEW;
    END
    $$
  `;
  await sql`COMMENT ON FUNCTION ahb_low_balance_alert() IS 'ahb-alerts-v1'`;
  await sql`COMMENT ON FUNCTION ahb_large_txn_alert() IS 'ahb-alerts-v1'`;
  try {
    await sql`CREATE OR REPLACE TRIGGER ahb_low_balance_alert AFTER UPDATE OF balance ON accounts FOR EACH ROW EXECUTE FUNCTION ahb_low_balance_alert()`;
    await sql`CREATE OR REPLACE TRIGGER ahb_large_txn_alert AFTER INSERT ON transactions FOR EACH ROW EXECUTE FUNCTION ahb_large_txn_alert()`;
  } catch (err) {
    // Another request may be installing them at the same moment; that's fine.
    const again = await sql`SELECT COUNT(*) AS n FROM pg_trigger WHERE tgname IN ('ahb_low_balance_alert', 'ahb_large_txn_alert') AND NOT tgisinternal`;
    if (Number(again[0].n) !== 2) throw err;
  }
}

function money(n) {
  return Number(n).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

// ----- Account alerts -----
function shapeAlerts(row) {
  const r = row || {};
  return {
    lowBalance: { enabled: r.low_balance_enabled === true || r.low_balance_enabled === 't', threshold: r.low_balance_threshold != null ? Number(r.low_balance_threshold) : 100 },
    largeTransaction: { enabled: r.large_txn_enabled === true || r.large_txn_enabled === 't', threshold: r.large_txn_threshold != null ? Number(r.large_txn_threshold) : 500 },
  };
}

async function getAlertSettings(sql, userId) {
  await ensureSettingsSchema(sql);
  const rows = await sql`SELECT * FROM account_alert_settings WHERE user_id = ${userId}`;
  return shapeAlerts(rows[0]);
}

function parseAlert(input, label, fallback) {
  if (!input || typeof input !== 'object') return fallback;
  const enabled = input.enabled === true;
  const threshold = Math.round(Number(input.threshold) * 100) / 100;
  if (!Number.isFinite(threshold) || threshold < ALERT_MIN || threshold > ALERT_MAX) {
    throw new SettingsError(400, `Set the ${label} amount between ${money(ALERT_MIN)} and ${money(ALERT_MAX)}.`);
  }
  return { enabled, threshold };
}

async function saveAlertSettings(sql, userId, input = {}) {
  const current = await getAlertSettings(sql, userId);
  const low = parseAlert(input.lowBalance, 'low balance', current.lowBalance);
  const large = parseAlert(input.largeTransaction, 'large transaction', current.largeTransaction);
  const rows = await sql`
    INSERT INTO account_alert_settings (user_id, low_balance_enabled, low_balance_threshold, large_txn_enabled, large_txn_threshold, updated_at)
    VALUES (${userId}, ${low.enabled}, ${low.threshold}, ${large.enabled}, ${large.threshold}, NOW())
    ON CONFLICT (user_id) DO UPDATE SET
      low_balance_enabled = EXCLUDED.low_balance_enabled,
      low_balance_threshold = EXCLUDED.low_balance_threshold,
      large_txn_enabled = EXCLUDED.large_txn_enabled,
      large_txn_threshold = EXCLUDED.large_txn_threshold,
      updated_at = NOW()
    RETURNING *
  `;
  return shapeAlerts(rows[0]);
}

// ----- Auto-lock -----
async function getPreferences(sql, userId) {
  await ensureSettingsSchema(sql);
  const rows = await sql`SELECT auto_lock_minutes FROM users WHERE id = ${userId}`;
  const m = rows.length ? Number(rows[0].auto_lock_minutes) : DEFAULT_AUTO_LOCK;
  return { autoLockMinutes: AUTO_LOCK_CHOICES.includes(m) ? m : DEFAULT_AUTO_LOCK, autoLockChoices: AUTO_LOCK_CHOICES };
}

async function savePreferences(sql, userId, input = {}) {
  await ensureSettingsSchema(sql);
  const m = Number(input.autoLockMinutes);
  if (!AUTO_LOCK_CHOICES.includes(m)) throw new SettingsError(400, `Choose ${AUTO_LOCK_CHOICES.join(', ')} minutes.`);
  await sql`UPDATE users SET auto_lock_minutes = ${m} WHERE id = ${userId}`;
  return getPreferences(sql, userId);
}

// Optional tables (Face ID, sessions, identity checks) may not exist yet on a
// fresh database; a missing table just means "not set up".
async function optional(fn, fallback) {
  try { return await fn(); } catch (err) { return fallback; }
}

// ----- Security checkup -----
async function securityCheckup(sql, userId, { currentJti = null, nowMs = Date.now() } = {}) {
  await ensureSettingsSchema(sql);
  const users = await sql`
    SELECT passcode_hash IS NOT NULL AS has_passcode, auto_lock_minutes, notif_txn, notif_push
    FROM users WHERE id = ${userId}
  `;
  if (!users.length) throw new SettingsError(404, 'Account not found.');
  const u = users[0];
  const hasPasscode = u.has_passcode === true || u.has_passcode === 't';
  const autoLock = Number(u.auto_lock_minutes) || DEFAULT_AUTO_LOCK;

  const faceIds = await optional(async () => Number((await sql`SELECT COUNT(*) AS n FROM webauthn_credentials WHERE user_id = ${userId}`)[0].n), 0);
  const stepUp = await optional(() => getStepUpSettings(sql, userId), { enabled: false, threshold: null });
  const sessions = await optional(() => sql`SELECT jti, last_seen_at FROM user_sessions WHERE user_id = ${userId} AND revoked_at IS NULL`, []);
  const staleCutoff = nowMs - 30 * 864e5;
  const others = sessions.filter((s) => s.jti !== currentJti);
  const stale = others.filter((s) => !s.last_seen_at || Date.parse(s.last_seen_at) < staleCutoff);
  const kyc = await optional(async () => {
    const rows = await sql`SELECT status FROM kyc_verifications WHERE user_id = ${userId} ORDER BY created_at DESC LIMIT 1`;
    return rows.length ? rows[0].status : 'not_started';
  }, 'not_started');
  const alerts = await getAlertSettings(sql, userId);
  const alertsOn = alerts.lowBalance.enabled || alerts.largeTransaction.enabled;

  const items = [
    {
      id: 'faceId', title: 'Sign in with Face ID', ok: faceIds > 0,
      detail: faceIds > 0 ? `Set up on ${faceIds} device${faceIds === 1 ? '' : 's'}` : 'Quicker than your password, and nobody can look over your shoulder',
      fix: { label: 'Set up', view: 'settings-biometrics' },
    },
    {
      id: 'passcode', title: 'App passcode', ok: hasPasscode,
      detail: hasPasscode ? 'Set' : "Confirms large payments when Face ID isn't available",
      fix: { label: 'Create', view: 'settings-passcode' },
    },
    {
      id: 'confirm', title: 'Confirm large payments', ok: stepUp.enabled === true,
      detail: stepUp.enabled ? `Payments of ${money(stepUp.threshold)} or more need Face ID or your passcode` : 'Off: large payments go through without a second check',
      fix: { label: 'Turn on', view: 'settings-transaction-confirmation' },
    },
    {
      id: 'devices', title: 'Signed-in devices', ok: stale.length === 0,
      detail: stale.length
        ? `${stale.length} device${stale.length === 1 ? '' : 's'} not used in over 30 days`
        : others.length ? `${others.length} other device${others.length === 1 ? '' : 's'}, all used recently` : 'Only this device',
      fix: { label: 'Review', view: 'settings-linked-devices' },
    },
    {
      id: 'alerts', title: 'Account alerts', ok: alertsOn,
      detail: alertsOn
        ? [alerts.lowBalance.enabled ? `balance under ${money(alerts.lowBalance.threshold)}` : null, alerts.largeTransaction.enabled ? `payments over ${money(alerts.largeTransaction.threshold)}` : null].filter(Boolean).join(' · ').replace(/^./, (c) => c.toUpperCase())
        : 'Get told when your balance runs low or a big payment goes out',
      fix: { label: 'Set up', view: 'settings-alerts' },
    },
    {
      id: 'autoLock', title: 'Auto-lock', ok: autoLock <= 5,
      detail: `Signs you out after ${autoLock} minute${autoLock === 1 ? '' : 's'} of inactivity${autoLock <= 5 ? '' : ' (5 or less is safer)'}`,
      fix: { label: 'Change', view: 'settings-auto-lock' },
    },
    {
      id: 'identity', title: 'Identity verified', ok: kyc === 'verified',
      detail: kyc === 'verified' ? 'Verified' : kyc === 'pending' ? "In review, we'll let you know" : kyc === 'rejected' ? 'Needs another try' : 'Verify to unlock wires and higher limits',
      fix: kyc === 'pending' ? null : { label: 'Verify', view: 'profile' },
    },
  ];
  const done = items.filter((i) => i.ok).length;
  const score = Math.round((done / items.length) * 100);
  const label = score === 100 ? 'Excellent' : score >= 70 ? 'Good' : score >= 45 ? 'Fair' : 'Needs attention';
  return { score, label, done, total: items.length, items };
}

// ----- Download my data -----
// Everything we hold about the customer, minus secrets (password, passcode,
// PIN and SSN hashes, tokens, keys) and with account numbers shortened.
const SECRET_COLUMN = /hash|token|secret|password|passcode|pin$|^pin|ssn|otp|salt|key|jti|challenge/i;

function scrub(row) {
  const out = {};
  Object.entries(row || {}).forEach(([k, v]) => { if (!SECRET_COLUMN.test(k)) out[k] = v; });
  return out;
}

function maskNumber(v) {
  const s = String(v || '');
  return s.length > 4 ? `••••${s.slice(-4)}` : s;
}

async function exportUserData(sql, userId, { nowMs = Date.now() } = {}) {
  await ensureSettingsSchema(sql);
  const users = await sql`SELECT * FROM users WHERE id = ${userId}`;
  if (!users.length) throw new SettingsError(404, 'Account not found.');
  const accounts = await sql`SELECT * FROM accounts WHERE user_id = ${userId} ORDER BY id`;
  const data = {
    about: {
      exportedAt: new Date(nowMs).toISOString(),
      format: 'Apex Horizon Bank data export, version 1',
      note: 'Passwords, passcodes, PINs and security keys are never included. Account numbers show the last 4 digits.',
    },
    profile: scrub(users[0]),
    preferences: await getPreferences(sql, userId),
    accountAlerts: await getAlertSettings(sql, userId),
    accounts: accounts.map((a) => ({ ...scrub(a), account_number: maskNumber(a.account_number) })),
    transactions: await optional(() => sql`
      SELECT t.id, a.account_type, t.type, t.amount, t.description, t.created_at
      FROM transactions t JOIN accounts a ON a.id = t.account_id
      WHERE a.user_id = ${userId} ORDER BY t.created_at DESC, t.id DESC LIMIT 20000
    `, []),
    savingsGoals: await optional(() => sql`SELECT * FROM savings_goals WHERE user_id = ${userId} ORDER BY id`, []),
    budgets: await optional(() => sql`SELECT category, monthly_limit, created_at, updated_at FROM budgets WHERE user_id = ${userId} ORDER BY category`, []),
    supportConversations: await optional(async () => {
      const tickets = await sql`SELECT id, category, subject, status, created_at, updated_at, closed_at FROM support_tickets WHERE user_id = ${userId} ORDER BY id`;
      const messages = tickets.length ? await sql`
        SELECT m.ticket_id, m.sender, m.agent_name, m.body, m.created_at FROM support_messages m
        JOIN support_tickets t ON t.id = m.ticket_id WHERE t.user_id = ${userId} ORDER BY m.id
      ` : [];
      return tickets.map((t) => ({ ...t, messages: messages.filter((m) => Number(m.ticket_id) === Number(t.id)).map(({ ticket_id, ...m }) => m) }));
    }, []),
    notifications: await optional(() => sql`SELECT title, message, is_read, created_at FROM notifications WHERE user_id = ${userId} ORDER BY id DESC LIMIT 5000`, []),
    signIns: await optional(() => sql`SELECT method, ip_address, city, region, country, user_agent, created_at FROM login_activity WHERE user_id = ${userId} ORDER BY created_at DESC LIMIT 500`, []),
    devices: await optional(() => sql`SELECT device_name, ip_address, created_at, last_seen_at, revoked_at FROM user_sessions WHERE user_id = ${userId} ORDER BY created_at DESC LIMIT 200`, []),
  };
  data.about.counts = {
    accounts: data.accounts.length,
    transactions: data.transactions.length,
    savingsGoals: data.savingsGoals.length,
    budgets: data.budgets.length,
    supportConversations: data.supportConversations.length,
    notifications: data.notifications.length,
    signIns: data.signIns.length,
  };
  const date = new Date(nowMs).toISOString().slice(0, 10);
  return { filename: `apex-horizon-my-data-${date}.json`, json: JSON.stringify(data, null, 2), counts: data.about.counts };
}

module.exports = {
  AUTO_LOCK_CHOICES,
  DEFAULT_AUTO_LOCK,
  SettingsError,
  ensureSettingsSchema,
  getAlertSettings,
  saveAlertSettings,
  getPreferences,
  savePreferences,
  securityCheckup,
  exportUserData,
  _resetForTests: () => { schemaReady = false; },
};
