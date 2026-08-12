const { save, json, readBody, adminOk } = require('../../lib/db');

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return json(res, 204, {});
  if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'POST only' });

  try {
    const data = JSON.parse((await readBody(req)) || '{}');
    const check = adminOk(data.key || '');
    if (!check.ok) return json(res, 401, check);
    if (data.confirm !== 'DELETE_ALL') {
      return json(res, 400, { ok: false, error: 'Send confirm: DELETE_ALL' });
    }
    const ok = await save({ regions: [] });
    if (!ok) return json(res, 500, { ok: false, error: 'Save failed' });
    return json(res, 200, { ok: true, remaining: 0 });
  } catch (e) {
    return json(res, 500, { ok: false, error: e.message });
  }
};
