const { esc, layout, detailsTable, highlightBox, button, notice, p, h, steps } = require('./emailLayout');

// Uses Resend's HTTP API directly — no SDK dependency needed.
const RESEND_API_URL = 'https://api.resend.com/emails';

// Mail comes from apexhorizonbank.com, which is verified on Resend (records
// added to Vercel DNS: DKIM at resend._domainkey, SPF + MX at send.), so it
// reaches every customer. EMAIL_FROM in Vercel overrides it if ever needed.
const FROM_ADDRESS = process.env.EMAIL_FROM || 'Apex Horizon Bank <no-reply@apexhorizonbank.com>';

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

function money(amount) {
  const s = String(amount == null ? '' : amount).replace(/^\$/, '');
  return `$${s}`;
}

function welcomeEmailHtml(fullName, accountNumber) {
  return layout({
    preheader: 'Your Checking and Savings accounts are ready.',
    body: [
      h(`Welcome to Apex Horizon, ${fullName}`),
      p('Your account has been created. A Checking and a Savings account are ready to use.'),
      accountNumber ? detailsTable([
        ['Account holder', fullName],
        ['Checking account number', accountNumber],
        ['Also included', 'High-Yield Savings'],
      ], { title: 'Your account' }) : '',
      p('Share your account number with other Apex customers so they can send you money.'),
      p('<strong>Getting started</strong>', 'margin-bottom:4px;'),
      steps([
        'Sign in and add money to your Checking account.',
        'Turn on Face ID in Settings for faster, safer sign-ins.',
        'Set up a savings goal and watch your balance grow.',
      ]),
    ].join(''),
  });
}

function moneySentEmailHtml({ senderName, recipientName, amount, note, date, reference, fromAccount }) {
  return layout({
    preheader: `You sent ${money(amount)} to ${recipientName}.`,
    body: [
      h('Payment sent'),
      p(`Hi ${esc(senderName)}, your payment has gone through.`),
      highlightBox(`-${money(amount)}`, { label: 'Amount sent', spacing: '0', size: 34 }),
      detailsTable([
        ['To', recipientName],
        ['From', fromAccount],
        ['Note', note ? `"${note}"` : ''],
        ['Date', date],
        ['Status', 'Completed'],
        ['Reference', reference],
      ], { title: 'Payment details' }),
      notice("<strong>Don't recognise this payment?</strong> Sign in, review your recent activity and change your password right away.", 'warn'),
    ].join(''),
  });
}

function moneyReceivedEmailHtml({ recipientName, senderName, amount, note, date, reference, toAccount }) {
  return layout({
    preheader: `${senderName} sent you ${money(amount)}.`,
    body: [
      h('You received money'),
      p(`Hi ${esc(recipientName)}, ${esc(senderName)} sent you a payment. It's already in your account.`),
      highlightBox(`+${money(amount)}`, { label: 'Amount received', spacing: '0', size: 34, color: '#047857' }),
      detailsTable([
        ['From', senderName],
        ['Deposited to', toAccount],
        ['Note', note ? `"${note}"` : ''],
        ['Date', date],
        ['Status', 'Completed'],
        ['Reference', reference],
      ], { title: 'Payment details' }),
    ].join(''),
  });
}

function emailChangeConfirmationHtml(confirmUrl) {
  return layout({
    preheader: 'Confirm this address to finish changing your Apex email.',
    body: [
      h('Confirm your new email'),
      p('You asked to use this address for your Apex Horizon Bank account. Confirm it to finish the change.'),
      button(confirmUrl, 'Confirm new email'),
      detailsTable([
        ['Request', 'Change account email'],
        ['Link valid for', '30 minutes'],
      ]),
      notice("<strong>Didn't ask for this?</strong> Ignore this email. Your account email stays exactly as it is until someone confirms with this link.", 'warn'),
      p('<span style="font-size:12px;color:#64748b;">Button not working? Copy this link into your browser:<br>' + esc(confirmUrl) + '</span>'),
    ].join(''),
  });
}

function passwordResetEmailHtml(resetLink) {
  return layout({
    preheader: 'Use this link within 30 minutes to choose a new password.',
    body: [
      h('Reset your password'),
      p('We got a request to reset the password on your Apex Horizon Bank account. Choose a new one with the button below.'),
      button(resetLink, 'Reset password'),
      detailsTable([
        ['Request', 'Password reset'],
        ['Link valid for', '30 minutes, one use'],
      ]),
      notice("<strong>Didn't ask for this?</strong> You can ignore this email and your password stays the same. If you keep getting these, sign in and change your password.", 'warn'),
      p('<span style="font-size:12px;color:#64748b;">Button not working? Copy this link into your browser:<br>' + esc(resetLink) + '</span>'),
    ].join(''),
  });
}

function signInAlertEmailHtml({ email, method, ip, city, region, country, userAgent, date }) {
  const location = [city, region, country].filter(Boolean).join(', ') || 'Unknown location';
  return layout({
    preheader: `${email} signed in.`,
    security: false,
    body: [
      h('New sign-in detected'),
      p(`<strong>${esc(email)}</strong> signed in to Apex Horizon Bank.`),
      detailsTable([
        ['Account', email],
        ['Signed in with', method === 'webauthn' ? 'Face ID' : method === 'passcode' ? 'App passcode' : 'Password'],
        ['Time', date],
        ['Location', location],
        ['IP address', ip || 'Unknown'],
        ['Device', userAgent || 'Unknown'],
      ], { title: 'Sign-in details' }),
    ].join(''),
  });
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
