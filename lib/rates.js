// Published rates, kept in one place.
//
// New savings accounts open at SAVINGS_APY (api/signup.js), and older accounts
// with no rate get it too (lib/interest.js). The sign-in screen's savings offer
// shows the same number (AHB_PUBLIC_RATES in index.html); a test checks the two
// match, so the ad never promises a rate the account doesn't pay.

const SAVINGS_APY = 0.045; // 4.50% APY, compounded daily

module.exports = { SAVINGS_APY };
