const { neon } = require('@neondatabase/serverless');
const {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} = require('@simplewebauthn/server');
const { getUserFromRequest } = require('../lib/auth');
const { setChallengeCookie, readChallengeCookie, clearChallengeCookie, RP_NAME, RP_ID, ORIGIN } = require('../lib/webauthn');
const { issueStepUpToken, ensureStepUpSchema } = require('../lib/stepUp');

const sql = neon(process.env.DATABASE_URL || process.env.POSTGRES_URL);

// Signed-in Face ID management:
//   options / verify              — set up Face ID on this device
//   status                        — which devices have Face ID
//   remove                        — turn Face ID off for one device
//   stepup-options / stepup-verify — confirm a large transfer with Face ID
// Face ID *sign-in* lives in api/webauthn-login.js (no session yet there).

async function ensureCredentialColumns() {
  await sql`ALTER TABLE webauthn_credentials ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW()`;
  await sql`ALTER TABLE webauthn_credentials ADD COLUMN IF NOT EXISTS last_used_at TIMESTAMPTZ`;
}

async function createNotification(userId, title, message) {
  try {
    await sql`
      INSERT INTO notifications (user_id, title, message, is_read, created_at)
      VALUES (${userId}, ${title}, ${message}, FALSE, NOW())
    `;
  } catch (err) {
    console.error('Face ID notification error (non-fatal):', err);
  }
}

