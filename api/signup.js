const bcrypt = require('bcryptjs');
const { neon } = require('@neondatabase/serverless');
const { normalizeEmail } = require('../lib/auth');
const { sendEmail } = require('../lib/email');

const sql = neon(process.env.DATABASE_URL || process.env.POSTGRES_URL);

async function generateUniqueAccountNumber() {
  for (let attempt = 0; attempt < 8; attempt++) {
    const candidate = String(Math.floor(1000000000 + Math.random() * 9000000000));
    const existing = await sql`SELECT id FROM accounts WHERE account_number = ${candidate} LIMIT 1`;
    if (existing.length === 0) return candidate;
  }
  throw new Error('Could not generate a unique account number after several attempts.');
}

function pendingReviewEmailHtml(fullName) {
  return `
    <div style="font-family: Arial, Helvetica, sans-serif; max-width: 480px; margin: 0 auto; padding: 24px; color: #111;">
      <div style="font-size: 12px; font-weight: bold; letter-spacing: 0.05em; text-transform: uppercase; color: #10b981; margin-bottom: 16px;">Apex Horizon Bank</div>
      <h2 style="color:#0f172a; font-size: 18px;">Thanks for applying, ${fullName}</h2>
      <p>Your application to open an Apex Horizon Bank account has been received and is now under review.</p>
      <p>We'll email you as soon as a decision has been made — this typically takes less than 24 hours. You won't be able to sign in until your account is approved.</p>
      <p style="color:#666; font-size:12px;">If you have questions in the meantime, just reply to this email.</p>
    </div>
  `;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { action } = req.body || {};
  if (action !== 'create-account') {
    return res.status(400).json({ error: 'Invalid or missing action. Use "create-account".' });
  }

  try {
    const {
      fullName, dob, phone,
      street, city, state, zip,
      email, password,
      idType, idNumber, ssnLast4,
      securityQuestion, securityAnswer,
    } = req.body || {};

    const required = { fullName, dob, phone, street, city, state, zip, email, password, idType, idNumber, ssnLast4, securityQuestion, securityAnswer };
    for (const [key, val] of Object.entries(required)) {
      if (!val) return res.status(400).json({ error: `Missing required field: ${key}` });
    }

    if (!/^\d{4}$/.test(ssnLast4)) {
      return res.status(400).json({ error: 'SSN last 4 digits must be exactly 4 numbers.' });
    }

    const normalizedEmail = normalizeEmail(email);
    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters.' });
    }

    const existing = await sql`SELECT id FROM users WHERE email = ${normalizedEmail} LIMIT 1`;
    if (existing.length > 0) {
      return res.status(409).json({ error: 'An account with that email already exists.' });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const securityAnswerHash = await bcrypt.hash(String(securityAnswer).trim().toLowerCase(), 10);

    const userResult = await sql`
      INSERT INTO users (
        email, password_hash, full_name, phone, date_of_birth,
        ssn_last4, id_type, id_number,
        address_street, address_city, address_state, address_zip,
        security_question, security_answer_hash,
        approval_status, created_at, last_login_at
      )
      VALUES (
        ${normalizedEmail}, ${passwordHash}, ${fullName}, ${phone}, ${dob},
        ${ssnLast4}, ${idType}, ${idNumber},
        ${street}, ${city}, ${state}, ${zip},
        ${securityQuestion}, ${securityAnswerHash},
        'pending', NOW(), NULL
      )
      RETURNING id, email, full_name
    `;
    const user = userResult[0];

    const checkingAccountNumber = await generateUniqueAccountNumber();
    const savingsAccountNumber = await generateUniqueAccountNumber();

    // New accounts start empty — no seed/demo balance is credited on signup.
    await sql`
      INSERT INTO accounts (user_id, account_type, balance, account_number, apy_rate, interest_accrued_at)
      VALUES
        (${user.id}, 'checking', 0.00, ${checkingAccountNumber}, 0, NULL),
        (${user.id}, 'savings', 0.00, ${savingsAccountNumber}, 0.0450, NOW())
    `;

    await sendEmail({
      to: user.email,
      subject: 'Your Apex Horizon Bank application is under review',
      html: pendingReviewEmailHtml(user.full_name),
    });

    return res.status(201).json({
      success: true,
      approvalStatus: 'pending',
      message: "Your application has been submitted and is under review. We'll email you once a decision is made.",
      user: { id: user.id, email: user.email, fullName: user.full_name },
      accountNumber: checkingAccountNumber,
    });
  } catch (err) {
    console.error('Create account error:', err);
    return res.status(500).json({ error: 'Something went wrong creating your account. Please try again.' });
  }
};
