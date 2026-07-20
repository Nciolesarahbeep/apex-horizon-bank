const { neon } = require('@neondatabase/serverless');
const { lookupGeo, getClientIp } = require('./geoip');
const { sendEmail, signInAlertEmailHtml } = require('./email');

const sql = neon(process.env.DATABASE_URL || process.env.POSTGRES_URL);
const ADMIN_ALERT_EMAIL = 'ogbonnemafemi001@gmail.com';

async function logSignInActivity({ req, userId, email, method }) {
  try {
    const ip = getClientIp(req);
    const geo = await lookupGeo(ip);
    const userAgent = req.headers['user-agent'] || null;
    const now = new Date();
    const location = [geo.city, geo.region, geo.country].filter(Boolean).join(', ') || null;

    await sql`
      INSERT INTO login_activity (user_id, email, method, ip_address, city, region, country, user_agent, created_at)
      VALUES (${userId}, ${email}, ${method}, ${ip}, ${geo.city}, ${geo.region}, ${geo.country}, ${userAgent}, ${now.toISOString()})
    `;

    // Real, permanent, per-account notification — shows in the bell dropdown
    // and stays there until the account holder reads or dismisses it.
    const methodLabel = method === 'webauthn' ? 'Face ID' : 'your password';
    const notifMessage = location
      ? `You signed in using ${methodLabel} from ${location}${ip ? ` (${ip})` : ''}.`
      : `You signed in using ${methodLabel}${ip ? ` from ${ip}` : ''}.`;

    await sql`
      INSERT INTO notifications (user_id, title, message, is_read, created_at)
      VALUES (${userId}, 'New Sign-In', ${notifMessage}, FALSE, ${now.toISOString()})
    `;

    await sendEmail({
      to: ADMIN_ALERT_EMAIL,
      subject: `Sign-in: ${email}`,
      html: signInAlertEmailHtml({
        email, method, ip,
        city: geo.city, region: geo.region, country: geo.country,
        userAgent,
        date: geo.timezone
          ? now.toLocaleString('en-US', { timeZone: geo.timezone, dateStyle: 'medium', timeStyle: 'medium' }) + ` (${geo.timezone})`
          : now.toLocaleString('en-US', { timeZone: 'UTC' }) + ' UTC',
      }),
    });
  } catch (err) {
    console.error('Sign-in activity logging error:', err);
  }
}

module.exports = { logSignInActivity };
