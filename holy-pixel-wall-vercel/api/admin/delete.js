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
    const before = (db.regions || []).length;
    db.regions = (db.regions || []).filter(r => r.id !== data.id);
    if (db.regions.length === before) {
      return json(res, 404, { ok: false, error: 'Claim not found' });
    }
    const ok = await save(db);
    if (!ok) return json(res, 500, { ok: false, error: 'Save failed' });
    return json(res, 200, { ok: true, removed: data.id, remaining: db.regions.length });
  } catch (e) {
    return json(res, 500, { ok: false, error: e.message });
  }
};
