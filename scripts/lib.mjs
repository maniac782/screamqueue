// Pure helpers for the nightly data refresh: subgenre tagging and popularity scoring.
// Kept separate from refresh-data.mjs so they can be tested without network access.

export const GENRE = { horror: 27, thriller: 53, scifi: 878, comedy: 35, mystery: 9648, fantasy: 14, animation: 16 };

// Each subgenre matches TMDB keyword names (lowercased) and/or TMDB genre ids.
// Order matters only for display. Edit freely; the site reads the list from movies.json.
export const SUBGENRES = [
  { key: 'slasher',    label: 'Slasher',             kw: /slasher|serial killer|masked killer|killing spree|final girl|mass murder|psychopath/ },
  { key: 'possession', label: 'Possession',          kw: /possession|possessed|exorcis/ },
  { key: 'demonic',    label: 'Demonic',             kw: /demon|devil|satan|antichrist|\bhell\b|lucifer/ },
  { key: 'ghost',      label: 'Ghosts & Hauntings',  kw: /ghost|haunt|poltergeist|spirit|apparition|séance|seance/ },
  { key: 'occult',     label: 'Occult & Witchcraft', kw: /occult|witch|coven|ritual|black magic|cult\b|cults|curse|cursed/ },
  { key: 'folk',       label: 'Folk Horror',         kw: /folk horror|folklore|pagan|wicker|harvest|rural|village|legend/ },
  { key: 'found',      label: 'Found Footage',       kw: /found footage|mockumentary|faux documentary|screenlife|desktop film|pov/ },
  { key: 'creature',   label: 'Creature Feature',    kw: /monster|creature|kaiju|shark|alien|beast|cryptid|animal attack|giant (animal|insect|spider)|killer animal|spider|snake/ },
  { key: 'zombie',     label: 'Zombies & Infection', kw: /zombie|undead|living dead|outbreak|infection|virus|pandemic/ },
  { key: 'vampire',    label: 'Vampires',            kw: /vampire|dracula|bloodsucker/ },
  { key: 'werewolf',   label: 'Werewolves',          kw: /werewolf|lycanthrop/ },
  { key: 'body',       label: 'Body Horror',         kw: /body horror|mutation|mutant|transformation|parasite|disfigure|flesh/ },
  { key: 'psych',      label: 'Psychological',       kw: /psychological|paranoia|madness|insanity|grief|hallucinat|delusion|mental illness|gaslighting/ },
  { key: 'home',       label: 'Home Invasion',       kw: /home invasion|intruder|break-in|stalker|stalking/ },
  { key: 'survival',   label: 'Survival & Backwoods', kw: /survival|stranded|trapped|wilderness|backwoods|cannibal|hillbilly|lost in the woods|cabin/ },
  { key: 'cosmic',     label: 'Cosmic & Lovecraftian', kw: /lovecraft|cosmic horror|eldritch|cthulhu|other dimension|alternate dimension/ },
  { key: 'tech',       label: 'Tech Horror',         kw: /artificial intelligence|\bai\b|internet|social media|video game|cursed video|technology|robot|computer/ },
  { key: 'teen',       label: 'Teen & Camp',         kw: /teen|high school|summer camp|college|sorority|fraternity|prom/ },
  { key: 'extreme',    label: 'Gore & Extreme',      kw: /torture|gore|splatter|extreme violence|snuff|new french extremity|brutality/ },
  { key: 'classic',    label: 'Classic Monsters',    kw: /universal monsters|frankenstein|mummy|invisible man|hammer horror/ },
  { key: 'anthology',  label: 'Anthology',           kw: /anthology|horror anthology|segment/ },
  { key: 'scifi',      label: 'Sci-Fi Horror',       kw: /space horror|sci-fi horror/, genre: GENRE.scifi },
  { key: 'comedy',     label: 'Horror Comedy',       kw: /horror comedy|horror spoof|splatstick|parody/, genre: GENRE.comedy },
  { key: 'terror',     label: 'Thriller & Terror',   kw: /survival thriller|psychological thriller|suspense/, genre: GENRE.thriller },
];

