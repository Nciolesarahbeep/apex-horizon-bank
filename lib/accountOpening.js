// Opening an account, the way a bank's online application works.
//
//  1. Email check: we send a 6-digit code to the email address and the
//     applicant enters it (sendEmailCode / verifyEmailCode). Codes last 10
//     minutes, allow 5 tries, and at most 3 can be sent per email every 30
//     minutes. If the email service can't deliver it, the application can go
//     ahead with the email marked unverified, so nobody is locked out.
//  2. The application itself (submitApplication) is checked on the server
//     like a bank's Customer Identification Program would: legal name, age
//     18+, a US mobile number, a real street address (no P.O. boxes), a
//     government ID that hasn't expired, the last 4 of the SSN, a few
//     questions about where the money comes from, sign-in details that meet
//     the password rules, and agreement to the account terms and e-delivery.
//  3. Accepted applications are 'pending' with a reference number like
//     AH-4821-7390. Operations approves or rejects them from the admin panel;
//     until then the applicant can check the status with their email and
//     reference (applicationStatus), and can't sign in.
//
// Only the last 4 of the SSN is ever asked for or stored.

const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const US_STATES = ['AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'DC', 'FL', 'GA', 'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY'];
const ID_TYPES = { drivers_license: "Driver's license", state_id: 'State ID card', passport: 'U.S. passport' };
const SECURITY_QUESTIONS = ["First pet's name?", 'City you were born in?', "Mother's maiden name?", 'Name of your first school?', 'Street you grew up on?', 'Your childhood best friend?'];
const CHOICES = {
  yearsAtAddress: { under_1: 'Less than 1 year', '1_2': '1-2 years', '3_5': '3-5 years', over_5: 'More than 5 years' },
  employment: { employed: 'Employed', self_employed: 'Self-employed', student: 'Student', retired: 'Retired', not_employed: 'Not employed' },
  income: { under_25k: 'Under $25,000', '25k_50k': '$25,000-$49,999', '50k_100k': '$50,000-$99,999', '100k_250k': '$100,000-$249,999', over_250k: '$250,000 or more' },
  sourceOfFunds: { salary: 'Salary or wages', savings: 'Savings', investments: 'Investments', family: 'Family or gifts', benefits: 'Benefits or pension', other: 'Other' },
  purposes: { everyday: 'Everyday spending', saving: 'Saving', direct_deposit: 'Getting paid', bills: 'Paying bills', transfers: 'Sending money to people' },
  monthlyDeposits: { under_1k: 'Under $1,000', '1k_5k': '$1,000-$4,999', '5k_10k': '$5,000-$9,999', over_10k: '$10,000 or more' },
};
const { layout, detailsTable, highlightBox, notice, button, p, h, steps } = require('./emailLayout');
const { CANONICAL_URL } = require('./appUrl');
const CODE_TTL_MIN = 10;
const MAX_CODE_ATTEMPTS = 5;
const MAX_SENDS = 3;
const SEND_WINDOW_MIN = 30;
const RESEND_AFTER_S = 30;
const COMMON_PASSWORDS = new Set(['password', 'password1', 'password12', 'password123', '12345678', '123456789', '1234567890', 'qwerty123', 'qwertyuiop', 'iloveyou1', 'letmein123', 'welcome1', 'welcome123', 'abc12345', 'admin123', 'passw0rd']);

class OpeningError extends Error {
  constructor(status, message, field) {
    super(message);
    this.status = status;
    if (field) this.field = field;
  }
}

function secret() {
  return process.env.JWT_SECRET || process.env.OTP_SECRET || 'apex-horizon-signup';
}
const normEmail = (e) => String(e || '').trim().toLowerCase();
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
function maskEmail(email) {
  const [user, domain] = String(email).split('@');
  if (!domain) return email;
  const shown = user.length <= 2 ? user.slice(0, 1) : user.slice(0, 2);
  return `${shown}${'•'.repeat(Math.max(1, Math.min(4, user.length - shown.length)))}@${domain}`;
}
function codeHash(email, code) {
  return crypto.createHmac('sha256', secret()).update(`signup:${email}:${code}`).digest('hex');
}
function sameHash(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ----- Schema -----
const schemaReady = new WeakMap();
function ensureOpeningSchema(sql) {
  let p = schemaReady.get(sql);
  if (!p) {
    p = (async () => {
      await sql`
        CREATE TABLE IF NOT EXISTS signup_email_codes (
          email TEXT PRIMARY KEY,
          code_hash TEXT NOT NULL,
          attempts INTEGER NOT NULL DEFAULT 0,
          sends INTEGER NOT NULL DEFAULT 1,
          first_sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          last_sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          expires_at TIMESTAMPTZ NOT NULL,
          verified_at TIMESTAMPTZ,
          undeliverable BOOLEAN NOT NULL DEFAULT FALSE
        )
      `;
      await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT FALSE`;
      await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS application_ref TEXT`;
      await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS application JSONB`;
      await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS id_state TEXT`;
      await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS id_expiry DATE`;
      await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS address_unit TEXT`;
      await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ`;
      await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS approval_reason TEXT`;
      await sql`CREATE UNIQUE INDEX IF NOT EXISTS users_application_ref_idx ON users (application_ref) WHERE application_ref IS NOT NULL`;
    })();
    p.catch(() => schemaReady.delete(sql));
    schemaReady.set(sql, p);
  }
  return p;
}

// ----- Step 1: the email code -----
function codeEmailHtml(code) {
  return layout({
    preheader: `${code} is your Apex Horizon verification code.`,
    body: [
      h('Confirm your email'),
      p('Enter this code in your Apex Horizon account application to verify your email address:'),
      highlightBox(code, { label: 'Verification code', spacing: '0.2em' }),
      detailsTable([
        ['Purpose', 'Account application'],
        ['Code valid for', `${CODE_TTL_MIN} minutes`],
      ]),
      notice("<strong>Didn't start an application?</strong> You can safely ignore this email. Nothing happens without this code.", 'info'),
    ].join(''),
  });
}

async function sendEmailCode(sql, { email }, { sendEmail }) {
  await ensureOpeningSchema(sql);
  const e = normEmail(email);
  if (!EMAIL_RE.test(e) || e.length > 254) throw new OpeningError(400, 'Enter a valid email address.', 'email');
  const taken = await sql`SELECT id FROM users WHERE email = ${e} LIMIT 1`;
  if (taken.length) throw new OpeningError(409, 'An Apex account already uses this email. Sign in instead, or use a different email.', 'email');

  const rows = await sql`
    SELECT sends, EXTRACT(EPOCH FROM (NOW() - first_sent_at)) AS since_first, EXTRACT(EPOCH FROM (NOW() - last_sent_at)) AS since_last
    FROM signup_email_codes WHERE email = ${e}
  `;
  const row = rows[0];
  const fresh = !row || Number(row.since_first) > SEND_WINDOW_MIN * 60;
  if (row && Number(row.since_last) < RESEND_AFTER_S) {
    throw new OpeningError(429, `Please wait ${Math.ceil(RESEND_AFTER_S - Number(row.since_last))} seconds before asking for another code.`, 'email');
  }
  if (row && !fresh && Number(row.sends) >= MAX_SENDS) {
    throw new OpeningError(429, "We've sent the most codes we can for now. Try again in a little while.", 'email');
  }

  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  const sent = await sendEmail({ to: e, subject: `${code} is your Apex Horizon verification code`, html: codeEmailHtml(code) });
  const hash = codeHash(e, code);
  const undeliverable = !sent;
  if (fresh) {
    await sql`
      INSERT INTO signup_email_codes (email, code_hash, attempts, sends, first_sent_at, last_sent_at, expires_at, verified_at, undeliverable)
      VALUES (${e}, ${hash}, 0, 1, NOW(), NOW(), NOW() + make_interval(mins => ${CODE_TTL_MIN}), NULL, ${undeliverable})
      ON CONFLICT (email) DO UPDATE SET code_hash = EXCLUDED.code_hash, attempts = 0, sends = 1, first_sent_at = NOW(), last_sent_at = NOW(),
        expires_at = EXCLUDED.expires_at, verified_at = NULL, undeliverable = EXCLUDED.undeliverable
    `;
  } else {
    await sql`
      UPDATE signup_email_codes
      SET code_hash = ${hash}, attempts = 0, sends = sends + 1, last_sent_at = NOW(),
          expires_at = NOW() + make_interval(mins => ${CODE_TTL_MIN}), verified_at = NULL, undeliverable = ${undeliverable}
      WHERE email = ${e}
    `;
  }
  return { sent: !!sent, destination: maskEmail(e), expiresInSeconds: CODE_TTL_MIN * 60, resendAfterSeconds: RESEND_AFTER_S };
}

async function verifyEmailCode(sql, { email, code }) {
  await ensureOpeningSchema(sql);
  const e = normEmail(email);
  const c = String(code || '').replace(/\D/g, '');
  if (c.length !== 6) throw new OpeningError(400, 'Enter the 6-digit code.', 'code');
  const rows = await sql`
    UPDATE signup_email_codes SET attempts = attempts + 1
    WHERE email = ${e} AND expires_at > NOW() AND attempts < ${MAX_CODE_ATTEMPTS} AND verified_at IS NULL
    RETURNING code_hash, attempts
  `;
  if (!rows.length) {
    const any = await sql`SELECT attempts, expires_at > NOW() AS live, verified_at FROM signup_email_codes WHERE email = ${e}`;
    if (!any.length) throw new OpeningError(400, 'Send a code to your email first.', 'code');
    if (any[0].verified_at) return { verified: true, emailToken: emailToken(e) };
    if (!(any[0].live === true || any[0].live === 't')) throw new OpeningError(400, 'That code has expired. Send a new one.', 'code');
    throw new OpeningError(429, 'Too many wrong tries. Send a new code.', 'code');
  }
  if (!sameHash(rows[0].code_hash, codeHash(e, c))) {
    const left = MAX_CODE_ATTEMPTS - Number(rows[0].attempts);
    throw new OpeningError(400, left > 0 ? `That code isn't right. ${left} ${left === 1 ? 'try' : 'tries'} left.` : 'Too many wrong tries. Send a new code.', 'code');
  }
  await sql`UPDATE signup_email_codes SET verified_at = NOW() WHERE email = ${e}`;
  return { verified: true, emailToken: emailToken(e) };
}

// A small signed token (HMAC-SHA256) proving this email was confirmed, good
// for 2 hours. It's checked again when the application is submitted.
const b64u = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
function emailToken(email, nowMs = Date.now()) {
  const iat = Math.floor(nowMs / 1000);
  const body = b64u(JSON.stringify({ purpose: 'signup-email', email, iat, exp: iat + 7200 }));
  const sig = b64u(crypto.createHmac('sha256', secret()).update(body).digest());
  return `${body}.${sig}`;
}
function readEmailToken(token, nowMs = Date.now()) {
  const [body, sig] = String(token || '').split('.');
  if (!body || !sig) return null;
  const want = b64u(crypto.createHmac('sha256', secret()).update(body).digest());
  if (!sameHash(sig, want)) return null;
  let claims;
  try { claims = JSON.parse(Buffer.from(body.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString()); } catch (_) { return null; }
  if (!claims || claims.purpose !== 'signup-email' || !(claims.exp > Math.floor(nowMs / 1000))) return null;
  return claims;
}

// ----- Step 2: the application -----
const NAME_RE = /^[\p{L}][\p{L}' .-]{0,48}$/u;
function clean(v, max = 200) { return String(v == null ? '' : v).trim().replace(/\s+/g, ' ').slice(0, max); }
function need(cond, message, field) { if (!cond) throw new OpeningError(400, message, field); }
function parseDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
  if (!m) return null;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3] ? d : null;
}
function ageOn(dob, now) {
  let age = now.getUTCFullYear() - dob.getUTCFullYear();
  const m = now.getUTCMonth() - dob.getUTCMonth();
  if (m < 0 || (m === 0 && now.getUTCDate() < dob.getUTCDate())) age--;
  return age;
}
function normalizePhone(raw) {
  let d = String(raw || '').replace(/\D/g, '');
  if (d.length === 11 && d.startsWith('1')) d = d.slice(1);
  return /^[2-9]\d{2}[2-9]\d{6}$/.test(d) ? d : null;
}
function pick(map, v) { return Object.prototype.hasOwnProperty.call(map, v) ? v : null; }

function passwordProblems(pw, { email, firstName, lastName }) {
  const p = String(pw || '');
  const out = [];
  if (p.length < 8) out.push('at least 8 characters');
  if (p.length > 64) out.push('no more than 64 characters');
  if (!/[A-Za-z]/.test(p)) out.push('a letter');
  if (!/\d/.test(p)) out.push('a number');
  if (/\s/.test(p)) out.push('no spaces');
  const lower = p.toLowerCase();
  const local = String(email || '').split('@')[0].toLowerCase();
  if (local.length >= 4 && lower.includes(local)) out.push("not your email");
  if ((firstName && firstName.length >= 3 && lower.includes(firstName.toLowerCase())) || (lastName && lastName.length >= 3 && lower.includes(lastName.toLowerCase()))) out.push('not your name');
  if (COMMON_PASSWORDS.has(lower)) out.push('not a common password');
  return out;
}

function validateApplication(b, now = new Date()) {
  const a = b || {};
  const firstName = clean(a.firstName, 50);
  const middleName = clean(a.middleName, 50);
  const lastName = clean(a.lastName, 50);
  need(NAME_RE.test(firstName), 'Enter your legal first name, as it appears on your ID.', 'firstName');
  need(!middleName || NAME_RE.test(middleName), "That middle name doesn't look right.", 'middleName');
  need(NAME_RE.test(lastName), 'Enter your legal last name, as it appears on your ID.', 'lastName');

  const dob = parseDate(a.dob);
  need(dob && dob < now, 'Enter your date of birth.', 'dob');
  const age = ageOn(dob, now);
  need(age >= 18, 'You need to be 18 or older to open an account online.', 'dob');
  need(age <= 120, 'Check your date of birth.', 'dob');

  const email = normEmail(a.email);
  need(EMAIL_RE.test(email) && email.length <= 254, 'Enter a valid email address.', 'email');
  const phone = normalizePhone(a.phone);
  need(phone, 'Enter a 10-digit US mobile number.', 'phone');

  const street = clean(a.street, 100);
  const unit = clean(a.unit, 20);
  const city = clean(a.city, 50);
  const state = String(a.state || '').trim().toUpperCase();
  const zip = String(a.zip || '').trim();
  need(street.length >= 5 && /\d/.test(street) && /[A-Za-z]/.test(street), 'Enter your street address, including the house or building number.', 'street');
  need(!/\bp\.?\s*o\.?\s*box\b|\bpost\s+office\s+box\b/i.test(`${street} ${unit}`), "Use the address where you live. A P.O. box can't be a home address.", 'street');
  need(/^[A-Za-z][A-Za-z .'-]{1,49}$/.test(city), 'Enter your city.', 'city');
  need(US_STATES.includes(state), 'Choose your state.', 'state');
  need(/^\d{5}(-\d{4})?$/.test(zip), 'Enter a 5-digit ZIP code.', 'zip');
  const yearsAtAddress = pick(CHOICES.yearsAtAddress, a.yearsAtAddress);
  need(yearsAtAddress, 'Tell us how long you have lived at this address.', 'yearsAtAddress');

  const ssnLast4 = String(a.ssnLast4 || '').trim();
  need(/^\d{4}$/.test(ssnLast4) && ssnLast4 !== '0000', 'Enter the last 4 digits of your Social Security number.', 'ssnLast4');
  const idType = pick(ID_TYPES, a.idType);
  need(idType, 'Choose the type of ID you have.', 'idType');
  const idNumber = String(a.idNumber || '').trim().toUpperCase().replace(/\s+/g, '');
  need(idType === 'passport' ? /^[A-Z0-9]{6,9}$/.test(idNumber) : /^[A-Z0-9-]{4,20}$/.test(idNumber), idType === 'passport' ? 'A U.S. passport number is 6-9 letters and numbers.' : 'Enter the number on your ID.', 'idNumber');
  const idState = idType === 'passport' ? null : String(a.idState || '').trim().toUpperCase();
  need(idType === 'passport' || US_STATES.includes(idState), 'Choose the state that issued your ID.', 'idState');
  const idExpiry = parseDate(a.idExpiry);
  need(idExpiry, 'Enter the expiration date on your ID.', 'idExpiry');
  need(idExpiry > now, 'That ID has expired. Use an ID that is still valid.', 'idExpiry');
  need(idExpiry < new Date(now.getTime() + 15 * 365.25 * 864e5), 'Check the expiration date on your ID.', 'idExpiry');

  const employment = pick(CHOICES.employment, a.employment);
  need(employment, 'Tell us about your employment.', 'employment');
  const occupation = clean(a.occupation, 60);
  need(!['employed', 'self_employed'].includes(employment) || occupation.length >= 2, 'Tell us your occupation.', 'occupation');
  const income = pick(CHOICES.income, a.income);
  need(income, 'Choose your yearly income.', 'income');
  const sourceOfFunds = pick(CHOICES.sourceOfFunds, a.sourceOfFunds);
  need(sourceOfFunds, 'Tell us where the money for this account will come from.', 'sourceOfFunds');
  const purposes = Array.isArray(a.purposes) ? [...new Set(a.purposes.filter((p) => pick(CHOICES.purposes, p)))] : [];
  need(purposes.length > 0, 'Choose at least one way you plan to use the account.', 'purposes');
  const monthlyDeposits = pick(CHOICES.monthlyDeposits, a.monthlyDeposits);
  need(monthlyDeposits, 'Tell us roughly how much you expect to deposit each month.', 'monthlyDeposits');
  need(a.pep === 'yes' || a.pep === 'no', 'Answer the question about public office.', 'pep');

  const password = String(a.password || '');
  const problems = passwordProblems(password, { email, firstName, lastName });
  need(problems.length === 0, `Your password needs ${problems.join(', ')}.`, 'password');
  const securityQuestion = SECURITY_QUESTIONS.includes(a.securityQuestion) ? a.securityQuestion : null;
  need(securityQuestion, 'Choose a security question.', 'securityQuestion');
  const securityAnswer = clean(a.securityAnswer, 60);
  need(securityAnswer.length >= 2, 'Answer your security question.', 'securityAnswer');

  need(a.agreeTerms === true, 'Please agree to the Deposit Account Agreement and Privacy Notice.', 'agreeTerms');
  need(a.agreeEsign === true, 'Please agree to get your documents electronically.', 'agreeEsign');

  return {
    firstName, middleName, lastName, fullName: [firstName, middleName, lastName].filter(Boolean).join(' '),
    dob: a.dob, email, phone, street, unit, city, state, zip: zip.slice(0, 5), yearsAtAddress,
    ssnLast4, idType, idNumber, idState, idExpiry: a.idExpiry,
    profile: { employment, occupation: occupation || null, income, sourceOfFunds, purposes, monthlyDeposits, pep: a.pep === 'yes' },
    password, securityQuestion, securityAnswer,
  };
}

function receivedEmailHtml(firstName, reference) {
  return layout({
    preheader: `Application ${reference} received. We'll email you a decision soon.`,
    body: [
      h(`We've got your application, ${firstName}`),
      p('Thanks for applying to open Apex Everyday Checking and High-Yield Savings. Your application is now in review.'),
      highlightBox(reference, { label: 'Application reference', spacing: '0.06em', size: 26 }),
      detailsTable([
        ['Applying for', 'Everyday Checking + High-Yield Savings'],
        ['Status', 'Under review'],
        ['Typical decision time', 'Within 1 business day'],
      ], { title: 'Application summary' }),
      p('<strong>What happens next</strong>', 'margin-bottom:4px;'),
      steps([
        'We review your details and verify your identity.',
        "We email you a decision. You don't need to do anything.",
        'Once approved, sign in with the email and password you chose.',
      ]),
      notice('You can check your status any time from the sign-in screen with your email and this reference. Keep the reference handy.', 'info'),
    ].join(''),
  });
}

async function newReference(sql) {
  for (let i = 0; i < 8; i++) {
    const ref = `AH-${crypto.randomInt(1000, 10000)}-${crypto.randomInt(1000, 10000)}`;
    const taken = await sql`SELECT 1 FROM users WHERE application_ref = ${ref} LIMIT 1`;
    if (!taken.length) return ref;
  }
  throw new Error('Could not create an application reference.');
}

async function newAccountNumber(sql) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const candidate = String(crypto.randomInt(1000000000, 10000000000));
    const existing = await sql`SELECT id FROM accounts WHERE account_number = ${candidate} LIMIT 1`;
    if (!existing.length) return candidate;
  }
  throw new Error('Could not generate a unique account number.');
}

async function submitApplication(sql, body, { sendEmail, savingsApy = 0.045, now = new Date() }) {
  await ensureOpeningSchema(sql);
  const app = validateApplication(body, now);

  // The email must have been confirmed with a code, unless our email service
  // couldn't deliver the code (then it goes ahead, marked unverified).
  let emailVerified = false;
  if (body.emailToken) {
    const claims = readEmailToken(body.emailToken);
    need(claims && claims.email === app.email, 'Your email check has expired. Confirm your email again.', 'email');
    emailVerified = true;
  } else {
    const rows = await sql`SELECT undeliverable, last_sent_at > NOW() - INTERVAL '2 hours' AS recent FROM signup_email_codes WHERE email = ${app.email}`;
    const ok = rows.length && (rows[0].undeliverable === true || rows[0].undeliverable === 't') && (rows[0].recent === true || rows[0].recent === 't');
    need(ok, 'Confirm your email with the code we sent before submitting.', 'email');
  }

  const taken = await sql`SELECT id FROM users WHERE email = ${app.email} LIMIT 1`;
  if (taken.length) throw new OpeningError(409, 'An Apex account already uses this email. Sign in instead.', 'email');

  const passwordHash = await bcrypt.hash(app.password, 10);
  const answerHash = await bcrypt.hash(app.securityAnswer.toLowerCase(), 10);
  const reference = await newReference(sql);
  const application = {
    product: 'everyday_checking_savings',
    yearsAtAddress: app.yearsAtAddress,
    ...app.profile,
    submittedAt: now.toISOString(),
    agreedTo: ['deposit_account_agreement', 'privacy_notice', 'esign_consent'],
  };

  let user;
  try {
    const rows = await sql`
      INSERT INTO users (
        email, password_hash, full_name, phone, date_of_birth,
        ssn_last4, id_type, id_number, id_state, id_expiry,
        address_street, address_unit, address_city, address_state, address_zip,
        security_question, security_answer_hash,
        approval_status, email_verified, application_ref, application, created_at, last_login_at
      )
      VALUES (
        ${app.email}, ${passwordHash}, ${app.fullName}, ${app.phone}, ${app.dob},
        ${app.ssnLast4}, ${app.idType}, ${app.idNumber}, ${app.idState}, ${app.idExpiry},
        ${app.street}, ${app.unit || null}, ${app.city}, ${app.state}, ${app.zip},
        ${app.securityQuestion}, ${answerHash},
        'pending', ${emailVerified}, ${reference}, ${JSON.stringify(application)}::jsonb, NOW(), NULL
      )
      RETURNING id, email, full_name, created_at
    `;
    user = rows[0];
  } catch (err) {
    if (err && (err.code === '23505' || /duplicate key/i.test(String(err.message)))) throw new OpeningError(409, 'An Apex account already uses this email. Sign in instead.', 'email');
    throw err;
  }

  const checkingNumber = await newAccountNumber(sql);
  const savingsNumber = await newAccountNumber(sql);
  await sql`
    INSERT INTO accounts (user_id, account_type, balance, account_number, apy_rate, interest_accrued_at)
    VALUES
      (${user.id}, 'checking', 0.00, ${checkingNumber}, 0, NULL),
      (${user.id}, 'savings', 0.00, ${savingsNumber}, ${savingsApy}, NOW())
  `;
  await sql`DELETE FROM signup_email_codes WHERE email = ${app.email}`;

  let confirmationSent = false;
  try {
    confirmationSent = !!(await sendEmail({ to: user.email, subject: `We've received your Apex Horizon application (${reference})`, html: receivedEmailHtml(app.firstName, reference) }));
  } catch (_) { /* best effort */ }

  return {
    success: true,
    approvalStatus: 'pending',
    reference,
    submittedAt: user.created_at,
    firstName: app.firstName,
    email: maskEmail(user.email),
    emailVerified,
    confirmationSent,
    message: "Your application has been submitted and is under review. We'll email you once a decision is made.",
  };
}

// ----- Checking on an application -----
async function applicationStatus(sql, { email, reference }) {
  await ensureOpeningSchema(sql);
  const e = normEmail(email);
  const ref = String(reference || '').trim().toUpperCase().replace(/\s+/g, '');
  need(EMAIL_RE.test(e), 'Enter the email you applied with.', 'email');
  need(/^AH-\d{4}-\d{4}$/.test(ref), 'Enter your reference, like AH-1234-5678.', 'reference');
  const rows = await sql`
    SELECT full_name, approval_status, approval_reason, created_at, approved_at
    FROM users WHERE email = ${e} AND application_ref = ${ref} LIMIT 1
  `;
  if (!rows.length) throw new OpeningError(404, "We couldn't find an application with that email and reference. Check both and try again.");
  const r = rows[0];
  return {
    reference: ref,
    status: r.approval_status || 'approved',
    firstName: String(r.full_name || '').split(' ')[0],
    submittedAt: r.created_at,
    decidedAt: r.approved_at || null,
    reason: r.approval_status === 'rejected' ? (r.approval_reason || null) : null,
  };
}

// ----- Decision emails (sent by the admin panel) -----
function decisionEmailHtml({ firstName, approved, reason, checkingLast4 }) {
  if (approved) {
    return layout({
      preheader: 'Your Apex Horizon accounts are open.',
      body: [
        h(`Welcome to Apex Horizon, ${firstName}`),
        p('Good news: your application has been approved and your accounts are open.'),
        detailsTable([
          ['Everyday Checking', checkingLast4 ? `Account ending ${checkingLast4}` : 'Open'],
          ['High-Yield Savings', 'Open'],
          ['Status', 'Approved'],
        ], { title: 'Your accounts' }),
        p('<strong>Get started</strong>', 'margin-bottom:4px;'),
        steps([
          'Sign in with the email and password you chose.',
          'Add money to your Checking account.',
          'Turn on Face ID in Settings for faster, safer sign-ins.',
        ]),
        button(CANONICAL_URL, 'Sign in to Apex'),
      ].join(''),
    });
  }
  return layout({
    preheader: "An update on your Apex Horizon application.",
    body: [
      h('An update on your application'),
      p(`Hi ${escapeHtml(firstName)}, thank you for applying. Unfortunately we couldn't open an account for you at this time.`),
      detailsTable([
        ['Decision', 'Not approved'],
        ['Reason', reason],
      ], { title: 'Application decision' }),
      notice('If you think something is wrong, please contact our support team and we will take another look.', 'info'),
    ].join(''),
  });
}

module.exports = {
  OpeningError,
  US_STATES,
  ID_TYPES,
  SECURITY_QUESTIONS,
  CHOICES,
  MAX_CODE_ATTEMPTS,
  ensureOpeningSchema,
  sendEmailCode,
  verifyEmailCode,
  validateApplication,
  passwordProblems,
  submitApplication,
  applicationStatus,
  decisionEmailHtml,
  codeEmailHtml,
  receivedEmailHtml,
  maskEmail,
  _codeHashForTests: codeHash,
  _emailTokenForTests: emailToken,
  _readEmailTokenForTests: readEmailToken,
};
