// Letterboxd import: read the export (the .zip from letterboxd.com/settings/data, or its CSV files)
// and match the movies to the ones on this site by title and year.

// ---------- a tiny unzip (stored and deflated files), using the browser's own decompressor ----------
async function inflateRaw(bytes) {
  const ds = new DecompressionStream('deflate-raw');
  const out = new Response(new Blob([bytes]).stream().pipeThrough(ds));
  return new Uint8Array(await out.arrayBuffer());
}
export async function unzip(buf) {
  const u8 = new Uint8Array(buf), dv = new DataView(buf);
  // find the end-of-central-directory record (it sits in the last 64 KB)
  let eocd = -1;
  for (let i = u8.length - 22; i >= Math.max(0, u8.length - 65557); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('That isn\'t a zip file.');
  const n = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const files = {};
  const dec = new TextDecoder();
  for (let k = 0; k < n; k++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const method = dv.getUint16(p + 10, true), csize = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true), extraLen = dv.getUint16(p + 30, true), commentLen = dv.getUint16(p + 32, true);
    const local = dv.getUint32(p + 42, true);
    const name = dec.decode(u8.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/') || !/\.csv$/i.test(name)) continue;
    const start = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);
    const data = u8.subarray(start, start + csize);
    if (method === 0) files[name] = dec.decode(data);
    else if (method === 8) files[name] = dec.decode(await inflateRaw(data));
  }
  return files;
}

// ---------- CSV ----------
export function parseCSV(text) {
  const rows = []; let row = [], cur = '', q = false;
  text = text.replace(/^﻿/, '');
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cur); rows.push(row); row = []; cur = ''; }
    else cur += c;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  const head = (rows.shift() || []).map((h) => h.trim());
  return rows.filter((r) => r.some((x) => x.trim())).map((r) => Object.fromEntries(head.map((h, i) => [h, (r[i] ?? '').trim()])));
}

// ---------- matching ----------
export const normTitle = (t) => String(t || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .replace(/&/g, ' and ').replace(/^(the|a|an)\s+/, '').replace(/[^a-z0-9]+/g, ' ').trim();

// files: { 'watched.csv': text, ... } (any folder). Returns what was found and how it matched.
export function readExport(files, movies) {
  const pick = (name) => Object.entries(files).find(([k]) => k.split('/').pop().toLowerCase() === name)?.[1];
  const watched = pick('watched.csv') ? parseCSV(pick('watched.csv')) : [];
  const ratings = pick('ratings.csv') ? parseCSV(pick('ratings.csv')) : [];
  const diary = pick('diary.csv') ? parseCSV(pick('diary.csv')) : [];
  const watchlist = pick('watchlist.csv') ? parseCSV(pick('watchlist.csv')) : [];
  if (!watched.length && !ratings.length && !diary.length && !watchlist.length) throw new Error('No Letterboxd files found. Choose the .zip from Letterboxd, or watched.csv, ratings.csv and watchlist.csv.');

  const index = new Map();
  for (const m of movies) { const k = normTitle(m.t); if (!index.has(k)) index.set(k, []); index.get(k).push(m); }
  const find = (name, year) => {
    const list = index.get(normTitle(name)); if (!list) return null;
    const y = Number(year) || null;
    return (y && (list.find((m) => m.y === y) || list.find((m) => m.y && Math.abs(m.y - y) === 1))) || (!y && list.length === 1 ? list[0] : null);
  };
  const key = (r) => r['Letterboxd URI'] || `${r.Name}|${r.Year}`;
  const seen = new Map(); // id -> { m, rating, on }
  const all = new Map();  // every distinct movie in the export, for the counts
  const touch = (r) => { all.set(key(r), r); return find(r.Name, r.Year); };
  for (const r of [...watched, ...diary, ...ratings]) {
    const m = touch(r); if (!m) continue;
    const x = seen.get(m.id) || { m, rating: 0, on: '' };
    const on = r['Watched Date'] || '';
    if (on && on > x.on) x.on = on;
    if (!x.on && r.Date) x.logged = r.Date;
    if (r.Rating) x.rating = Math.max(0.5, Math.min(5, Math.round(Number(r.Rating) * 2) / 2)) || x.rating;
    seen.set(m.id, x);
  }
  const queue = new Map();
  for (const r of watchlist) { const m = find(r.Name, r.Year); all.set('wl:' + key(r), r); if (m && !seen.has(m.id)) queue.set(m.id, { m }); }
  return {
    counts: { watched: new Set([...watched, ...diary, ...ratings].map((r) => `${normTitle(r.Name)}|${r.Year}`)).size, ratings: ratings.length, watchlist: watchlist.length },
    seen: [...seen.values()], queue: [...queue.values()],
  };
}
