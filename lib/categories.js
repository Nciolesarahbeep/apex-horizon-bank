// Spending categories, shared by Budgets (server) and Insights (browser).
//
// index.html carries an identical copy of SPEND_CATEGORIES, SPEND_OUT_TYPES and
// NOT_SPENDING_PATTERN (search for "AHB_SPEND_CATEGORIES") so both screens put
// every transaction in the same bucket. If you change one, change the other.
//
// Rules are checked top to bottom and the first match wins, so more specific
// words come first ("uber eats" is dining before "uber" is transport).

const SPEND_CATEGORIES = [
  { id: 'groceries', name: 'Groceries', icon: 'fa-cart-shopping', color: '#10b981', keywords: ['grocer', 'supermarket', 'whole foods', 'trader joe', 'kroger', 'safeway', 'aldi', 'publix', 'costco wholesale'] },
  { id: 'dining', name: 'Dining & coffee', icon: 'fa-utensils', color: '#f59e0b', keywords: ['restaurant', 'dining', 'coffee', 'starbucks', 'cafe', 'café', 'dunkin', 'peet', 'chipotle', 'mcdonald', 'pizza', 'burger', 'uber eats', 'doordash', 'grubhub', 'chick-fil-a', 'panera', 'diner', 'bistro', 'sushi', 'taco'] },
  { id: 'travel', name: 'Travel', icon: 'fa-plane', color: '#0ea5e9', keywords: ['airline', 'flight', 'delta air', 'united air', 'southwest', 'hotel', 'airbnb', 'marriott', 'hilton', 'expedia', 'travel'] },
  { id: 'transport', name: 'Transport', icon: 'fa-car', color: '#3b82f6', keywords: ['uber', 'lyft', 'fuel', 'gas', 'shell', 'chevron', 'exxon', 'transit', 'parking', 'metro', 'toll', 'taxi'] },
  { id: 'subscriptions', name: 'Subscriptions', icon: 'fa-rotate', color: '#a855f7', keywords: ['netflix', 'spotify', 'hulu', 'disney', 'subscription', 'streaming', 'icloud', 'adobe', 'youtube', 'gym', 'membership'] },
  { id: 'entertainment', name: 'Entertainment', icon: 'fa-film', color: '#ec4899', keywords: ['entertainment', 'movie', 'cinema', 'amc', 'concert', 'ticketmaster', 'steam', 'playstation', 'xbox'] },
  { id: 'health', name: 'Health', icon: 'fa-heart-pulse', color: '#ef4444', keywords: ['pharmacy', 'cvs', 'walgreens', 'health', 'clinic', 'doctor', 'dental', 'hospital', 'medical'] },
  { id: 'housing', name: 'Housing', icon: 'fa-house', color: '#8b5cf6', keywords: ['rent payment', 'mortgage', 'apartments', 'landlord'] },
  { id: 'bills', name: 'Bills & utilities', icon: 'fa-bolt', color: '#e11d48', keywords: ['utilit', 'electric', 'water', 'internet', 'comcast', 'verizon', 'at&t', 't-mobile', 'phone', 'pg&e', 'monthly bill', 'insurance', 'premium', 'geico', 'state farm', 'allstate', 'progressive', 'bill pay'] },
  { id: 'shopping', name: 'Shopping', icon: 'fa-bag-shopping', color: '#6366f1', keywords: ['amazon', 'target', 'walmart', 'best buy', 'ebay', 'etsy', 'nike', 'home depot', 'store', 'shop', 'mall', 'retail', 'marketplace'] },
  { id: 'cash', name: 'Cash & ATM', icon: 'fa-money-bill-wave', color: '#64748b', keywords: ['atm withdrawal', 'cash withdrawal', 'atm fee'] },
  { id: 'loans', name: 'Loan payments', icon: 'fa-hand-holding-dollar', color: '#0f766e', keywords: ['loan payment'] },
  { id: 'people', name: 'Money to people', icon: 'fa-user', color: '#14b8a6', keywords: [] },
  { id: 'other', name: 'Everything else', icon: 'fa-receipt', color: '#94a3b8', keywords: [] },
];

// What counts as spending: money going out to someone else. Moves between
// your own accounts, into savings goals, and paying off the Apex card (the
// purchases were already counted when you made them) don't count.
const SPEND_OUT_TYPES = ['debit', 'credit_purchase', 'p2p_out', 'wire_out', 'admin_debit'];
const NOT_SPENDING_PATTERN = /^(to goal|from goal|round-ups|goal closed):|^credit card payment|^external transfer/i;

const CATEGORY_BY_ID = Object.fromEntries(SPEND_CATEGORIES.map((c) => [c.id, c]));

function isSpending(t) {
  return SPEND_OUT_TYPES.includes(t.type) && !NOT_SPENDING_PATTERN.test(String(t.description || ''));
}

function categorize(t) {
  if (t.type === 'p2p_out' || t.type === 'wire_out') return CATEGORY_BY_ID.people;
  const text = String(t.description || '').toLowerCase();
  for (const cat of SPEND_CATEGORIES) {
    if (cat.keywords.length && cat.keywords.some((k) => text.includes(k))) return cat;
  }
  return CATEGORY_BY_ID.other;
}

module.exports = { SPEND_CATEGORIES, SPEND_OUT_TYPES, NOT_SPENDING_PATTERN, CATEGORY_BY_ID, isSpending, categorize };
