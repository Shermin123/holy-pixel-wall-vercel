const crypto = require('crypto');

const MIN = 10;
const PERM_PIXEL_CAP = 1000;

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const USE_UPSTASH = !!(UPSTASH_URL && UPSTASH_TOKEN);

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
    const res = await fetch(UPSTASH_URL, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + UPSTASH_TOKEN,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(['SET', 'wall_data', val])
    });
    await res.json();
    return true;
  } catch (e) {
    console.error('Upstash save failed', e);
    return false;
  }
}

async function load() {
  if (!USE_UPSTASH) {
    // Vercel has no persistent disk — Upstash required for shared wall
    return { regions: [] };
  }
  return await upstashGet();
}

async function save(db) {
  if (!USE_UPSTASH) return false;
  return await upstashSet(db);
}

function expired(r) {
  if (!r || r.duration === 'permanent') return false;
  const MS_DAY = 86400000;
  let ms = MS_DAY * 30;
  if (r.duration === '3month') ms = MS_DAY * 90;
  if (r.duration === '6month') ms = MS_DAY * 182;
  if (r.duration === '1day') ms = MS_DAY;
  if (r.duration === 'daily') ms = MS_DAY * 10;
  return Date.now() - (r.claimedAt || 0) > ms;
}

function permanentUsed(db) {
  let n = 0;
  (db.regions || []).forEach(r => {
    if (!r || r.duration !== 'permanent' || expired(r)) return;
    n += (r.pixels || (r.cells && r.cells.length) || 0);
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

function priceUnit(d) {
  if (d === 'permanent') return 50;
  if (d === '6month') return 10;
  if (d === '3month') return 1;
  return 0.10; // 30 days
}

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
}

function json(res, code, obj) {
  cors(res);
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', d => chunks.push(d));
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}

function adminOk(key) {
  const ADMIN_KEY = process.env.ADMIN_KEY || '';
  if (!ADMIN_KEY) return { ok: false, error: 'Set ADMIN_KEY on Vercel first' };
  if (!key || key !== ADMIN_KEY) return { ok: false, error: 'Unauthorized' };
  return { ok: true };
}

module.exports = {
  MIN,
  PERM_PIXEL_CAP,
  USE_UPSTASH,
  load,
  save,
  expired,
  permanentUsed,
  soldMap,
  priceUnit,
  cors,
  json,
  readBody,
  adminOk,
  crypto
};
