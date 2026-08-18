const { load, save, json, readBody, adminOk } = require('../../lib/db');

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return json(res, 204, {});
  if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'POST only' });

  try {
    const data = JSON.parse((await readBody(req)) || '{}');
    const check = adminOk(data.key || '');
    if (!check.ok) return json(res, 401, check);
    if (!data.id) return json(res, 400, { ok: false, error: 'Missing claim id' });

    const db = await load();
    const idx = (db.regions || []).findIndex(r => r && r.id === data.id);
    if (idx < 0) return json(res, 404, { ok: false, error: 'Claim not found' });

    const r = db.regions[idx];
    if (data.name != null) r.name = String(data.name).slice(0, 40);
    if (data.desc != null) r.desc = String(data.desc).slice(0, 120);
    if (data.link != null) r.link = String(data.link).slice(0, 500);
    if (data.linkType != null) r.linkType = String(data.linkType).slice(0, 40);
    if (data.duration != null) r.duration = String(data.duration);
    if (data.media != null) {
      r.media = data.media;
      r.mediaType = data.mediaType || (data.media ? 'image' : 'none');
    }
    if (data.fit != null) r.fit = data.fit;
    if (data.cropScale != null) r.cropScale = data.cropScale;
    if (data.cropX != null) r.cropX = data.cropX;
    if (data.cropY != null) r.cropY = data.cropY;
    if (data.removeMedia) {
      r.media = '';
      r.mediaType = 'none';
    }
    r.updatedAt = Date.now();
    r.updatedBy = 'admin';

    db.regions[idx] = r;
    const ok = await save(db);
    if (!ok) return json(res, 500, { ok: false, error: 'Save failed' });
    return json(res, 200, { ok: true, region: {
      id: r.id, name: r.name, desc: r.desc, link: r.link,
      duration: r.duration, mediaType: r.mediaType,
      hasMedia: !!(r.media && r.media.length)
    }});
  } catch (e) {
    return json(res, 500, { ok: false, error: e.message });
  }
};
