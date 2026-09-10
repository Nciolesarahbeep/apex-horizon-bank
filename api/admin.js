const { neon } = require('@neondatabase/serverless');

const sql = neon(process.env.DATABASE_URL || process.env.POSTGRES_URL);

const RESTRICTION_LEVELS = ['none', 'transfers_only', 'full'];

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function checkAdminAuth(req) {
  const provided = req.headers['x-admin-secret'];
  const expected = process.env.ADMIN_SECRET;
  return Boolean(expected) && Boolean(provided) && provided === expected;
}

// =====================================================================
// Transaction history seeding — generates realistic, backdated
// transactions (with receipts) for a chosen account, up to 3 years back.
// =====================================================================

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}
function randomFloat(min, max, decimals = 2) {
  const val = Math.random() * (max - min) + min;
  return Number(val.toFixed(decimals));
}
function pick(arr) {
  return arr[randomInt(0, arr.length - 1)];
}
function randomReceiptNumber(prefix) {
  return `${prefix}-${randomInt(100000, 999999)}`;
}
function randomCardLast4() {
  return String(randomInt(1000, 9999));
}
function randomAddress() {
  const streets = ['Maple Ave', 'Oak Street', '5th Avenue', 'Sunset Blvd', 'Main Street', 'River Road', 'Elm Street', 'Highland Drive'];
  const cities = ['Springfield', 'Riverside', 'Fairview', 'Brookhaven', 'Clearwater', 'Millbrook'];
  const states = ['CA', 'TX', 'NY', 'IL', 'WA', 'CO'];
  return `${randomInt(100, 9999)} ${pick(streets)}, ${pick(cities)}, ${pick(states)} ${randomInt(10000, 99999)}`;
}

const GROCERY_MERCHANTS = ['Whole Foods Market', "Trader Joe's", 'Kroger', 'Safeway', 'ALDI', 'Publix'];
const GROCERY_ITEMS = ['Organic Bananas', 'Whole Milk', 'Sourdough Bread', 'Free-Range Eggs', 'Chicken Breast', 'Baby Spinach', 'Greek Yogurt', 'Coffee Beans', 'Pasta', 'Olive Oil', 'Avocados', 'Ground Beef', 'Cheddar Cheese', 'Orange Juice', 'Paper Towels'];

const DINING_MERCHANTS = ['Chipotle Mexican Grill', 'Panera Bread', 'Olive Garden', "Chick-fil-A", 'Local Bistro & Wine Bar', 'The Corner Diner', 'Sushi Hana', 'Pizza Roma'];

const COFFEE_MERCHANTS = ['Starbucks', "Peet's Coffee", "Dunkin'", 'Local Grind Coffee Co.'];

const GAS_MERCHANTS = ['Shell', 'Chevron', 'ExxonMobil', 'BP', 'Costco Gas'];

const SHOPPING_MERCHANTS = ['Amazon.com', 'Target', 'Best Buy', 'Etsy', 'Nike.com', 'Home Depot'];
const SHOPPING_ITEMS = ['Wireless Earbuds', 'Phone Case', 'USB-C Cable', 'Throw Pillow', 'Desk Lamp', 'Notebook Set', 'Running Shoes', 'Kitchen Utensil Set', 'Bluetooth Speaker', 'Yoga Mat'];

const ENTERTAINMENT_MERCHANTS = ['AMC Theatres', 'Steam', 'PlayStation Store', 'Ticketmaster', 'Regal Cinemas'];

const HEALTH_MERCHANTS = ['CVS Pharmacy', 'Walgreens', 'City Medical Group Copay', 'Quest Diagnostics'];

const TRAVEL_MERCHANTS = ['Delta Air Lines', 'Airbnb', 'Uber', 'Lyft', 'Marriott Hotels'];

const SUBSCRIPTION_POOL = [
  { name: 'Netflix', amount: 15.49 },
  { name: 'Spotify Premium', amount: 11.99 },
  { name: 'Amazon Prime', amount: 14.99 },
  { name: 'Disney+', amount: 13.99 },
  { name: 'Adobe Creative Cloud', amount: 54.99 },
  { name: 'iCloud+ Storage', amount: 2.99 },
];

const UTILITY_PROVIDERS = ['City Water & Power', 'Pacific Coast Electric', 'Comcast Xfinity', 'AT&T Internet'];
const INSURANCE_PROVIDERS = ['State Farm Insurance', 'Geico Auto Insurance', 'Progressive Insurance'];
const EMPLOYERS = ['Acme Corp', 'TechNova Inc', 'Brightline Solutions', 'Meridian Health Systems', 'Union Logistics Group', 'Sterling & Cole LLP'];

