const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const DB_FILE = path.join(ROOT, 'data', 'claims.json');
const MIN = 10;
const PERM_PIXEL_CAP = 1000;
const ADMIN_KEY = process.env.ADMIN_KEY || '';
const MAX_MEDIA_CHARS = 900000; // ~0.9MB base64 safety for Upstash

fs.mkdirSync(path.join(ROOT, 'data'), { recursive: true });

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const USE_UPSTASH = !!(UPSTASH_URL && UPSTASH_TOKEN);

console.log(
  'Storage:',
  USE_UPSTASH ? 'UPSTASH (PERMANENT FREE)' : 'FILE (WILL BE DELETED ON RENDER FREE)'
);

async function upstashGet() {
  try {
    const res = await fetch(UPSTASH_URL + '/get/wall_data', {
      headers: { Authorization: 'Bearer ' + UPSTASH_TOKEN }
    });
    const j = await res.json();
    if (!j.result) return { regions: [] };
    return JSON.parse(j.result);
  } catch (e) {
    console.error('Upstash get failed', e);
    return { regions: [] };
  }
}

async function upstashSet(db) {
  try {
    const val = JSON.stringify(db);
    if (val.length > 7_500_000) {
      console.error('Upstash payload too large', val.length);
      return false;
    }
    const res = await fetch(UPSTASH_URL, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + UPSTASH_TOKEN,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(['SET', 'wall_data', val])
    });
    const j = await res.json();
    console.log('Upstash saved', j, 'bytes', val.length);
    if (j && j.error) {
      console.error('Upstash error', j.error);
      return false;
    }
    return true;
  } catch (e) {
    console.error('Upstash save failed', e);
    return false;
  }
}

function fileLoad() {
  try {
    if (!fs.existsSync(DB_FILE)) return { regions: [] };
    return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch {
    return { regions: [] };
  }
}

function fileSave(db) {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
    return true;
  } catch {
    return false;
  }
}

async function load() {
  if (USE_UPSTASH) return await upstashGet();
  return fileLoad();
}

async function save(db) {
  if (USE_UPSTASH) {
    const ok = await upstashSet(db);
    fileSave(db);
    return ok;
  }
  return fileSave(db);
}

function expired(r) {
  if (!r || r.duration === 'permanent') return false;
  const MS_DAY = 86400000;
  let ms = MS_DAY * 182; // default ~6 months
  const d = String(r.duration || '').toLowerCase();
  if (d === '1year' || d === 'year' || d === '12month') ms = MS_DAY * 365;
  else if (d === '6month' || d === '6months') ms = MS_DAY * 182;
  else if (d === '3month') ms = MS_DAY * 90;
  else if (d === '1month') ms = MS_DAY * 30;
  else if (d === '1day') ms = MS_DAY;
  else if (d === 'daily') ms = MS_DAY * 10;
  return Date.now() - (r.claimedAt || 0) > ms;
}

function permanentUsed(db) {
  let n = 0;
  (db.regions || []).forEach(r => {
    if (!r || r.duration !== 'permanent' || expired(r)) return;
    n += r.pixels || (r.cells && r.cells.length) || 0;
  });
  return n;
}

function soldMap(db) {
  const m = new Map();
  db.regions = (db.regions || []).filter(r => !expired(r));
  for (const r of db.regions) {
    const cells = r.cells || [];
    if (cells.length) cells.forEach(k => m.set(k, r));
  }
  return m;
}

/** Must match frontend: 6month $0.50 · 1year $1 · permanent $10 */
function priceUnit(d) {
  const x = String(d || '6month').toLowerCase();
  if (x === 'permanent') return 10;
  if (x === '1year' || x === 'year' || x === '12month') return 1;
  if (x === '6month' || x === '6months') return 0.5;
  if (x === '3month' || x === '1month') return 0.5;
  return 0.5;
}

function json(res, code, obj) {
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS'
  });
  res.end(JSON.stringify(obj));
}

