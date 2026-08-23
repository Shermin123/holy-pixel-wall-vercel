const {
  MIN, PERM_PIXEL_CAP, load, soldMap, permanentUsed, json, readBody
} = require('../lib/db');

/** Must match frontend price() / priceQuote() */
function unitPriceFor(duration) {
  const d = String(duration || '6month').toLowerCase();
  if (d === 'permanent') return 10;
  if (d === '1year' || d === 'year' || d === '12month') return 1;
  if (d === '6month' || d === '6months' || d === '3month' || d === '1month') return 0.5;
  return 0.5; // default = 6-month rate
}

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return json(res, 204, {});
  if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'POST only' });

  try {
    const key = process.env.STRIPE_SECRET_KEY || '';
    if (!key) return json(res, 400, { ok: false, error: 'Stripe not configured' });

    const data = JSON.parse((await readBody(req)) || '{}');
    const cells = Array.isArray(data.cells) ? data.cells : [];
    if (cells.length < MIN) {
      return json(res, 400, { ok: false, error: 'Need at least ' + MIN + ' pixels' });
    }

    const duration = data.duration || '6month'; // match UI default (not 1month)
    const db = await load();
    const map = soldMap(db);

    for (const k of cells) {
      if (map.has(k)) return json(res, 409, { ok: false, error: 'Already owned' });
    }

    if (duration === 'permanent') {
      const used = permanentUsed(db);
      const left = Math.max(0, PERM_PIXEL_CAP - used);
      if (left <= 0) {
        return json(res, 400, { ok: false, error: 'No permanent pixels left (limit ' + PERM_PIXEL_CAP + ')' });
      }
      if (cells.length > left) {
        return json(res, 400, { ok: false, error: 'Only ' + left + ' permanent pixels left' });
      }
    }

    const unit = unitPriceFor(duration);
    const totalCents = Math.round(cells.length * unit * 100);

    // Optional: reject if client sent a mismatched amount (tamper check)
    if (data.amountCents != null && Math.abs(Number(data.amountCents) - totalCents) > 1) {
      return json(res, 400, {
        ok: false,
        error: 'Price mismatch — refresh and try again'
      });
    }

    if (totalCents < 50) {
      return json(res, 400, { ok: false, error: 'Amount too small for Stripe (min $0.50)' });
    }

    let publicUrl = process.env.PUBLIC_URL || '';
    if (!publicUrl && process.env.VERCEL_URL) publicUrl = 'https://' + process.env.VERCEL_URL;
    if (!publicUrl) publicUrl = 'https://www.holypixelwall.com';
    publicUrl = publicUrl.replace(/\/$/, '');

    const label =
      'Holy Pixel Wall — ' +
      cells.length +
      ' px × $' +
      unit.toFixed(2) +
      ' (' +
      duration +
      ')';

    const params = new URLSearchParams();
    params.append('mode', 'payment');
    params.append('success_url', publicUrl + '/?paid=1&session_id={CHECKOUT_SESSION_ID}');
    params.append('cancel_url', publicUrl + '/?canceled=1');
    params.append('line_items[0][price_data][currency]', 'usd');
    params.append('line_items[0][price_data][product_data][name]', label);
    // Total charge for the whole selection (quantity 1)
    params.append('line_items[0][price_data][unit_amount]', String(totalCents));
    params.append('line_items[0][quantity]', '1');
    params.append('metadata[pixels]', String(cells.length));
    params.append('metadata[duration]', duration);
    params.append('metadata[unit]', String(unit));

    const stripeRes = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + key,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: params
    });

    const session = await stripeRes.json();
    if (!stripeRes.ok) {
      return json(res, 500, {
        ok: false,
        error: (session.error && session.error.message) || 'Stripe error'
      });
    }

    return json(res, 200, {
      ok: true,
      url: session.url,
      amount: totalCents / 100,
      unit,
      pixels: cells.length,
      duration
    });
  } catch (e) {
    return json(res, 500, { ok: false, error: e.message });
  }
};