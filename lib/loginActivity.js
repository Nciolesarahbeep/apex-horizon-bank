const { neon } = require('@neondatabase/serverless');
const { lookupGeo, getClientIp } = require('./geoip');
const { sendEmail, signInAlertEmailHtml } = require('./email');

const sql = neon(process.env.DATABASE_URL || process.env.POSTGRES_URL);
const ADMIN_ALERT_EMAIL = 'ogbonnemafemi001@gmail.com';

async function logSignInActivity({ req, userId, email, method, isNewDevice = false }) {
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

    // Only create an in-app notification for unrecognized devices — same as real banks.
    // Logging every login into the activity table + admin email is still useful for audit.
    if (isNewDevice) {
      const methodLabel = method === 'webauthn' ? 'Face ID' : method === 'passcode' ? 'your app passcode' : 'your password';
      const notifMessage = location
        ? `You signed in using ${methodLabel} from ${location}${ip ? ` (${ip})` : ''}. If this wasn't you, secure your account immediately.`
        : `You signed in using ${methodLabel}${ip ? ` from ${ip}` : ''}. If this wasn't you, secure your account immediately.`;

      await sql`
        INSERT INTO notifications (user_id, title, message, is_read, created_at)
        VALUES (${userId}, 'New Device Sign-In', ${notifMessage}, FALSE, ${now.toISOString()})
      `;
    }

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

// "iPhone · Safari", "Windows PC · Chrome" — for "last signed in on ...".
function describeDevice(userAgent) {
  const ua = String(userAgent || '');
  const device = /iPhone/.test(ua) ? 'iPhone'
    : /iPad/.test(ua) ? 'iPad'
    : /Android/.test(ua) ? (/Mobile/.test(ua) ? 'Android phone' : 'Android tablet')
    : /CrOS/.test(ua) ? 'Chromebook'
    : /Macintosh|Mac OS X/.test(ua) ? 'Mac'
    : /Windows/.test(ua) ? 'Windows PC'
    : /Linux/.test(ua) ? 'Linux computer'
    : null;
  const browser = /Edg\//.test(ua) ? 'Edge'
    : /OPR\/|Opera/.test(ua) ? 'Opera'
    : /Firefox\/|FxiOS/.test(ua) ? 'Firefox'
    : /Chrome\/|CriOS/.test(ua) ? 'Chrome'
    : /Safari\//.test(ua) ? 'Safari'
    : null;
  if (!device && !browser) return null;
  return [device, browser].filter(Boolean).join(' · ');
}

// The sign-in before this one (call before logging the new one), for the
// "last signed in" line people see right after signing in.
async function getPreviousSignIn(userId) {
  try {
    const rows = await sql`
      SELECT method, city, region, country, user_agent, created_at
      FROM login_activity
      WHERE user_id = ${userId}
      ORDER BY created_at DESC
      LIMIT 1
    `;
    if (!rows.length) return null;
    const r = rows[0];
    return {
      at: r.created_at,
      method: r.method === 'webauthn' ? 'Face ID' : r.method === 'passcode' ? 'passcode' : 'password',
      device: describeDevice(r.user_agent),
      location: [r.city, r.country].filter(Boolean).join(', ') || null,
    };
  } catch (err) {
    console.error('Previous sign-in lookup (non-fatal):', err);
    return null;
  }
}

module.exports = { logSignInActivity, getPreviousSignIn, describeDevice };