export function tagSubgenres(keywordNames = [], genreIds = []) {
  const names = keywordNames.map((k) => String(k).toLowerCase());
  const out = [];
  for (const sg of SUBGENRES) {
    const byKw = sg.kw && names.some((n) => sg.kw.test(n));
    const byGenre = sg.genre && genreIds.includes(sg.genre);
    if (byKw || byGenre) out.push(sg.key);
  }
  return out;
}

// Percentile rank (0-100) of each value among the non-null values.
export function percentiles(values) {
  const present = values.map((v, i) => [v, i]).filter(([v]) => v != null && Number.isFinite(v));
  present.sort((a, b) => a[0] - b[0]);
  const out = new Array(values.length).fill(null);
  const n = present.length;
  if (n === 0) return out;
  let i = 0;
  while (i < n) {
    let j = i;
    while (j + 1 < n && present[j + 1][0] === present[i][0]) j++;
    const pct = n === 1 ? 100 : (((i + j) / 2) / (n - 1)) * 100;
    for (let k = i; k <= j; k++) out[present[k][1]] = pct;
    i = j + 1;
  }
  return out;
}

const log = (v) => (v == null ? null : Math.log10(1 + Math.max(0, v)));

// Weighted mean that ignores missing parts and re-normalizes the weights.
export function blend(parts) {
  let w = 0, s = 0;
  for (const [value, weight] of parts) {
    if (value == null || !Number.isFinite(value)) continue;
    w += weight; s += value * weight;
  }
  return w ? s / w : null;
}

export function rankScore(rank, depth = 60) {
  if (!rank) return null;
  return Math.max(0, 100 * (1 - (rank - 1) / depth));
}

export const TIERS = [
  { key: 'favorite', label: 'Crowd Favorite', min: 80 },
  { key: 'known',    label: 'Well-Known',     min: 55 },
  { key: 'cult',     label: 'Cult Pick',      min: 30 },
  { key: 'deep',     label: 'Deep Cut',       min: 0 },
];

export function tierFor(reach) {
  return (TIERS.find((t) => reach >= t.min) || TIERS[TIERS.length - 1]).key;
}

// movies: [{ pop, votes, imdbVotes, traktWatchers, traktPlays, weekRank, dayRank, date }]
// Adds buzz (0-100, "talked about right now"), reach (0-100, "how widely seen"), tier and flags.
export function scoreMovies(movies, today = new Date()) {
  const pPop = percentiles(movies.map((m) => log(m.pop)));
  const pVotes = percentiles(movies.map((m) => log(m.votes)));
  const pImdb = percentiles(movies.map((m) => log(m.imdbVotes)));
  const pTraktNow = percentiles(movies.map((m) => log(m.traktWatchers)));
  const pTraktPlays = percentiles(movies.map((m) => log(m.traktPlays)));
  const day = 86400000;
  return movies.map((m, i) => {
    const trend = Math.max(rankScore(m.weekRank) ?? -1, rankScore(m.dayRank, 40) ?? -1);
    const buzz = blend([
      [pPop[i], 0.45],
      [trend >= 0 ? trend : (m.weekRank === undefined ? null : 0), 0.35],
      [pTraktNow[i], 0.2],
    ]);
    const reach = blend([
      [pVotes[i], 0.5],
      [pImdb[i], 0.35],
      [pTraktPlays[i], 0.15],
    ]);
    const ageDays = m.date ? (today - new Date(m.date + 'T12:00:00Z')) / day : null;
    const isNew = ageDays != null && ageDays >= 0 && ageDays <= 120;
    const soon = ageDays != null && ageDays < 0;
    const b = Math.round(buzz ?? 0), r = Math.round(reach ?? 0);
    const flags = [];
    if (b >= 80 || (m.weekRank && m.weekRank <= 20)) flags.push('hot');
    if (isNew) flags.push('new');
    if (isNew && b < 45) flags.push('quiet');
    if (soon) flags.push('soon');
    return { ...m, buzz: b, reach: r, tier: tierFor(r), flags };
  });
}

export function usCertification(releaseDates, region = 'US') {
  const r = releaseDates?.results?.find((x) => x.iso_3166_1 === region);
  const c = r?.release_dates?.map((d) => d.certification).find((x) => x);
  return c || null;
}
