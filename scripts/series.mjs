// Horror TV series for Scream Queue (public/data/series.json), run by refresh-data.mjs after the movies.
// TMDB has no Horror genre for TV, so shows are found by horror keywords plus a hand-picked list of well-known ones.
// Kids, family, reality, talk, news, soap and documentary shows are left out; animation only when hand-picked.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { tagSubgenres, scoreMovies, GENRE } from './lib.mjs';

const TV_SKIP_GENRES = [10762, 10751, 10764, 10767, 10763, 10766, 99, 16]; // kids, family, reality, talk, news, soap, documentary, animation
const MAX_SERIES = Number(process.env.MAX_SERIES || 600);

// Well-known horror series, looked up by name and first-air year (so they're on the site even if their tags are thin).
const PICKS = [
  ['The Haunting of Hill House', 2018], ['The Haunting of Bly Manor', 2020], ['Midnight Mass', 2021], ['The Fall of the House of Usher', 2023],
  ['The Midnight Club', 2022], ['American Horror Story', 2011], ['American Horror Stories', 2021], ['The Walking Dead', 2010], ['Fear the Walking Dead', 2015],
  ['Chucky', 2021], ['From', 2022], ['Yellowjackets', 2021], ['Ash vs Evil Dead', 2015], ['Penny Dreadful', 2014], ['Hannibal', 2013], ['Bates Motel', 2013],
  ['Scream Queens', 2015], ['Scream', 2015], ['Castle Rock', 2018], ['Lovecraft Country', 2020], ['Evil', 2019], ['The Terror', 2018], ['Channel Zero', 2016],
  ['Supernatural', 2005], ['Tales from the Crypt', 1989], ['Are You Afraid of the Dark?', 1990], ['The Twilight Zone', 1959], ['The Twilight Zone', 2019],
  ['Masters of Horror', 2005], ['Slasher', 2016], ['Marianne', 2019], ['Kingdom', 2019], ['Sweet Home', 2020], ['All of Us Are Dead', 2022],
  ['Interview with the Vampire', 2022], ['What We Do in the Shadows', 2019], ['Wednesday', 2022], ['The Outsider', 2020], ['30 Coins', 2020],
  ['Brand New Cherry Flavor', 2021], ['Archive 81', 2022], ['Servant', 2019], ['Them', 2021], ["Guillermo del Toro's Cabinet of Curiosities", 2022],
  ['Stranger Things', 2016], ['Teen Wolf', 2011], ['The Strain', 2014], ['From Dusk till Dawn: The Series', 2014], ['Black Summer', 2019], ['Z Nation', 2014],
  ['iZombie', 2015], ['Santa Clarita Diet', 2017], ['Buffy the Vampire Slayer', 1997], ['Angel', 1999], ['True Blood', 2008], ['Hemlock Grove', 2013],
  ['Creepshow', 2019], ['Tales from the Darkside', 1983], ["Freddy's Nightmares", 1988], ['Friday the 13th: The Series', 1987], ['Twin Peaks', 1990],
  ['The X-Files', 1993], ['Goosebumps', 1995], ['Goosebumps', 2023], ['Salem', 2014], ['The Exorcist', 2016], ['Damien', 2016], ['Van Helsing', 2016],
  ['Grimm', 2011], ['Sleepy Hollow', 2013], ['Dead Set', 2008], ['Inside No. 9', 2014], ['Black Mirror', 2011], ['The Last of Us', 2023], ['Day of the Dead', 2021],
  ['Shining Vale', 2022], ['Wolf Like Me', 2022], ['The Mist', 2017], ['Swamp Thing', 2019], ['Locke & Key', 2020], ['The Order', 2019], ['Brand New Cherry Flavor', 2021],
  ['Ghosts', 2021], ['Mayfair Witches', 2023], ['Them: The Scare', 2024], ['Dead Boy Detectives', 2024], ['Hellbound', 2021], ['Parasyte: The Grey', 2024],
  ['Monsterland', 2020], ['The Haunting of Bly Manor', 2020], ['Dark', 2017], ['Junji Ito Maniac: Japanese Tales of the Macabre', 2023], ['Castlevania', 2017],
];
const PICK_ANIMATION_OK = new Set(['Castlevania', 'Junji Ito Maniac: Japanese Tales of the Macabre']);
const KEYWORDS = ['horror', 'supernatural horror', 'psychological horror', 'folk horror', 'body horror', 'slasher', 'zombie apocalypse', 'haunted house',
  'horror anthology', 'demonic possession', 'werewolf', 'vampire', 'zombie', 'cosmic horror', 'creature feature', 'survival horror'];

