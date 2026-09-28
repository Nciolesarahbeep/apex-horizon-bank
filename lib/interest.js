// Savings interest engine.
//
// Interest compounds daily at each savings account's apy_rate and is credited
// straight into the balance (the way Revolut / many high-yield accounts pay
// daily), with an "Interest Earned" ledger row. It runs from the daily cron in
// api/account-services.js and can be triggered manually from the admin panel.
//
// Everything happens in ONE SQL statement: the balance update, the
// interest_accrued_at reset, and the ledger rows land together or not at all.
// Because interest is computed from the time since interest_accrued_at, running
// it twice in a row never double-pays; the second run just finds ~0 elapsed.
//
// Amounts under one cent are not paid out and interest_accrued_at is left alone,
// so small balances keep accruing until they reach at least $0.01.

const { SAVINGS_APY } = require('./rates');

async function creditSavingsInterest(sql, { minHoursSinceLastCredit = 20 } = {}) {
  // Older savings accounts created before APY existed have no rate or start
  // time. Give them the standard rate and start their accrual clock now.
  await sql`
    UPDATE accounts
    SET apy_rate = COALESCE(apy_rate, ${SAVINGS_APY}),
        interest_accrued_at = COALESCE(interest_accrued_at, NOW())
    WHERE account_type = 'savings'
      AND (apy_rate IS NULL OR interest_accrued_at IS NULL)
  `;

  const minHours = Math.max(0, Number(minHoursSinceLastCredit) || 0);

  const rows = await sql`
    WITH due AS (
      SELECT a.id,
             ROUND(
               (a.balance * (
                 POWER(1 + a.apy_rate / 365.0,
                       EXTRACT(EPOCH FROM (NOW() - a.interest_accrued_at)) / 86400.0)
                 - 1
               ))::numeric,
               2
             ) AS interest
      FROM accounts a
      WHERE a.account_type = 'savings'
        AND a.apy_rate > 0
        AND a.balance > 0
        AND a.interest_accrued_at IS NOT NULL
        AND a.interest_accrued_at <= NOW() - make_interval(hours => ${minHours})
      FOR UPDATE
    ),
    paid AS (
      UPDATE accounts a
      SET balance = a.balance + d.interest,
          interest_accrued_at = NOW()
      FROM due d
      WHERE a.id = d.id AND d.interest >= 0.01
      RETURNING a.id, a.user_id, d.interest
    ),
    ledger AS (
      INSERT INTO transactions (account_id, type, amount, description, created_at)
      SELECT p.id, 'interest', p.interest, 'Interest Earned', NOW()
      FROM paid p
      RETURNING id
    )
    SELECT
      (SELECT COUNT(*) FROM paid)::int AS accounts_paid,
      (SELECT COALESCE(SUM(interest), 0) FROM paid) AS total_paid,
      (SELECT COUNT(*) FROM ledger)::int AS ledger_rows
  `;

  const result = rows[0] || {};
  return {
    accountsPaid: Number(result.accounts_paid || 0),
    totalPaid: Number(result.total_paid || 0),
  };
}

module.exports = { creditSavingsInterest };
