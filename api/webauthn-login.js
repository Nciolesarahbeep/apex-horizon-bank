const { neon } = require('@neondatabase/serverless');
const { generateAuthenticationOptions, verifyAuthenticationResponse } = require('@simplewebauthn/server');
const { normalizeEmail, signToken, setSessionCookie, createSession } = require('../lib/auth');
const { setChallengeCookie, readChallengeCookie, clearChallengeCookie, RP_ID, ORIGIN } = require('../lib/webauthn');
const { logSignInActivity, getPreviousSignIn } = require('../lib/loginActivity');
const { isKnownDevice, recordKnownDevice } = require('../lib/fraud');
const { rememberThisDevice } = require('../lib/deviceTrust');


const sql = neon(process.env.DATABASE_URL || process.env.POSTGRES_URL);
const { withPush } = require('../lib/push');

module.exports = withPush(async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { action } = req.body || {};

  if (action === 'options') {
    try {
      const { email, credentialIds } = req.body || {};

      // No email: the app sends the Face ID keys it saved on this phone, and
      // we ask the phone for exactly those, so it goes straight to the Face
      // ID scan instead of showing a list to choose from. With no saved keys
      // (or none we still know), the phone offers whatever key it has for
      // Apex, and verify works out whose it is.
      if (!email) {
        const ids = Array.isArray(credentialIds)
          ? [...new Set(credentialIds.filter((id) => typeof id === 'string' && /^[A-Za-z0-9_-]{16,1400}$/.test(id)))].slice(0, 10)
          : [];
        const known = ids.length
          ? await sql`SELECT credential_id FROM webauthn_credentials WHERE credential_id = ANY(${`{${ids.join(',')}}`}::text[])`
          : [];
        const options = await generateAuthenticationOptions({
          rpID: RP_ID,
          userVerification: 'required',
          ...(known.length ? {
            allowCredentials: known.map((c) => ({
              id: Buffer.from(c.credential_id, 'base64url'),
              type: 'public-key',
              transports: ['internal'],
            })),
          } : {}),
        });
        setChallengeCookie(res, options.challenge, { userId: null, purpose: 'login' });
        return res.status(200).json(options);
      }

      const normalizedEmail = normalizeEmail(email);
      const userRows = await sql`SELECT id FROM users WHERE email = ${normalizedEmail} LIMIT 1`;

      if (userRows.length === 0) {
        return res.status(404).json({ error: 'No account found for that email.' });
      }
      const user = userRows[0];

      const creds = await sql`SELECT credential_id FROM webauthn_credentials WHERE user_id = ${user.id}`;
      if (creds.length === 0) {
        return res.status(404).json({ error: 'Face ID is not set up for this account yet.' });
      }

      const options = await generateAuthenticationOptions({
        rpID: RP_ID,
        userVerification: 'required',
        allowCredentials: creds.map((c) => ({
          id: Buffer.from(c.credential_id, 'base64url'),
          type: 'public-key',
          transports: ['internal'],
        })),
      });

      setChallengeCookie(res, options.challenge, { userId: user.id, purpose: 'login' });

      return res.status(200).json(options);
    } catch (err) {
      console.error('WebAuthn login-options error:', err);
      return res.status(500).json({ error: 'Could not start Face ID sign-in. Please try again.' });
    }
  }

  if (action === 'verify') {
    try {
      const challengeData = readChallengeCookie(req);
      if (!challengeData || (challengeData.purpose && challengeData.purpose !== 'login')) {
        return res.status(400).json({ error: 'Face ID sign-in expired. Please try again.' });
      }

      const { assertionResponse } = req.body || {};
      if (!assertionResponse) {
        return res.status(400).json({ error: 'Missing sign-in response.' });
      }

      const credRows = await sql`
        SELECT id, user_id, credential_id, public_key, counter
        FROM webauthn_credentials
        WHERE credential_id = ${assertionResponse.id}
        LIMIT 1
      `;

      if (credRows.length === 0 || (challengeData.userId != null && credRows[0].user_id !== challengeData.userId)) {
        return res.status(400).json({ error: 'Face ID credential not recognized.' });
      }
      const credRow = credRows[0];

      const verification = await verifyAuthenticationResponse({
        response: assertionResponse,
        expectedChallenge: challengeData.challenge,
        expectedOrigin: ORIGIN,
        expectedRPID: RP_ID,
        authenticator: {
          credentialID: Buffer.from(credRow.credential_id, 'base64url'),
          credentialPublicKey: Buffer.from(credRow.public_key, 'base64url'),
          counter: Number(credRow.counter),
        },
      });

      if (!verification.verified) {
        return res.status(400).json({ error: 'Face ID verification failed. Please try again.' });
      }

      await sql`
        UPDATE webauthn_credentials SET counter = ${verification.authenticationInfo.newCounter}
        WHERE id = ${credRow.id}
      `;
      try {
        await sql`UPDATE webauthn_credentials SET last_used_at = NOW() WHERE id = ${credRow.id}`;
      } catch (e) {
        // Column is added by api/webauthn-register.js; ignore if it isn't there yet.
      }

      const userRows = await sql`
        SELECT id, email, full_name, is_active, approval_status, approval_reason
        FROM users WHERE id = ${credRow.user_id} LIMIT 1
      `;
      if (userRows.length === 0) {
        return res.status(401).json({ error: 'Account not found.' });
      }
      const user = userRows[0];

      // Same account gates as password sign-in: Face ID must not let a
      // pending, rejected or disabled account in.
      if (user.approval_status === 'pending') {
        return res.status(403).json({ error: "Your account is still under review. We'll notify you by email once a decision is made.", approvalStatus: 'pending' });
      }
      if (user.approval_status === 'rejected') {
        return res.status(403).json({
          error: user.approval_reason
            ? `Your account application was not approved: ${user.approval_reason}`
            : 'Your account application was not approved. Please contact support for details.',
          approvalStatus: 'rejected',
        });
      }
      if (!user.is_active) {
        return res.status(403).json({ error: 'This account has been disabled. Please contact support.' });
      }

      await sql`UPDATE users SET last_login_at = NOW() WHERE id = ${user.id}`;

      // Same session-tracking path as password login, so Face ID sign-ins
      // show up in — and can be revoked from — Linked Devices too.
      const jti = await createSession(user.id, req);
      const token = signToken({ userId: user.id, email: user.email, jti });
      setSessionCookie(res, token);
      clearChallengeCookie(res);

      const { known } = await isKnownDevice({ userId: user.id, req });
      if (!known) {
        await recordKnownDevice({ userId: user.id, req });
      }
      // Face ID proves it's this phone, so mark it as a trusted device
      // (that's what lets the passcode unlock work here later).
      await rememberThisDevice(sql, req, res, user.id);
      const previousSignIn = await getPreviousSignIn(user.id);
      await logSignInActivity({ req, userId: user.id, email: user.email, method: 'webauthn', isNewDevice: !known });

      return res.status(200).json({
        user: { id: user.id, email: user.email, fullName: user.full_name },
        previousSignIn,
        newDevice: !known,
      });
    } catch (err) {
      console.error('WebAuthn login-verify error:', err);
      return res.status(500).json({ error: 'Could not complete Face ID sign-in. Please try again.' });
    }
  }

  return res.status(400).json({ error: 'Invalid or missing action. Use "options" or "verify".' });
}, sql);
