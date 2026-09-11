const {
  MIN,
  PERM_PIXEL_CAP,
  load,
  save,
  soldMap,
  permanentUsed,
  json,
  readBody,
  adminOk
} = require('../lib/db');

const crypto = require('crypto');

// Do NOT silently delete large images.
// This is only a safety limit for the current Base64 architecture.
// The long-term solution is image storage outside Redis.
const MAX_MEDIA_CHARS = 8500000;

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') {
    return json(res, 204, {});
  }

  if (req.method !== 'POST') {
    return json(res, 405, {
      ok: false,
      error: 'POST only'
    });
  }

  try {
    let data;

    try {
      const rawBody = await readBody(req);

      data = JSON.parse(rawBody || '{}');
    } catch (e) {
      console.error('Claim JSON parse failed:', e);

      return json(res, 400, {
        ok: false,
        error: 'Invalid JSON or request is too large'
      });
    }

    const cells = Array.isArray(data.cells)
      ? data.cells
      : [];

    const adminCheck = adminOk(data.key || '');
    const isAdmin = !!adminCheck.ok;

    // Normal users need minimum pixels.
    if (!isAdmin && cells.length < MIN) {
      return json(res, 400, {
        ok: false,
        error: 'Need ' + MIN + ' pixels minimum'
      });
    }

    // Admin still needs at least one cell.
    if (isAdmin && !cells.length) {
      return json(res, 400, {
        ok: false,
        error: 'No cells selected'
      });
    }

    /*
      IMPORTANT:
      Keep the original image exactly as received.

      Do NOT:
      - resize it
      - convert it to JPEG
      - lower its quality
      - remove it because it is large
    */

    const media = typeof data.media === 'string'
      ? data.media
      : '';

    if (media && media.length > MAX_MEDIA_CHARS) {
      return json(res, 413, {
        ok: false,
        error:
          'Image is too large for the current database system. ' +
          'The original image was NOT compressed or deleted. ' +
          'Use a smaller file or move image storage to object storage.'
      });
    }

    const db = await load();

    /*
      Permanent pixel limit
    */
    if (
      !isAdmin &&
      (data.duration || '') === 'permanent'
    ) {
      const used = permanentUsed(db);

      const left = Math.max(
        0,
        PERM_PIXEL_CAP - used
      );

      if (left <= 0) {
        return json(res, 400, {
          ok: false,
          error: 'No permanent pixels left'
        });
      }

      if (cells.length > left) {
        return json(res, 400, {
          ok: false,
          error:
            'Only ' +
            left +
            ' permanent pixels left'
        });
      }
    }

    /*
      Check whether any selected pixels
      have already been claimed.
    */
    const map = soldMap(db);

    for (const k of cells) {
      if (map.has(k)) {
        return json(res, 409, {
          ok: false,
          error: 'Some blocks already owned'
        });
      }
    }

    /*
      Calculate bounding box
    */
    let minC = Infinity;
    let maxC = -Infinity;
    let minR = Infinity;
    let maxR = -Infinity;

    cells.forEach(k => {
      const parts = String(k)
        .split(',')
        .map(Number);

      const c = parts[0];
      const r = parts[1];

      if (!Number.isFinite(c) || !Number.isFinite(r)) {
        return;
      }

      minC = Math.min(minC, c);
      maxC = Math.max(maxC, c);

      minR = Math.min(minR, r);
      maxR = Math.max(maxR, r);
    });

    /*
      Create claim
    */
    const claimId = crypto.randomUUID();
    const claimAt = Date.now();

    db.regions = db.regions || [];
    db.history = db.history || [];

    const region = {
      id: claimId,

      name: String(
        data.name || 'ANON'
      ).slice(0, 40),

      country: String(
        data.country || ''
      ).slice(0, 8),

      desc: String(
        data.desc || ''
      ).slice(0, 120),

      /*
        ORIGINAL MEDIA
        No compression.
        No resizing.
        No conversion.
      */
      media,

      mediaType: media
        ? (data.mediaType || 'image')
        : 'none',

      fit: 'cover',

      cropScale:
        Number(data.cropScale) || 1,

      cropX:
        data.cropX != null
          ? Number(data.cropX)
          : 0.5,

      cropY:
        data.cropY != null
          ? Number(data.cropY)
          : 0.5,

      link:
        typeof data.link === 'string'
          ? data.link
          : '',

      linkType:
        data.linkType || 'none',

      duration:
        data.duration || '1month',

      paid:
        isAdmin
          ? 0
          : (Number(data.paid) || 0),

      freeAdmin:
        isAdmin || false,

      claimedAt: claimAt,

      cells,

      minC,
      maxC,
      minR,
      maxR,

      pixels: cells.length
    };

    db.regions.push(region);

    /*
      History entry
    */
    db.history.push({
      id: claimId,

      name: String(
        data.name || 'ANON'
      ).slice(0, 40),

      country: String(
        data.country || ''
      ).slice(0, 8),

      pixels: cells.length,

      duration:
        data.duration || '1month',

      paid:
        isAdmin
          ? 0
          : (Number(data.paid) || 0),

      freeAdmin:
        isAdmin || false,

      claimedAt: claimAt,

      event:
        isAdmin
          ? 'admin_claim'
          : 'claim'
    });

    /*
      Keep only latest 500 history records.
    */
    if (db.history.length > 500) {
      db.history =
        db.history.slice(-500);
    }

    /*
      SAVE EXACTLY WHAT WE RECEIVED.

      IMPORTANT:
      We no longer remove the image if saving
      fails. Losing the image silently is what
      caused claims to appear without their
      uploaded media.
    */
    const ok = await save(db);

    if (!ok) {
      return json(res, 500, {
        ok: false,
        error:
          'Save failed. The claim was NOT saved. ' +
          'Check your Upstash environment variables ' +
          'or database size/request limits.'
      });
    }

    return json(res, 201, {
      ok: true,
      id: claimId
    });

  } catch (e) {
    console.error('Claim failed:', e);

    return json(res, 500, {
      ok: false,
      error: e.message || 'Claim failed'
    });
  }
};