function body(req) {
  return new Promise((resolve, reject) => {
    const c = [];
    let size = 0;
    const LIMIT = 12 * 1024 * 1024; // 12MB
    req.on('data', d => {
      size += d.length;
      if (size > LIMIT) {
        reject(new Error('Body too large'));
        req.destroy();
        return;
      }
      c.push(d);
    });
    req.on('end', () => resolve(Buffer.concat(c).toString()));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return json(res, 204, {});

  const url = new URL(req.url, 'http://localhost:' + PORT);
  const p = url.pathname;

  try {
    if (p === '/api/health') {
      const db = await load();
      return json(res, 200, {
        ok: true,
        regions: (db.regions || []).length,
        storage: USE_UPSTASH ? 'upstash-permanent' : 'file-temp-will-delete'
      });
    }

    if (p === '/api/wall' && req.method === 'GET') {
      const db = await load();
      soldMap(db);
      return json(res, 200, { regions: db.regions });
    }

    if (p === '/api/checkout' && req.method === 'POST') {
      const key = process.env.STRIPE_SECRET_KEY || '';
      if (!key) return json(res, 400, { ok: false, error: 'Stripe not configured' });

      const data = JSON.parse((await body(req)) || '{}');
      const cells = data.cells || [];
      if (cells.length < MIN) {
        return json(res, 400, { ok: false, error: 'Need at least ' + MIN });
      }

      // Match UI default (6 months), not 1month
      const duration = data.duration || '6month';
      const db = await load();
      const map = soldMap(db);
      for (const k of cells) {
        if (map.has(k)) return json(res, 409, { ok: false, error: 'Already owned' });
      }

      if (duration === 'permanent') {
        const used = permanentUsed(db);
        const left = Math.max(0, PERM_PIXEL_CAP - used);
        if (left <= 0) {
          return json(res, 400, {
            ok: false,
            error: 'No permanent pixels left (limit ' + PERM_PIXEL_CAP + ')'
          });
        }
        if (cells.length > left) {
          return json(res, 400, {
            ok: false,
            error: 'Only ' + left + ' permanent pixels left'
          });
        }
      }

      const unit = priceUnit(duration);
      const totalCents = Math.round(cells.length * unit * 100);
      if (totalCents < 50) {
        return json(res, 400, {
          ok: false,
          error: 'Amount too small for Stripe (min $0.50)'
        });
      }

      const publicUrl = (process.env.PUBLIC_URL || 'https://www.holypixelwall.com').replace(
        /\/$/,
        ''
      );
      const unitLabel = unit.toFixed(2);
      const totalLabel = (totalCents / 100).toFixed(2);

      const params = new URLSearchParams();
      params.append('mode', 'payment');
      params.append(
        'success_url',
        publicUrl + '/?paid=1&session_id={CHECKOUT_SESSION_ID}'
      );
      params.append('cancel_url', publicUrl + '/?canceled=1');
      params.append('line_items[0][price_data][currency]', 'usd');
      params.append(
        'line_items[0][price_data][product_data][name]',
        cells.length + ' pixels × $' + unitLabel + ' = $' + totalLabel + ' (' + duration + ')'
      );
      // Total for the whole selection (quantity 1)
      params.append('line_items[0][price_data][unit_amount]', String(totalCents));
      params.append('line_items[0][quantity]', '1');
      params.append('metadata[pixels]', String(cells.length));
      params.append('metadata[duration]', duration);
      params.append('metadata[unit]', String(unit));

      const stripeRes = await fetch('https://api.stripe.com/v1/checkout/sessions', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + key,
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: params
      });
      const session = await stripeRes.json();
      if (!stripeRes.ok) {
        return json(res, 500, {
          ok: false,
          error: (session.error && session.error.message) || 'Stripe error'
        });
      }
      return json(res, 200, {
        ok: true,
        url: session.url,
        amount: totalCents / 100,
        unit,
        pixels: cells.length,
        duration
      });
    }

    if (p === '/api/claim' && req.method === 'POST') {
      let data;
      try {
        data = JSON.parse((await body(req)) || '{}');
      } catch (e) {
        return json(res, 400, {
          ok: false,
          error: 'Invalid JSON body (image may be too large)'
        });
      }

      const cells = data.cells || [];
      if (cells.length < MIN) {
        return json(res, 400, { ok: false, error: 'Need ' + MIN + ' pixels minimum' });
      }

      let media = data.media || '';
      if (media && media.length > MAX_MEDIA_CHARS) {
        console.warn('Media truncated', media.length);
        media = '';
      }

      const db = await load();
      if ((data.duration || '') === 'permanent') {
        const used = permanentUsed(db);
        const left = Math.max(0, PERM_PIXEL_CAP - used);
        if (left <= 0) {
          return json(res, 400, { ok: false, error: 'No permanent pixels left' });
        }
        if (cells.length > left) {
          return json(res, 400, {
            ok: false,
            error: 'Only ' + left + ' permanent pixels left'
          });
        }
      }

      const map = soldMap(db);
      for (const k of cells) {
        if (map.has(k)) {
          return json(res, 409, {
            ok: false,
            error: 'Some blocks already owned — payment received, contact support'
          });
        }
      }

      let minC = 1e9,
        maxC = -1,
        minR = 1e9,
        maxR = -1;
      cells.forEach(k => {
        const [c, r] = String(k).split(',').map(Number);
        if (!isFinite(c) || !isFinite(r)) return;
        minC = Math.min(minC, c);
        maxC = Math.max(maxC, c);
        minR = Math.min(minR, r);
        maxR = Math.max(maxR, r);
      });

      db.regions = db.regions || [];
      db.history = db.history || [];
      const claimId = crypto.randomUUID();
      const claimAt = Date.now();
      const duration = data.duration || '6month';
      const unit = priceUnit(duration);
      const paid =
        data.paid != null && Number(data.paid) > 0
          ? Number(data.paid)
          : Math.round(cells.length * unit * 100) / 100;

      const entry = {
        id: claimId,
        name: String(data.name || 'ANON').slice(0, 40),
        desc: String(data.desc || '').slice(0, 120),
        media: media,
        mediaType: media ? data.mediaType || 'image' : 'none',
        fit: 'cover',
        cropScale: data.cropScale || 1,
        cropX: data.cropX != null ? data.cropX : 0.5,
        cropY: data.cropY != null ? data.cropY : 0.5,
        link: data.link || '',
        linkType: data.linkType || 'none',
        duration,
        paid,
        claimedAt: claimAt,
        cells,
        minC,
        maxC,
        minR,
        maxR,
        pixels: cells.length
      };
      db.regions.push(entry);

      db.history.push({
        id: claimId,
        name: entry.name,
        pixels: cells.length,
        duration: entry.duration,
        paid: entry.paid || 0,
        claimedAt: claimAt,
        event: 'claim'
      });
      if (db.history.length > 500) db.history = db.history.slice(-500);

      let ok = await save(db);
      if (!ok && media) {
        db.regions[db.regions.length - 1].media = '';
        db.regions[db.regions.length - 1].mediaType = 'none';
        ok = await save(db);
      }
      if (!ok) {
        return json(res, 500, {
          ok: false,
          error: 'Save failed — check Upstash env vars'
        });
      }
      return json(res, 201, { ok: true });
    }

    function requireAdmin(data) {
      if (!ADMIN_KEY) return 'Set ADMIN_KEY env var first';
      const key = (data && data.key) || url.searchParams.get('key') || '';
      if (!key || key !== ADMIN_KEY) return 'Invalid admin key';
      return null;
    }

    if (p === '/api/admin/list' && req.method === 'GET') {
      if (!ADMIN_KEY || url.searchParams.get('key') !== ADMIN_KEY) {
        return json(res, 401, { ok: false, error: 'Unauthorized' });
      }
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
    }

    if (p === '/api/admin/create' && req.method === 'POST') {
      let data;
      try {
        data = JSON.parse((await body(req)) || '{}');
      } catch (e) {
        return json(res, 400, { ok: false, error: 'Invalid JSON' });
      }
      const err = requireAdmin(data);
      if (err) return json(res, 401, { ok: false, error: err });

      const cells = Array.isArray(data.cells) ? data.cells : [];
      if (cells.length < 1) {
        return json(res, 400, { ok: false, error: 'Select at least 1 pixel' });
      }

      let media = data.media || '';
      if (media.length > MAX_MEDIA_CHARS) {
        return json(res, 400, { ok: false, error: 'Image too large' });
      }

      const db = await load();
      const map = soldMap(db);
      for (const k of cells) {
        if (map.has(k)) {
          return json(res, 409, {
            ok: false,
            error: 'Some selected pixels are already occupied'
          });
        }
      }

      let minC = 1e9,
        maxC = -1,
        minR = 1e9,
        maxR = -1;
      cells.forEach(k => {
        const [c, r] = String(k).split(',').map(Number);
        if (!Number.isFinite(c) || !Number.isFinite(r)) return;
        minC = Math.min(minC, c);
        maxC = Math.max(maxC, c);
        minR = Math.min(minR, r);
        maxR = Math.max(maxR, r);
      });

      const claimId = crypto.randomUUID();
      const claimAt = Date.now();
      const entry = {
        id: claimId,
        name: String(data.name || 'OWNER').slice(0, 40),
        desc: String(data.desc || '').slice(0, 120),
        media: media,
        mediaType: media ? data.mediaType || 'image' : 'none',
        fit: data.fit || 'cover',
        cropScale: data.cropScale || 1,
        cropX: data.cropX != null ? data.cropX : 0.5,
        cropY: data.cropY != null ? data.cropY : 0.5,
        link: data.link || '',
        linkType: data.linkType || 'none',
        duration: data.duration || 'permanent',
        paid: 0,
        claimedAt: claimAt,
        cells,
        minC,
        maxC,
        minR,
        maxR,
        pixels: cells.length,
        ownerCreated: true
      };

      db.regions = db.regions || [];
      db.history = db.history || [];
      db.regions.push(entry);
      db.history.push({
        id: claimId,
        name: entry.name,
        pixels: cells.length,
        duration: entry.duration,
        paid: 0,
        claimedAt: claimAt,
        event: 'owner_create'
      });
      if (db.history.length > 500) db.history = db.history.slice(-500);

      const ok = await save(db);
      if (!ok) return json(res, 500, { ok: false, error: 'Save failed' });
      return json(res, 201, { ok: true, region: entry });
    }

    if (p === '/api/admin/delete' && req.method === 'POST') {
      const data = JSON.parse((await body(req)) || '{}');
      const err = requireAdmin(data);
      if (err) return json(res, 401, { ok: false, error: err });
      if (!data.id) return json(res, 400, { ok: false, error: 'Missing claim id' });

      const db = await load();
      const before = (db.regions || []).length;
      const removed = (db.regions || []).find(r => r.id === data.id);
      db.regions = (db.regions || []).filter(r => r.id !== data.id);
      if (db.regions.length === before) {
        return json(res, 404, { ok: false, error: 'Claim not found' });
      }

      db.history = db.history || [];
      if (removed) {
        db.history.push({
          id: removed.id,
          name: removed.name || 'ANON',
          pixels: removed.pixels || (removed.cells && removed.cells.length) || 0,
          duration: removed.duration,
          paid: removed.paid || 0,
          claimedAt: Date.now(),
          event: 'removed',
          originalClaimedAt: removed.claimedAt
        });
        if (db.history.length > 500) db.history = db.history.slice(-500);
      }

      const ok = await save(db);
      if (!ok) return json(res, 500, { ok: false, error: 'Save failed' });
      return json(res, 200, {
        ok: true,
        removed: data.id,
        remaining: db.regions.length
      });
    }

    if (p === '/api/admin/clear' && req.method === 'POST') {
      const data = JSON.parse((await body(req)) || '{}');
      const err = requireAdmin(data);
      if (err) return json(res, 401, { ok: false, error: err });
      if (data.confirm !== 'DELETE_ALL') {
        return json(res, 400, { ok: false, error: 'Send confirm: DELETE_ALL' });
      }
      const ok = await save({ regions: [] });
      if (!ok) return json(res, 500, { ok: false, error: 'Save failed' });
      return json(res, 200, { ok: true, remaining: 0 });
    }

    if (p === '/api/history' && req.method === 'GET') {
      const db = await load();
      const history = (db.history || []).slice().reverse();
      if (!history.length && db.regions && db.regions.length) {
        db.regions.forEach(r => {
          if (!r) return;
          history.push({
            id: r.id,
            name: r.name || 'ANON',
            pixels: r.pixels || (r.cells && r.cells.length) || 0,
            duration: r.duration,
            paid: r.paid || 0,
            claimedAt: r.claimedAt || 0,
            event: 'claim'
          });
        });
        history.sort((a, b) => (b.claimedAt || 0) - (a.claimedAt || 0));
      }
      return json(res, 200, { ok: true, history: history.slice(0, 200) });
    }

    let file = p === '/' ? '/index.html' : p;
    const full = path.join(ROOT, path.normalize(file));
    if (!full.startsWith(ROOT)) {
      res.writeHead(403);
      return res.end('no');
    }
    fs.readFile(full, (err, buf) => {
      if (err) {
        res.writeHead(404);
        return res.end('Not found');
      }
      const ext = path.extname(full);
      const types = {
        '.html': 'text/html; charset=utf-8',
        '.js': 'text/javascript',
        '.css': 'text/css'
      };
      res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream' });
      res.end(buf);
    });
  } catch (e) {
    console.error(e);
    json(res, 500, { ok: false, error: e.message });
  }
});

server.listen(PORT, () =>
  console.log(
    'Wall running on ' + PORT + ' with ' + (USE_UPSTASH ? 'PERMANENT STORAGE' : 'TEMP FILE')
  )
);