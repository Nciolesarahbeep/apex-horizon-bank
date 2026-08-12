const { neon } = require('@neondatabase/serverless');
const { getUserFromRequest } = require('../lib/auth');

const sql = neon(process.env.DATABASE_URL || process.env.POSTGRES_URL);

const CLAUDE_MODEL = 'claude-haiku-4-5-20251001';
const MAX_REPLY_TOKENS = 400;

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const session = await getUserFromRequest(req);
    if (!session) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const { message } = req.body || {};
    if (!message || typeof message !== 'string' || !message.trim()) {
      return res.status(400).json({ error: 'A message is required.' });
    }
    if (message.length > 1000) {
      return res.status(400).json({ error: 'Message is too long.' });
    }

    if (!process.env.ANTHROPIC_API_KEY) {
      console.error('ANTHROPIC_API_KEY is not set.');
      return res.status(500).json({ error: 'Ask Apex AI is not configured yet. Please try again later.' });
    }

    // Pull real, current account + transaction data so the assistant answers
    // from actual numbers instead of guessing.
    const accounts = await sql`
      SELECT account_type, balance FROM accounts
      WHERE user_id = ${session.userId}
    `;

    const recentTxns = await sql`
      SELECT t.type, t.amount, t.description, t.created_at
      FROM transactions t
      JOIN accounts a ON a.id = t.account_id
      WHERE a.user_id = ${session.userId}
      ORDER BY t.created_at DESC
      LIMIT 15
    `;

    const accountSummary = accounts
      .map(a => `- ${a.account_type}: $${Number(a.balance).toFixed(2)}`)
      .join('\n') || '(no accounts found)';

    const txnSummary = recentTxns
      .map(t => `- ${new Date(t.created_at).toLocaleDateString('en-US', { month: 'short', day: '2-digit' })} | ${t.type} | ${t.description} | $${Number(t.amount).toFixed(2)}`)
      .join('\n') || '(no recent transactions)';

    const systemPrompt = `You are Apex, the AI assistant for Apex Horizon Bank's mobile app. You help the logged-in customer understand their own account activity and answer general banking questions about how the app works.

Ground rules:
- You are read-only. You cannot move money, change settings, freeze cards, or take any action — only answer questions and explain things. If asked to perform an action, explain the customer needs to use the relevant screen in the app (Send Money, Send Wire, Settings, etc.).
- Never reveal full card numbers, CVV, PIN, or full account numbers, even if present in context — the app already masks these by design.
- Keep answers concise and conversational, 2-4 sentences unless the question needs a list.
- If asked about something outside this customer's own data or general banking help, say you can only help with their Apex Horizon account and general app questions.

Customer's current account balances:
${accountSummary}

Customer's recent transactions (most recent first):
${txnSummary}`;

    const apiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: CLAUDE_MODEL,
        max_tokens: MAX_REPLY_TOKENS,
        system: systemPrompt,
        messages: [
          { role: 'user', content: message.trim() },
        ],
      }),
    });

    if (!apiRes.ok) {
      const errText = await apiRes.text();
      console.error('Claude API error:', apiRes.status, errText);
      return res.status(502).json({ error: 'Ask Apex AI is having trouble right now. Please try again in a moment.' });
    }

    const data = await apiRes.json();
    const replyText = (data.content || [])
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('\n')
      .trim();

    if (!replyText) {
      return res.status(502).json({ error: 'Ask Apex AI could not generate a response. Please try again.' });
    }

    return res.status(200).json({ reply: replyText });
  } catch (err) {
    console.error('Assistant error:', err);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
};
