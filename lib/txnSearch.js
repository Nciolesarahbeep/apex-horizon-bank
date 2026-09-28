// Transaction search for /api/transactions.
//
// Every filter runs in SQL over the person's full history (the old version
// fetched the latest 500 rows and filtered them in JavaScript, so older
// transactions could never be found). Pages use keyset paging on
// (created_at, id), so new transactions arriving mid-scroll never shift or
// duplicate rows. The same filters can be downloaded as a CSV file.

const { isSpending, categorize } = require('./categories');

// Direction rules match the app (txnIsOutgoing in index.html): some types are
// always money in or out; anything else goes by the sign of the amount.
const IN_TYPES = ['p2p_in', 'transfer_in', 'ach_in', 'credit', 'loan_disbursement', 'interest', 'check_deposit', 'admin_credit', 'credit_payment', 'credit_reward', 'credit_refund'];
const OUT_TYPES = ['p2p_out', 'wire_out', 'transfer_out', 'debit', 'credit_purchase', 'admin_debit'];

const TYPE_LABELS = {
  p2p_in: 'Payment received',
  p2p_out: 'Payment sent',
  transfer_in: 'Transfer in',
  transfer_out: 'Transfer out',
  wire_out: 'Wire transfer',
  ach_in: 'Direct deposit',
  debit: 'Debit',
  credit: 'Credit',
  credit_purchase: 'Card purchase',
  credit_payment: 'Card payment',
  credit_reward: 'Cash back credit',
  credit_refund: 'Card refund',
  loan_disbursement: 'Loan disbursement',
  interest: 'Interest',
  check_deposit: 'Check deposit',
  admin_credit: 'Bank credit',
  admin_debit: 'Bank debit',
};

const ACCOUNT_LABELS = { checking: 'Checking', savings: 'Savings', credit: 'Credit card' };
const MAX_LIMIT = 300;
const CSV_MAX_ROWS = 10000;

class SearchError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SearchError';
    this.status = 400;
  }
}

function parseAmount(value) {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  const n = Number(String(value).replace(/[$,\s]/g, ''));
  if (!Number.isFinite(n) || n < 0) throw new SearchError('Enter amounts as positive numbers.');
  return Math.round(n * 100) / 100;
}

// A calendar day in the person's own timezone. tzOffset is minutes behind UTC,
// exactly what the browser's Date#getTimezoneOffset() returns (Lagos is -60).
function parseDay(value, tzOffset, endOfDay) {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value).trim());
  if (!m) throw new SearchError('Use dates like 2026-09-27.');
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const check = new Date(Date.UTC(y, mo - 1, d));
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) {
    throw new SearchError('Use dates like 2026-09-27.');
  }
  const localMidnight = Date.UTC(y, mo - 1, d + (endOfDay ? 1 : 0));
  return new Date(localMidnight + tzOffset * 60000).toISOString();
}

function encodeCursor(key, id) {
  return Buffer.from(JSON.stringify({ k: String(key), id: Number(id) })).toString('base64url');
}

function decodeCursor(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  try {
    const o = JSON.parse(Buffer.from(String(raw), 'base64url').toString('utf8'));
    const keyOk = typeof o.k === 'string' && /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d{1,6})?([+-]\d{2}(:?\d{2})?|Z)?$/.test(o.k);
    if (keyOk && Number.isInteger(o.id) && o.id > 0) return o;
  } catch (err) {
    // fall through
  }
  throw new SearchError('That page of results has expired. Please search again.');
}

