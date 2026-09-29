const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { sendEmail } = require('./email');
const { layout, detailsTable, highlightBox, notice, p, h } = require('./emailLayout');

const OTP_SECRET = process.env.JWT_SECRET || process.env.OTP_SECRET;
const OTP_TTL_SECONDS = 10 * 60; // 10 minutes
const MAX_ATTEMPTS = 5;

function generateOtpCode() {
  return crypto.randomInt(100000, 1000000).toString();
}

function hashCode(code) {
  return crypto.createHash('sha256').update(code).digest('hex');
}

function otpEmailHtml(code) {
  return layout({
    preheader: `${code} is your Apex Horizon Bank verification code.`,
    body: [
      h('Verify this sign-in'),
      p("We noticed a sign-in from a device we don't recognise. Enter this code to continue:"),
      highlightBox(code, { label: 'Verification code', spacing: '0.2em' }),
      detailsTable([
        ['Purpose', 'Sign-in verification'],
        ['Code valid for', '10 minutes, one use'],
      ]),
      notice("<strong>Didn't try to sign in?</strong> Don't share this code with anyone. Change your password in the app to secure your account.", 'alert'),
    ].join(''),
  });
}

async function generateAndSendLoginOtp({ userId, email, fingerprint }) {
  const code = generateOtpCode();
  const codeHash = hashCode(code);

  const pendingToken = jwt.sign(
    {
      purpose: 'login-otp',
      userId,
      fingerprint,
      codeHash,
      attempts: 0,
    },
    OTP_SECRET,
    { expiresIn: OTP_TTL_SECONDS }
  );

  const sent = await sendEmail({
    to: email,
    subject: 'Your Apex Horizon Bank verification code',
    html: otpEmailHtml(code),
  });

  if (!sent) {
    // Email is best-effort elsewhere in this app, but here the code IS the
    // login path — if it didn't send, the user has no way to get the code.
    console.error(`Login OTP email failed to send for user ${userId}`);
  }

  return pendingToken;
}

async function verifyLoginOtp({ pendingToken, code }) {
  if (!pendingToken || !code) {
    return { success: false, error: 'Missing verification code.' };
  }

  let payload;
  try {
    payload = jwt.verify(pendingToken, OTP_SECRET);
  } catch (err) {
    return { success: false, error: 'This verification code has expired. Please log in again.' };
  }

  if (payload.purpose !== 'login-otp') {
    return { success: false, error: 'Invalid verification session.' };
  }

  if (payload.attempts >= MAX_ATTEMPTS) {
    return { success: false, error: 'Too many incorrect attempts. Please log in again.' };
  }

  const submittedHash = hashCode(String(code).trim());
  if (submittedHash !== payload.codeHash) {
    return { success: false, error: 'Incorrect verification code.' };
  }

  return { success: true, userId: payload.userId };
}

module.exports = { generateAndSendLoginOtp, verifyLoginOtp };
