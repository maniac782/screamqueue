#!/usr/bin/env node
// Nightly data refresh for Scream Queue.
// Pulls horror movies from TMDB (required), and optionally Trakt and OMDb,
// tags subgenres, scores buzz/reach, and writes public/data/movies.json.
//
// Env:
//   TMDB_READ_TOKEN  (TMDB "API Read Access Token")  or  TMDB_API_KEY
//   TRAKT_CLIENT_ID  (optional; Trakt API keys now need a Trakt VIP account)
//   OMDB_API_KEY     (optional; adds IMDb rating + votes, Rotten Tomatoes critics score, Metacritic)
//   REGION           (default US)
//   MAX_MOVIES       (default 5000)

import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SUBGENRES, TIERS, GENRE, tagSubgenres, scoreMovies, usCertification } from './lib.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(ROOT, 'public/data/movies.json');
const REGION = process.env.REGION || 'US';
const MAX_MOVIES = Number(process.env.MAX_MOVIES || 5000);
const TMDB_TOKEN = process.env.TMDB_READ_TOKEN;
const TMDB_KEY = process.env.TMDB_API_KEY;
const TRAKT_ID = process.env.TRAKT_CLIENT_ID;
const OMDB_KEY = process.env.OMDB_API_KEY;
const OMDB_MAX_CALLS = Number(process.env.OMDB_MAX_CALLS || 950); // free OMDb tier is 1,000/day
const OMDB_STALE_DAYS_NEW = 7;       // movies from this year or last: scores still moving
const OMDB_STALE_DAYS_OLD = 45;      // older movies barely change

if (!TMDB_TOKEN && !TMDB_KEY) {
  console.error('Missing TMDB_READ_TOKEN or TMDB_API_KEY. Add one as a GitHub Actions secret.');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url, headers = {}, tries = 4) {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url, { headers });
    if (res.ok) return res.json();
    if ((res.status === 429 || res.status >= 500) && attempt < tries) {
      const wait = Number(res.headers.get('retry-after')) * 1000 || 1000 * attempt * attempt;
      await sleep(wait);
      continue;
    }
    const where = url.replace(/(api_key|apikey)=[^&]+/g, '$1=***');
    throw new Error(`HTTP ${res.status} for ${where}`);
  }
}

function tmdb(path, params = {}) {
  const u = new URL('https://api.themoviedb.org/3' + path);
  for (const [k, v] of Object.entries(params)) if (v != null) u.searchParams.set(k, v);
  const headers = { accept: 'application/json' };
  if (TMDB_TOKEN) headers.authorization = `Bearer ${TMDB_TOKEN}`;
  else u.searchParams.set('api_key', TMDB_KEY);
  return getJson(u.toString(), headers);
}

function trakt(path) {
  return getJson('https://api.trakt.tv' + path, {
    'content-type': 'application/json',
    'trakt-api-version': '2',
    'trakt-api-key': TRAKT_ID,
  });
}

async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      try { out[i] = await fn(items[i], i); } catch (e) { out[i] = null; console.warn(String(e.message || e)); }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

async function pages(path, params, count) {
  const all = [];
  for (let page = 1; page <= count; page++) {
    const data = await tmdb(path, { ...params, page });
    all.push(...(data.results || []));
    if (page >= (data.total_pages || 1)) break;
  }
  return all;
}

// Dead Meat's "Kill Count" videos on YouTube, listed with yt-dlp (no API key needed). Returns [{ id, title }] or null.
const DEAD_MEAT = 'https://www.youtube.com/@deadmeat/videos';
let kcError = null;
function deadMeatVideos() {
  return new Promise((done) => {
    execFile('python3', ['-m', 'yt_dlp', '--flat-playlist', '--dump-single-json', '--no-warnings', '--ignore-errors', DEAD_MEAT],
      { maxBuffer: 128 * 1024 * 1024, timeout: 240000 }, (err, out, errOut) => {
        try { done((JSON.parse(out).entries || []).filter((e) => e?.id && e?.title).map((e) => ({ id: e.id, title: e.title }))); }
        catch (e) {
          kcError = `${err ? String(err.message) : 'no JSON'} | ${String(errOut || '').slice(-300)} | out=${String(out || '').slice(0, 120)}`.replace(/\s+/g, ' ');
          console.warn('Kill Count videos skipped:', kcError);
          done(null);
        }
      });
  });
}
const ROMAN = { ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7, viii: 8, ix: 9, x: 10 };
const normTitle = (t) => String(t).toLowerCase().replace(/\[[^\]]*\]/g, ' ').replace(/&/g, 'and')
  .replace(/\b(ii|iii|iv|vi|vii|viii|ix)\b/g, (r) => ROMAN[r]).replace(/\bpart (v|x)\b/g, (_, r) => `part ${ROMAN[r]}`)
  .replace(/^(the|a|an)\s+/, '').replace(/[^a-z0-9]+/g, '');

const isoDaysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
// US release dates from TMDB: th = first theatrical (limited or wide), dig = first digital. Omitted when unknown.
function usDates(releaseDates, region = 'US') {
  const list = releaseDates?.results?.find((x) => x.iso_3166_1 === region)?.release_dates || [];
  const first = (types) => list.filter((r) => types.includes(r.type) && r.release_date).map((r) => r.release_date.slice(0, 10)).sort()[0];
  const out = {}; const th = first([2, 3]); const dig = first([4]);
  if (th) out.th = th; if (dig) out.dig = dig;
  return out;
}

async function main() {
  let previous = { movies: [] };
  try { previous = JSON.parse(await readFile(OUT, 'utf8')); } catch { /* first run */ }
  const prevById = new Map((previous.movies || []).map((m) => [m.id, m]));

  console.log('Collecting candidates from TMDB…');
  const weekly = (await pages('/trending/movie/week', { language: 'en-US' }, 15)).filter((m) => m.genre_ids?.includes(GENRE.horror));
  const daily = (await pages('/trending/movie/day', { language: 'en-US' }, 8)).filter((m) => m.genre_ids?.includes(GENRE.horror));
  const weekRank = new Map(weekly.map((m, i) => [m.id, i + 1]));
  const dayRank = new Map(daily.map((m, i) => [m.id, i + 1]));

  const base = { with_genres: GENRE.horror, include_adult: 'false', language: 'en-US', region: REGION };
  // US theatrical releases: what's playing now and what's coming in the next six months
  const theatrical = { ...base, with_release_type: '2|3' };
  const lists = [
    weekly, daily,
    await pages('/discover/movie', { ...theatrical, sort_by: 'popularity.desc', 'release_date.gte': isoDaysAgo(70), 'release_date.lte': isoDaysAgo(0) }, 3),
    await pages('/discover/movie', { ...theatrical, sort_by: 'popularity.desc', 'release_date.gte': isoDaysAgo(-1), 'release_date.lte': isoDaysAgo(-180) }, 3),
    await pages('/discover/movie', { ...base, sort_by: 'popularity.desc', 'vote_count.gte': 20 }, 25),
    // The full back catalog: every horror movie with at least a few dozen ratings (not limited to a release region).
    await pages('/discover/movie', { with_genres: GENRE.horror, include_adult: 'false', language: 'en-US', sort_by: 'vote_count.desc', 'vote_count.gte': 25 }, 250),
    await pages('/discover/movie', { ...base, sort_by: 'popularity.desc', 'primary_release_date.gte': isoDaysAgo(150) }, 4),
    // What's streaming on Shudder (TMDB provider 99) right now
    await pages('/discover/movie', { ...base, sort_by: 'popularity.desc', with_watch_providers: 99, watch_region: REGION }, 6),
  ];

  // Optional Trakt signals
  const traktNow = new Map();   // tmdb id -> watchers right now
  const traktPlays = new Map(); // tmdb id -> plays this year
  const traktIds = [];
  if (TRAKT_ID) {
    console.log('Adding Trakt signals…');
    try {
      const tr = await trakt('/movies/trending?genres=horror&limit=100');
      for (const x of tr) if (x.movie?.ids?.tmdb) { traktNow.set(x.movie.ids.tmdb, x.watchers); traktIds.push(x.movie.ids.tmdb); }
      const wy = await trakt('/movies/watched/yearly?genres=horror&limit=100');
      for (const x of wy) if (x.movie?.ids?.tmdb) { traktPlays.set(x.movie.ids.tmdb, x.play_count ?? x.watcher_count); traktIds.push(x.movie.ids.tmdb); }
      const wa = await trakt('/movies/watched/all?genres=horror&limit=100');
      for (const x of wa) if (x.movie?.ids?.tmdb) { traktPlays.set(x.movie.ids.tmdb, Math.max(traktPlays.get(x.movie.ids.tmdb) || 0, x.watcher_count || 0)); traktIds.push(x.movie.ids.tmdb); }
    } catch (e) { console.warn('Trakt skipped:', e.message); }
  }

  const ids = [];
  const seen = new Set();
  for (const id of [...lists.flat().map((m) => m.id), ...traktIds]) {
    if (!seen.has(id)) { seen.add(id); ids.push(id); }
  }
  ids.splice(MAX_MOVIES);

  // Halloween Fun: well-known movies TMDB doesn't call horror but people watch in October (Hocus Pocus, Beetlejuice,
  // The Addams Family...), found by keyword. Plus any movie the admin added by hand (config/site.extraMovies).
  // These come on top of the horror list, so they never push horror movies out.
  const funIds = new Set();
  // Hand-picked October classics, looked up by title and year.
  const FUN_PICKS = [
    ['Hocus Pocus', 1993], ['Hocus Pocus 2', 2022], ['Beetlejuice', 1988], ['Beetlejuice Beetlejuice', 2024], ['The Addams Family', 1991], ['Addams Family Values', 1993],
    ['The Addams Family', 2019], ['Ghostbusters', 1984], ['Ghostbusters II', 1989], ['Ghostbusters: Afterlife', 2021], ['Ghostbusters: Frozen Empire', 2024], ['Casper', 1995],
    ['The Nightmare Before Christmas', 1993], ['Corpse Bride', 2005], ['Frankenweenie', 2012], ['ParaNorman', 2012], ['Monster House', 2006], ['Hotel Transylvania', 2012],
    ['Hotel Transylvania 2', 2015], ['Young Frankenstein', 1974], ['The Witches', 1990], ['Practical Magic', 1998], ['Death Becomes Her', 1992], ['Edward Scissorhands', 1990],
    ['Halloweentown', 1998], ['Twitches', 2005], ['Hubie Halloween', 2020], ['Haunted Mansion', 2023], ['The Haunted Mansion', 2003], ['Dark Shadows', 2012],
    ['Wallace & Gromit: The Curse of the Were-Rabbit', 2005], ['Goosebumps', 2015], ['Toy Story of Terror!', 2013], ['It\'s the Great Pumpkin, Charlie Brown', 1966],
    ['The Adventures of Ichabod and Mr. Toad', 1949], ['Teen Wolf', 1985], ['The Lost Boys', 1987], ['Fright Night', 1985], ['Gremlins', 1984], ['Arsenic and Old Lace', 1944],
    ['Abbott and Costello Meet Frankenstein', 1948], ['What We Do in the Shadows', 2014], ['Scary Movie', 2000], ['Shaun of the Dead', 2004], ['Zombieland', 2009],
    ['Hocus Pocus', 1993], ['The Craft', 1996], ['Sleepy Hollow', 1999], ['Coraline', 2009], ['Monster Squad', 1987], ['The Monster Squad', 1987], ['Ernest Scared Stupid', 1991],
  ];
  try {
    await pool(FUN_PICKS, 6, async ([title, year]) => {
      const r = await tmdb('/search/movie', { query: title, year, include_adult: 'false', language: 'en-US' });
      const hit = (r.results || []).find((m) => (m.release_date || '').startsWith(String(year))) || r.results?.[0];
      if (hit) funIds.add(hit.id);
    });
    // Plus anything well known that TMDB tags with Halloween itself.
    const kwIds = [];
    for (const name of ['halloween', 'trick or treating', 'jack-o\'-lantern']) {
      const r = await tmdb('/search/keyword', { query: name });
      const hit = (r.results || []).find((k) => k.name.toLowerCase() === name);
      if (hit) kwIds.push(hit.id);
    }
    if (kwIds.length) {
      const found = await pages('/discover/movie', { with_keywords: kwIds.join('|'), without_genres: [GENRE.horror, GENRE.romance, GENRE.documentary].join(','), include_adult: 'false', language: 'en-US', sort_by: 'vote_count.desc', 'vote_count.gte': 300 }, 3);
      for (const m of found) funIds.add(m.id);
    }
    const inList = new Set(ids);
    for (const id of funIds) if (!inList.has(id)) { seen.add(id); ids.push(id); inList.add(id); }
  } catch (e) { console.warn('Halloween Fun skipped:', e.message); }
  const extraIds = new Set();
  try {
    const doc = await getJson('https://firestore.googleapis.com/v1/projects/screamqueue/databases/(default)/documents/config/site');
    for (const v of doc.fields?.extraMovies?.arrayValue?.values || []) { const id = Number(v.integerValue ?? v.doubleValue ?? v.stringValue); if (id) extraIds.add(id); }
    const inList = new Set(ids);
    for (const id of extraIds) if (!inList.has(id)) { seen.add(id); ids.push(id); }
  } catch (e) { console.warn('Admin extras skipped:', e.message); }
  console.log(`Halloween Fun: ${funIds.size} movies; added by the admin: ${extraIds.size}.`);
  const keepAnyway = (d) => funIds.has(d.id) || extraIds.has(d.id);
  const isHorror = (d) => d.genres?.some((g) => g.id === GENRE.horror);
  console.log(`Fetching details for ${ids.length} movies…`);

  const details = await pool(ids, 12, (id) =>
    tmdb(`/movie/${id}`, { language: 'en-US', append_to_response: 'keywords,watch/providers,external_ids,release_dates,credits,videos,recommendations' }));

  // Provider names for the "my services" picker
  const prov = await tmdb('/watch/providers/movie', { watch_region: REGION, language: 'en-US' });
  const providerList = (prov.results || [])
    .sort((a, b) => (a.display_priorities?.[REGION] ?? 999) - (b.display_priorities?.[REGION] ?? 999))
    .map((p) => ({ id: p.provider_id, name: p.provider_name, logo: p.logo_path || null, pr: p.display_priorities?.[REGION] ?? p.display_priority ?? 999 }));

  // OMDb: IMDb rating/votes, Rotten Tomatoes critics score and Metacritic, cached between runs.
  // The free key allows ~1,000 calls a day, so each night we fill movies that have no scores yet
  // (most popular first), then refresh the stalest ones. A full first pass takes about 5 nights.
  const thisYear = new Date().getFullYear();
  const keep = (imdbId, prev) => ({ id: imdbId, r: prev?.r ?? null, v: prev?.v ?? null, tom: prev?.tom ?? null, mc: prev?.mc ?? null, at: prev?.at ?? null });
  const omdb = new Map();
  let omdbCalls = 0;
  if (OMDB_KEY) {
    const need = [];
    for (const d of details) {
      if (!d || !(isHorror(d) || keepAnyway(d))) continue;
      const imdbId = d.external_ids?.imdb_id || d.imdb_id; if (!imdbId) continue;
      const prev = prevById.get(d.id)?.imdb;
      const y = d.release_date ? Number(d.release_date.slice(0, 4)) : thisYear;
      const age = prev?.at ? (Date.now() - Date.parse(prev.at)) / 86400000 : Infinity;
      const stale = y >= thisYear - 1 ? OMDB_STALE_DAYS_NEW : OMDB_STALE_DAYS_OLD;
      if (age < stale && prev?.tom !== undefined) continue;
      need.push({ d, imdbId, prev, missing: !prev?.at || prev?.tom === undefined, age, pop: d.popularity || 0 });
    }
    need.sort((a, b) => (b.missing - a.missing) || (a.missing ? b.pop - a.pop : b.age - a.age));
    let limited = false;
    await pool(need.slice(0, OMDB_MAX_CALLS), 6, async ({ d, imdbId, prev }) => {
      if (limited) return;
      omdbCalls++;
      try {
        const o = await getJson(`https://www.omdbapi.com/?i=${imdbId}&apikey=${OMDB_KEY}`);
        if (o.Response === 'False') { if (/limit/i.test(o.Error || '')) limited = true; return; }
        const r = parseFloat(o.imdbRating); const v = parseInt(String(o.imdbVotes).replace(/,/g, ''), 10);
        const rtv = (o.Ratings || []).find((x) => x.Source === 'Rotten Tomatoes')?.Value;
        const tom = rtv ? parseInt(rtv, 10) : NaN;
        const mc = parseInt(o.Metascore, 10);
        omdb.set(d.id, { id: imdbId, r: Number.isFinite(r) ? r : null, v: Number.isFinite(v) ? v : null, tom: Number.isFinite(tom) ? tom : null, mc: Number.isFinite(mc) ? mc : null, at: new Date().toISOString() });
      } catch (e) { if (/401/.test(String(e.message))) limited = true; }
    });
    console.log(`OMDb: ${need.length} movies wanted scores, made ${omdbCalls} calls${limited ? ' (stopped at the daily limit)' : ''}.`);
  }
  function imdbFor(d) {
    const imdbId = d.external_ids?.imdb_id || d.imdb_id;
    if (!imdbId) return null;
    return omdb.get(d.id) || keep(imdbId, prevById.get(d.id)?.imdb);
  }

  // Best YouTube trailer: official English trailers first, then teasers; the earliest one is usually the main trailer.
  function trailerFor(d) {
    const vids = (d.videos?.results || []).filter((v) => v.site === 'YouTube' && v.key && /^(Trailer|Teaser)$/.test(v.type));
    const score = (v) => (v.type === 'Trailer' ? 4 : 0) + (v.official ? 2 : 0) + (!v.iso_639_1 || v.iso_639_1 === 'en' ? 1 : 0);
    vids.sort((a, b) => score(b) - score(a) || String(a.published_at).localeCompare(String(b.published_at)));
    return vids[0]?.key || null;
  }

  const rows = [];
  for (const d of details) {
    if (!d || !(isHorror(d) || keepAnyway(d))) continue;
    if (d.adult) continue;
    const genreIds = d.genres.map((g) => g.id);
    const kwNames = (d.keywords?.keywords || []).map((k) => k.name);
    const wp = d['watch/providers']?.results?.[REGION] || {};
    const imdb = imdbFor(d);
    rows.push({
      id: d.id,
      t: d.title,
      y: d.release_date ? Number(d.release_date.slice(0, 4)) : null,
      date: d.release_date || null,
      rt: d.runtime || null,
      ov: d.overview || '',
      cert: usCertification(d.release_dates, REGION),
      ...usDates(d.release_dates, REGION),
      dir: (d.credits?.crew || []).filter((c) => c.job === 'Director').map((c) => c.name).slice(0, 2),
      cast: (d.credits?.cast || []).slice(0, 4).map((c) => c.name),
      castFull: (d.credits?.cast || []).slice(0, 12).map((c) => ({ i: c.id, n: c.name, c: c.character || '', p: c.profile_path || null })),
      dirFull: (d.credits?.crew || []).filter((c) => c.job === 'Director').slice(0, 2).map((c) => ({ i: c.id, n: c.name, p: c.profile_path || null })),
      g: d.genres.map((g) => g.name),
      sg: isHorror(d) ? tagSubgenres(kwNames, genreIds) : ['fun', ...tagSubgenres(kwNames, genreIds).filter((k) => k !== 'comedy')],
      pv: (wp.flatrate || []).map((p) => p.provider_id),
      fr: [...(wp.free || []), ...(wp.ads || [])].map((p) => p.provider_id),
      rent: (wp.rent || []).length > 0,
      wl: wp.link || null,
      poster: d.poster_path || null,
      bd: d.backdrop_path || null,
      yt: trailerFor(d),
      col: d.belongs_to_collection?.id || null,
      rec: (d.recommendations?.results || []).map((x) => x.id),
      va: d.vote_average ?? null,
      // scoring inputs
      pop: d.popularity ?? null,
      votes: d.vote_count ?? null,
      imdbVotes: imdb?.v ?? null,
      traktWatchers: TRAKT_ID ? (traktNow.get(d.id) ?? 0) : null,
      traktPlays: TRAKT_ID ? (traktPlays.get(d.id) ?? null) : null,
      weekRank: weekRank.get(d.id) ?? null,
      dayRank: dayRank.get(d.id) ?? null,
      imdb,
    });
  }

  // Cast and directors go in 100 small shard files per kind, loaded only when someone opens a movie or a person:
  //   data/cast/N.json   movie id -> { c: [cast], d: [directors] }
  //   data/people/N.json person id -> { n: name, p: photo, m: [[movie id, character or "Director"], ...] }
  const CAST_DIR = resolve(ROOT, 'public/data/cast');
  const PEOPLE_DIR = resolve(ROOT, 'public/data/people');
  const castShards = Array.from({ length: 100 }, () => ({}));
  const people = new Map();
  const credit = (who, movieId, role) => {
    if (!who.i) return;
    const p = people.get(who.i) || { n: who.n, p: who.p || null, m: [] };
    if (!p.p && who.p) p.p = who.p;
    if (!p.m.some(([id]) => id === movieId)) p.m.push([movieId, role]);
    people.set(who.i, p);
  };
  for (const r of rows) {
    if (r.castFull.length || r.dirFull.length) castShards[r.id % 100][r.id] = { c: r.castFull, d: r.dirFull };
    for (const c of r.castFull) credit(c, r.id, c.c || '');
    for (const d of r.dirFull) credit(d, r.id, 'Director');
    delete r.castFull; delete r.dirFull;
  }
  const peopleShards = Array.from({ length: 100 }, () => ({}));
  for (const [id, p] of people) peopleShards[id % 100][id] = p;
  for (const [dir, list] of [[CAST_DIR, castShards], [PEOPLE_DIR, peopleShards]]) {
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    await Promise.all(list.map((sh, i) => writeFile(resolve(dir, `${i}.json`), JSON.stringify(sh))));
  }
  // Small name index for search: anyone in 2+ movies here, or any director. [id, name, movie count, photo]
  const index = [...people].filter(([, p]) => p.m.length >= 2 || p.m.some(([, r]) => r === 'Director'))
    .sort((a, b) => b[1].m.length - a[1].m.length).map(([id, p]) => [id, p.n, p.m.length, p.p || 0]);
  await writeFile(resolve(ROOT, 'public/data/people-index.json'), JSON.stringify(index));
  console.log(`Wrote cast for ${rows.length} movies and ${people.size} people.`);

  // Newly streaming: providers a movie gained since last night, kept for 21 days (ns: { d: date, p: [provider ids] }).
  // The site shows these from your queue on Tonight, and the email job (functions/) sends a daily note about them.
  const todayStr = new Date().toISOString().slice(0, 10);
  const nsCutoff = new Date(Date.now() - 21 * 86400000).toISOString().slice(0, 10);
  let nsNew = 0;
  for (const r of rows) {
    const prev = prevById.get(r.id);
    const nowP = [...r.pv, ...r.fr];
    if (prev) {
      const before = new Set([...(prev.pv || []), ...(prev.fr || [])]);
      const added = nowP.filter((x) => !before.has(x));
      if (added.length && !previous.sample) { r.ns = { d: todayStr, p: added }; nsNew++; continue; }
    }
    if (prev?.ns && prev.ns.d >= nsCutoff) { const still = prev.ns.p.filter((x) => nowP.includes(x)); if (still.length) r.ns = { d: prev.ns.d, p: still }; }
  }
  console.log(`Newly streaming tonight: ${nsNew} movies.`);

  // "People who liked this also liked": TMDB's recommendations, kept only when they're on the site (top 12).
  const onSite = new Set(rows.map((r) => r.id));
  for (const r of rows) r.rec = r.rec.filter((id) => onSite.has(id)).slice(0, 12);

  // Series: TMDB groups sequels, prequels and reboots into collections ("Halloween Collection").
  // data/collections.json: collection id -> { n: name, p: [[movie id, title, year, poster], ...] in release order }.
  // Parts that aren't horror or aren't on the site are kept too; the site links those to TMDB.
  const colIds = [...new Set(rows.map((r) => r.col).filter(Boolean))];
  const collections = {};
  await pool(colIds, 8, async (cid) => {
    try {
      const c = await tmdb(`/collection/${cid}`, { language: 'en-US' });
      const parts = (c.parts || []).filter((x) => !x.adult)
        .sort((a, b) => (a.release_date || '9999').localeCompare(b.release_date || '9999'))
        .map((x) => [x.id, x.title, x.release_date ? Number(x.release_date.slice(0, 4)) : null, x.poster_path || 0]);
      if (parts.length > 1) collections[cid] = { n: c.name.replace(/\s+Collection$/i, ''), p: parts };
    } catch (e) { console.warn('collection', cid, e.message); }
  });
  for (const r of rows) if (r.col && !collections[r.col]) r.col = null;
  await writeFile(resolve(ROOT, 'public/data/collections.json'), JSON.stringify(collections));
  console.log(`Series: ${Object.keys(collections).length} collections.`);

  // Match Kill Count videos ("Halloween (1978) KILL COUNT") to movies by title + year. Keep last night's matches if YouTube can't be reached.
  const vids = await deadMeatVideos();
  let kcMatched = 0;
  if (vids) {
    // Exact title + year first; then allow the year to be off by one, but never reuse a video already matched.
    // Newer "RECOUNT" videos replace the originals, so they win when both exist.
    const kv = vids.map((v) => { const m = v.title.match(/^(.*?)\s*\((\d{4})\)\s*(?:kill count|body count)/i); return m && { id: v.id, k: normTitle(m[1]), y: +m[2], title: v.title, re: /recount/i.test(v.title) }; })
      .filter(Boolean).sort((a, b) => b.re - a.re);
    const exact = new Map();
    for (const v of kv) if (!exact.has(`${v.k}|${v.y}`)) exact.set(`${v.k}|${v.y}`, v.id);
    const used = new Set();
    for (const r of rows) { const id = r.y && exact.get(`${normTitle(r.t)}|${r.y}`); if (id) { r.kc = id; used.add(id); kcMatched++; } }
    for (const r of rows) {
      if (r.kc || !r.y) continue;
      const v = kv.find((x) => x.k === normTitle(r.t) && Math.abs(x.y - r.y) <= 2 && !used.has(x.id) && !exact.has(`${x.k}|${r.y}`));
      if (v) { r.kc = v.id; used.add(v.id); kcMatched++; }
    }
    // Last try: same year and one title is the start of the other ("Halloween H20" / "Halloween H20: 20 Years Later").
    for (const r of rows) {
      if (r.kc || !r.y) continue;
      const k = normTitle(r.t);
      const v = kv.find((x) => x.y === r.y && !used.has(x.id) && Math.min(x.k.length, k.length) >= 6 && (k.startsWith(x.k) || x.k.startsWith(k)));
      if (v) { r.kc = v.id; used.add(v.id); kcMatched++; }
    }
    const sameMovie = new Set(kv.filter((v) => used.has(v.id)).map((v) => `${v.k}|${v.y}`));
    const unmatched = kv.filter((v) => !used.has(v.id) && !sameMovie.has(`${v.k}|${v.y}`)).map((v) => v.title);
    await writeFile(resolve(ROOT, 'public/data/killcount-unmatched.json'), JSON.stringify(unmatched, null, 0));
    console.log(`Kill Count: ${vids.length} Dead Meat videos, ${kv.length} Kill Counts, ${kcMatched} matched to movies.`);
  } else {
    for (const r of rows) { const prev = prevById.get(r.id)?.kc; if (prev) { r.kc = prev; kcMatched++; } }
  }

  const scored = scoreMovies(rows).map(({ pop, votes, imdbVotes, traktWatchers, traktPlays, ...m }) => ({
    ...m,
    n: { pop: pop != null ? Math.round(pop) : null, votes, trakt: traktWatchers, plays: traktPlays },
  }));
  scored.sort((a, b) => b.buzz - a.buzz || b.reach - a.reach);

  const usedProviders = new Set(scored.flatMap((m) => [...m.pv, ...m.fr]));
  const out = {
    generatedAt: new Date().toISOString(),
    sample: false,
    region: REGION,
    sources: { tmdb: true, trakt: !!TRAKT_ID, omdb: !!OMDB_KEY, killCount: vids ? vids.length : 'kept', killCountMatched: kcMatched, ...(kcError ? { killCountError: kcError } : {}) },
    subgenres: SUBGENRES.map(({ key, label }) => ({ key, label })),
    tiers: TIERS.map(({ key, label }) => ({ key, label })),
    providers: providerList.filter((p, i) => i < 80 || usedProviders.has(p.id)),
    movies: scored,
  };
  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify(out));
  console.log(`Wrote ${scored.length} movies to public/data/movies.json (OMDb calls: ${omdbCalls}).`);
}

main().catch((e) => { console.error(e); process.exit(1); });
