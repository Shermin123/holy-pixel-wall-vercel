const {
  MIN, PERM_PIXEL_CAP, load, save, soldMap, permanentUsed, json, readBody, crypto
} = require('../lib/db');

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return json(res, 204, {});
  if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'POST only' });

  try {
    const data = JSON.parse((await readBody(req)) || '{}');
    const cells = data.cells || [];
    if (cells.length < MIN) {
      return json(res, 400, { ok: false, error: 'Need at least ' + MIN + ' pixels' });
    }

    const db = await load();
    if ((data.duration || '') === 'permanent') {
      const used = permanentUsed(db);
      const left = Math.max(0, PERM_PIXEL_CAP - used);
      if (left <= 0) {
        return json(res, 400, { ok: false, error: 'No permanent pixels left (limit ' + PERM_PIXEL_CAP + ')' });
      }
      if (cells.length > left) {
        return json(res, 400, { ok: false, error: 'Only ' + left + ' permanent pixels left' });
      }
    }

    const map = soldMap(db);
    for (const k of cells) {
      if (map.has(k)) return json(res, 409, { ok: false, error: 'Blocks owned' });
    }

    let minC = 1e9, maxC = -1, minR = 1e9, maxR = -1;
    cells.forEach(k => {
      const [c, r] = k.split(',').map(Number);
      minC = Math.min(minC, c);
      maxC = Math.max(maxC, c);
      minR = Math.min(minR, r);
      maxR = Math.max(maxR, r);
    });

    db.regions = db.regions || [];
    db.regions.push({
      id: crypto.randomUUID(),
      name: String(data.name || 'ANON').slice(0, 40),
      desc: String(data.desc || '').slice(0, 120),
      media: data.media || '',
      mediaType: data.mediaType || 'image',
      fit: 'cover',
      cropScale: data.cropScale || 1,
      cropX: data.cropX != null ? data.cropX : 0.5,
      cropY: data.cropY != null ? data.cropY : 0.5,
      link: data.link || '',
      linkType: data.linkType || 'none',
      duration: data.duration || '1month',
      paid: data.paid || 0,
      claimedAt: Date.now(),
      cells,
      minC,
      maxC,
      minR,
      maxR,
      pixels: cells.length
    });

    const ok = await save(db);
    if (!ok) {
      return json(res, 500, {
        ok: false,
        error: 'Save failed — set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN on Vercel'
      });
    }
    return json(res, 201, { ok: true });
  } catch (e) {
    return json(res, 500, { ok: false, error: e.message });
  }
};
