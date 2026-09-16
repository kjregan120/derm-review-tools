// Cloudflare Worker: holds real Twilio credentials server-side and exposes a
// single /send-sms endpoint the static site can call. The browser only ever
// sees APP_PASSWORD (a shared secret), never the Twilio Account SID/Auth Token.
//
// Required secrets (set with `wrangler secret put <NAME>`):
//   TWILIO_ACCOUNT_SID
//   TWILIO_AUTH_TOKEN
//   TWILIO_FROM_NUMBER   e.g. +12035551234
//   APP_PASSWORD         shared password the front end sends; must match Settings.json's smsWorker.password
//
// Non-secret config (set in wrangler.toml [vars]):
//   ALLOWED_ORIGIN        e.g. https://yourname.github.io

const MAX_BODY_LEN = 480; // a few SMS segments' worth

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function json(obj, status, origin) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
  });
}

export default {
  async fetch(request, env) {
    const origin = env.ALLOWED_ORIGIN || '*';

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders(origin) });
    }
    if (request.method !== 'POST') {
      return json({ error: 'Method not allowed' }, 405, origin);
    }

    let payload;
    try {
      payload = await request.json();
    } catch {
      return json({ error: 'Invalid JSON body' }, 400, origin);
    }

    const { password, to, body } = payload || {};

    if (!env.APP_PASSWORD || password !== env.APP_PASSWORD) {
      return json({ error: 'Unauthorized' }, 401, origin);
    }
    if (!to || !body) {
      return json({ error: 'Missing "to" or "body"' }, 400, origin);
    }
    if (!/^\+1\d{10}$/.test(to)) {
      return json({ error: 'Phone must be E.164, e.g. +12035551234' }, 400, origin);
    }
    if (typeof body !== 'string' || body.length === 0 || body.length > MAX_BODY_LEN) {
      return json({ error: `Message body must be 1-${MAX_BODY_LEN} characters` }, 400, origin);
    }

    const creds = btoa(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`);
    const form = new URLSearchParams({ To: to, From: env.TWILIO_FROM_NUMBER, Body: body });

    const twilioRes = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Messages.json`,
      {
        method: 'POST',
        headers: {
          Authorization: `Basic ${creds}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: form.toString(),
      }
    );

    const data = await twilioRes.json();
    if (!twilioRes.ok) {
      return json({ error: data.message || 'Twilio rejected the message' }, twilioRes.status, origin);
    }

    return json({ ok: true, sid: data.sid, status: data.status }, 200, origin);
  },
};
