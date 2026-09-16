// Cloudflare Worker: holds real SMS-provider credentials server-side and exposes
// a single /send-sms endpoint the static site can call. The browser only ever
// sees APP_PASSWORD (a shared secret), never the provider's real credentials.
//
// Provider is chosen with the SMS_PROVIDER var (wrangler.toml [vars]): "twilio" or "textbelt".
//
// Secrets (set with `wrangler secret put <NAME>`):
//   APP_PASSWORD         shared password the front end sends; must match Settings.json's smsWorker.password
//   TWILIO_ACCOUNT_SID   only needed when SMS_PROVIDER = "twilio"
//   TWILIO_AUTH_TOKEN    only needed when SMS_PROVIDER = "twilio"
//   TWILIO_FROM_NUMBER   only needed when SMS_PROVIDER = "twilio", e.g. +12035551234
//   TEXTBELT_KEY         only needed when SMS_PROVIDER = "textbelt"; "textbelt" itself
//                        is a shared free test key (1 send/day, no signup) — fine for a
//                        one-off demo, buy a real key at textbelt.com/purchase for anything more.
//
// Non-secret config (set in wrangler.toml [vars]):
//   ALLOWED_ORIGIN        e.g. https://yourname.github.io
//   SMS_PROVIDER          "twilio" or "textbelt"

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

async function sendViaTwilio(to, body, env) {
  const creds = btoa(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`);
  const form = new URLSearchParams({ To: to, From: env.TWILIO_FROM_NUMBER, Body: body });

  const res = await fetch(
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

  const data = await res.json();
  if (!res.ok) {
    return { ok: false, status: res.status, error: data.message || 'Twilio rejected the message' };
  }
  return { ok: true, status: 200, result: { sid: data.sid, status: data.status } };
}

async function sendViaTextbelt(to, body, env) {
  const form = new URLSearchParams({ phone: to, message: body, key: env.TEXTBELT_KEY || 'textbelt' });

  const res = await fetch('https://textbelt.com/text', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  });

  const data = await res.json();
  if (!data.success) {
    return { ok: false, status: 502, error: data.error || 'Textbelt rejected the message' };
  }
  return { ok: true, status: 200, result: { textId: data.textId, quotaRemaining: data.quotaRemaining } };
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

    const provider = env.SMS_PROVIDER || 'twilio';
    const result =
      provider === 'textbelt' ? await sendViaTextbelt(to, body, env) : await sendViaTwilio(to, body, env);

    if (!result.ok) {
      return json({ error: result.error }, result.status, origin);
    }
    return json({ ok: true, ...result.result }, 200, origin);
  },
};