function buildItemizedReceipt({ merchant, items: itemPool, cardLast4, taxRate = 0.0725 }) {
  const count = randomInt(1, 5);
  const items = [];
  for (let i = 0; i < count; i++) {
    items.push({ name: pick(itemPool), qty: randomInt(1, 3), price: randomFloat(1.5, 24.99) });
  }
  const subtotal = Number(items.reduce((sum, it) => sum + it.qty * it.price, 0).toFixed(2));
  const tax = Number((subtotal * taxRate).toFixed(2));
  const total = Number((subtotal + tax).toFixed(2));
  return {
    merchant,
    address: randomAddress(),
    items,
    subtotal,
    tax,
    total,
    paymentMethod: `•••• ${cardLast4}`,
    receiptNumber: randomReceiptNumber(merchant.slice(0, 2).toUpperCase()),
  };
}

function buildSimpleReceipt({ merchant, total, paymentMethod, category }) {
  return {
    merchant,
    category,
    total,
    paymentMethod,
    referenceNumber: randomReceiptNumber('REF'),
  };
}

function generateAccountHistory({ accountType, yearsBack, density }) {
  const now = new Date();
  const start = new Date(now);
  start.setFullYear(start.getFullYear() - yearsBack);

  const DENSITY_RANGES = { light: [4, 7], normal: [6, 11], heavy: [10, 18] };
  const [discMin, discMax] = DENSITY_RANGES[density] || DENSITY_RANGES.normal;

  const cardLast4 = randomCardLast4();
  const employer = pick(EMPLOYERS);
  const payBase = randomFloat(1400, 3200);
  const hasRent = accountType === 'checking' ? Math.random() < 0.7 : false;
  const rentAmount = hasRent ? randomFloat(950, 2400) : 0;
  const utilityProvider = pick(UTILITY_PROVIDERS);
  const insuranceProvider = Math.random() < 0.6 ? pick(INSURANCE_PROVIDERS) : null;
  const insuranceAmount = insuranceProvider ? randomFloat(60, 240) : 0;

  const subs = [];
  const subCount = randomInt(2, 4);
  const subPoolCopy = [...SUBSCRIPTION_POOL];
  for (let i = 0; i < subCount && subPoolCopy.length; i++) {
    subs.push(subPoolCopy.splice(randomInt(0, subPoolCopy.length - 1), 1)[0]);
  }

  const rows = [];
  function addRow(type, amount, description, date, receipt) {
    rows.push({ type, amount: Number(amount.toFixed(2)), description, created_at: date, receipt });
  }

  // ---- Recurring paychecks (biweekly) ----
  let payDate = new Date(start);
  payDate.setDate(payDate.getDate() + randomInt(0, 13));
  while (payDate <= now) {
    const amount = Number((payBase * randomFloat(0.97, 1.05)).toFixed(2));
    addRow('credit', amount, `Direct Deposit — ${employer} Payroll`, new Date(payDate), buildSimpleReceipt({
      merchant: `${employer} Payroll`, total: amount, paymentMethod: 'Direct Deposit (ACH)', category: 'Income',
    }));
    payDate.setDate(payDate.getDate() + 14);
  }

  // ---- Recurring monthly bills: rent, utilities, insurance, subscriptions ----
  let cursor = new Date(start.getFullYear(), start.getMonth(), 1);
  while (cursor <= now) {
    if (hasRent) {
      const date = new Date(cursor.getFullYear(), cursor.getMonth(), randomInt(1, 5), randomInt(6, 10), randomInt(0, 59));
      if (date >= start && date <= now) {
        addRow('debit', rentAmount, 'Rent Payment — Greenwood Apartments', date, buildSimpleReceipt({
          merchant: 'Greenwood Apartments', total: rentAmount, paymentMethod: 'Autopay (ACH)', category: 'Housing',
        }));
      }
    }

    const utilAmount = randomFloat(60, 220);
    const utilDate = new Date(cursor.getFullYear(), cursor.getMonth(), randomInt(8, 20), randomInt(7, 19), randomInt(0, 59));
    if (utilDate >= start && utilDate <= now) {
      addRow('debit', utilAmount, `${utilityProvider} — Monthly Bill`, utilDate, buildSimpleReceipt({
        merchant: utilityProvider, total: utilAmount, paymentMethod: 'Autopay (ACH)', category: 'Utilities',
      }));
    }

    if (insuranceProvider) {
      const insDate = new Date(cursor.getFullYear(), cursor.getMonth(), randomInt(1, 28), randomInt(7, 19), randomInt(0, 59));
      if (insDate >= start && insDate <= now) {
        addRow('debit', insuranceAmount, `${insuranceProvider} — Premium`, insDate, buildSimpleReceipt({
          merchant: insuranceProvider, total: insuranceAmount, paymentMethod: `•••• ${cardLast4}`, category: 'Insurance',
        }));
      }
    }

    subs.forEach((sub) => {
      const subDate = new Date(cursor.getFullYear(), cursor.getMonth(), randomInt(1, 28), randomInt(0, 23), randomInt(0, 59));
      if (subDate >= start && subDate <= now) {
        addRow('debit', sub.amount, `${sub.name} — Subscription`, subDate, buildSimpleReceipt({
          merchant: sub.name, total: sub.amount, paymentMethod: `•••• ${cardLast4}`, category: 'Subscription',
        }));
      }
    });

    cursor.setMonth(cursor.getMonth() + 1);
  }

  // ---- Discretionary spending ----
  const DISCRETIONARY = [
    { category: 'Groceries', merchants: GROCERY_MERCHANTS, items: GROCERY_ITEMS, itemized: true, weight: 5 },
    { category: 'Dining', merchants: DINING_MERCHANTS, min: 9, max: 68, itemized: false, weight: 4 },
    { category: 'Coffee', merchants: COFFEE_MERCHANTS, min: 3, max: 9, itemized: false, weight: 4 },
    { category: 'Gas', merchants: GAS_MERCHANTS, min: 25, max: 70, itemized: false, weight: 3 },
    { category: 'Shopping', merchants: SHOPPING_MERCHANTS, items: SHOPPING_ITEMS, itemized: true, weight: 3 },
    { category: 'Entertainment', merchants: ENTERTAINMENT_MERCHANTS, min: 10, max: 90, itemized: false, weight: 2 },
    { category: 'Health', merchants: HEALTH_MERCHANTS, min: 8, max: 130, itemized: false, weight: 1 },
    { category: 'Travel', merchants: TRAVEL_MERCHANTS, min: 20, max: 480, itemized: false, weight: 1 },
  ];
  const WEIGHTED_POOL = DISCRETIONARY.flatMap((c) => Array(c.weight).fill(c));

  cursor = new Date(start.getFullYear(), start.getMonth(), 1);
  while (cursor <= now) {
    const count = randomInt(discMin, discMax);
    for (let i = 0; i < count; i++) {
      const cat = pick(WEIGHTED_POOL);
      const date = new Date(cursor.getFullYear(), cursor.getMonth(), randomInt(1, 28), randomInt(6, 22), randomInt(0, 59));
      if (date < start || date > now) continue;
      const merchant = pick(cat.merchants);

      let receipt, amount;
      if (cat.itemized) {
        receipt = buildItemizedReceipt({ merchant, items: cat.items, cardLast4 });
        amount = receipt.total;
      } else {
        amount = randomFloat(cat.min, cat.max);
        receipt = buildSimpleReceipt({ merchant, total: amount, paymentMethod: `•••• ${cardLast4}`, category: cat.category });
      }
      addRow('debit', amount, `${merchant} — ${cat.category}`, date, receipt);

      if (Math.random() < 0.03) {
        const refundDate = new Date(date);
        refundDate.setDate(refundDate.getDate() + randomInt(2, 10));
        if (refundDate <= now) {
          addRow('credit', amount, `Refund — ${merchant}`, refundDate, buildSimpleReceipt({
            merchant, total: amount, paymentMethod: `•••• ${cardLast4}`, category: 'Refund',
          }));
        }
      }
    }

    if (Math.random() < 0.4) {
      const atmAmount = pick([20, 40, 60, 80, 100, 120]);
      const date = new Date(cursor.getFullYear(), cursor.getMonth(), randomInt(1, 28), randomInt(8, 21), randomInt(0, 59));
      if (date >= start && date <= now) {
        addRow('debit', atmAmount, 'ATM Withdrawal — Main St Branch', date, buildSimpleReceipt({
          merchant: 'Apex Horizon ATM — Main St Branch', total: atmAmount, paymentMethod: `•••• ${cardLast4}`, category: 'Cash Withdrawal',
        }));
      }
    }

    cursor.setMonth(cursor.getMonth() + 1);
  }

  // ---- Net-zero balancing entry so the account's current balance is unaffected ----
  const net = rows.reduce((sum, r) => sum + (r.type === 'credit' ? r.amount : -r.amount), 0);
  if (Math.abs(net) > 0.01) {
    addRow(net > 0 ? 'debit' : 'credit', Math.abs(net), 'Historical Ledger Adjustment', new Date(start), null);
  }

  rows.sort((a, b) => a.created_at - b.created_at);
  return rows;
}