function parseSearchParams(query) {
  const q = String(query.q || '').replace(/\s+/g, ' ').trim().slice(0, 100);
  // Typing an amount ("4.35", "$1,200") also finds transactions of that amount.
  const amountMatch = /^\$?\s*(\d{1,9}(?:,\d{3})*(?:\.\d{1,2})?)$/.exec(q);
  const qAmount = amountMatch ? Number(amountMatch[1].replace(/,/g, '')) : null;

  const rawType = String(query.type || '').trim().toLowerCase();
  const type = /^[a-z0-9_]{1,40}$/.test(rawType) ? rawType : null;
  const rawDirection = String(query.direction || '').trim().toLowerCase();
  const direction = rawDirection === 'in' || rawDirection === 'out' ? rawDirection : null;
  const rawAccount = String(query.account || '').trim().toLowerCase();
  const account = Object.prototype.hasOwnProperty.call(ACCOUNT_LABELS, rawAccount) ? rawAccount : null;

  let minAmount = parseAmount(query.minAmount);
  let maxAmount = parseAmount(query.maxAmount);
  if (minAmount !== null && maxAmount !== null && minAmount > maxAmount) {
    [minAmount, maxAmount] = [maxAmount, minAmount];
  }

  const tzRaw = Number(query.tzOffset);
  const tzOffset = Number.isInteger(tzRaw) && Math.abs(tzRaw) <= 840 ? tzRaw : 0;
  const fromTs = parseDay(query.fromDate, tzOffset, false);
  const toTs = parseDay(query.toDate, tzOffset, true);
  if (fromTs && toTs && fromTs >= toTs) throw new SearchError('The start date is after the end date.');

  const limitRaw = Number(query.limit);
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(Math.floor(limitRaw), 1), MAX_LIMIT) : 50;
  const cursor = decodeCursor(query.cursor);

  return { q, qAmount, type, direction, account, minAmount, maxAmount, fromTs, toTs, tzOffset, limit, cursor };
}

function likePattern(q) {
  return q ? `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
}

// One parameterized statement; a filter left empty is passed as NULL and
// switches itself off. Nothing the person types is ever spliced into the SQL.
async function queryTransactions(sql, userId, p, { limit, useCursor = true }) {
  const pattern = likePattern(p.q);
  const cursorKey = useCursor && p.cursor ? p.cursor.k : null;
  const cursorId = useCursor && p.cursor ? p.cursor.id : null;
  return sql`
    SELECT t.id, t.type, t.amount, t.description, t.created_at, a.account_type,
           t.created_at::text AS created_key,
           to_char(t.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_iso,
           COUNT(*) OVER () AS total_matched
    FROM transactions t
    JOIN accounts a ON a.id = t.account_id
    WHERE a.user_id = ${userId}
      AND (${pattern}::text IS NULL
           OR t.description ILIKE ${pattern}::text
           OR (${p.qAmount}::numeric IS NOT NULL AND ABS(t.amount) = ${p.qAmount}::numeric))
      AND (${p.type}::text IS NULL OR t.type = ${p.type}::text)
      AND (${p.account}::text IS NULL OR a.account_type = ${p.account}::text)
      AND (${p.direction}::text IS NULL
           OR (${p.direction}::text = 'in' AND (
                t.type IN ('p2p_in', 'transfer_in', 'ach_in', 'credit', 'loan_disbursement', 'interest', 'check_deposit', 'admin_credit', 'credit_payment', 'credit_reward', 'credit_refund')
                OR (t.type NOT IN ('p2p_out', 'wire_out', 'transfer_out', 'debit', 'credit_purchase', 'admin_debit')
                    AND t.type NOT IN ('p2p_in', 'transfer_in', 'ach_in', 'credit', 'loan_disbursement', 'interest', 'check_deposit', 'admin_credit', 'credit_payment', 'credit_reward', 'credit_refund')
                    AND t.amount >= 0)))
           OR (${p.direction}::text = 'out' AND (
                t.type IN ('p2p_out', 'wire_out', 'transfer_out', 'debit', 'credit_purchase', 'admin_debit')
                OR (t.type NOT IN ('p2p_in', 'transfer_in', 'ach_in', 'credit', 'loan_disbursement', 'interest', 'check_deposit', 'admin_credit', 'credit_payment', 'credit_reward', 'credit_refund')
                    AND t.type NOT IN ('p2p_out', 'wire_out', 'transfer_out', 'debit', 'credit_purchase', 'admin_debit')
                    AND t.amount < 0))))
      AND (${p.minAmount}::numeric IS NULL OR ABS(t.amount) >= ${p.minAmount}::numeric)
      AND (${p.maxAmount}::numeric IS NULL OR ABS(t.amount) <= ${p.maxAmount}::numeric)
      AND (${p.fromTs}::timestamptz IS NULL OR t.created_at >= ${p.fromTs}::timestamptz)
      AND (${p.toTs}::timestamptz IS NULL OR t.created_at < ${p.toTs}::timestamptz)
      AND (${cursorKey}::timestamptz IS NULL OR (t.created_at, t.id) < (${cursorKey}::timestamptz, ${cursorId}::int))
    ORDER BY t.created_at DESC, t.id DESC
    LIMIT ${limit}
  `;
}

async function searchTransactions(sql, userId, p) {
  const rows = await queryTransactions(sql, userId, p, { limit: p.limit + 1 });
  const hasMore = rows.length > p.limit;
  const page = rows.slice(0, p.limit);
  const last = page[page.length - 1];
  return {
    transactions: page.map((r) => ({
      id: r.id,
      type: r.type,
      amount: r.amount,
      description: r.description,
      created_at: r.created_at,
      account_type: r.account_type,
    })),
    // Only the first page counts everything; later pages count what's left.
    totalMatched: p.cursor ? null : (rows.length ? Number(rows[0].total_matched) : 0),
    limit: p.limit,
    hasMore,
    nextCursor: hasMore && last ? encodeCursor(last.created_key, last.id) : null,
    filters: {
      q: p.q,
      type: p.type,
      direction: p.direction,
      account: p.account,
      minAmount: p.minAmount,
      maxAmount: p.maxAmount,
      fromTs: p.fromTs,
      toTs: p.toTs,
    },
  };
}

function isOutgoing(t) {
  if (OUT_TYPES.includes(t.type)) return true;
  if (IN_TYPES.includes(t.type)) return false;
  return Number(t.amount) < 0;
}

// Spreadsheet apps run cells that start with = + - @ as formulas, so text
// cells get a leading apostrophe (OWASP "CSV injection" guidance).
function csvText(value) {
  let s = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) || s !== s.trim() ? `"${s.replace(/"/g, '""')}"` : s;
}

