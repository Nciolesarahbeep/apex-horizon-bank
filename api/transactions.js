const { neon } = require('@neondatabase/serverless');
const { getQuery } = require('../lib/query');
const { getUserFromRequest } = require('../lib/auth');
const { parseSearchParams, searchTransactions, exportTransactionsCsv, SearchError } = require('../lib/txnSearch');

const sql = neon(process.env.DATABASE_URL || process.env.POSTGRES_URL);

module.exports = async function handler(req, res) {
  const query = getQuery(req);
  if (req.method === 'DELETE') {
    try {
      const session = await getUserFromRequest(req);
      if (!session) {
        return res.status(401).json({ error: 'Not authenticated' });
      }

      const transactionId = Number(query?.id || (req.body || {}).id);
      if (!transactionId || !Number.isFinite(transactionId)) {
        return res.status(400).json({ error: 'Transaction ID is required.' });
      }

      // Ensure the transaction belongs to the authenticated user
      const owned = await sql`
        SELECT t.id
        FROM transactions t
        JOIN accounts a ON a.id = t.account_id
        WHERE t.id = ${transactionId} AND a.user_id = ${session.userId}
        LIMIT 1
      `;

      if (owned.length === 0) {
        return res.status(404).json({ error: 'Transaction not found.' });
      }

      // Remove any open disputes first to avoid FK issues
      await sql`
        DELETE FROM transaction_disputes
        WHERE transaction_id = ${transactionId}
      `;

      await sql`
        DELETE FROM transactions
        WHERE id = ${transactionId}
      `;

      return res.status(200).json({
        success: true,
        message: 'Receipt deleted successfully.',
        id: transactionId,
      });
    } catch (err) {
      console.error('Delete transaction error:', err);
      return res.status(500).json({ error: 'Failed to delete receipt.' });
    }
  }

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET, DELETE');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const session = await getUserFromRequest(req);
    if (!session) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    // Filters: q (text or an amount), direction (in|out), type, account
    // (checking|savings|credit), minAmount, maxAmount, fromDate, toDate
    // (YYYY-MM-DD in the person's timezone, given by tzOffset), limit, cursor.
    let params;
    try {
      params = parseSearchParams(query || {});
    } catch (err) {
      if (err instanceof SearchError) return res.status(400).json({ error: err.message });
      throw err;
    }

    if (String(query.format || '').toLowerCase() === 'csv') {
      const file = await exportTransactionsCsv(sql, session.userId, params);
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${file.filename}"`);
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Row-Count', String(file.rowCount));
      if (file.truncated) res.setHeader('X-Truncated', 'true');
      return res.status(200).send(file.csv);
    }

    const result = await searchTransactions(sql, session.userId, params);
    return res.status(200).json(result);
  } catch (err) {
    console.error('Transactions endpoint error:', err);
    return res.status(500).json({ error: 'Something went wrong loading your transactions.' });
  }
};