function cleanDeviceName(name) {
  const n = String(name || '').replace(/[^\w\s().,'-]/g, '').trim().slice(0, 40);
  return n || 'This device';
}

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

  // ---------- Set up Face ID on this device ----------
  if (action === 'options') {
    try {
      await ensureCredentialColumns();
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

      setChallengeCookie(res, options.challenge, { userId: user.id, purpose: 'register' });

      return res.status(200).json(options);
    } catch (err) {
      console.error('WebAuthn register-options error:', err);
      return res.status(500).json({ error: 'Could not start Face ID setup. Please try again.' });
    }
  }

  if (action === 'verify') {
    try {
      await ensureCredentialColumns();
      const challengeData = readChallengeCookie(req);
      if (!challengeData || challengeData.userId !== session.userId || (challengeData.purpose && challengeData.purpose !== 'register')) {
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
        requireUserVerification: true,
      });

      if (!verification.verified || !verification.registrationInfo) {
        return res.status(400).json({ error: 'Could not verify Face ID registration. Please try again.' });
      }

      const { credentialID, credentialPublicKey, counter } = verification.registrationInfo;
      const credentialId = Buffer.from(credentialID).toString('base64url');
      const name = cleanDeviceName(deviceName);

      await sql`
        INSERT INTO webauthn_credentials (user_id, credential_id, public_key, counter, device_name, created_at, last_used_at)
        VALUES (
          ${session.userId},
          ${credentialId},
          ${Buffer.from(credentialPublicKey).toString('base64url')},
          ${counter},
          ${name},
          NOW(),
          NOW()
        )
      `;

      clearChallengeCookie(res);
      await createNotification(session.userId, 'Face ID Turned On', `Face ID was set up on ${name}. If this wasn't you, remove it in Settings → Biometrics and change your password.`);

      return res.status(200).json({ success: true, credentialId, message: 'Face ID enabled for this device.' });
    } catch (err) {
      console.error('WebAuthn register-verify error:', err);
      return res.status(500).json({ error: 'Could not complete Face ID setup. Please try again.' });
    }
  }

  // ---------- Which devices have Face ID ----------
  if (action === 'status') {
    try {
      await ensureCredentialColumns();
      const rows = await sql`
        SELECT id, credential_id, device_name, created_at, last_used_at
        FROM webauthn_credentials
        WHERE user_id = ${session.userId}
        ORDER BY COALESCE(last_used_at, created_at) DESC NULLS LAST
      `;
      return res.status(200).json({
        enabled: rows.length > 0,
        devices: rows.map((r) => ({
          id: r.id,
          credentialId: r.credential_id,
          deviceName: r.device_name || 'Device',
          createdAt: r.created_at,
          lastUsedAt: r.last_used_at,
        })),
      });
    } catch (err) {
      console.error('WebAuthn status error:', err);
      return res.status(500).json({ error: 'Could not load Face ID status.' });
    }
  }

  // ---------- Turn Face ID off for one device ----------
  if (action === 'remove') {
    try {
      const { credentialRowId } = req.body || {};
      const rows = await sql`
        DELETE FROM webauthn_credentials
        WHERE id = ${Number(credentialRowId)} AND user_id = ${session.userId}
        RETURNING device_name
      `;
      if (rows.length === 0) return res.status(404).json({ error: 'That device was not found.' });
      await createNotification(session.userId, 'Face ID Removed', `Face ID was turned off for ${rows[0].device_name || 'a device'}.`);
      return res.status(200).json({ success: true });
    } catch (err) {
      console.error('WebAuthn remove error:', err);
      return res.status(500).json({ error: 'Could not remove Face ID from that device.' });
    }
  }

  // ---------- Confirm a large transfer with Face ID ----------
  if (action === 'stepup-options') {
    try {
      const creds = await sql`SELECT credential_id FROM webauthn_credentials WHERE user_id = ${session.userId}`;
      if (creds.length === 0) {
        return res.status(404).json({ error: 'Face ID is not set up on this account.', noFaceId: true });
      }
      const amount = Number((req.body || {}).amount) || null;
      const options = await generateAuthenticationOptions({
        rpID: RP_ID,
        userVerification: 'required',
        allowCredentials: creds.map((c) => ({
          id: Buffer.from(c.credential_id, 'base64url'),
          type: 'public-key',
        })),
      });
      const scope = (req.body || {}).scope === 'card-details' ? 'card-details' : 'money';
      setChallengeCookie(res, options.challenge, { userId: session.userId, purpose: 'stepup', amount, scope });
      return res.status(200).json(options);
    } catch (err) {
      console.error('WebAuthn stepup-options error:', err);
      return res.status(500).json({ error: 'Could not start Face ID. Please try again or use your passcode.' });
    }
  }

  if (action === 'stepup-verify') {
    try {
      await ensureCredentialColumns();
      await ensureStepUpSchema(sql);
      const challengeData = readChallengeCookie(req);
      if (!challengeData || challengeData.userId !== session.userId || challengeData.purpose !== 'stepup') {
        return res.status(400).json({ error: 'Face ID confirmation expired. Please try again.' });
      }

      const { assertionResponse } = req.body || {};
      if (!assertionResponse || !assertionResponse.id) {
        return res.status(400).json({ error: 'Missing Face ID response.' });
      }

      const credRows = await sql`
        SELECT id, user_id, credential_id, public_key, counter
        FROM webauthn_credentials
        WHERE credential_id = ${assertionResponse.id} AND user_id = ${session.userId}
        LIMIT 1
      `;
      if (credRows.length === 0) {
        return res.status(400).json({ error: 'Face ID on this device is not linked to your account.' });
      }
      const credRow = credRows[0];

      const verification = await verifyAuthenticationResponse({
        response: assertionResponse,
        expectedChallenge: challengeData.challenge,
        expectedOrigin: ORIGIN,
        expectedRPID: RP_ID,
        requireUserVerification: true,
        authenticator: {
          credentialID: Buffer.from(credRow.credential_id, 'base64url'),
          credentialPublicKey: Buffer.from(credRow.public_key, 'base64url'),
          counter: Number(credRow.counter),
        },
      });

      if (!verification.verified) {
        return res.status(400).json({ error: 'Face ID did not match. Please try again or use your passcode.' });
      }

      await sql`
        UPDATE webauthn_credentials
        SET counter = ${verification.authenticationInfo.newCounter}, last_used_at = NOW()
        WHERE id = ${credRow.id}
      `;
      clearChallengeCookie(res);

      const { token, expiresInSeconds } = issueStepUpToken({
        userId: session.userId,
        jti: session.jti,
        method: 'face_id',
        maxAmount: challengeData.amount,
        scope: challengeData.scope,
      });
      return res.status(200).json({ success: true, stepUpToken: token, expiresInSeconds });
    } catch (err) {
      console.error('WebAuthn stepup-verify error:', err);
      return res.status(500).json({ error: 'Could not confirm with Face ID. Please try again or use your passcode.' });
    }
  }

  return res.status(400).json({ error: 'Invalid or missing action. Use "options", "verify", "status", "remove", "stepup-options" or "stepup-verify".' });
};
