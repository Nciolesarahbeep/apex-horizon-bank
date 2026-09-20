const { neon } = require('@neondatabase/serverless');
const { getUserFromRequest, revokeSessionByJti } = require('../lib/auth');
// TEMPORARY minimal restore - full file in artifacts
module.exports = async function handler(req, res) {
  return res.status(503).json({ error: 'Account services temporarily updating. Please retry in 1 minute.' });
};
