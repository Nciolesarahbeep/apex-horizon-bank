// Push notifications to phones and browsers (Web Push).
//
// No push SDK: this speaks the standard protocol directly with Node's crypto.
//  - Each message is encrypted for the one device it's going to (RFC 8291,
//    "aes128gcm"), so Apple/Google/Mozilla's push servers only ever see
//    ciphertext.
//  - Each request is signed with our VAPID key (RFC 8292), which proves to the
//    push service that the message comes from the server that the device
//    subscribed to.
//
// How notifications reach a phone: everything the app tells a customer already
// lands in the notifications table (from API code and from database
// triggers). withPush() wraps an API handler; after any POST/PUT/DELETE (or
// the daily cron) and before the response goes out, flushPending() claims the
// notifications created in the last few minutes that haven't been pushed yet
// and sends them to that customer's devices. The claim is one UPDATE with
// SKIP LOCKED, so two requests finishing at once never send the same alert
// twice.
//
// Keys: VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY if set. Otherwise a key pair is
// derived from PUSH_KEY_SECRET (or JWT_SECRET), so push works with no extra
// setup and the key stays the same across deploys.

const crypto = require('crypto');

const MAX_DEVICES = 10;          // per customer; the oldest drop off
const FRESH_MINUTES = 15;        // older unpushed alerts are stale, not sent
const FLUSH_BATCH = 40;          // alerts claimed per flush
const SEND_TIMEOUT_MS = 4000;
const RECORD_SIZE = 4096;

// Only real push services. The endpoint comes from the browser, and we make an
// HTTPS request to it, so anything else is refused (no requests to arbitrary
// hosts from our servers).
const PUSH_HOSTS = [
  /^([a-z0-9-]+\.)*push\.apple\.com$/,
  /^fcm\.googleapis\.com$/,
  /^android\.googleapis\.com$/,
  /^([a-z0-9-]+\.)*push\.services\.mozilla\.com$/,
  /^([a-z0-9-]+\.)*notify\.windows\.com$/,
];

class PushError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// ----- base64url -----
function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function fromB64url(str) {
  const s = String(str || '').replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(s + '='.repeat((4 - (s.length % 4)) % 4), 'base64');
}
function isB64url(str, maxLen = 200) {
  return typeof str === 'string' && str.length > 0 && str.length <= maxLen && /^[A-Za-z0-9_-]+=*$/.test(str);
}

// ----- VAPID keys -----
let cachedKeys;
function vapidKeys() {
  if (cachedKeys !== undefined) return cachedKeys;
  const envPub = process.env.VAPID_PUBLIC_KEY;
  const envPriv = process.env.VAPID_PRIVATE_KEY;
  if (envPub && envPriv) {
    cachedKeys = { publicKey: envPub.trim(), privateKey: envPriv.trim(), source: 'env' };
    return cachedKeys;
  }
  const secret = process.env.PUSH_KEY_SECRET || process.env.JWT_SECRET;
  if (!secret) { cachedKeys = null; return null; }
  // A P-256 private key is any 32-byte number between 1 and the curve order;
  // setPrivateKey refuses the (astronomically rare) out-of-range values, so try
  // the next counter if that happens.
  for (let i = 0; i < 16; i++) {
    const d = Buffer.from(crypto.hkdfSync('sha256', secret, 'apex-horizon-vapid', `p256-${i}`, 32));
    try {
      const ecdh = crypto.createECDH('prime256v1');
      ecdh.setPrivateKey(d);
      cachedKeys = { publicKey: b64url(ecdh.getPublicKey()), privateKey: b64url(d), source: 'derived' };
      return cachedKeys;
    } catch (_) { /* next counter */ }
  }
  cachedKeys = null;
  return null;
}
function resetKeyCacheForTests() { cachedKeys = undefined; }

function vapidSubject() {
  return process.env.VAPID_SUBJECT || 'https://apexhorizonbank.com';
}

function privateKeyObject(publicKeyB64, privateKeyB64) {
  const pub = fromB64url(publicKeyB64);
  return crypto.createPrivateKey({
    key: { kty: 'EC', crv: 'P-256', d: b64url(fromB64url(privateKeyB64)), x: b64url(pub.subarray(1, 33)), y: b64url(pub.subarray(33, 65)) },
    format: 'jwk',
  });
}

