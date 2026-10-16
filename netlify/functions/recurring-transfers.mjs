// Runs the recurring-transfer processor once a day, replacing the Vercel cron
// in vercel.json. Same time as before: 13:00 UTC, which is 2pm in Lagos.

import { createReq, invoke } from '../vercel-adapter.mjs';

export default async () => {
  if (!process.env.CRON_SECRET) {
    console.error('CRON_SECRET is not set, so recurring transfers were skipped.');
    return;
  }

  const { default: handler } = await import('../../api/account-services.js');

  // api/account-services.js and lib/push.js recognise the daily run by the
  // "vercel-cron" user agent and the CRON_SECRET bearer token, so this sends
  // both, exactly as Vercel Cron did.
  const req = createReq({
    method: 'GET',
    url: '/api/account-services?resource=process-recurring',
    headers: {
      'user-agent': 'vercel-cron/1.0 (Netlify scheduled function)',
      'authorization': `Bearer ${process.env.CRON_SECRET}`,
    },
    ip: '127.0.0.1',
  });

  const response = await invoke(handler, req, null);
  console.log(`Recurring transfers: ${response.status} ${await response.text()}`);
};

export const config = {
  schedule: '0 13 * * *',
};
