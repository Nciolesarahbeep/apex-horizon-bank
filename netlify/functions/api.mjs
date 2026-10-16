// Every /api/<name> request on Netlify lands here and runs the matching
// api/<name>.js file, unchanged, through the Vercel adapter.
//
// Adding a new file to api/? Add one line for it to ROUTES below.

import { readBody, createReqFromRequest, invoke } from '../vercel-adapter.mjs';

const ROUTES = {
  'account-services': () => import('../../api/account-services.js'),
  'admin': () => import('../../api/admin.js'),
  'auth-session': () => import('../../api/auth-session.js'),
  'bill-pay': () => import('../../api/bill-pay.js'),
  'external-banking': () => import('../../api/external-banking.js'),
  'me': () => import('../../api/me.js'),
  'password-reset': () => import('../../api/password-reset.js'),
  'signup': () => import('../../api/signup.js'),
  'transactions': () => import('../../api/transactions.js'),
  'transfer': () => import('../../api/transfer.js'),
  'webauthn-login': () => import('../../api/webauthn-login.js'),
  'webauthn-register': () => import('../../api/webauthn-register.js'),
};

export default async (request, context) => {
  const name = context && context.params ? context.params.name : '';
  const load = Object.hasOwn(ROUTES, name) ? ROUTES[name] : null;
  if (!load) return Response.json({ error: 'Not found' }, { status: 404 });

  let body;
  try {
    body = await readBody(request);
  } catch (err) {
    return Response.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const { default: handler } = await load();
  return invoke(handler, createReqFromRequest(request, context, body), context);
};

export const config = {
  path: '/api/:name',
};
