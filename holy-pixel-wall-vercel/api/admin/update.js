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
    const idx = (db.regions || []).findIndex(
      r => r && (r.id === data.id || r.claimId === data.id)
    );
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
    if (data.mediaType != null && data.media == null) {
      r.mediaType = String(data.mediaType);
    }
    if (data.fit != null) r.fit = data.fit;
    if (data.cropScale != null) r.cropScale = Number(data.cropScale);
    if (data.cropX != null) r.cropX = Number(data.cropX);
    if (data.cropY != null) r.cropY = Number(data.cropY);
    if (data.removeMedia) {
      r.media = '';
      r.mediaType = 'none';
    }

    // --- RESIZE: persist new geometry (this was missing) ---
    if (Array.isArray(data.cells) && data.cells.length > 0) {
      const cells = data.cells.map(String);
      let minC = Infinity, maxC = -Infinity, minR = Infinity, maxR = -Infinity;
      for (const k of cells) {
        const p = String(k).split(',');
        const c = Number(p[0]), row = Number(p[1]);
        if (!Number.isFinite(c) || !Number.isFinite(row)) continue;
        if (c < minC) minC = c;
        if (c > maxC) maxC = c;
        if (row < minR) minR = row;
        if (row > maxR) maxR = row;
      }
      if (Number.isFinite(minC)) {
        r.cells = cells;
        r.minC = data.minC != null ? Number(data.minC) : minC;
        r.maxC = data.maxC != null ? Number(data.maxC) : maxC;
        r.minR = data.minR != null ? Number(data.minR) : minR;
        r.maxR = data.maxR != null ? Number(data.maxR) : maxR;
        r.pixels = data.pixels != null ? Number(data.pixels) : cells.length;
      }
    } else if (
      data.minC != null && data.maxC != null &&
      data.minR != null && data.maxR != null
    ) {
      const minC = Number(data.minC);
      const maxC = Number(data.maxC);
      const minR = Number(data.minR);
      const maxR = Number(data.maxR);
      if (
        Number.isFinite(minC) && Number.isFinite(maxC) &&
        Number.isFinite(minR) && Number.isFinite(maxR) &&
        maxC >= minC && maxR >= minR
      ) {
        const cells = [];
        for (let c = minC; c <= maxC; c++) {
          for (let row = minR; row <= maxR; row++) {
            cells.push(c + ',' + row);
          }
        }
        r.cells = cells;
        r.minC = minC;
        r.maxC = maxC;
        r.minR = minR;
        r.maxR = maxR;
        r.pixels = cells.length;
      }
    }

    r.updatedAt = Date.now();
    r.updatedBy = 'admin';
    db.regions[idx] = r;

    const ok = await save(db);
    if (!ok) return json(res, 500, { ok: false, error: 'Save failed' });

    return json(res, 200, {
      ok: true,
      region: {
        id: r.id,
        name: r.name,
        desc: r.desc,
        link: r.link,
        duration: r.duration,
        mediaType: r.mediaType,
        hasMedia: !!(r.media && r.media.length),
        minC: r.minC,
        maxC: r.maxC,
        minR: r.minR,
        maxR: r.maxR,
        pixels: r.pixels,
        cells: r.cells
      }
    });
  } catch (e) {
    return json(res, 500, { ok: false, error: e.message });
  }
};