// RFC 8292: a short-lived ES256 JWT for the push service's origin.
function vapidAuthHeader(endpoint, keys = vapidKeys(), nowSec = Math.floor(Date.now() / 1000)) {
  if (!keys) throw new PushError(503, 'Push notifications are not set up on the server.');
  const aud = new URL(endpoint).origin;
  const header = b64url(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const claims = b64url(JSON.stringify({ aud, exp: nowSec + 12 * 3600, sub: vapidSubject() }));
  const unsigned = `${header}.${claims}`;
  const sig = crypto.sign('sha256', Buffer.from(unsigned), { key: privateKeyObject(keys.publicKey, keys.privateKey), dsaEncoding: 'ieee-p1363' });
  return `vapid t=${unsigned}.${b64url(sig)}, k=${keys.publicKey}`;
}

// ----- RFC 8291 message encryption -----
// Returns the full request body: RFC 8188 header (salt, record size, our
// one-time public key) followed by one AES-128-GCM record.
function encryptPayload(plaintext, uaPublicB64, authSecretB64, { salt = crypto.randomBytes(16), asPrivate = null } = {}) {
  const uaPublic = fromB64url(uaPublicB64);
  const authSecret = fromB64url(authSecretB64);
  if (uaPublic.length !== 65 || uaPublic[0] !== 4) throw new PushError(400, 'That device key is not valid.');
  if (authSecret.length !== 16) throw new PushError(400, 'That device key is not valid.');

  const ecdh = crypto.createECDH('prime256v1');
  if (asPrivate) ecdh.setPrivateKey(fromB64url(asPrivate)); else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const sharedSecret = ecdh.computeSecret(uaPublic);

  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', sharedSecret, authSecret, keyInfo, 32));
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));

  const body = Buffer.from(plaintext);
  if (body.length > RECORD_SIZE - 16 - 1 - 86) throw new PushError(413, 'That notification is too long.');
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const record = Buffer.concat([cipher.update(Buffer.concat([body, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);

  const header = Buffer.alloc(21);
  Buffer.from(salt).copy(header, 0);
  header.writeUInt32BE(RECORD_SIZE, 16);
  header.writeUInt8(asPublic.length, 20);
  return Buffer.concat([header, asPublic, record]);
}

// ----- Validation -----
function validateEndpoint(endpoint) {
  if (typeof endpoint !== 'string' || endpoint.length > 1000) throw new PushError(400, 'That device subscription is not valid.');
  let url;
  try { url = new URL(endpoint); } catch (_) { throw new PushError(400, 'That device subscription is not valid.'); }
  if (url.protocol !== 'https:' || url.port || url.username || url.password) throw new PushError(400, 'That device subscription is not valid.');
  if (!PUSH_HOSTS.some((re) => re.test(url.hostname.toLowerCase()))) throw new PushError(400, "Notifications from this browser's push service aren't supported.");
  return url.href;
}

function validateSubscription(sub) {
  if (!sub || typeof sub !== 'object') throw new PushError(400, 'Missing device subscription.');
  const endpoint = validateEndpoint(sub.endpoint);
  const keys = sub.keys || {};
  if (!isB64url(keys.p256dh, 200) || !isB64url(keys.auth, 60)) throw new PushError(400, 'That device subscription is not valid.');
  const p = fromB64url(keys.p256dh);
  const a = fromB64url(keys.auth);
  if (p.length !== 65 || p[0] !== 4 || a.length !== 16) throw new PushError(400, 'That device subscription is not valid.');
  // Make sure it's actually a point on the curve before we store it.
  try {
    const probe = crypto.createECDH('prime256v1');
    probe.generateKeys();
    probe.computeSecret(p);
  } catch (_) { throw new PushError(400, 'That device subscription is not valid.'); }
  return { endpoint, p256dh: b64url(p), auth: b64url(a) };
}

function endpointHash(endpoint) {
  return crypto.createHash('sha256').update(String(endpoint)).digest('hex').slice(0, 24);
}

// ----- Schema -----
const schemaReady = new WeakMap();
function ensurePushSchema(sql) {
  let p = schemaReady.get(sql);
  if (!p) {
    p = (async () => {
      await sql`
        CREATE TABLE IF NOT EXISTS push_subscriptions (
          id SERIAL PRIMARY KEY,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          endpoint TEXT NOT NULL UNIQUE,
          p256dh TEXT NOT NULL,
          auth TEXT NOT NULL,
          device_label TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          last_success_at TIMESTAMPTZ,
          last_error TEXT,
          failures INTEGER NOT NULL DEFAULT 0
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS push_subscriptions_user_idx ON push_subscriptions (user_id)`;
      await sql`ALTER TABLE notifications ADD COLUMN IF NOT EXISTS pushed_at TIMESTAMPTZ`;
      await sql`CREATE INDEX IF NOT EXISTS notifications_unpushed_idx ON notifications (created_at) WHERE pushed_at IS NULL`;
      // Anything already stale is never going to be pushed; mark it so the
      // partial index stays small.
      await sql`UPDATE notifications SET pushed_at = created_at WHERE pushed_at IS NULL AND created_at <= NOW() - make_interval(mins => ${FRESH_MINUTES})`;
    })();
    p.catch(() => schemaReady.delete(sql));
    schemaReady.set(sql, p);
  }
  return p;
}

// ----- Devices -----
function shapeDevice(row) {
  return {
    id: Number(row.id),
    label: row.device_label || 'This device',
    endpointHash: endpointHash(row.endpoint),
    createdAt: row.created_at,
    lastSuccessAt: row.last_success_at || null,
    failing: Number(row.failures) >= 3,
  };
}

async function listDevices(sql, userId) {
  await ensurePushSchema(sql);
  const rows = await sql`
    SELECT id, endpoint, device_label, created_at, last_success_at, failures
    FROM push_subscriptions WHERE user_id = ${userId} ORDER BY created_at DESC, id DESC
  `;
  return rows.map(shapeDevice);
}

function deviceLabel(userAgent) {
  try {
    const { describeDevice } = require('./loginActivity');
    return describeDevice(userAgent) || null;
  } catch (_) {
    return null;
  }
}

async function subscribe(sql, userId, subscription, { userAgent } = {}) {
  if (!vapidKeys()) throw new PushError(503, 'Push notifications are not set up on the server.');
  const sub = validateSubscription(subscription);
  await ensurePushSchema(sql);
  const label = (deviceLabel(userAgent) || 'Browser').slice(0, 80);
  // One row per device. If someone else on this phone had it, it moves to
  // whoever is turning notifications on now.
  await sql`
    INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, device_label)
    VALUES (${userId}, ${sub.endpoint}, ${sub.p256dh}, ${sub.auth}, ${label})
    ON CONFLICT (endpoint) DO UPDATE
      SET user_id = EXCLUDED.user_id, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth,
          device_label = EXCLUDED.device_label, failures = 0, last_error = NULL,
          created_at = CASE WHEN push_subscriptions.user_id = EXCLUDED.user_id THEN push_subscriptions.created_at ELSE NOW() END
  `;
  await sql`
    DELETE FROM push_subscriptions
    WHERE user_id = ${userId}
      AND id NOT IN (SELECT id FROM push_subscriptions WHERE user_id = ${userId} ORDER BY created_at DESC, id DESC LIMIT ${MAX_DEVICES})
  `;
  const devices = await listDevices(sql, userId);
  return { devices, thisDevice: endpointHash(sub.endpoint) };
}

async function unsubscribe(sql, userId, { endpoint, id } = {}) {
  await ensurePushSchema(sql);
  if (id !== undefined && id !== null && id !== '') {
    const n = Number(id);
    if (!Number.isInteger(n) || n <= 0) throw new PushError(400, 'Unknown device.');
    await sql`DELETE FROM push_subscriptions WHERE id = ${n} AND user_id = ${userId}`;
  } else if (typeof endpoint === 'string' && endpoint) {
    await sql`DELETE FROM push_subscriptions WHERE endpoint = ${endpoint} AND user_id = ${userId}`;
  } else {
    throw new PushError(400, 'Say which device to turn off.');
  }
  return { devices: await listDevices(sql, userId) };
}

// Right after someone signs in: if this phone was getting another customer's
// notifications, stop that, so nobody sees someone else's alerts.
async function releaseIfOtherUser(sql, userId, endpoint) {
  if (typeof endpoint !== 'string' || !endpoint) return { mine: false };
  await ensurePushSchema(sql);
  const rows = await sql`SELECT user_id FROM push_subscriptions WHERE endpoint = ${endpoint}`;
  if (!rows.length) return { mine: false, released: false };
  if (Number(rows[0].user_id) === Number(userId)) return { mine: true, released: false };
  await sql`DELETE FROM push_subscriptions WHERE endpoint = ${endpoint} AND user_id <> ${userId}`;
  return { mine: false, released: true };
}

// ----- Sending -----
let transport = null; // tests swap this for a fake push service
function setTransportForTests(fn) { transport = fn; }

async function httpSend(endpoint, body, headers) {
  if (transport) return transport(endpoint, body, headers);
  const res = await fetch(endpoint, { method: 'POST', headers, body, signal: AbortSignal.timeout(SEND_TIMEOUT_MS) });
  let text = '';
  try { text = await res.text(); } catch (_) {}
  return { status: res.status, body: text.slice(0, 200) };
}

async function sendToDevice(sub, payload, { ttl = 86400, urgency = 'normal', topic = null } = {}) {
  const keys = vapidKeys();
  if (!keys) throw new PushError(503, 'Push notifications are not set up on the server.');
  const endpoint = validateEndpoint(sub.endpoint);
  const body = encryptPayload(JSON.stringify(payload), sub.p256dh, sub.auth);
  const headers = {
    'Content-Encoding': 'aes128gcm',
    'Content-Type': 'application/octet-stream',
    'Content-Length': String(body.length),
    TTL: String(ttl),
    Urgency: urgency,
    Authorization: vapidAuthHeader(endpoint, keys),
  };
  if (topic) headers.Topic = String(topic).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32);
  return httpSend(endpoint, body, headers);
}

// Send to every device a customer has, and tidy up devices that have gone away.
async function deliver(sql, subs, payload, opts) {
  let sent = 0, failed = 0, removed = 0;
  await Promise.all(subs.map(async (s) => {
    try {
      const r = await sendToDevice(s, payload, opts);
      if (r.status >= 200 && r.status < 300) {
        sent++;
        await sql`UPDATE push_subscriptions SET last_success_at = NOW(), failures = 0, last_error = NULL WHERE id = ${s.id}`;
      } else if (r.status === 404 || r.status === 410) {
        // The browser unsubscribed or the app was deleted.
        removed++;
        await sql`DELETE FROM push_subscriptions WHERE id = ${s.id}`;
      } else {
        failed++;
        await sql`UPDATE push_subscriptions SET failures = failures + 1, last_error = ${`HTTP ${r.status}`} WHERE id = ${s.id}`;
      }
    } catch (err) {
      failed++;
      try { await sql`UPDATE push_subscriptions SET failures = failures + 1, last_error = ${String((err && err.message) || err).slice(0, 200)} WHERE id = ${s.id}`; } catch (_) {}
    }
  }));
  return { sent, failed, removed };
}

// What kind of alert this is, for the "money in and out" switch. Security
// alerts always go through.
function pushCategory(title, message) {
  const t = `${title || ''} ${message || ''}`.toLowerCase();
  // Reminders people asked for (like a subscription coming up) always go.
  if (/is coming up|reminder/.test(t)) return 'account';
  if (/sign[- ]?in|signed in|new device|password|passcode|face id|security|verification|suspicious|fraud|locked|restrict/.test(t)) return 'security';
  if (/\$\s?\d|payment|transfer|deposit|received|sent|wire|purchase|charge|refund|withdraw|cash back|balance|autopay|round-up/.test(t)) return 'money';
  return 'account';
}

function pushPayload(n, unread) {
  return {
    id: Number(n.id),
    title: String(n.title || 'Apex Horizon Bank').slice(0, 80),
    body: String(n.message || '').slice(0, 240),
    tag: `ahb-${n.id}`,
    url: '/?open=notifications',
    badge: Number(unread) || 0,
    ts: n.created_at ? Date.parse(n.created_at) : Date.now(),
  };
}

async function flushPending(sql, { limit = FLUSH_BATCH } = {}) {
  if (!vapidKeys()) return { claimed: 0, sent: 0 };
  await ensurePushSchema(sql);
  const claimed = await sql`
    UPDATE notifications SET pushed_at = NOW()
    WHERE id IN (
      SELECT id FROM notifications
      WHERE pushed_at IS NULL AND created_at > NOW() - make_interval(mins => ${FRESH_MINUTES})
      ORDER BY id
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, user_id, title, message, created_at
  `;
  if (!claimed.length) return { claimed: 0, sent: 0 };
  const userIds = [...new Set(claimed.map((n) => Number(n.user_id)))];
  const idList = `{${userIds.join(',')}}`;
  const subs = await sql`SELECT id, user_id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ANY(${idList}::int[])`;
  if (!subs.length) return { claimed: claimed.length, sent: 0 };

  let moneyOff = new Set();
  try {
    const prefs = await sql`SELECT id FROM users WHERE id = ANY(${idList}::int[]) AND notif_txn = FALSE`;
    moneyOff = new Set(prefs.map((r) => Number(r.id)));
  } catch (_) { /* preference column not created yet: everything on */ }

  const unreadRows = await sql`
    SELECT user_id, COUNT(*) AS n FROM notifications
    WHERE user_id = ANY(${idList}::int[]) AND is_read = FALSE GROUP BY user_id
  `;
  const unread = new Map(unreadRows.map((r) => [Number(r.user_id), Number(r.n)]));

  const byUser = new Map();
  subs.forEach((s) => {
    const k = Number(s.user_id);
    if (!byUser.has(k)) byUser.set(k, []);
    byUser.get(k).push(s);
  });

  let sent = 0, skipped = 0;
  for (const n of claimed) {
    const uid = Number(n.user_id);
    const devices = byUser.get(uid);
    if (!devices) continue;
    const cat = pushCategory(n.title, n.message);
    if (cat === 'money' && moneyOff.has(uid)) { skipped++; continue; }
    const r = await deliver(sql, devices, pushPayload(n, unread.get(uid)), { urgency: cat === 'security' ? 'high' : 'normal' });
    sent += r.sent;
  }
  return { claimed: claimed.length, sent, skipped };
}

async function sendTest(sql, userId) {
  await ensurePushSchema(sql);
  const subs = await sql`SELECT id, user_id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ${userId}`;
  if (!subs.length) throw new PushError(400, 'Turn on notifications on this device first.');
  const r = await deliver(sql, subs, {
    id: 0,
    title: 'Notifications are on',
    body: "This is how Apex Horizon alerts will look on this device.",
    tag: 'ahb-test',
    url: '/',
  }, { ttl: 300, urgency: 'high' });
  return { ...r, devices: await listDevices(sql, userId) };
}

// Wrap an API handler so alerts it creates reach phones before it responds.
// Only for requests that change things (and the cron); plain GETs skip it.
function withPush(handler, sql) {
  return async function pushAware(req, res) {
    const method = String((req && req.method) || 'GET').toUpperCase();
    const headers = (req && req.headers) || {};
    const isCron = headers['x-vercel-cron'] === '1' || /vercel-cron/i.test(String(headers['user-agent'] || ''));
    if ((method === 'GET' && !isCron) || method === 'OPTIONS' || method === 'HEAD' || !res || typeof res.json !== 'function' || !vapidKeys()) {
      return handler(req, res);
    }
    const originalJson = res.json.bind(res);
    let pending = null;
    res.json = function deferredJson(body) {
      const send = () => originalJson(body);
      pending = pending
        ? pending.then(send)
        : flushPending(sql).catch((err) => console.error('Push flush (non-fatal):', err && err.message)).then(send);
      return res;
    };
    try {
      return await handler(req, res);
    } finally {
      if (pending) await pending;
    }
  };
}

module.exports = {
  PushError,
  vapidKeys,
  vapidAuthHeader,
  encryptPayload,
  validateSubscription,
  validateEndpoint,
  endpointHash,
  ensurePushSchema,
  listDevices,
  subscribe,
  unsubscribe,
  releaseIfOtherUser,
  sendTest,
  flushPending,
  pushCategory,
  withPush,
  setTransportForTests,
  resetKeyCacheForTests,
  b64url,
  fromB64url,
  MAX_DEVICES,
  FRESH_MINUTES,
};
