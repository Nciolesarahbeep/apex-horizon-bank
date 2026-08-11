const { neon } = require('@neondatabase/serverless');
const { generateRegistrationOptions, verifyRegistrationResponse } = require('@simplewebauthn/server');
const { getUserFromRequest } = require('../lib/auth');
const { setChallengeCookie, readChallengeCookie, clearChallengeCookie, RP_NAME, RP_ID, ORIGIN } = require('../lib/webauthn');

const sql = neon(process.env.DATABASE_URL || process.env.POSTGRES_URL);

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const session = await getUserFromRequest(req);
  if (!session) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  const { action } = req.body || {};

  if (action === 'options') {
    try {
      const userRows = await sql`SELECT id, email, full_name FROM users WHERE id = ${session.userId} LIMIT 1`;
      if (userRows.length === 0) {
        return res.status(401).json({ error: 'Not authenticated' });
      }
      const user = userRows[0];

      const existingCreds = await sql`SELECT credential_id FROM webauthn_credentials WHERE user_id = ${user.id}`;

      const options = await generateRegistrationOptions({
        rpName: RP_NAME,
        rpID: RP_ID,
        userID: Buffer.from(String(user.id)),
        userName: user.email,
        userDisplayName: user.full_name || user.email,
        attestationType: 'none',
        excludeCredentials: existingCreds.map((c) => ({
          id: Buffer.from(c.credential_id, 'base64url'),
          type: 'public-key',
        })),
        authenticatorSelection: {
          authenticatorAttachment: 'platform',
          userVerification: 'required',
          residentKey: 'preferred',
        },
      });

      setChallengeCookie(res, options.challenge, { userId: user.id });

      return res.status(200).json(options);
    } catch (err) {
      console.error('WebAuthn register-options error:', err);
      return res.status(500).json({ error: 'Could not start Face ID setup. Please try again.' });
    }
  }

  if (action === 'verify') {
    try {
      const challengeData = readChallengeCookie(req);
      if (!challengeData || challengeData.userId !== session.userId) {
        return res.status(400).json({ error: 'Face ID setup expired. Please try again.' });
      }

      const { attestationResponse, deviceName } = req.body || {};
      if (!attestationResponse) {
        return res.status(400).json({ error: 'Missing registration response.' });
      }

      const verification = await verifyRegistrationResponse({
        response: attestationResponse,
        expectedChallenge: challengeData.challenge,
        expectedOrigin: ORIGIN,
        expectedRPID: RP_ID,
      });

      if (!verification.verified || !verification.registrationInfo) {
        return res.status(400).json({ error: 'Could not verify Face ID registration. Please try again.' });
      }

      const { credentialID, credentialPublicKey, counter } = verification.registrationInfo;

      await sql`
        INSERT INTO webauthn_credentials (user_id, credential_id, public_key, counter, device_name)
        VALUES (
          ${session.userId},
          ${Buffer.from(credentialID).toString('base64url')},
          ${Buffer.from(credentialPublicKey).toString('base64url')},
          ${counter},
          ${deviceName || 'This device'}
        )
      `;

      clearChallengeCookie(res);

      return res.status(200).json({ success: true, message: 'Face ID enabled for this device.' });
    } catch (err) {
      console.error('WebAuthn register-verify error:', err);
      return res.status(500).json({ error: 'Could not complete Face ID setup. Please try again.' });
    }
  }

  return res.status(400).json({ error: 'Invalid or missing action. Use "options" or "verify".' });
};
