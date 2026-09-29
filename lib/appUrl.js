// The bank's public address, used for links in emails (password reset,
// confirming a new email address).
//
// APP_URL can point links somewhere else, such as a local test server, but
// never at a *.vercel.app address. Those are Vercel's automatic addresses:
// the old one only redirects to apexhorizonbank.com now and the rest need a
// Vercel login, so a link to one would put a retired address in someone's
// inbox. A stale APP_URL left over from before the move falls back to the
// real domain instead.
const CANONICAL_URL = 'https://apexhorizonbank.com';

function isVercelAppHost(hostname) {
  const host = String(hostname || '').toLowerCase();
  return host === 'vercel.app' || host.endsWith('.vercel.app');
}

function publicAppUrl() {
  const raw = String(process.env.APP_URL || '').trim();
  if (!raw) return CANONICAL_URL;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return CANONICAL_URL;
    if (isVercelAppHost(url.hostname)) return CANONICAL_URL;
    return url.origin;
  } catch (e) {
    return CANONICAL_URL;
  }
}

module.exports = { CANONICAL_URL, publicAppUrl, isVercelAppHost };
