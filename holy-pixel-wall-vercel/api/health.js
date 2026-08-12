const { load, USE_UPSTASH, json, cors } = require('../lib/db');

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return json(res, 204, {});
  cors(res);
  try {
    const db = await load();
    return json(res, 200, {
      ok: true,
      regions: (db.regions || []).length,
      storage: USE_UPSTASH ? 'upstash-permanent' : 'none-set-upstash'
    });
  } catch (e) {
    return json(res, 500, { ok: false, error: e.message });
  }
};
