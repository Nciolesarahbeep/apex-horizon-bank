const { neon } = require('@neondatabase/serverless');
const { getUserFromRequest } = require('../lib/auth');
const crypto = require('crypto');

const sql = neon(process.env.DATABASE_URL || process.env.POSTGRES_URL);

module.exports = async function handler(req, res) {
  const session = getUserFromRequest(req);
  if (!session) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  // GET /api/kyc - Check KYC status
  if (req.method === 'GET') {
    try {
      const kyc = await sql`
        SELECT id, status, verified_at, rejected_reason
        FROM kyc_verifications
        WHERE user_id = ${session.userId}
        ORDER BY created_at DESC
        LIMIT 1
      `;

      if (kyc.length === 0) {
        return res.status(200).json({
          status: 'not_started',
          message: 'KYC not started yet. Begin the verification process.',
        });
      }

      return res.status(200).json({
        kycId: kyc[0].id,
        status: kyc[0].status,
        verifiedAt: kyc[0].verified_at,
        rejectedReason: kyc[0].rejected_reason,
      });
    } catch (err) {
      console.error('Get KYC status error:', err);
      return res.status(500).json({ error: 'Failed to fetch KYC status.' });
    }
  }

  // POST /api/kyc - Submit KYC information
  if (req.method === 'POST') {
    try {
      const {
        dateOfBirth,
        ssn,
        streetAddress,
        city,
        state,
        zipCode,
        idType,
        idNumber,
        idExpiryDate,
        idIssuingState,
      } = req.body || {};

      // Validation
      if (!dateOfBirth || !ssn || !streetAddress || !city || !state || !zipCode) {
        return res.status(400).json({ error: 'All personal information fields are required.' });
      }

      if (!idType || !idNumber || !idExpiryDate || !idIssuingState) {
        return res.status(400).json({ error: 'All ID fields are required.' });
      }

      // Validate SSN format (9 digits)
      const cleanSSN = ssn.replace(/-/g, '');
      if (!/^\d{9}$/.test(cleanSSN)) {
        return res.status(400).json({ error: 'Invalid SSN format. Must be 9 digits.' });
      }

      // Validate date of birth (must be 18+)
      const dob = new Date(dateOfBirth);
      const age = new Date().getFullYear() - dob.getFullYear();
      if (age < 18) {
        return res.status(400).json({ error: 'Must be at least 18 years old.' });
      }

      // Hash SSN (never store plaintext)
      const ssnHash = crypto.createHash('sha256').update(cleanSSN).digest('hex');
      const ssnLastFour = cleanSSN.slice(-4);

      // Check if KYC already exists and not rejected
      const existing = await sql`
        SELECT id, status FROM kyc_verifications
        WHERE user_id = ${session.userId}
        ORDER BY created_at DESC LIMIT 1
      `;

      if (existing.length > 0 && existing[0].status !== 'rejected') {
        return res.status(400).json({
          error: 'KYC already submitted. Please wait for review or contact support if rejected.',
        });
      }

      // Create KYC record
      const kycResult = await sql`
        INSERT INTO kyc_verifications (
          user_id,
          ssn_hash,
          ssn_last_four,
          date_of_birth,
          street_address,
          city,
          state,
          zip_code,
          id_type,
          id_number,
          id_expiry_date,
          id_issuing_state,
          status
        )
        VALUES (
          ${session.userId},
          ${ssnHash},
          ${ssnLastFour},
          ${dateOfBirth},
          ${streetAddress},
          ${city},
          ${state},
          ${zipCode},
          ${idType},
          ${idNumber},
          ${idExpiryDate},
          ${idIssuingState},
          'pending'
        )
        RETURNING id, status, created_at
      `;

      return res.status(201).json({
        success: true,
        kycId: kycResult[0].id,
        status: 'pending',
        message: 'KYC submitted successfully. Verification typically completes within 24 hours.',
      });
    } catch (err) {
      console.error('Submit KYC error:', err);
      return res.status(500).json({ error: 'Failed to submit KYC.' });
    }
  }

  res.setHeader('Allow', 'GET, POST');
  return res.status(405).json({ error: 'Method not allowed' });
};
