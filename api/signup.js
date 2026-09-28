// Account opening. The rules live in lib/accountOpening.js.
//   POST { action: 'send-email-code', email }
//   POST { action: 'verify-email-code', email, code }       -> { emailToken }
//   POST { action: 'create-account', ...application }       -> { reference }
//   POST { action: 'application-status', email, reference }
const { neon } = require('@neondatabase/serverless');
const { sendEmail } = require('../lib/email');
const { SAVINGS_APY } = require('../lib/rates');
const opening = require('../lib/accountOpening');

const sql = neon(process.env.DATABASE_URL || process.env.POSTGRES_URL);

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const body = req.body || {};
  const { action } = body;
  try {
    if (action === 'send-email-code') {
      return res.status(200).json(await opening.sendEmailCode(sql, body, { sendEmail }));
    }
    if (action === 'verify-email-code') {
      return res.status(200).json(await opening.verifyEmailCode(sql, body));
    }
    if (action === 'create-account') {
      return res.status(201).json(await opening.submitApplication(sql, body, { sendEmail, savingsApy: SAVINGS_APY }));
    }
    if (action === 'application-status') {
      return res.status(200).json(await opening.applicationStatus(sql, body));
    }
    return res.status(400).json({ error: 'Invalid or missing action.' });
  } catch (err) {
    if (err instanceof opening.OpeningError) {
      return res.status(err.status).json({ error: err.message, ...(err.field ? { field: err.field } : {}) });
    }
    console.error('Account opening error:', err);
    return res.status(500).json({ error: 'Something went wrong with your application. Please try again.' });
  }
};