module.exports = async function handler(req, res) {
  if (!checkAdminAuth(req)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const action = req.method === 'GET' ? req.query.action : (req.body || {}).action;

  try {
    // ---------- listUsers ----------
    if (action === 'listUsers') {
      const search = normalizeEmail(req.query.search || '');
      const users = search
        ? await sql`
            SELECT u.id, u.email, u.full_name, u.is_active, u.approval_status, u.created_at,
                   COALESCE(SUM(a.balance), 0) AS total_balance
            FROM users u
            LEFT JOIN accounts a ON a.user_id = u.id
            WHERE LOWER(u.email) LIKE ${'%' + search + '%'}
            GROUP BY u.id
            ORDER BY u.created_at DESC
            LIMIT 100
          `
        : await sql`
            SELECT u.id, u.email, u.full_name, u.is_active, u.approval_status, u.created_at,
                   COALESCE(SUM(a.balance), 0) AS total_balance
            FROM users u
            LEFT JOIN accounts a ON a.user_id = u.id
            GROUP BY u.id
            ORDER BY u.created_at DESC
            LIMIT 100
          `;
      return res.status(200).json({ users });
    }

    // ---------- listAccounts(email) — accounts for a single user, with restriction status ----------
    if (action === 'listAccounts') {
      const email = normalizeEmail(req.query.email);
      if (!email) return res.status(400).json({ error: 'email is required' });

      const userRows = await sql`SELECT id, email FROM users WHERE LOWER(email) = ${email} LIMIT 1`;
      if (userRows.length === 0) return res.status(404).json({ error: 'User not found' });

      const accounts = await sql`
        SELECT id, account_type, balance, restriction_level, restricted_at, restricted_by
        FROM accounts
        WHERE user_id = ${userRows[0].id}
        ORDER BY (account_type = 'checking') DESC, id ASC
      `;
      return res.status(200).json({ email: userRows[0].email, accounts });
    }

    // ---------- recentTransactions (site-wide, last 50) ----------
    if (action === 'recentTransactions') {
      const transactions = await sql`
        SELECT t.id, t.type, t.amount, t.description, t.created_at,
               u.email AS user_email, a.account_type
        FROM transactions t
        JOIN accounts a ON a.id = t.account_id
        JOIN users u ON u.id = a.user_id
        ORDER BY t.created_at DESC
        LIMIT 50
      `;
      return res.status(200).json({ transactions });
    }

    // ---------- getAuditLogs(email) ----------
    if (action === 'getAuditLogs') {
      const email = normalizeEmail(req.query.email);
      if (!email) return res.status(400).json({ error: 'email is required' });

      const logs = await sql`
        SELECT id, admin_action, target_email, amount, details, created_at
        FROM admin_audit_log
        WHERE LOWER(target_email) = ${email}
        ORDER BY created_at DESC
        LIMIT 50
      `;
      return res.status(200).json({ logs });
    }

    // ---------- listPendingLoans ----------
    if (action === 'listPendingLoans') {
      const loans = await sql`
        SELECT l.id, l.user_id, l.principal, l.interest_rate, l.term_months, l.monthly_payment,
               l.purpose, l.monthly_income, l.employment_status, l.applicant_name, l.created_at,
               u.email AS user_email
        FROM loans l
        JOIN users u ON u.id = l.user_id
        WHERE l.status = 'pending'
        ORDER BY l.created_at ASC
      `;
      return res.status(200).json({ loans });
    }

    // ---------- listPendingAccounts (new signup approval queue) ----------
    if (action === 'listPendingAccounts') {
      const accounts = await sql`
        SELECT id, email, full_name, created_at
        FROM users
        WHERE approval_status = 'pending'
        ORDER BY created_at ASC
      `;
      return res.status(200).json({ accounts });
    }

    // ---------- listPendingKyc (enhanced verification review queue) ----------
    if (action === 'listPendingKyc') {
      const kycRequests = await sql`
        SELECT k.id, k.user_id, k.ssn_last_four, k.date_of_birth, k.street_address, k.city, k.state, k.zip_code,
               k.id_type, k.id_number, k.id_expiry_date, k.id_issuing_state, k.created_at,
               u.email AS user_email, u.full_name AS user_full_name
        FROM kyc_verifications k
        JOIN users u ON u.id = k.user_id
        WHERE k.status = 'pending'
        ORDER BY k.created_at ASC
      `;
      return res.status(200).json({ kycRequests });
    }

    // ---------- listDisputes (transaction dispute review queue) ----------
    if (action === 'listDisputes') {
      const disputes = await sql`
        SELECT d.id, d.dispute_type, d.reason, d.status, d.resolution, d.resolution_amount, d.created_at,
               t.id AS transaction_id, t.type AS transaction_type, t.amount,
               t.description AS transaction_description, t.created_at AS transaction_created_at,
               d.account_id,
               u.id AS user_id, u.email AS user_email, u.full_name AS user_full_name
        FROM transaction_disputes d
        JOIN transactions t ON t.id = d.transaction_id
        JOIN users u ON u.id = d.user_id
        WHERE d.status IN ('open', 'investigating')
        ORDER BY d.created_at ASC
      `;
      return res.status(200).json({ disputes });
    }

    // ---------- getLoginActivity (live sign-in feed) ----------
    if (action === 'getLoginActivity') {
      const activity = await sql`
        SELECT id, email, method, ip_address, city, region, country, user_agent, created_at
        FROM login_activity
        ORDER BY created_at DESC
        LIMIT 50
      `;
      return res.status(200).json({ activity });
    }

    // ---------- Everything below requires POST ----------
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'GET, POST');
      return res.status(405).json({ error: 'Method not allowed' });
    }

    // ---------- addFunds(email, amount) / withdrawFunds(email, amount) ----------
    if (action === 'addFunds' || action === 'withdrawFunds') {
      const email = normalizeEmail(req.body.email);
      const amount = Number(req.body.amount);

      if (!email) return res.status(400).json({ error: 'email is required' });
      if (!Number.isFinite(amount) || amount <= 0) {
        return res.status(400).json({ error: 'amount must be a positive number' });
      }

      const userRows = await sql`SELECT id FROM users WHERE LOWER(email) = ${email} LIMIT 1`;
      if (userRows.length === 0) return res.status(404).json({ error: 'User not found' });
      const userId = userRows[0].id;

      const accountRows = await sql`
        SELECT id, balance FROM accounts
        WHERE user_id = ${userId}
        ORDER BY (account_type = 'checking') DESC, id ASC
        LIMIT 1
      `;
      if (accountRows.length === 0) return res.status(404).json({ error: 'No account found for this user' });
      const account = accountRows[0];

      if (action === 'withdrawFunds' && Number(account.balance) < amount) {
        return res.status(400).json({ error: 'Insufficient funds in user account' });
      }

      const delta = action === 'addFunds' ? amount : -amount;
      const txnType = action === 'addFunds' ? 'admin_credit' : 'admin_debit';
      const description = action === 'addFunds'
        ? `Admin deposit of $${amount.toFixed(2)}`
        : `Admin withdrawal of $${amount.toFixed(2)}`;

      await sql`UPDATE accounts SET balance = balance + ${delta} WHERE id = ${account.id}`;

      await sql`
        INSERT INTO transactions (account_id, type, amount, description, created_at)
        VALUES (${account.id}, ${txnType}, ${amount}, ${description}, NOW())
      `;

      await sql`
        INSERT INTO admin_audit_log (admin_action, target_email, amount, details, created_at)
        VALUES (${action}, ${email}, ${amount}, ${description}, NOW())
      `;

      return res.status(200).json({
        success: true,
        message: `${action === 'addFunds' ? 'Added' : 'Withdrew'} $${amount.toFixed(2)} for ${email}`,
      });
    }

    // ---------- grantLoan(loanId) ----------
    if (action === 'grantLoan') {
      const loanId = Number(req.body.loanId);
      if (!loanId) return res.status(400).json({ error: 'loanId is required' });

      const loanRows = await sql`
        SELECT id, account_id, principal, purpose, term_months, interest_rate, status
        FROM loans WHERE id = ${loanId} LIMIT 1
      `;
      if (loanRows.length === 0) return res.status(404).json({ error: 'Loan not found' });
      const loan = loanRows[0];

      if (loan.status !== 'pending') {
        return res.status(400).json({ error: `This loan is already ${loan.status}, not pending.` });
      }

      const description = `Loan Disbursement — ${loan.purpose} (${loan.term_months} mo @ ${(Number(loan.interest_rate) * 100).toFixed(2)}% APR)`;

      await sql`UPDATE accounts SET balance = balance + ${loan.principal} WHERE id = ${loan.account_id}`;

      await sql`
        INSERT INTO transactions (account_id, type, amount, description, created_at)
        VALUES (${loan.account_id}, 'loan_disbursement', ${loan.principal}, ${description}, NOW())
      `;

      await sql`
        UPDATE loans SET status = 'active', disbursed_at = NOW(), remaining_balance = ${loan.principal} WHERE id = ${loan.id}
      `;

      await sql`
        INSERT INTO admin_audit_log (admin_action, target_email, amount, details, created_at)
        VALUES ('grantLoan', NULL, ${loan.principal}, ${description}, NOW())
      `;

      return res.status(200).json({ success: true, message: `Loan #${loan.id} approved and $${Number(loan.principal).toFixed(2)} disbursed.` });
    }

    // ---------- approveAccount(userId) ----------
    if (action === 'approveAccount') {
      const userId = Number(req.body.userId);
      if (!userId) return res.status(400).json({ error: 'userId is required' });

      const userRows = await sql`
        SELECT id, email, approval_status FROM users WHERE id = ${userId} LIMIT 1
      `;
      if (userRows.length === 0) return res.status(404).json({ error: 'User not found' });
      const user = userRows[0];

      if (user.approval_status !== 'pending') {
        return res.status(400).json({ error: `This account is already ${user.approval_status}, not pending.` });
      }

      await sql`
        UPDATE users
        SET approval_status = 'approved', approved_at = NOW(), approved_by = 'admin'
        WHERE id = ${userId}
      `;

      await sql`
        INSERT INTO admin_audit_log (admin_action, target_email, amount, details, created_at)
        VALUES ('approveAccount', ${user.email}, NULL, 'Account approved and can now sign in', NOW())
      `;

      try {
        await sql`
          INSERT INTO notifications (user_id, title, message, is_read, created_at)
          VALUES (${userId}, 'Account Approved', 'Your Apex Horizon Bank account has been approved. You can now sign in.', FALSE, NOW())
        `;
      } catch (notifyErr) {
        console.error('Approve account notification error (non-fatal):', notifyErr);
      }

      return res.status(200).json({ success: true, message: `Account for ${user.email} approved.` });
    }

    // ---------- rejectAccount(userId, reason) ----------
    if (action === 'rejectAccount') {
      const userId = Number(req.body.userId);
      const reason = (req.body.reason || '').trim();
      if (!userId) return res.status(400).json({ error: 'userId is required' });

      const userRows = await sql`
        SELECT id, email, approval_status FROM users WHERE id = ${userId} LIMIT 1
      `;
      if (userRows.length === 0) return res.status(404).json({ error: 'User not found' });
      const user = userRows[0];

      if (user.approval_status !== 'pending') {
        return res.status(400).json({ error: `This account is already ${user.approval_status}, not pending.` });
      }

      await sql`
        UPDATE users
        SET approval_status = 'rejected', approval_reason = ${reason || null}, approved_at = NOW(), approved_by = 'admin'
        WHERE id = ${userId}
      `;

      await sql`
        INSERT INTO admin_audit_log (admin_action, target_email, amount, details, created_at)
        VALUES ('rejectAccount', ${user.email}, NULL, ${reason || 'Account application rejected'}, NOW())
      `;

      return res.status(200).json({ success: true, message: `Account for ${user.email} rejected.` });
    }

    // ---------- approveKyc(kycId) ----------
    if (action === 'approveKyc') {
      const kycId = Number(req.body.kycId);
      if (!kycId) return res.status(400).json({ error: 'kycId is required' });

      const rows = await sql`SELECT id, user_id, status FROM kyc_verifications WHERE id = ${kycId} LIMIT 1`;
      if (rows.length === 0) return res.status(404).json({ error: 'Verification request not found' });
      const kyc = rows[0];

      if (kyc.status !== 'pending') {
        return res.status(400).json({ error: `This request is already ${kyc.status}.` });
      }

      await sql`UPDATE kyc_verifications SET status = 'verified', verified_at = NOW() WHERE id = ${kycId}`;

      try {
        await sql`
          INSERT INTO notifications (user_id, title, message, is_read, created_at)
          VALUES (${kyc.user_id}, 'Identity Verified', 'Your enhanced identity verification has been approved. You can now send wire transfers.', FALSE, NOW())
        `;
      } catch (notifyErr) {
        console.error('KYC approval notification error (non-fatal):', notifyErr);
      }

      await sql`
        INSERT INTO admin_audit_log (admin_action, target_email, amount, details, created_at)
        VALUES ('approveKyc', NULL, NULL, ${'KYC #' + kycId + ' approved'}, NOW())
      `;

      return res.status(200).json({ success: true, message: `Verification #${kycId} approved.` });
    }

    // ---------- rejectKyc(kycId, reason) ----------
    if (action === 'rejectKyc') {
      const kycId = Number(req.body.kycId);
      const reason = (req.body.reason || '').trim();
      if (!kycId) return res.status(400).json({ error: 'kycId is required' });

      const rows = await sql`SELECT id, user_id, status FROM kyc_verifications WHERE id = ${kycId} LIMIT 1`;
      if (rows.length === 0) return res.status(404).json({ error: 'Verification request not found' });
      const kyc = rows[0];

      if (kyc.status !== 'pending') {
        return res.status(400).json({ error: `This request is already ${kyc.status}.` });
      }

      await sql`UPDATE kyc_verifications SET status = 'rejected', rejected_reason = ${reason || null} WHERE id = ${kycId}`;

      try {
        await sql`
          INSERT INTO notifications (user_id, title, message, is_read, created_at)
          VALUES (${kyc.user_id}, 'Verification Update', ${reason ? `Your verification was not approved: ${reason}` : 'Your verification was not approved.'}, FALSE, NOW())
        `;
      } catch (notifyErr) {
        console.error('KYC rejection notification error (non-fatal):', notifyErr);
      }

      await sql`
        INSERT INTO admin_audit_log (admin_action, target_email, amount, details, created_at)
        VALUES ('rejectKyc', NULL, NULL, ${'KYC #' + kycId + ' rejected'}, NOW())
      `;

      return res.status(200).json({ success: true, message: `Verification #${kycId} rejected.` });
    }

    // ---------- resolveDispute(disputeId, resolution, resolutionAmount) ----------
    if (action === 'resolveDispute') {
      const disputeId = Number(req.body.disputeId);
      const resolution = (req.body.resolution || '').trim();
      const resolutionAmount = req.body.resolutionAmount != null && req.body.resolutionAmount !== ''
        ? Number(req.body.resolutionAmount)
        : null;
      if (!disputeId) return res.status(400).json({ error: 'disputeId is required' });
      if (resolutionAmount != null && (!Number.isFinite(resolutionAmount) || resolutionAmount <= 0)) {
        return res.status(400).json({ error: 'Refund amount must be a positive number.' });
      }

      const rows = await sql`
        SELECT id, user_id, account_id, status FROM transaction_disputes WHERE id = ${disputeId} LIMIT 1
      `;
      if (rows.length === 0) return res.status(404).json({ error: 'Dispute not found' });
      const dispute = rows[0];

      if (dispute.status === 'resolved' || dispute.status === 'rejected') {
        return res.status(400).json({ error: `This dispute is already ${dispute.status}.` });
      }

      await sql`
        UPDATE transaction_disputes
        SET status = 'resolved', resolution = ${resolution || null}, resolution_amount = ${resolutionAmount}
        WHERE id = ${disputeId}
      `;

      if (resolutionAmount) {
        await sql`UPDATE accounts SET balance = balance + ${resolutionAmount} WHERE id = ${dispute.account_id}`;
        await sql`
          INSERT INTO transactions (account_id, type, amount, description, created_at)
          VALUES (${dispute.account_id}, 'credit', ${resolutionAmount}, ${'Dispute Refund — Case #' + disputeId}, NOW())
        `;
      }

      try {
        const notifMessage = resolutionAmount
          ? `Your dispute has been resolved in your favor. $${resolutionAmount.toFixed(2)} has been credited to your account.${resolution ? ' ' + resolution : ''}`
          : (resolution ? `Your dispute has been resolved: ${resolution}` : 'Your dispute has been resolved.');
        await sql`
          INSERT INTO notifications (user_id, title, message, is_read, created_at)
          VALUES (${dispute.user_id}, 'Dispute Resolved', ${notifMessage}, FALSE, NOW())
        `;
      } catch (notifyErr) {
        console.error('Dispute resolution notification error (non-fatal):', notifyErr);
      }

      await sql`
        INSERT INTO admin_audit_log (admin_action, target_email, amount, details, created_at)
        VALUES ('resolveDispute', NULL, ${resolutionAmount}, ${'Dispute #' + disputeId + ' resolved'}, NOW())
      `;

      return res.status(200).json({
        success: true,
        message: resolutionAmount
          ? `Dispute #${disputeId} resolved and $${resolutionAmount.toFixed(2)} refunded to the customer.`
          : `Dispute #${disputeId} marked as resolved.`
      });
    }

    // ---------- rejectDispute(disputeId, resolution) ----------
    if (action === 'rejectDispute') {
      const disputeId = Number(req.body.disputeId);
      const resolution = (req.body.resolution || '').trim();
      if (!disputeId) return res.status(400).json({ error: 'disputeId is required' });

      const rows = await sql`SELECT id, user_id, status FROM transaction_disputes WHERE id = ${disputeId} LIMIT 1`;
      if (rows.length === 0) return res.status(404).json({ error: 'Dispute not found' });
      const dispute = rows[0];

      if (dispute.status === 'resolved' || dispute.status === 'rejected') {
        return res.status(400).json({ error: `This dispute is already ${dispute.status}.` });
      }

      await sql`
        UPDATE transaction_disputes SET status = 'rejected', resolution = ${resolution || null}
        WHERE id = ${disputeId}
      `;

      try {
        await sql`
          INSERT INTO notifications (user_id, title, message, is_read, created_at)
          VALUES (${dispute.user_id}, 'Dispute Update', ${resolution ? `Your dispute was reviewed: ${resolution}` : 'Your dispute was reviewed and closed.'}, FALSE, NOW())
        `;
      } catch (notifyErr) {
        console.error('Dispute rejection notification error (non-fatal):', notifyErr);
      }

      await sql`
        INSERT INTO admin_audit_log (admin_action, target_email, amount, details, created_at)
        VALUES ('rejectDispute', NULL, NULL, ${'Dispute #' + disputeId + ' rejected'}, NOW())
      `;

      return res.status(200).json({ success: true, message: `Dispute #${disputeId} rejected.` });
    }

    // ---------- toggleAccountStatus(email) ----------
    if (action === 'toggleAccountStatus') {
      const email = normalizeEmail(req.body.email);
      if (!email) return res.status(400).json({ error: 'email is required' });

      const userRows = await sql`SELECT id, is_active FROM users WHERE LOWER(email) = ${email} LIMIT 1`;
      if (userRows.length === 0) return res.status(404).json({ error: 'User not found' });

      const newStatus = !userRows[0].is_active;
      await sql`UPDATE users SET is_active = ${newStatus} WHERE id = ${userRows[0].id}`;

      await sql`
        INSERT INTO admin_audit_log (admin_action, target_email, amount, details, created_at)
        VALUES ('toggleAccountStatus', ${email}, NULL, ${newStatus ? 'Account enabled' : 'Account disabled'}, NOW())
      `;

      return res.status(200).json({ success: true, isActive: newStatus });
    }

    // ---------- setAccountRestriction(accountId, level) ----------
    if (action === 'setAccountRestriction') {
      const accountId = Number(req.body.accountId);
      const level = String(req.body.level || '').trim();

      if (!accountId) return res.status(400).json({ error: 'accountId is required' });
      if (!RESTRICTION_LEVELS.includes(level)) {
        return res.status(400).json({ error: `level must be one of: ${RESTRICTION_LEVELS.join(', ')}` });
      }

      const accountRows = await sql`
        SELECT a.id, a.account_type, a.restriction_level, u.id AS user_id, u.email
        FROM accounts a
        JOIN users u ON u.id = a.user_id
        WHERE a.id = ${accountId}
        LIMIT 1
      `;
      if (accountRows.length === 0) return res.status(404).json({ error: 'Account not found' });
      const account = accountRows[0];

      await sql`
        UPDATE accounts
        SET restriction_level = ${level},
            restricted_at = ${level === 'none' ? null : new Date().toISOString()},
            restricted_by = ${level === 'none' ? null : 'admin'}
        WHERE id = ${accountId}
      `;

      const label = { none: 'restriction removed', transfers_only: 'transfers/wires locked', full: 'fully locked — view only' }[level];

      try {
        const notifMessage = level === 'none'
          ? `The hold on your ${account.account_type} account has been lifted. Full access has been restored.`
          : `There is an issue on your ${account.account_type} account that requires in-person verification at a branch. Please visit any of our branches with a valid ID to resolve this issue.`;
        await sql`
          INSERT INTO notifications (user_id, title, message, is_read, created_at)
          VALUES (${account.user_id}, ${level === 'none' ? 'Account Restored' : 'Account Issue'}, ${notifMessage}, FALSE, NOW())
        `;
      } catch (notifyErr) {
        console.error('Account restriction notification error (non-fatal):', notifyErr);
      }

      await sql`
        INSERT INTO admin_audit_log (admin_action, target_email, amount, details, created_at)
        VALUES ('setAccountRestriction', ${account.email}, NULL, ${'Account #' + accountId + ' (' + account.account_type + '): ' + label}, NOW())
      `;

      return res.status(200).json({ success: true, accountId, restrictionLevel: level, message: `Account #${accountId} — ${label}.` });
    }

    // ---------- seedTransactionHistory(accountId, yearsBack, density) ----------
    // Generates realistic backdated transaction history (with receipts) for
    // any account. Nets to zero so the account's current balance is unchanged.
    if (action === 'seedTransactionHistory') {
      const accountId = Number(req.body.accountId);
      const yearsBack = Math.min(Math.max(Number(req.body.yearsBack) || 3, 1), 3);
      const density = ['light', 'normal', 'heavy'].includes(req.body.density) ? req.body.density : 'normal';

      if (!accountId) return res.status(400).json({ error: 'accountId is required' });

      const accountRows = await sql`
        SELECT a.id, a.account_type, u.email
        FROM accounts a
        JOIN users u ON u.id = a.user_id
        WHERE a.id = ${accountId}
        LIMIT 1
      `;
      if (accountRows.length === 0) return res.status(404).json({ error: 'Account not found' });
      const account = accountRows[0];

      // Idempotent — safe to run every time; only adds the column the first time.
      await sql`ALTER TABLE transactions ADD COLUMN IF NOT EXISTS receipt JSONB`;

      const rows = generateAccountHistory({ accountType: account.account_type, yearsBack, density });

      if (rows.length === 0) {
        return res.status(200).json({ success: true, message: 'No transactions generated.', count: 0 });
      }

      const types = rows.map((r) => r.type);
      const amounts = rows.map((r) => r.amount);
      const descriptions = rows.map((r) => r.description);
      const createdAts = rows.map((r) => r.created_at.toISOString());
      const receipts = rows.map((r) => (r.receipt ? JSON.stringify(r.receipt) : null));

      const inserted = await sql`
        INSERT INTO transactions (account_id, type, amount, description, created_at, receipt)
        SELECT ${accountId}, t.type, t.amount, t.description, t.created_at, t.receipt
        FROM unnest(
          ${types}::text[],
          ${amounts}::numeric[],
          ${descriptions}::text[],
          ${createdAts}::timestamptz[],
          ${receipts}::jsonb[]
        ) AS t(type, amount, description, created_at, receipt)
        RETURNING id
      `;

      await sql`
        INSERT INTO admin_audit_log (admin_action, target_email, amount, details, created_at)
        VALUES ('seedTransactionHistory', ${account.email}, NULL, ${'Seeded ' + inserted.length + ' historical transactions (' + yearsBack + 'yr, ' + density + ') on account #' + accountId}, NOW())
      `;

      return res.status(200).json({
        success: true,
        message: `Seeded ${inserted.length} historical transactions on account #${accountId} (${account.email}), spanning ${yearsBack} year(s). Current balance was not changed.`,
        count: inserted.length,
      });
    }

    return res.status(400).json({
      error: 'Invalid or missing action. Use "listUsers", "listAccounts", "recentTransactions", "getAuditLogs", "listPendingLoans", "listPendingAccounts", "listPendingKyc", "listDisputes", "getLoginActivity", "addFunds", "withdrawFunds", "grantLoan", "approveAccount", "rejectAccount", "approveKyc", "rejectKyc", "resolveDispute", "rejectDispute", "toggleAccountStatus", "setAccountRestriction", or "seedTransactionHistory".',
    });
  } catch (err) {
    console.error('Admin API error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
