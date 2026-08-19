const {
  MIN, PERM_PIXEL_CAP, load, save, soldMap, permanentUsed, json, readBody, adminOk
} = require('../lib/db');
const crypto = require('crypto');
const MAX_MEDIA_CHARS = 900000;

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return json(res, 204, {});
  if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'POST only' });
  try {
    let data;
    try {
      data = JSON.parse((await readBody(req)) || '{}');
    } catch (e) {
      return json(res, 400, { ok: false, error: 'Invalid JSON (image may be too large)' });
    }
    const cells = data.cells || [];
    const adminCheck = adminOk(data.key || '');
    const isAdmin = !!adminCheck.ok;

    if (!isAdmin && cells.length < MIN) {
      return json(res, 400, { ok: false, error: 'Need ' + MIN + ' pixels minimum' });
    }
    if (isAdmin && !cells.length) {
      return json(res, 400, { ok: false, error: 'No cells selected' });
    }

    let media = data.media || '';
    if (media && media.length > MAX_MEDIA_CHARS) media = '';

    const db = await load();
    // Admin free claims skip permanent pixel cap
    if (!isAdmin && (data.duration || '') === 'permanent') {
      const used = permanentUsed(db);
      const left = Math.max(0, PERM_PIXEL_CAP - used);
      if (left <= 0) return json(res, 400, { ok: false, error: 'No permanent pixels left' });
      if (cells.length > left) return json(res, 400, { ok: false, error: 'Only ' + left + ' permanent left' });
    }
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

    const claimId = crypto.randomUUID();
    const claimAt = Date.now();
    db.regions = db.regions || [];
    db.history = db.history || [];
    db.regions.push({
      id: claimId,
      name: String(data.name || 'ANON').slice(0, 40),
      country: String(data.country || '').slice(0, 8),
      desc: String(data.desc || '').slice(0, 120),
      media,
      mediaType: media ? (data.mediaType || 'image') : 'none',
      fit: 'cover',
      cropScale: data.cropScale || 1,
      cropX: data.cropX != null ? data.cropX : 0.5,
      cropY: data.cropY != null ? data.cropY : 0.5,
      link: data.link || '',
      linkType: data.linkType || 'none',
      duration: data.duration || '1month',
      paid: isAdmin ? 0 : (data.paid || 0),
      freeAdmin: isAdmin || false,
      country: String(data.country || '').slice(0, 8),
      claimedAt: claimAt,
      cells, minC, maxC, minR, maxR,
      pixels: cells.length
    });
    db.history.push({
      id: claimId,
      name: String(data.name || 'ANON').slice(0, 40),
      country: String(data.country || '').slice(0, 8),
      pixels: cells.length,
      duration: data.duration || '1month',
      paid: isAdmin ? 0 : (data.paid || 0),
      freeAdmin: isAdmin || false,
      country: String(data.country || '').slice(0, 8),
      claimedAt: claimAt,
      event: isAdmin ? 'admin_claim' : 'claim'
    });
    if (db.history.length > 500) db.history = db.history.slice(-500);

    let ok = await save(db);
    if (!ok && media) {
      db.regions[db.regions.length - 1].media = '';
      db.regions[db.regions.length - 1].mediaType = 'none';
      ok = await save(db);
    }
    if (!ok) return json(res, 500, { ok: false, error: 'Save failed — check Upstash env vars' });
    return json(res, 201, { ok: true });
  } catch (e) {
    return json(res, 500, { ok: false, error: e.message });
  }
};
