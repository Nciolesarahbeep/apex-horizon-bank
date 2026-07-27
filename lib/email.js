// Uses Resend's HTTP API directly — no SDK dependency needed.
const RESEND_API_URL = 'https://api.resend.com/emails';

// Until you verify your own domain on Resend, sending must come from
// onboarding@resend.dev. Once you verify a domain (e.g. apexhorizonbank.com),
// change this to something like "Apex Horizon Bank <noreply@apexhorizonbank.com>".
const FROM_ADDRESS = 'Apex Horizon Bank <onboarding@resend.dev>';

// Never throws — email is a nice-to-have and must never break a banking operation.
async function sendEmail({ to, subject, html }) {
  try {
    if (!process.env.RESEND_API_KEY) {
      console.error('Email not sent: RESEND_API_KEY not configured.');
      return false;
    }

    const response = await fetch(RESEND_API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: FROM_ADDRESS,
        to,
        subject,
        html,
      }),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      console.error('Email send error:', response.status, errorBody);
      return false;
    }

    return true;
  } catch (err) {
    console.error('Email send error:', err);
    return false;
  }
}

function baseWrapper(innerHtml) {
  return `
    <div style="font-family: Arial, Helvetica, sans-serif; max-width: 480px; margin: 0 auto; padding: 24px; color: #111;">
      <div style="font-size: 12px; font-weight: bold; letter-spacing: 0.05em; text-transform: uppercase; color: #10b981; margin-bottom: 16px;">Apex Horizon Bank</div>
      ${innerHtml}
      <p style="margin-top: 32px; font-size: 12px; color: #666; border-top: 1px solid #eee; padding-top: 16px;">
        This is an automated message from Apex Horizon Bank. Please do not reply to this email.
      </p>
    </div>
  `;
}

function welcomeEmailHtml(fullName, accountNumber) {
  return baseWrapper(`
    <h1 style="color:#0f172a; font-size: 20px;">Welcome, ${fullName}!</h1>
    <p>Your Apex Horizon Bank account has been created successfully. You now have a Checking and a Savings account ready to use.</p>
    ${accountNumber ? `
    <div style="background:#f0fdf4; border:1px solid #bbf7d0; border-radius:8px; padding:16px; margin:20px 0;">
      <p style="margin:0; font-size:11px; text-transform:uppercase; letter-spacing:0.05em; color:#059669; font-weight:bold;">Your Account Number</p>
      <p style="margin:4px 0 0; font-size:20px; font-weight:bold; letter-spacing:0.05em; color:#0f172a;">${accountNumber}</p>
      <p style="margin:8px 0 0; font-size:12px; color:#444;">Share this with other Apex users to receive P2P transfers.</p>
    </div>
    ` : ''}
    <p>Log in anytime to check your balance, send money to other Apex users, and manage your account.</p>
  `);
}

function moneySentEmailHtml({ senderName, recipientName, amount, note, date }) {
  return baseWrapper(`
    <h2 style="color:#0f172a; font-size: 18px;">Payment Sent</h2>
    <p>Hi ${senderName},</p>
    <p>You sent <strong>$${amount}</strong> to <strong>${recipientName}</strong>.</p>
    ${note ? `<p style="color:#444;">Note: "${note}"</p>` : ''}
    <p style="color:#666; font-size:13px;">${date}</p>
  `);
}

function moneyReceivedEmailHtml({ recipientName, senderName, amount, note, date }) {
  return baseWrapper(`
    <h2 style="color:#0f172a; font-size: 18px;">Payment Received</h2>
    <p>Hi ${recipientName},</p>
    <p>You received <strong>$${amount}</strong> from <strong>${senderName}</strong>.</p>
    ${note ? `<p style="color:#444;">Note: "${note}"</p>` : ''}
    <p style="color:#666; font-size:13px;">${date}</p>
  `);
}

function emailChangeConfirmationHtml(confirmUrl) {
  return baseWrapper(`
    <h2 style="color:#0f172a; font-size: 18px;">Confirm Your New Email</h2>
    <p>You requested to change the email address on your Apex Horizon Bank account to this address.</p>
    <p style="margin: 24px 0;">
      <a href="${confirmUrl}" style="background:#0f172a; color:#fff; padding:12px 24px; border-radius:8px; text-decoration:none; font-weight:bold; font-size:14px;">Confirm New Email</a>
    </p>
    <p style="color:#666; font-size:12px;">This link expires in 30 minutes. If you didn't request this change, you can safely ignore this email — your account email will stay the same.</p>
  `);
}

function passwordResetEmailHtml(resetLink) {
  return baseWrapper(`
    <h2 style="color:#0f172a; font-size: 18px;">Reset Your Password</h2>
    <p>We received a request to reset your Apex Horizon Bank password.</p>
    <p style="margin: 24px 0;">
      <a href="${resetLink}" style="background:#0f172a; color:#fff; padding:12px 24px; border-radius:8px; text-decoration:none; font-weight:bold; font-size:14px;">Reset Password</a>
    </p>
    <p style="color:#666; font-size:12px;">This link expires in 30 minutes. If you didn't request this, you can safely ignore this email — your password will stay the same.</p>
  `);
}

function signInAlertEmailHtml({ email, method, ip, city, region, country, userAgent, date }) {
  const location = [city, region, country].filter(Boolean).join(', ') || 'Unknown location';
  return baseWrapper(`
    <h2 style="color:#0f172a; font-size: 18px;">New Sign-In Detected</h2>
    <p><strong>${email}</strong> signed in via ${method === 'webauthn' ? 'Face ID' : 'password'}.</p>
    <div style="background:#f8fafc; border:1px solid #e2e8f0; border-radius:8px; padding:16px; margin:20px 0; font-size:13px;">
      <p style="margin:0 0 6px;"><strong>IP Address:</strong> ${ip || 'Unknown'}</p>
      <p style="margin:0 0 6px;"><strong>Location:</strong> ${location}</p>
      <p style="margin:0 0 6px;"><strong>Device:</strong> ${userAgent || 'Unknown'}</p>
      <p style="margin:0;"><strong>Time:</strong> ${date}</p>
    </div>
  `);
}

module.exports = {
  sendEmail,
  welcomeEmailHtml,
  moneySentEmailHtml,
  moneyReceivedEmailHtml,
  emailChangeConfirmationHtml,
  passwordResetEmailHtml,
  signInAlertEmailHtml,
};
