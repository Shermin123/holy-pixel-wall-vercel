const { load, save, soldMap, json, readBody, adminOk } = require('../../lib/db');
const crypto = require('crypto');

const MIN = 1; // admin can place small blocks

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return json(res, 204, {});
  if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'POST only' });

  try {
    const data = JSON.parse((await readBody(req)) || '{}');
    const check = adminOk(data.key || '');
    if (!check.ok) return json(res, 401, check);

    const cells = data.cells || [];
    if (!cells.length) return json(res, 400, { ok: false, error: 'No cells' });

    const db = await load();
    const map = soldMap(db);
    for (const k of cells) {
      if (map.has(k)) return json(res, 409, { ok: false, error: 'Some blocks already owned' });
    }

    let minC = 1e9, maxC = -1, minR = 1e9, maxR = -1;
    cells.forEach(k => {
      const [c, r] = String(k).split(',').map(Number);
      if (!isFinite(c) || !isFinite(r)) return;
      minC = Math.min(minC, c); maxC = Math.max(maxC, c);
      minR = Math.min(minR, r); maxR = Math.max(maxR, r);
    });

    db.regions = db.regions || [];
    db.history = db.history || [];
    const claimId = crypto.randomUUID();
    const claimAt = Date.now();
    const entry = {
      id: claimId,
      name: String(data.name || 'ADMIN').slice(0, 40),
      desc: String(data.desc || '').slice(0, 120),
      media: data.media || '',
      mediaType: data.media ? (data.mediaType || 'image') : 'none',
      fit: data.fit || 'cover',
      cropScale: data.cropScale || 1,
      cropX: data.cropX != null ? data.cropX : 0.5,
      cropY: data.cropY != null ? data.cropY : 0.5,
      link: data.link || '',
      linkType: data.linkType || 'none',
      duration: data.duration || 'permanent',
      paid: 0,
      freeAdmin: true,
      claimedAt: claimAt,
      cells, minC, maxC, minR, maxR,
      pixels: cells.length
    };
    db.regions.push(entry);
    db.history.push({
      id: claimId,
      name: entry.name,
      pixels: cells.length,
      duration: entry.duration,
      paid: 0,
      claimedAt: claimAt,
      event: 'admin_claim'
    });
    if (db.history.length > 500) db.history = db.history.slice(-500);

    const ok = await save(db);
    if (!ok) return json(res, 500, { ok: false, error: 'Save failed' });
    return json(res, 201, { ok: true, region: { id: claimId, pixels: cells.length } });
  } catch (e) {
    return json(res, 500, { ok: false, error: e.message });
  }
};
