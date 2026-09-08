const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { sendEmail } = require('./email');

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
  return `
    <div style="font-family: Arial, Helvetica, sans-serif; max-width: 480px; margin: 0 auto; padding: 24px; color: #111;">
      <div style="font-size: 12px; font-weight: bold; letter-spacing: 0.05em; text-transform: uppercase; color: #10b981; margin-bottom: 16px;">Apex Horizon Bank</div>
      <h2 style="color:#0f172a; font-size: 18px;">Verify This Sign-In</h2>
      <p>We noticed a login from a device we don't recognize. Enter this code to continue:</p>
      <div style="background:#f0fdf4; border:1px solid #bbf7d0; border-radius:8px; padding:16px; margin:20px 0; text-align:center;">
        <p style="margin:0; font-size:28px; font-weight:bold; letter-spacing:0.1em; color:#0f172a;">${code}</p>
      </div>
      <p style="color:#666; font-size:12px;">This code expires in 10 minutes. If you didn't try to sign in, please secure your account immediately.</p>
      <p style="margin-top: 32px; font-size: 12px; color: #666; border-top: 1px solid #eee; padding-top: 16px;">
        This is an automated message from Apex Horizon Bank. Please do not reply to this email.
      </p>
    </div>
  `;
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
