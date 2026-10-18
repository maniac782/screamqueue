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

import { readFile, writeFile, mkdir } from 'node:fs/promises';
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

const isoDaysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);

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
  const lists = [
    weekly, daily,
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
  console.log(`Fetching details for ${ids.length} movies…`);

  const details = await pool(ids, 12, (id) =>
    tmdb(`/movie/${id}`, { language: 'en-US', append_to_response: 'keywords,watch/providers,external_ids,release_dates,credits,videos' }));

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
      if (!d || !d.genres?.some((g) => g.id === GENRE.horror)) continue;
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
    if (!d || !d.genres?.some((g) => g.id === GENRE.horror)) continue;
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
      dir: (d.credits?.crew || []).filter((c) => c.job === 'Director').map((c) => c.name).slice(0, 2),
      cast: (d.credits?.cast || []).slice(0, 4).map((c) => c.name),
      g: d.genres.map((g) => g.name),
      sg: tagSubgenres(kwNames, genreIds),
      pv: (wp.flatrate || []).map((p) => p.provider_id),
      fr: [...(wp.free || []), ...(wp.ads || [])].map((p) => p.provider_id),
      rent: (wp.rent || []).length > 0,
      wl: wp.link || null,
      poster: d.poster_path || null,
      bd: d.backdrop_path || null,
      yt: trailerFor(d),
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
    sources: { tmdb: true, trakt: !!TRAKT_ID, omdb: !!OMDB_KEY },
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
