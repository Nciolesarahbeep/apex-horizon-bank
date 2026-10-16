// Lets the Vercel-style handlers in api/ run on Netlify without changing them.
//
// Vercel calls each api/*.js file as handler(req, res) and gives it helpers
// like req.body and res.status(200).json(...). Netlify functions get a web
// Request and must return a web Response instead. This file translates
// between the two, so the api/ and lib/ code stays exactly as it was.

// Vercel sets NODE_ENV=production for functions; Netlify doesn't. lib/auth.js,
// lib/webauthn.js and lib/deviceTrust.js only mark cookies Secure in
// production, so set it the same way here (but not under `netlify dev`).
if (!process.env.NODE_ENV && !process.env.NETLIFY_DEV) {
  process.env.NODE_ENV = 'production';
}

// Parses the body the way Vercel did: JSON (an empty JSON body becomes {}),
// form posts, plain text, or raw bytes. No Content-Type means no body.
// Throws on invalid JSON so the caller can answer 400, as Vercel did.
export async function readBody(request) {
  const contentType = request.headers.get('content-type');
  if (!contentType || request.method === 'GET' || request.method === 'HEAD') {
    return contentType && /json/i.test(contentType) ? {} : undefined;
  }
  const raw = Buffer.from(await request.arrayBuffer());
  const type = contentType.split(';')[0].trim().toLowerCase();
  if (type === 'application/json' || type.endsWith('+json')) {
    const text = raw.toString('utf8');
    return text ? JSON.parse(text) : {};
  }
  if (type === 'application/x-www-form-urlencoded') {
    return Object.fromEntries(new URLSearchParams(raw.toString('utf8')));
  }
  if (type === 'text/plain') return raw.toString('utf8');
  if (type === 'application/octet-stream') return raw;
  return undefined;
}

// A Node-style req like the one Vercel passed: method, url (path + query),
// lower-case headers, the parsed body, req.query and req.socket.remoteAddress.
export function createReq({ method = 'GET', url = '/', headers = {}, body, ip = null }) {
  const lowerHeaders = {};
  for (const [name, value] of Object.entries(headers)) lowerHeaders[name.toLowerCase()] = value;
  return {
    method: String(method).toUpperCase(),
    url,
    headers: lowerHeaders,
    body,
    get query() {
      const query = {};
      for (const [key, value] of new URL(url, 'http://localhost').searchParams) {
        query[key] = key in query ? [].concat(query[key], value) : value;
      }
      return query;
    },
    socket: { remoteAddress: ip },
    connection: { remoteAddress: ip },
  };
}

// Builds that req from a Netlify Request.
export function createReqFromRequest(request, context, body) {
  const url = new URL(request.url);
  const headers = {};
  for (const [name, value] of request.headers) {
    // On Vercel, x-vercel-* headers came from Vercel itself. On Netlify a
    // visitor could send them, so drop any that arrive and set the ones the
    // code reads from Netlify's own data below.
    if (!name.startsWith('x-vercel-')) headers[name] = value;
  }

  const ip = (context && context.ip) || null;
  // lib/rateLimit.js, lib/auth.js and lib/geoip.js take the first address in
  // x-forwarded-for. Netlify may keep whatever the visitor sent there, which
  // would let someone dodge the login rate limit, so use Netlify's own value.
  if (ip) headers['x-forwarded-for'] = ip;

  // lib/webauthn.js picks the Face ID address from the host the request came in on.
  headers.host = url.host;
  headers['x-forwarded-host'] = url.host;

  // api/auth-session.js shows sign-in locations like "Lagos, NG" from these.
  const geo = (context && context.geo) || {};
  if (geo.city) headers['x-vercel-ip-city'] = encodeURIComponent(geo.city);
  if (geo.country && geo.country.code) headers['x-vercel-ip-country'] = geo.country.code;

  return createReq({ method: request.method, url: url.pathname + url.search, headers, body, ip });
}

// A res with the Vercel helpers the handlers use: status(), json(), send(),
// setHeader()/getHeader() (including several Set-Cookie values) and end().
function createRes(method) {
  const headers = new Map();
  let body = null;
  let markFinished;
  const finished = new Promise((resolve) => { markFinished = resolve; });

  const res = {
    statusCode: 200,
    writableEnded: false,
    get headersSent() { return res.writableEnded; },
    status(code) { res.statusCode = Number(code); return res; },
    setHeader(name, value) { headers.set(String(name).toLowerCase(), value); return res; },
    getHeader(name) { return headers.get(String(name).toLowerCase()); },
    getHeaders() { return Object.fromEntries(headers); },
    hasHeader(name) { return headers.has(String(name).toLowerCase()); },
    removeHeader(name) { headers.delete(String(name).toLowerCase()); return res; },
    json(data) {
      if (!res.hasHeader('content-type')) res.setHeader('Content-Type', 'application/json; charset=utf-8');
      return res.end(JSON.stringify(data));
    },
    send(data) {
      if (data === undefined || data === null) return res.end();
      if (data instanceof Uint8Array) {
        if (!res.hasHeader('content-type')) res.setHeader('Content-Type', 'application/octet-stream');
        return res.end(data);
      }
      if (typeof data === 'object') return res.json(data);
      if (!res.hasHeader('content-type')) res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.end(String(data));
    },
    end(chunk) {
      if (res.writableEnded) return res;
      if (chunk !== undefined && chunk !== null && typeof chunk !== 'function') body = chunk;
      res.writableEnded = true;
      markFinished();
      return res;
    },
  };

  function toResponse() {
    const out = new Headers();
    for (const [name, value] of headers) {
      for (const v of [].concat(value)) out.append(name, String(v));
    }
    // vercel.json added these to every response; Netlify's [[headers]] rules
    // only cover static files, so function responses get them here.
    if (!out.has('x-content-type-options')) out.set('X-Content-Type-Options', 'nosniff');
    if (!out.has('x-frame-options')) out.set('X-Frame-Options', 'DENY');
    const status = res.statusCode;
    const noBody = method === 'HEAD' || status === 204 || status === 304;
    return new Response(noBody ? null : body, { status, headers: out });
  }

  return { res, finished, toResponse };
}

function serverError() {
  return Response.json({ error: 'Internal server error' }, { status: 500 });
}

// Runs a Vercel handler and returns its answer as a Response. Like Vercel, it
// answers as soon as the handler responds; anything the handler still does
// after that keeps running in the background instead of being cut off.
export async function invoke(handler, req, context) {
  const { res, finished, toResponse } = createRes(req.method);
  const work = (async () => handler(req, res))();

  const outcome = await Promise.race([
    finished.then(() => ({ sent: true })),
    work.then(() => ({ done: true }), (error) => ({ error })),
  ]);

  if (outcome.error) {
    console.error(`${req.method} ${req.url} failed:`, outcome.error);
    return res.writableEnded ? toResponse() : serverError();
  }
  if (!res.writableEnded) {
    console.error(`${req.method} ${req.url} finished without sending a response`);
    return serverError();
  }
  if (outcome.sent) {
    const rest = work.catch((error) => console.error(`${req.method} ${req.url} failed after responding:`, error));
    if (context && typeof context.waitUntil === 'function') context.waitUntil(rest);
  }
  return toResponse();
}