function humanizeType(type) {
  return String(type || 'Transaction').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

// Same categories as Budgets and Insights (lib/categories.js). Money in is
// "Income"; moves between your own accounts, goals and card payments are
// "Transfers" because they aren't spending.
function csvCategory(t, out) {
  if (!out) return 'Income';
  return isSpending(t) ? categorize(t).name : 'Transfers';
}

function buildCsv(rows, tzOffset) {
  const lines = ['Date,Time,Description,Category,Type,Account,Direction,Amount,Reference'];
  for (const t of rows) {
    const out = isOutgoing(t);
    const utcMs = Date.parse(t.created_iso);
    const local = new Date(utcMs - tzOffset * 60000).toISOString();
    const amount = (out ? -1 : 1) * Math.abs(Number(t.amount));
    lines.push([
      local.slice(0, 10),
      local.slice(11, 16),
      csvText(t.description || humanizeType(t.type)),
      csvText(csvCategory(t, out)),
      csvText(TYPE_LABELS[t.type] || humanizeType(t.type)),
      csvText(ACCOUNT_LABELS[t.account_type] || t.account_type || ''),
      out ? 'Out' : 'In',
      amount.toFixed(2),
      `TXN-${t.id}`,
    ].join(','));
  }
  // The byte-order mark makes Excel read the file as UTF-8 (em dashes etc.).
  return `﻿${lines.join('\r\n')}\r\n`;
}

async function exportTransactionsCsv(sql, userId, p) {
  const rows = await queryTransactions(sql, userId, p, { limit: CSV_MAX_ROWS + 1, useCursor: false });
  const truncated = rows.length > CSV_MAX_ROWS;
  const today = new Date(Date.now() - p.tzOffset * 60000).toISOString().slice(0, 10);
  return {
    csv: buildCsv(rows.slice(0, CSV_MAX_ROWS), p.tzOffset),
    filename: `apex-horizon-transactions-${today}.csv`,
    rowCount: Math.min(rows.length, CSV_MAX_ROWS),
    truncated,
  };
}

module.exports = {
  SearchError,
  parseSearchParams,
  searchTransactions,
  exportTransactionsCsv,
  buildCsv,
  csvText,
  IN_TYPES,
  OUT_TYPES,
  CSV_MAX_ROWS,
};
