const nodemailer = require('nodemailer');

let transporter = null;
function getTransporter() {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: process.env.GMAIL_USER,
        pass: process.env.GMAIL_APP_PASSWORD,
      },
    });
  }
  return transporter;
}

// Never throws — email is a nice-to-have and must never break a banking operation.
async function sendEmail({ to, subject, html }) {
  try {
    if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) {
      console.error('Email not sent: GMAIL_USER/GMAIL_APP_PASSWORD not configured.');
      return false;
    }
    const t = getTransporter();
    await t.sendMail({
      from: `"Apex Horizon Bank" <${process.env.GMAIL_USER}>`,
      to,
      subject,
      html,
    });
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

function welcomeEmailHtml(fullName) {
  return baseWrapper(`
    <h1 style="color:#0f172a; font-size: 20px;">Welcome, ${fullName}!</h1>
    <p>Your Apex Horizon Bank account has been created successfully. You now have a Checking and a Savings account ready to use.</p>
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

module.exports = {
  sendEmail,
  welcomeEmailHtml,
  moneySentEmailHtml,
  moneyReceivedEmailHtml,
};
