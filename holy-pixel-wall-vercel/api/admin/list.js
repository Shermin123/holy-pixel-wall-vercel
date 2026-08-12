const { load, soldMap, json, adminOk } = require('../../lib/db');

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return json(res, 204, {});
  if (req.method !== 'GET') return json(res, 405, { ok: false, error: 'GET only' });

  try {
    const url = new URL(req.url, 'http://localhost');
    const check = adminOk(url.searchParams.get('key') || '');
    if (!check.ok) return json(res, 401, check);

    const db = await load();
    soldMap(db);
    const list = (db.regions || []).map(r => ({
      id: r.id,
      name: r.name,
      desc: r.desc,
      pixels: r.pixels || (r.cells && r.cells.length) || 0,
      duration: r.duration,
      paid: r.paid,
      link: r.link,
      mediaType: r.mediaType,
      hasMedia: !!(r.media && r.media.length),
      claimedAt: r.claimedAt,
      minC: r.minC,
      maxC: r.maxC,
      minR: r.minR,
      maxR: r.maxR
    }));
    return json(res, 200, { ok: true, count: list.length, regions: list });
  } catch (e) {
    return json(res, 500, { ok: false, error: e.message });
  }
};
