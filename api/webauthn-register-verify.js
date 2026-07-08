const { neon } = require('@neondatabase/serverless');
const { verifyRegistrationResponse } = require('@simplewebauthn/server');
const { getUserFromRequest } = require('../lib/auth');
const { readChallengeCookie, clearChallengeCookie, RP_ID, ORIGIN } = require('./webauthn');

const sql = neon(process.env.DATABASE_URL || process.env.POSTGRES_URL);

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const session = getUserFromRequest(req);
    if (!session) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

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
};
