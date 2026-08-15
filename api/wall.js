const { load, soldMap, json, cors } = require('../lib/db');

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return json(res, 204, {});
  if (req.method !== 'GET') return json(res, 405, { ok: false, error: 'GET only' });
  try {
    const db = await load();
    soldMap(db);
    return json(res, 200, { regions: db.regions || [] });
  } catch (e) {
    return json(res, 500, { ok: false, error: e.message });
  }
};