function usRating(cr) { return (cr?.results || []).find((x) => x.iso_3166_1 === 'US')?.rating || null; }
function trailerFor(d) {
  const vids = (d.videos?.results || []).filter((v) => v.site === 'YouTube' && v.key && /^(Trailer|Teaser)$/.test(v.type));
  const score = (v) => (v.type === 'Trailer' ? 4 : 0) + (v.official ? 2 : 0) + (!v.iso_639_1 || v.iso_639_1 === 'en' ? 1 : 0);
  vids.sort((a, b) => score(b) - score(a) || String(b.published_at).localeCompare(String(a.published_at)));
  return vids[0]?.key || null;
}
// Summaries cut at a word, not mid-word.
const clip = (t, n = 420) => { t = String(t || '').replace(/\s+/g, ' ').trim(); return t.length <= n ? t : t.slice(0, t.lastIndexOf(' ', n)) + '…'; };
const statusOf = (s) => (s === 'Returning Series' || s === 'In Production' || s === 'Planned' ? 'on' : s === 'Canceled' ? 'cancel' : 'end');

// tmdb(path, params), pages(path, params, count), pool(items, n, fn), getJson(url) come from refresh-data.mjs.
export async function refreshSeries({ tmdb, pages, pool, getJson, root, region = 'US', omdbKey = null, omdbBudget = 0 }) {
  const OUT = `${root}/public/data/series.json`;
  let previous = { series: [] };
  try { previous = JSON.parse(await readFile(OUT, 'utf8')); } catch { /* first run */ }
  const prevById = new Map((previous.series || []).map((s) => [s.tv, s]));

  // 1. Candidates: horror keywords (most-rated first, plus recent ones), the hand-picked list, and the admin's extras.
  const kwIds = [];
  await pool(KEYWORDS, 4, async (name) => {
    const r = await tmdb('/search/keyword', { query: name });
    const hit = (r.results || []).find((k) => k.name.toLowerCase() === name);
    if (hit) kwIds.push(hit.id);
  });
  const base = { with_keywords: kwIds.join('|'), without_genres: TV_SKIP_GENRES.join(','), include_adult: 'false', language: 'en-US' };
  const found = kwIds.length ? [
    ...(await pages('/discover/tv', { ...base, sort_by: 'vote_count.desc', 'vote_count.gte': 30 }, 20)),
    ...(await pages('/discover/tv', { ...base, sort_by: 'popularity.desc', 'first_air_date.gte': new Date(Date.now() - 730 * 86400000).toISOString().slice(0, 10), 'vote_count.gte': 3 }, 4)),
    ...(await pages('/discover/tv', { ...base, sort_by: 'popularity.desc', 'air_date.gte': new Date(Date.now() - 120 * 86400000).toISOString().slice(0, 10), 'vote_count.gte': 10 }, 3)),
  ] : [];
  const picked = new Set();
  await pool(PICKS, 6, async ([name, year]) => {
    const r = await tmdb('/search/tv', { query: name, first_air_date_year: year, include_adult: 'false', language: 'en-US' });
    const hit = (r.results || []).find((x) => (x.first_air_date || '').startsWith(String(year))) || r.results?.[0];
    if (hit) picked.add(hit.id);
  });
  const extra = new Set();
  try {
    const doc = await getJson('https://firestore.googleapis.com/v1/projects/screamqueue/databases/(default)/documents/config/site');
    for (const v of doc.fields?.extraSeries?.arrayValue?.values || []) { const id = Number(v.integerValue ?? v.doubleValue ?? v.stringValue); if (id) extra.add(id); }
  } catch { /* no extras */ }
  const ids = [...new Set([...picked, ...extra, ...found.map((x) => x.id)])].slice(0, MAX_SERIES);
  console.log(`Series: ${found.length} found by keyword, ${picked.size} hand-picked, ${extra.size} added by the admin; fetching ${ids.length}.`);

  // 2. Details
  const details = await pool(ids, 10, (id) => tmdb(`/tv/${id}`, { language: 'en-US', append_to_response: 'keywords,watch/providers,external_ids,content_ratings,aggregate_credits,videos,recommendations' }));
  const keepIt = (d) => d && !d.adult && (picked.has(d.id) || extra.has(d.id) || !d.genres?.some((g) => TV_SKIP_GENRES.includes(g.id)));

  // 3. OMDb (IMDb rating, votes) for series, with whatever budget the movies left tonight.
  const omdb = new Map(); let calls = 0;
  if (omdbKey && omdbBudget > 0) {
    const need = details.filter(keepIt).map((d) => ({ d, imdbId: d.external_ids?.imdb_id, prev: prevById.get(d.id)?.imdb }))
      .filter((x) => x.imdbId && (!x.prev?.at || Date.now() - Date.parse(x.prev.at) > 30 * 86400000))
      .sort((a, b) => (!!a.prev?.at - !!b.prev?.at) || (b.d.popularity || 0) - (a.d.popularity || 0)).slice(0, omdbBudget);
    await pool(need, 5, async ({ d, imdbId }) => {
      calls++;
      try {
        const o = await getJson(`https://www.omdbapi.com/?i=${imdbId}&apikey=${omdbKey}`);
        if (o.Response === 'False') return;
        const r = parseFloat(o.imdbRating), v = parseInt(String(o.imdbVotes).replace(/,/g, ''), 10);
        omdb.set(d.id, { id: imdbId, r: Number.isFinite(r) ? r : null, v: Number.isFinite(v) ? v : null, at: new Date().toISOString() });
      } catch { /* skip */ }
    });
  }

  // 4. Rows
  const rows = [];
  for (const d of details) {
    if (!keepIt(d)) continue;
    const kw = (d.keywords?.results || []).map((k) => k.name);
    const wp = d['watch/providers']?.results?.[region] || {};
    const seasons = (d.seasons || []).filter((s) => s.season_number > 0 && s.episode_count > 0)
      .map((s) => [s.season_number, s.name || `Season ${s.season_number}`, s.episode_count, s.air_date ? Number(s.air_date.slice(0, 4)) : null, s.poster_path || 0]);
    if (!seasons.length) continue;
    const imdbId = d.external_ids?.imdb_id || null;
    const imdb = imdbId ? (omdb.get(d.id) || (prevById.get(d.id)?.imdb?.id === imdbId ? prevById.get(d.id).imdb : { id: imdbId, r: null, v: null, at: null })) : null;
    const last = d.last_air_date || null;
    rows.push({
      id: `tv${d.id}`, tv: d.id, type: 'tv',
      t: d.name, y: d.first_air_date ? Number(d.first_air_date.slice(0, 4)) : null,
      y2: statusOf(d.status) === 'on' ? null : (last ? Number(last.slice(0, 4)) : null),
      st: statusOf(d.status), date: d.first_air_date || null, last,
      next: d.next_episode_to_air?.air_date || null,
      nextEp: d.next_episode_to_air ? [d.next_episode_to_air.season_number, d.next_episode_to_air.episode_number] : null,
      ns: seasons.length, ne: seasons.reduce((n, s) => n + s[2], 0),
      rt: d.episode_run_time?.length ? Math.round(d.episode_run_time.reduce((a, b) => a + b, 0) / d.episode_run_time.length) : null,
      ov: d.overview || '', cert: usRating(d.content_ratings),
      dir: (d.created_by || []).map((c) => c.name).slice(0, 2),
      cast: (d.aggregate_credits?.cast || []).slice(0, 4).map((c) => c.name),
      net: (d.networks || []).map((n) => n.name).slice(0, 2),
      g: (d.genres || []).map((g) => g.name),
      sg: tagSubgenres(kw, (d.genres || []).map((g) => g.id).filter((id) => id === GENRE.comedy)),
      pv: (wp.flatrate || []).map((p) => p.provider_id),
      fr: [...(wp.free || []), ...(wp.ads || [])].map((p) => p.provider_id),
      rent: (wp.rent || wp.buy || []).length > 0, wl: wp.link || null,
      poster: d.poster_path || null, bd: d.backdrop_path || null, yt: trailerFor(d),
      rec: (d.recommendations?.results || []).map((x) => `tv${x.id}`),
      va: d.vote_average ?? null, seasons, imdb,
      // scoring inputs (removed below)
      pop: d.popularity ?? null, votes: d.vote_count ?? null, imdbVotes: imdb?.v ?? null,
      // when the latest season started: a season that premiered lately gets the "New season" flag
      sdate: (d.seasons || []).filter((s) => s.season_number > 0 && s.air_date).map((s) => s.air_date).sort().pop() || null,
    });
  }
  const onSite = new Set(rows.map((r) => r.id));
  for (const r of rows) r.rec = r.rec.filter((id) => onSite.has(id)).slice(0, 12);
  const scored = scoreMovies(rows.map((r) => ({ ...r, date: r.date }))).map(({ pop, votes, imdbVotes, sdate, ...s }) => {
    const recent = sdate && (Date.now() - Date.parse(sdate + 'T12:00:00Z')) / 86400000 <= 60;
    const flags = [...s.flags]; if (recent && !flags.includes('new')) flags.push('newseason');
    return { ...s, flags, n: { pop: pop != null ? Math.round(pop) : null, votes } };
  });
  scored.sort((a, b) => b.buzz - a.buzz || b.reach - a.reach);

  // 5. Episodes, one small file per series (loaded only when someone opens it):
  //    data/episodes/<tmdb id>.json = { "<season>": [[episode, title, air date, runtime, summary], ...] }
  // Seasons that are over (all episodes aired, show not adding to them) are kept from last night instead of re-fetched.
  const EP_DIR = `${root}/public/data/episodes`;
  await mkdir(EP_DIR, { recursive: true });
  const todayStr = new Date().toISOString().slice(0, 10);
  let epCalls = 0, epKept = 0;
  await pool(scored, 6, async (sr) => {
    const file = `${EP_DIR}/${sr.tv}.json`;
    let prev = null; try { prev = JSON.parse(await readFile(file, 'utf8')); } catch { /* new */ }
    const out = {};
    for (const [n, , eps] of sr.seasons) {
      const old = prev?.[n];
      const settled = old && old.length >= eps && old.every((e) => e[2] && e[2] <= todayStr) && !(sr.st === 'on' && n === sr.ns);
      if (settled) { out[n] = old; epKept++; continue; }
      try {
        const r = await tmdb(`/tv/${sr.tv}/season/${n}`, { language: 'en-US' }); epCalls++;
        out[n] = (r.episodes || []).map((e) => [e.episode_number, e.name || `Episode ${e.episode_number}`, e.air_date || 0, e.runtime || 0, clip(e.overview)]);
      } catch { if (old) out[n] = old; }
    }
    await writeFile(file, JSON.stringify(out));
  });
  console.log(`Episodes: fetched ${epCalls} seasons, kept ${epKept} from last night.`);

  await writeFile(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), series: scored }));
  console.log(`Wrote ${scored.length} series to public/data/series.json (OMDb calls: ${calls}).`);
  return calls;
}
