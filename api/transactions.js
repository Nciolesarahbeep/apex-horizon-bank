const { neon } = require('@neondatabase/serverless');
const { getUserFromRequest } = require('../lib/auth');

const sql = neon(process.env.DATABASE_URL || process.env.POSTGRES_URL);

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const session = await getUserFromRequest(req);
    if (!session) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const limit = Math.min(Math.max(Number(req.query?.limit) || 50, 1), 300);
    const q = String(req.query?.q || '').trim().toLowerCase();
    const type = String(req.query?.type || '').trim().toLowerCase();
    const direction = String(req.query?.direction || '').trim().toLowerCase();
    const minAmount = req.query?.minAmount !== undefined && req.query?.minAmount !== ''
      ? Number(req.query.minAmount)
      : null;
    const maxAmount = req.query?.maxAmount !== undefined && req.query?.maxAmount !== ''
      ? Number(req.query.maxAmount)
      : null;
    const fromDate = String(req.query?.fromDate || '').trim();
    const toDate = String(req.query?.toDate || '').trim();

    const fetchLimit = Math.min(500, Math.max(limit * 4, 100));

    const rows = await sql`
      SELECT
        t.id,
        t.type,
        t.amount,
        t.description,
        t.created_at,
        a.account_type
      FROM transactions t
      JOIN accounts a ON a.id = t.account_id
      WHERE a.user_id = ${session.userId}
      ORDER BY t.created_at DESC
      LIMIT ${fetchLimit}
    `;

    const incomingTypes = new Set([
      'p2p_in', 'transfer_in', 'ach_in', 'credit', 'loan_disbursement',
    ]);
    const outgoingTypes = new Set([
      'p2p_out', 'transfer_out', 'wire_out', 'debit',
    ]);

    let filtered = rows;

    if (q) {
      filtered = filtered.filter((t) => {
        const hay = `${t.description || ''} ${t.type || ''} ${t.account_type || ''}`.toLowerCase();
        return hay.includes(q);
      });
    }

    if (type) {
      filtered = filtered.filter((t) => String(t.type || '').toLowerCase() === type);
    }

    if (direction === 'in') {
      filtered = filtered.filter((t) => incomingTypes.has(t.type));
    } else if (direction === 'out') {
      filtered = filtered.filter((t) => outgoingTypes.has(t.type) || (!incomingTypes.has(t.type) && Number(t.amount) < 0));
    }

    if (minAmount !== null && Number.isFinite(minAmount)) {
      filtered = filtered.filter((t) => Math.abs(Number(t.amount)) >= minAmount);
    }
    if (maxAmount !== null && Number.isFinite(maxAmount)) {
      filtered = filtered.filter((t) => Math.abs(Number(t.amount)) <= maxAmount);
    }

    if (fromDate && /^\d{4}-\d{2}-\d{2}$/.test(fromDate)) {
      const from = new Date(fromDate + 'T00:00:00.000Z');
      filtered = filtered.filter((t) => new Date(t.created_at) >= from);
    }
    if (toDate && /^\d{4}-\d{2}-\d{2}$/.test(toDate)) {
      const to = new Date(toDate + 'T23:59:59.999Z');
      filtered = filtered.filter((t) => new Date(t.created_at) <= to);
    }

    const totalMatched = filtered.length;
    const page = filtered.slice(0, limit);

    return res.status(200).json({
      transactions: page,
      totalMatched,
      limit,
      filters: { q, type, direction, minAmount, maxAmount, fromDate, toDate },
    });
  } catch (err) {
    console.error('Transactions endpoint error:', err);
    return res.status(500).json({ error: 'Something went wrong loading your transactions.' });
  }
};
