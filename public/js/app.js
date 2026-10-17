import { VERSION, SITE_NAME, TAGLINE, DEMO, VOTES_PER_PERSON } from './config.js';

const { store } = globalThis.SQ_STORE
  ? { store: globalThis.SQ_STORE }
  : DEMO ? await import('./store-local.js') : await import('./store-firebase.js');

// ---------- state ----------
const S = {
  user: null,
  profile: { name: '', services: [], hideSeen: false },
  mine: new Map(),
  data: null,
  movies: [],
  byId: new Map(),
  provName: new Map(),
  sgLabel: new Map(),
  tierLabel: new Map(),
  config: { showPosters: false, featured: [], hidden: [], sgFix: {}, announcement: '' },
  f: { q: '', sg: new Set(), tier: new Set(), mine: false, hideSeen: false, decade: '', sort: 'buzz', provider: '', limit: 60 },
  p: { sg: new Set(), mix: 'crowd', mine: true, queueOnly: false, maxRt: '', recent: [], current: null },
  qTab: 'queue',
  stopNight: null,
  afterSignIn: '#/',
};

// ---------- helpers ----------
const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'K' : String(n));
const status = (id) => S.mine.get(String(id));
const isSeen = (m) => status(m.id)?.status === 'seen';
const everSeen = (m) => { const st = status(m.id); return st?.status === 'seen' || !!st?.wasSeen; };
const onMine = (m) => S.profile.services.some((p) => m.pv.includes(p) || m.fr.includes(p));
const HUES = ['#b3243f', '#2b8a7e', '#6d55c2', '#b7791f', '#3b6fb6', '#8a3b8f', '#4f7f3a', '#a0522d'];
const hueFor = (m) => HUES[(S.data?.subgenres.findIndex((s) => s.key === m.sg[0]) + 8) % 8 || 0];
const SAMPLE = () => !!S.data?.sample;

function toast(msg) {
  document.querySelectorAll('.toast').forEach((x) => x.remove());
  const t = document.createElement('div');
  t.className = 'toast'; t.setAttribute('role', 'status'); t.textContent = msg;
  document.body.append(t);
  setTimeout(() => t.remove(), 2600);
}

function needUser() {
  if (S.user) return true;
  S.afterSignIn = location.hash || '#/';
  location.hash = '#/signin';
  return false;
}

function links(m) {
  const q = encodeURIComponent(`${m.t} ${m.y || ''}`.trim());
  if (SAMPLE()) {
    return [
      ['Letterboxd', `https://letterboxd.com/search/${encodeURIComponent(m.t)}/`],
      ['IMDb', `https://www.imdb.com/find/?q=${q}`],
      ['TMDB', `https://www.themoviedb.org/search?query=${q}`],
      ['Where to watch', `https://www.justwatch.com/us/search?q=${encodeURIComponent(m.t)}`],
    ];
  }
  const out = [['Letterboxd', `https://letterboxd.com/tmdb/${m.id}/`]];
  if (m.imdb?.id) out.push(['IMDb', `https://www.imdb.com/title/${m.imdb.id}/`]);
  out.push(['TMDB', `https://www.themoviedb.org/movie/${m.id}`]);
  if (m.wl) out.push(['Where to watch', m.wl]);
  return out;
}

function whyBuzz(m) {
  const out = [];
  if (m.weekRank) out.push(`#${m.weekRank} horror movie on TMDB's trending list this week`);
  else if (m.dayRank) out.push(`#${m.dayRank} horror movie on TMDB's trending list today`);
  if (m.n?.trakt) out.push(`${fmt(m.n.trakt)} people watching on Trakt right now`);
  if (m.flags.includes('quiet')) out.push('Just released, but few people are talking about it yet');
  if (!out.length) out.push(m.buzz >= 60 ? 'Lots of activity on TMDB lately' : m.buzz >= 35 ? 'Steady interest on TMDB' : 'Not much chatter right now');
  return out;
}
function whyReach(m) {
  const out = [];
  if (m.imdb?.v) out.push(`${fmt(m.imdb.v)} IMDb ratings${m.imdb.r ? ` · avg ${m.imdb.r}` : ''}`);
  if (m.n?.votes) out.push(`${fmt(m.n.votes)} TMDB ratings${m.va ? ` · avg ${m.va.toFixed(1)}` : ''}`);
  if (m.n?.plays) out.push(`${fmt(m.n.plays)} Trakt watchers`);
  if (!out.length) out.push({ favorite: 'Most horror fans have seen this one', known: 'Widely seen by horror fans', cult: 'A smaller but devoted audience', deep: 'Few people have found this one', fresh: 'Too new to have many ratings yet' }[m.tier]);
  return out;
}

function meter(label, value, color) {
  const on = Math.round(value / 10);
  return `<div class="meter" style="--m:${color}"><div class="lbl"><span>${label}</span><b>${value}</b></div>
    <div class="bar" aria-hidden="true">${Array.from({ length: 10 }, (_, i) => `<i class="${i < on ? 'on' : ''}"></i>`).join('')}</div></div>`;
}

function servicesText(m) {
  const names = [...m.pv, ...m.fr].map((p) => S.provName.get(p)).filter(Boolean);
  if (names.length) return names.slice(0, 3).join(', ') + (names.length > 3 ? ` +${names.length - 3}` : '');
  return m.rent ? 'Rent or buy' : 'Not streaming';
}

function cover(m) {
  const st = status(m.id);
  const img = S.config.showPosters && m.poster;
  return `<div class="cover ${img ? 'has-img' : ''}" style="--hue:${hueFor(m)}">
    ${img ? `<img loading="lazy" alt="" src="https://image.tmdb.org/t/p/w342${m.poster}">` : ''}
    <div class="band"></div>
    <div class="label"><span class="ttl">${esc(m.t)}</span><span class="yr">${m.y ?? ''}${m.rt ? ` · ${m.rt} min` : ''}</span></div>
    <div class="foot"><span>BUZZ ${m.buzz}</span><span>REACH ${m.reach}</span></div>
    <span class="sticker t-${m.tier}">${esc(S.tierLabel.get(m.tier))}</span>
    ${m.flags.includes('hot') ? '<span class="sticker hot">Hot this week</span>' : ''}
    ${st ? `<span class="mark">${st.status === 'seen' ? 'Seen' : 'Queued'}</span>` : ''}
  </div>`;
}

function card(m) {
  const tags = m.sg.slice(0, 2).map((k) => `<span class="tag">${esc(S.sgLabel.get(k))}</span>`).join('');
  return `<button class="sleeve" data-act="open" data-id="${m.id}" aria-label="${esc(m.t)}${m.y ? ` (${m.y})` : ''}">
    ${cover(m)}
    <span class="meta"><span class="muted" style="font-size:.82rem">${esc(servicesText(m))}</span><span class="chips">${tags}</span></span>
  </button>`;
}

function shelf(title, desc, list, emptyText, more) {
  return `<section class="shelf">
    <div class="shelf-head"><div><h2>${title}</h2>${desc ? `<p class="muted">${desc}</p>` : ''}</div>${more || ''}</div>
    ${list.length ? `<div class="shelf-track">${list.map(card).join('')}</div>` : `<div class="empty">${emptyText}</div>`}
  </section>`;
}

// ---------- data ----------
async function loadData() {
  const res = await fetch('data/movies.json', { cache: 'no-cache' });
  S.data = await res.json();
  S.provName = new Map(S.data.providers.map((p) => [p.id, p.name]));
  S.sgLabel = new Map(S.data.subgenres.map((s) => [s.key, s.label]));
  S.tierLabel = new Map(S.data.tiers.map((t) => [t.key, t.label]));
  applyConfig();
}
function applyConfig() {
  const hidden = new Set((S.config.hidden || []).map(String));
  S.movies = S.data.movies
    .filter((m) => !hidden.has(String(m.id)))
    .map((m) => (S.config.sgFix?.[m.id] ? { ...m, sg: S.config.sgFix[m.id] } : m));
  S.byId = new Map(S.data.movies.map((m) => [String(m.id), S.config.sgFix?.[m.id] ? { ...m, sg: S.config.sgFix[m.id] } : m]));
}
async function loadMine() {
  if (!S.user) { S.mine = new Map(); S.profile = { name: '', services: [], hideSeen: false }; return; }
  [S.profile, S.mine] = await Promise.all([store.getProfile(), store.loadMyMovies()]);
  S.f.hideSeen = S.profile.hideSeen;
  if (!S.profile.services.length) S.p.mine = false;
}

// ---------- views ----------
const views = {};

views.tonight = () => {
  const pool = S.movies.filter((m) => !isSeen(m));
  const featured = (S.config.featured || []).map((id) => S.byId.get(String(id))).filter(Boolean);
  const mineFirst = (list) => (S.profile.services.length ? list.filter(onMine) : list);
  const hot = pool.filter((m) => m.flags.includes('hot') || m.buzz >= 70).sort((a, b) => b.buzz - a.buzz).slice(0, 16);
  const crowd = mineFirst(pool.filter((m) => m.tier === 'favorite' || m.tier === 'known')).sort((a, b) => b.buzz + b.reach - a.buzz - a.reach).slice(0, 16);
  const cult = pool.filter((m) => m.tier === 'cult').sort((a, b) => b.buzz - a.buzz).slice(0, 16);
  const newBuzz = pool.filter((m) => m.flags.includes('new') && !m.flags.includes('quiet')).sort((a, b) => b.buzz - a.buzz).slice(0, 16);
  const quiet = pool.filter((m) => m.flags.includes('quiet')).sort((a, b) => (b.date || '').localeCompare(a.date || '')).slice(0, 16);
  const shudder = pool.filter((m) => m.pv.includes(99)).sort((a, b) => b.buzz - a.buzz).slice(0, 16);
  const top = featured[0] || mineFirst(hot)[0] || hot[0] || pool[0];
  const firstRun = 'Shows up after the first nightly data refresh.';
  return `
  <section class="hero">
    <div class="stack">
      <span class="kicker">Tonight</span>
      <h1>What are we watching?</h1>
      <p class="muted">Horror sorted by what people are actually watching and talking about, not just what came out this week. ${S.profile.services.length ? 'Shelves lean toward your streaming services.' : '<a href="#/settings">Add your streaming services</a> to see what you can watch right now.'}</p>
      <div class="row"><a class="btn primary" href="#/pick">Pick for me</a><a class="btn" href="#/browse">Browse the shelves</a></div>
    </div>
    ${top ? `<div class="hero-pick">
      <button class="sleeve" data-act="open" data-id="${top.id}" aria-label="${esc(top.t)}">${cover(top)}</button>
      <div class="stack" style="gap:8px">
        <span class="kicker">${featured[0] ? 'Featured pick' : 'Top of the shelf'}</span>
        <h2>${esc(top.t)} <span class="muted mono" style="font-size:.9rem">${top.y ?? ''}</span></h2>
        <p class="muted" style="font-size:.92rem">${esc(whyBuzz(top)[0])}. ${esc(servicesText(top))}.</p>
        <div class="row"><button class="btn small" data-act="open" data-id="${top.id}">Details</button>${queueBtn(top, true)}</div>
      </div></div>` : ''}
  </section>
  ${featured.length > 1 ? shelf('Featured', 'Hand-picked by the site admin.', featured, '') : ''}
  ${shelf('Trending this week', 'The horror movies with the most activity right now.', hot, firstRun, '<a class="btn small ghost" href="#/browse">See all</a>')}
  ${shelf(S.profile.services.length ? 'Crowd favorites on your services' : 'Crowd favorites', 'Widely seen, well-liked, easy to get a group on board with.', crowd, S.profile.services.length ? 'Nothing from this shelf is on your services. Try the Browse page.' : firstRun)}
  ${shelf('New and buzzing', 'Released in the last four months and getting real attention.', newBuzz, firstRun)}
  ${shelf('New and quiet', 'Recently released, but few people are watching yet. Proceed with curiosity.', quiet, firstRun)}
  ${shelf('Cult picks', 'Smaller audiences, loyal fans.', cult, firstRun)}
  ${shelf('On Shudder now', 'Ranked by current buzz.', shudder, firstRun)}`;
};

function queueBtn(m, small) {
  const st = status(m.id);
  const on = st?.status === 'queue';
  return `<button class="btn ${small ? 'small' : ''}" data-act="queue" data-id="${m.id}" aria-pressed="${on}">${on ? 'In your queue' : st?.status === 'seen' ? 'Queue again' : 'Add to queue'}</button>`;
}

// Browse
function filtered() {
  const f = S.f; const q = f.q.trim().toLowerCase();
  let list = S.movies.filter((m) =>
    (!q || m.t.toLowerCase().includes(q) || m.dir.some((d) => d.toLowerCase().includes(q))) &&
    (!f.sg.size || [...f.sg].every((k) => m.sg.includes(k))) &&
    (!f.tier.size || f.tier.has(m.tier)) &&
    (!f.mine || onMine(m)) &&
    (!f.provider || m.pv.includes(Number(f.provider)) || m.fr.includes(Number(f.provider))) &&
    (!f.hideSeen || !isSeen(m)) &&
    (!f.decade || (m.y && Math.floor(m.y / 10) * 10 === Number(f.decade))));
  const by = {
    buzz: (a, b) => b.buzz - a.buzz,
    reach: (a, b) => b.reach - a.reach,
    rating: (a, b) => (b.imdb?.r ?? b.va ?? 0) - (a.imdb?.r ?? a.va ?? 0),
    newest: (a, b) => (b.date || '').localeCompare(a.date || ''),
    title: (a, b) => a.t.localeCompare(b.t),
  }[f.sort];
  return list.sort(by);
}
function renderResults() {
  const list = filtered();
  const el = $('#results'); if (!el) return;
  el.innerHTML = `<p class="muted mono" style="font-size:.85rem">${list.length} movie${list.length === 1 ? '' : 's'}</p>
    ${list.length ? `<div class="grid">${list.slice(0, S.f.limit).map(card).join('')}</div>` : '<div class="empty">Nothing matches all of those filters. Try removing a subgenre.</div>'}
    ${list.length > S.f.limit ? '<div class="row" style="justify-content:center"><button class="btn" data-act="more">Show more</button></div>' : ''}`;
}
views.browse = () => {
  const f = S.f;
  const decades = [...new Set(S.movies.map((m) => m.y && Math.floor(m.y / 10) * 10).filter(Boolean))].sort((a, b) => b - a);
  const provs = S.data.providers.filter((p) => S.movies.some((m) => m.pv.includes(p.id) || m.fr.includes(p.id)));
  setTimeout(renderResults);
  return `<div class="page-head"><h1>Browse the shelves</h1><p class="muted">Stack subgenres to narrow it down. Buzz is what people are watching now; Reach is how widely it has been seen overall.</p></div>
  <div class="panel filters">
    <div class="toolbar">
      <input type="search" id="f-q" data-bind="q" placeholder="Search by title or director" value="${esc(f.q)}" aria-label="Search">
      <select id="f-sort" data-bind="sort" aria-label="Sort">${[['buzz', 'Most buzz'], ['reach', 'Most seen'], ['rating', 'Highest rated'], ['newest', 'Newest'], ['title', 'Title A–Z']].map(([v, l]) => `<option value="${v}" ${f.sort === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
      <select id="f-decade" data-bind="decade" aria-label="Decade"><option value="">Any decade</option>${decades.map((d) => `<option value="${d}" ${String(f.decade) === String(d) ? 'selected' : ''}>${d}s</option>`).join('')}</select>
      <select id="f-provider" data-bind="provider" aria-label="Streaming service"><option value="">Any service</option>${provs.map((p) => `<option value="${p.id}" ${String(f.provider) === String(p.id) ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select>
    </div>
    <div class="filter-row"><span>Subgenre</span><div class="chips">${S.data.subgenres.map((s) => `<button class="chip" data-act="fsg" data-k="${s.key}" aria-pressed="${f.sg.has(s.key)}">${esc(s.label)}</button>`).join('')}</div></div>
    <div class="filter-row"><span>How known</span><div class="chips">${S.data.tiers.map((t) => `<button class="chip" data-act="ftier" data-k="${t.key}" aria-pressed="${f.tier.has(t.key)}">${esc(t.label)}</button>`).join('')}</div></div>
    <div class="filter-row"><span>Show</span><div class="chips">
      <button class="chip" data-act="fmine" aria-pressed="${f.mine}" ${S.profile.services.length ? '' : 'disabled title="Add services in Settings"'}>On my services</button>
      <button class="chip" data-act="fseen" aria-pressed="${f.hideSeen}">Hide what I've seen</button>
      ${f.sg.size || f.tier.size || f.q || f.decade || f.provider || f.mine ? '<button class="chip" data-act="fclear">Clear filters</button>' : ''}
    </div></div>
  </div>
  <div id="results" class="stack"></div>`;
};

// Pick for me
function pickOne() {
  const p = S.p;
  const tiers = { crowd: ['favorite', 'known', 'fresh'], different: ['known', 'cult', 'fresh'], deep: ['cult', 'deep'], any: ['favorite', 'known', 'cult', 'deep', 'fresh'] }[p.mix];
  let pool = S.movies.filter((m) => !isSeen(m) && tiers.includes(m.tier) && (m.tier !== 'fresh' || p.mix !== 'crowd' || m.buzz >= 70) && !m.flags.includes('soon') &&
    (!p.sg.size || m.sg.some((k) => p.sg.has(k))) &&
    (!p.mine || onMine(m)) &&
    (!p.queueOnly || status(m.id)?.status === 'queue') &&
    (!p.maxRt || !m.rt || m.rt <= Number(p.maxRt)));
  const fresh = pool.filter((m) => !p.recent.includes(m.id));
  if (fresh.length) pool = fresh;
  if (!pool.length) return null;
  const weight = (m) => {
    let w = { crowd: 10 + m.buzz + m.reach, different: 20 + m.buzz + (m.va || 6) * 6, deep: 30 + (100 - m.reach) + m.buzz / 2, any: 20 + m.buzz }[p.mix];
    if (status(m.id)?.status === 'queue') w *= 1.4;
    return Math.max(1, w);
  };
  const total = pool.reduce((s, m) => s + weight(m), 0);
  let r = Math.random() * total;
  for (const m of pool) { r -= weight(m); if (r <= 0) return m; }
  return pool[pool.length - 1];
}
function renderPick() {
  const el = $('#pick-result'); if (!el) return;
  const m = S.p.current && S.byId.get(String(S.p.current));
  if (!m) { el.innerHTML = `<div class="empty">${S.p.current === false ? 'Nothing fits all of those choices. Loosen a filter and try again.' : 'Set your mood on the left, then press Pick for me.'}</div>`; return; }
  el.innerHTML = `<div class="panel hero-pick" style="grid-template-columns:150px minmax(0,1fr)">
    <button class="sleeve" data-act="open" data-id="${m.id}" aria-label="${esc(m.t)}">${cover(m)}</button>
    <div class="stack" style="gap:10px">
      <h2>${esc(m.t)} <span class="muted mono" style="font-size:.9rem">${m.y ?? ''}</span></h2>
      <div class="chips">${m.sg.map((k) => `<span class="tag">${esc(S.sgLabel.get(k))}</span>`).join('')}</div>
      <p class="muted" style="font-size:.92rem">${esc(m.ov || '')}</p>
      <p style="font-size:.9rem"><b>Watch:</b> ${esc(servicesText(m))}</p>
      <div class="meters">${meter('Buzz', m.buzz, 'var(--accent)')}${meter('Reach', m.reach, 'var(--teal)')}</div>
      <div class="row"><button class="btn primary" data-act="repick">Another one</button>${queueBtn(m)}<button class="btn" data-act="open" data-id="${m.id}">Details</button></div>
    </div></div>`;
}
views.pick = () => {
  const p = S.p;
  setTimeout(renderPick);
  return `<div class="page-head"><h1>Pick for me</h1><p class="muted">Tell it the mood and it pulls one from the shelf, weighted toward what fits. Movies you've seen are skipped.</p></div>
  <div class="two-col">
    <div class="panel filters">
      <div class="filter-row"><span>Mood</span><div class="chips">${[['crowd', 'Crowd pleaser'], ['different', 'Something different'], ['deep', 'Deep cut'], ['any', 'Surprise me']].map(([k, l]) => `<button class="chip" data-act="pmix" data-k="${k}" aria-pressed="${p.mix === k}">${l}</button>`).join('')}</div></div>
      <div class="filter-row"><span>Any of</span><div class="chips">${S.data.subgenres.map((s) => `<button class="chip" data-act="psg" data-k="${s.key}" aria-pressed="${p.sg.has(s.key)}">${esc(s.label)}</button>`).join('')}</div></div>
      <div class="filter-row"><span>Limits</span><div class="chips">
        <button class="chip" data-act="pmine" aria-pressed="${p.mine}" ${S.profile.services.length ? '' : 'disabled title="Add services in Settings"'}>On my services</button>
        <button class="chip" data-act="pqueue" aria-pressed="${p.queueOnly}" ${S.user ? '' : 'disabled'}>From my queue</button>
        <select id="p-rt" data-bind="maxRt" aria-label="Maximum length" style="width:auto"><option value="">Any length</option>${[90, 100, 110, 120].map((n) => `<option value="${n}" ${String(p.maxRt) === String(n) ? 'selected' : ''}>Under ${n} min</option>`).join('')}</select>
      </div></div>
      <div class="row"><button class="btn primary" data-act="repick">Pick for me</button></div>
    </div>
    <div id="pick-result"></div>
  </div>`;
};

// Queue
views.queue = () => {
  if (!S.user) return signInPrompt('Sign in to keep a watch queue and track what you have seen.');
  const all = [...S.mine.entries()].map(([id, st]) => ({ m: S.byId.get(id), st, id })).filter((x) => x.m);
  const q = all.filter((x) => x.st.status === 'queue').sort((a, b) => b.st.at - a.st.at);
  const seen = all.filter((x) => x.st.status === 'seen').sort((a, b) => b.st.at - a.st.at);
  const counts = {};
  for (const { m } of seen) for (const k of m.sg) counts[k] = (counts[k] || 0) + 1;
  const favs = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, n]) => `${S.sgLabel.get(k)} (${n})`).join(', ');
  const tab = S.qTab;
  const rows = tab === 'queue' ? q : seen;
  return `<div class="page-head"><h1>My queue</h1><p class="muted">${q.length} to watch · ${seen.length} seen${favs ? ` · Most watched: ${esc(favs)}` : ''}</p></div>
  <div class="tabs" role="tablist"><button role="tab" data-act="qtab" data-k="queue" aria-selected="${tab === 'queue'}">To watch (${q.length})</button><button role="tab" data-act="qtab" data-k="seen" aria-selected="${tab === 'seen'}">Seen (${seen.length})</button></div>
  ${tab === 'seen' ? '<p class="muted">Badges, milestones and your watch log live in the <a href="#/trophies">Trophy Case</a>.</p>' : ''}
  ${rows.length ? `<div class="grid">${rows.map((x) => card(x.m)).join('')}</div>` : `<div class="empty">${tab === 'queue' ? 'Your queue is empty. Add movies from any shelf with "Add to queue".' : 'Nothing marked as seen yet. Open a movie and press "Seen it".'}</div>`}`;
};

// Movie nights
views.nights = async () => {
  if (!S.user) return signInPrompt('Sign in to start a movie night and vote with friends.');
  const list = (await store.listNights()).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  return `<div class="page-head"><h1>Movie nights</h1><p class="muted">Start a night, send friends the link, everyone suggests movies and gets ${VOTES_PER_PERSON} votes.</p></div>
  <div class="two-col">
    <div class="list">${list.length ? list.map((n) => `<a class="list-item" href="#/night/${n.id}" style="text-decoration:none;color:inherit">
      <div><div class="t">${esc(n.title)}</div><div class="muted" style="font-size:.85rem">${n.date ? esc(n.date) + ' · ' : ''}${n.members.length} ${n.members.length === 1 ? 'person' : 'people'} · ${Object.keys(n.candidates || {}).length} suggestions${n.winner ? ' · Decided: ' + esc(S.byId.get(String(n.winner))?.t || '') : ''}</div></div>
      <span class="tag">${n.status === 'decided' ? 'Decided' : 'Voting'}</span></a>`).join('') : '<div class="empty">No movie nights yet. Start one on the right.</div>'}</div>
    <form class="panel stack" data-form="new-night">
      <h2>Start a movie night</h2>
      <label class="field">Name<input type="text" id="night-title" name="title" required maxlength="60" placeholder="Friday Fright Night"></label>
      <label class="field">Date (optional)<input type="date" id="night-date" name="date"></label>
      <button class="btn primary" type="submit">Create and get the link</button>
    </form>
  </div>`;
};

function renderNight(n, id) {
  const el = $('#night'); if (!el) return;
  if (!n) { el.innerHTML = '<div class="empty">This movie night was not found. It may have been deleted, or the link is incomplete.</div>'; return; }
  const me = S.user.uid;
  const member = n.members.includes(me);
  const owner = n.owner === me;
  if (!member) {
    el.innerHTML = `<div class="panel stack auth-card"><h1>${esc(n.title)}</h1><p class="muted">${esc(n.memberNames?.[n.owner] || 'Someone')} invited you to suggest and vote on what to watch${n.date ? ' on ' + esc(n.date) : ''}.</p><button class="btn primary" data-act="join" data-id="${id}">Join this movie night</button></div>`;
    return;
  }
  const votes = n.votes || {};
  const mine = votes[me] || [];
  const tally = {};
  for (const arr of Object.values(votes)) for (const v of arr) tally[v] = (tally[v] || 0) + 1;
  const cands = Object.entries(n.candidates || {}).map(([mid, c]) => ({ mid, c, m: S.byId.get(mid), v: tally[mid] || 0 })).filter((x) => x.m).sort((a, b) => b.v - a.v || a.m.t.localeCompare(b.m.t));
  const winner = n.winner && S.byId.get(String(n.winner));
  const queueIdeas = [...S.mine.entries()].filter(([mid, st]) => st.status === 'queue' && !n.candidates?.[mid]).map(([mid]) => S.byId.get(mid)).filter(Boolean).slice(0, 8);
  const link = location.href.split('#')[0] + '#/night/' + id;
  el.innerHTML = `
  <div class="page-head"><h1>${esc(n.title)}</h1><p class="muted">${n.date ? esc(n.date) + ' · ' : ''}${n.members.map((u) => esc(n.memberNames?.[u] || 'Guest')).join(', ')}</p></div>
  ${winner ? `<div class="panel list-item winner"><div><div class="muted" style="font-size:.8rem;text-transform:uppercase;letter-spacing:.1em">We're watching</div><div class="t" style="font-size:1.3rem">${esc(winner.t)} <span class="muted mono" style="font-size:.9rem">${winner.y ?? ''}</span></div><div class="muted" style="font-size:.9rem">${esc(servicesText(winner))}</div></div>
    <div class="row"><button class="btn small" data-act="open" data-id="${winner.id}">Details</button><button class="btn small" data-act="seen" data-id="${winner.id}">Mark seen</button>${owner ? `<button class="btn small ghost" data-act="decide" data-night="${id}" data-id="">Reopen voting</button>` : ''}</div></div>` : ''}
  <div class="two-col">
    <section class="stack">
      <div class="shelf-head"><h2>Suggestions</h2><span class="muted mono" style="font-size:.85rem">You have ${Math.max(0, VOTES_PER_PERSON - mine.length)} of ${VOTES_PER_PERSON} votes left</span></div>
      <div class="list">${cands.length ? cands.map(({ mid, c, m, v }) => {
        const voted = mine.includes(mid);
        return `<div class="list-item ${winner && String(winner.id) === mid ? 'winner' : ''}">
          <div style="min-width:0"><button class="btn ghost small" style="padding:0;border:0;text-transform:none;font-family:var(--font-body);font-size:1rem;font-weight:600;letter-spacing:0" data-act="open" data-id="${mid}">${esc(m.t)}</button> <span class="muted mono" style="font-size:.85rem">${m.y ?? ''}</span>
          <div class="muted" style="font-size:.82rem">${esc(servicesText(m))} · suggested by ${esc(n.memberNames?.[c.by] || 'Guest')}</div></div>
          <div class="row"><span class="tally" aria-label="${v} votes">${v}</span>
            <button class="btn small" data-act="vote" data-night="${id}" data-id="${mid}" aria-pressed="${voted}" ${!voted && mine.length >= VOTES_PER_PERSON ? 'disabled' : ''}>${voted ? 'Voted' : 'Vote'}</button>
            ${owner ? `<button class="btn small" data-act="decide" data-night="${id}" data-id="${mid}">Pick</button><button class="btn small ghost" data-act="unsuggest" data-night="${id}" data-id="${mid}" aria-label="Remove ${esc(m.t)}">Remove</button>` : ''}</div>
        </div>`;
      }).join('') : '<div class="empty">No suggestions yet. Add a few from the right.</div>'}</div>
    </section>
    <aside class="stack">
      <div class="panel stack"><h3>Invite friends</h3><p class="muted" style="font-size:.9rem">Anyone with this link can sign up and join.</p>
        <input type="text" id="invite-link" readonly value="${esc(link)}" aria-label="Invite link"><button class="btn" data-act="copy" data-target="invite-link">Copy link</button></div>
      <div class="panel stack"><h3>Suggest a movie</h3>
        <input type="search" id="night-search" placeholder="Search titles" aria-label="Search titles to suggest">
        <div id="night-search-results" class="list"></div>
        ${queueIdeas.length ? `<div class="muted" style="font-size:.85rem">From your queue</div><div class="chips">${queueIdeas.map((m) => `<button class="chip" data-act="suggest" data-night="${id}" data-id="${m.id}">+ ${esc(m.t)}</button>`).join('')}</div>` : ''}
      </div>
      ${owner ? `<button class="btn ghost" data-act="delnight" data-night="${id}">Delete this movie night</button>` : ''}
    </aside>
  </div>`;
  el.dataset.night = id;
}
views.night = (id) => {
  if (!S.user) return signInPrompt('Sign in or create an account to join this movie night.');
  setTimeout(() => { S.stopNight = store.watchNight(id, (n) => { S.lastNight = n; renderNight(n, id); }); });
  return '<div id="night" class="stack"><div class="empty">Loading movie night…</div></div>';
};

// Settings
views.settings = () => {
  if (!S.user) return signInPrompt('Sign in to save your name and streaming services.');
  let theme = 'system'; try { theme = localStorage.getItem('sq-theme') || 'system'; } catch { /* ignore */ }
  return `<div class="page-head"><h1>Settings</h1></div>
  <form class="panel stack" data-form="settings" style="max-width:760px">
    <label class="field">Display name (shown on movie nights)<input type="text" id="set-name" name="name" maxlength="40" value="${esc(S.profile.name)}"></label>
    <div class="stack" style="gap:6px"><span class="muted" style="font-size:.9rem">Streaming services you have</span>
      <div class="chips">${S.data.providers.map((p) => `<button type="button" class="chip" data-act="svc" data-k="${p.id}" aria-pressed="${S.profile.services.includes(p.id)}">${esc(p.name)}</button>`).join('')}</div></div>
    <label class="row" style="gap:8px"><input type="checkbox" id="set-hide" name="hideSeen" ${S.profile.hideSeen ? 'checked' : ''}> Hide movies I've seen when browsing</label>
    <label class="field" style="max-width:220px">Theme<select id="set-theme" data-bind-theme>${['system', 'dark', 'light'].map((t) => `<option value="${t}" ${theme === t ? 'selected' : ''}>${t[0].toUpperCase() + t.slice(1)}</option>`).join('')}</select></label>
    <div class="row"><button class="btn primary" type="submit">Save settings</button><button class="btn ghost" type="button" data-act="signout">Sign out</button>${store.demo ? '<button class="btn ghost" type="button" data-act="resetdemo">Reset demo data</button>' : ''}</div>
  </form>`;
};

// Sign in
function signInPrompt(msg) {
  return `<div class="panel stack auth-card"><h1>Sign in</h1><p class="muted">${msg}</p><a class="btn primary" href="#/signin" data-act="gosignin">Sign in or create an account</a></div>`;
}
views.signin = () => {
  if (S.user) { setTimeout(() => (location.hash = S.afterSignIn || '#/')); return ''; }
  return `<div class="panel stack auth-card">
    <h1>Welcome to ${esc(SITE_NAME)}</h1>
    <p class="muted">${esc(TAGLINE)} An account keeps your queue, ratings and movie nights.</p>
    ${store.demo ? '<p class="ok">Demo mode: any details work and nothing leaves this browser.</p>' : ''}
    <button class="btn primary" data-act="google">Continue with Google</button>
    <div class="divider">or use email</div>
    <div class="tabs" role="tablist"><button role="tab" data-act="authtab" data-k="in" aria-selected="${S.authTab !== 'up'}">Sign in</button><button role="tab" data-act="authtab" data-k="up" aria-selected="${S.authTab === 'up'}">Create account</button></div>
    <form class="stack" data-form="auth">
      ${S.authTab === 'up' ? '<label class="field">Display name<input type="text" id="auth-name" name="name" maxlength="40" required></label>' : ''}
      <label class="field">Email<input type="email" id="auth-email" name="email" required autocomplete="email"></label>
      <label class="field">Password<input type="password" id="auth-pass" name="password" required minlength="6" autocomplete="${S.authTab === 'up' ? 'new-password' : 'current-password'}"></label>
      <p class="error" id="auth-msg" hidden></p>
      <div class="row"><button class="btn primary" type="submit">${S.authTab === 'up' ? 'Create account' : 'Sign in'}</button>${S.authTab === 'up' ? '' : '<button class="btn ghost" type="button" data-act="reset">Forgot password</button>'}</div>
    </form></div>`;
};

// About
views.about = () => `<div class="page-head"><h1>How ${esc(SITE_NAME)} works</h1></div>
  <div class="panel stack" style="max-width:760px">
    <p>Every night the site pulls the most popular, most trending and most-rated horror movies from TMDB, along with where they're streaming in the US.</p>
    <h3>Buzz (0–100)</h3><p class="muted">How much activity a movie is getting right now: its place on TMDB's daily and weekly trending lists, its current TMDB popularity, and (when connected) how many people are watching it on Trakt.</p>
    <h3>Reach (0–100)</h3><p class="muted">How widely it has been seen overall: rating counts on TMDB and IMDb, and Trakt watchers when available. Reach sets the sticker on each sleeve:</p>
    <div class="chips">${S.data.tiers.map((t) => `<span class="tag">${esc(t.label)}</span>`).join('')}</div>
    <p class="muted">A movie that came out last week with low Buzz and low Reach lands on the "New and quiet" shelf, so you can tell a new release from one people are actually watching.</p>
    <h3>Subgenres</h3><p class="muted">Tagged from TMDB keywords (for example "slasher", "demonic possession", "found footage") plus genre overlaps like horror-comedy and sci-fi horror. A movie can have several. The admin can correct tags.</p>
    <p class="muted" style="font-size:.85rem">Both scores are relative to the other horror movies on the site, not to all movies.</p>
  </div>`;

// Admin
views.admin = async () => {
  if (!S.user?.isAdmin) return '<div class="empty">This page is for site admins.</div>';
  const stats = await store.adminStats().catch(() => ({ users: '—' }));
  const c = S.config;
  const d = S.data;
  const listOf = (ids, act) => ids.map((id) => S.byId.get(String(id))).filter(Boolean).map((m) => `<div class="list-item"><span>${esc(m.t)} <span class="muted mono">${m.y ?? ''}</span></span><button class="btn small ghost" data-act="${act}" data-id="${m.id}">Remove</button></div>`).join('') || '<p class="muted">None.</p>';
  const fix = S.adminFix && S.byId.get(String(S.adminFix));
  return `<div class="page-head"><h1>Admin</h1><p class="muted">Site-wide settings. Changes apply for everyone after you press Save.</p></div>
  <div class="two-col">
  <div class="stack">
    <div class="panel stack"><h2>Data</h2>
      <p class="mono" style="font-size:.9rem">${d.movies.length} movies · refreshed ${new Date(d.generatedAt).toLocaleString()}<br>
      Sources: TMDB ${d.sources.tmdb ? 'on' : 'off'} · Trakt ${d.sources.trakt ? 'on' : 'off'} · OMDb/IMDb ${d.sources.omdb ? 'on' : 'off'}${d.sample ? '<br>Showing sample data until the first nightly refresh runs.' : ''}<br>Accounts: ${stats.users}</p></div>
    <div class="panel stack"><h2>Site settings</h2>
      <label class="row" style="gap:8px"><input type="checkbox" id="adm-posters" ${c.showPosters ? 'checked' : ''}> Show TMDB poster art on sleeves</label>
      <p class="muted" style="font-size:.85rem">Posters belong to the studios. TMDB's API terms allow showing them with TMDB credit. Off by default.</p>
      <label class="field">Announcement banner (leave blank for none)<input type="text" id="adm-announce" maxlength="160" value="${esc(c.announcement || '')}"></label>
    </div>
    <div class="panel stack"><h2>Fix a movie's subgenres</h2>
      <input type="search" id="adm-fix-search" placeholder="Search a title" aria-label="Search a title to fix">
      <div id="adm-fix-results" class="list"></div>
      ${fix ? `<div class="stack"><b>${esc(fix.t)}</b><div class="chips">${d.subgenres.map((s) => `<button class="chip" data-act="fixsg" data-k="${s.key}" aria-pressed="${fix.sg.includes(s.key)}">${esc(s.label)}</button>`).join('')}</div>${c.sgFix?.[fix.id] ? `<button class="btn small ghost" data-act="fixclear" data-id="${fix.id}">Use automatic tags again</button>` : ''}</div>` : ''}
    </div>
  </div>
  <div class="stack">
    <div class="panel stack"><h2>Featured</h2><div class="list">${listOf(c.featured || [], 'unfeature')}</div>
      <input type="search" id="adm-feat-search" placeholder="Search to feature" aria-label="Search a title to feature"><div id="adm-feat-results" class="list"></div></div>
    <div class="panel stack"><h2>Hidden from the site</h2><div class="list">${listOf(c.hidden || [], 'unhide')}</div>
      <input type="search" id="adm-hide-search" placeholder="Search to hide" aria-label="Search a title to hide"><div id="adm-hide-results" class="list"></div></div>
    <button class="btn primary" data-act="savecfg">Save admin changes</button>
  </div></div>`;
};

function searchList(q, act, n = 6) {
  q = q.trim().toLowerCase(); if (!q) return '';
  return S.data.movies.filter((m) => m.t.toLowerCase().includes(q)).slice(0, n)
    .map((m) => `<div class="list-item"><span>${esc(m.t)} <span class="muted mono">${m.y ?? ''}</span></span><button class="btn small" data-act="${act}" data-id="${m.id}">${{ feature: 'Feature', hide: 'Hide', fixpick: 'Edit tags', nsuggest: 'Suggest' }[act]}</button></div>`).join('') || '<p class="muted">No matches.</p>';
}

// ---------- trophy case ----------
const MILESTONES = [
  [1, 'First Blood', 'Logged your first horror movie'],
  [13, 'Unlucky 13', 'Thirteen movies seen'],
  [31, 'Thirty-One Nights', 'A full October of horror'],
  [50, 'Half a Hundred', 'Fifty movies seen'],
  [100, 'Centurion', 'One hundred movies seen'],
  [250, 'Lifer', 'Two hundred fifty movies seen'],
  [500, 'Crypt Keeper', 'Five hundred movies seen'],
  [666, 'Number of the Beast', 'Six hundred sixty-six movies seen'],
];
const LEVELS = [[1, 'Initiate'], [5, 'Regular'], [10, 'Devotee'], [25, 'Master']];
const ESSENTIALS = 100;
const today = () => new Date().toISOString().slice(0, 10);

// Everything the user has seen, using the saved snapshot when a movie has left the nightly list.
function seenList() {
  return [...S.mine.entries()].filter(([, st]) => st.status === 'seen' || st.wasSeen).map(([id, st]) => {
    const m = S.byId.get(id);
    return {
      id, st, m,
      t: m?.t || st.title || 'Unknown title', y: m?.y ?? st.y ?? null,
      sg: m?.sg || st.sg || [], rt: m?.rt ?? st.rt ?? null, tier: m?.tier || st.tier || null,
      date: m?.date || st.date || null, on: st.seenOn || '',
    };
  });
}
function essentialsList() {
  return S.data.movies.filter((m) => m.tier !== 'fresh').slice().sort((a, b) => b.reach - a.reach || (b.n?.votes || 0) - (a.n?.votes || 0)).slice(0, ESSENTIALS);
}
function levelFor(n) {
  let cur = null, next = LEVELS[0];
  for (const l of LEVELS) { if (n >= l[0]) cur = l; else { next = l; break; } next = null; }
  return { cur, next };
}
function computeBadges(seen) {
  const ess = new Set(essentialsList().map((m) => String(m.id)));
  const essSeen = seen.filter((x) => ess.has(x.id)).length;
  const decades = new Set(seen.map((x) => x.y && Math.floor(x.y / 10) * 10).filter(Boolean));
  const deep = seen.filter((x) => x.tier === 'deep').length;
  const rated = seen.filter((x) => x.st.rating).length;
  const early = seen.filter((x) => x.on && x.date && (Date.parse(x.on) - Date.parse(x.date)) / 864e5 <= 30 && Date.parse(x.on) >= Date.parse(x.date)).length;
  const perDay = {};
  for (const x of seen) if (x.on) perDay[x.on] = (perDay[x.on] || 0) + 1;
  const marathon = Math.max(0, ...Object.values(perDay));
  const oct = seen.filter((x) => x.on && x.on.slice(5, 7) === '10' && x.on.slice(0, 4) === today().slice(0, 4)).length;
  const covered = new Set(seen.flatMap((x) => x.sg)).size;
  return [
    { k: 'ess', name: 'Horror Essentials', desc: `Seen ${ESSENTIALS} of the most widely seen horror movies`, have: essSeen, need: ESSENTIALS, steps: [10, 25, 50, 100] },
    { k: 'sub', name: 'Well Rounded', desc: 'Seen at least one movie in every subgenre', have: covered, need: S.data.subgenres.length },
    { k: 'dec', name: 'Time Traveler', desc: 'Movies from six different decades', have: decades.size, need: 6 },
    { k: 'deep', name: 'Deep Diver', desc: 'Ten Deep Cuts seen', have: deep, need: 10 },
    { k: 'early', name: 'Opening Night', desc: 'Watched a movie within 30 days of release', have: early, need: 1 },
    { k: 'mar', name: 'Marathoner', desc: 'Three movies logged on the same day', have: marathon, need: 3 },
    { k: 'crit', name: 'Critic', desc: 'Rated 25 movies', have: rated, need: 25 },
    { k: 'oct', name: 'Spooky Season', desc: `31 movies watched this October`, have: oct, need: 31 },
  ];
}
function prog(have, need) {
  const pct = Math.min(100, Math.round((have / need) * 100));
  return `<div class="prog" role="progressbar" aria-valuemin="0" aria-valuemax="${need}" aria-valuenow="${Math.min(have, need)}"><i style="width:${pct}%"></i></div>`;
}
function skullsText(r) { return r ? '💀'.repeat(r) : '<span class="muted">Not rated</span>'; }

views.trophies = () => {
  if (!S.user) return signInPrompt('Sign in to keep a trophy case of every horror movie you have seen.');
  const seen = seenList();
  const mins = seen.reduce((s, x) => s + (x.rt || 0), 0);
  const rated = seen.filter((x) => x.st.rating);
  const avg = rated.length ? (rated.reduce((s, x) => s + x.st.rating, 0) / rated.length).toFixed(1) : '—';
  const nextMs = MILESTONES.find(([n]) => seen.length < n);
  const earnedMs = MILESTONES.filter(([n]) => seen.length >= n);
  const badges = computeBadges(seen);
  const counts = {};
  for (const x of seen) for (const k of x.sg) counts[k] = (counts[k] || 0) + 1;
  const ess = essentialsList();
  const essNext = ess.filter((m) => !everSeen(m)).slice(0, 12);
  // watch log grouped by month
  const groups = new Map();
  for (const x of seen.sort((a, b) => (b.on || '').localeCompare(a.on || '') || (b.st.at || 0) - (a.st.at || 0))) {
    const key = x.on ? x.on.slice(0, 7) : '';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(x);
  }
  const monthName = (k) => (k ? new Date(k + '-15T12:00:00Z').toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' }) : 'Before Scream Queue');
  return `<div class="page-head"><h1>Trophy Case</h1><p class="muted">Every horror movie you've survived. Mark movies as seen anywhere on the site, or check off the classics in bulk.</p></div>
  <section class="tiles">
    <div class="tile"><b class="mono">${seen.length}</b><span>Movies seen</span></div>
    <div class="tile"><b class="mono">${Math.round(mins / 60)}</b><span>Hours of horror</span></div>
    <div class="tile"><b class="mono">${avg}</b><span>Average rating</span></div>
    <div class="tile"><b class="mono">${Object.keys(counts).length}<small>/${S.data.subgenres.length}</small></b><span>Subgenres explored</span></div>
  </section>

  <section class="panel stack">
    <div class="shelf-head"><h2>Milestones</h2>${nextMs ? `<span class="muted mono" style="font-size:.85rem">${nextMs[0] - seen.length} more to ${esc(nextMs[1])}</span>` : ''}</div>
    ${nextMs ? prog(seen.length, nextMs[0]) : ''}
    <div class="medals">${MILESTONES.map(([n, name, desc]) => `<div class="medal ${seen.length >= n ? 'won' : ''}" title="${esc(desc)}"><span class="mono">${n}</span><b>${esc(name)}</b></div>`).join('')}</div>
    ${earnedMs.length ? '' : '<p class="muted">Log your first movie to earn First Blood.</p>'}
  </section>

  <section class="stack">
    <h2>Badges</h2>
    <div class="badges">${badges.map((b) => {
      const won = b.have >= b.need;
      const step = b.steps ? b.steps.filter((s) => b.have >= s).pop() : null;
      const nextStep = b.steps ? b.steps.find((s) => b.have < s) : null;
      return `<div class="badge ${won ? 'won' : step ? 'part' : ''}">
        <div class="row" style="justify-content:space-between"><b>${esc(b.name)}</b><span class="mono muted">${Math.min(b.have, b.need)}/${b.need}</span></div>
        <span class="muted" style="font-size:.85rem">${esc(b.desc)}${step && !won ? ` · ${step} reached, next ${nextStep}` : ''}</span>
        ${prog(b.have, b.need)}</div>`;
    }).join('')}</div>
  </section>

  <section class="panel stack">
    <div class="shelf-head"><h2>Subgenre mastery</h2><span class="muted" style="font-size:.85rem">${LEVELS.map(([n, l]) => `${l} ${n}`).join(' · ')}</span></div>
    <div class="mastery">${S.data.subgenres.map((s) => {
      const n = counts[s.key] || 0; const { cur, next } = levelFor(n);
      return `<button class="mast ${cur ? 'won' : ''}" data-act="sgbrowse" data-k="${s.key}" title="Browse ${esc(s.label)}">
        <span class="row" style="justify-content:space-between;gap:6px"><b>${esc(s.label)}</b><span class="mono">${n}</span></span>
        <span class="muted" style="font-size:.8rem">${cur ? esc(cur[1]) : 'Not started'}${next ? ` · ${next[0] - n} to ${next[1]}` : ' · Maxed'}</span>
        ${prog(n, next ? next[0] : n || 1)}</button>`;
    }).join('')}</div>
  </section>

  <section class="shelf">
    <div class="shelf-head"><div><h2>Horror Essentials · ${ess.length - ess.filter((m) => !everSeen(m)).length} of ${ess.length}</h2><p class="muted">The ${ESSENTIALS} most widely seen horror movies on the site. Next up for you:</p></div><a class="btn small" href="#/checklist">Check off what you've seen</a></div>
    ${essNext.length ? `<div class="shelf-track">${essNext.map(card).join('')}</div>` : '<div class="empty">You have seen every one of them. Respect.</div>'}
  </section>

  <section class="stack">
    <h2>Watch log</h2>
    ${seen.length ? [...groups.entries()].map(([k, list]) => `<div class="stack" style="gap:8px"><h3 class="muted">${esc(monthName(k))} <span class="mono">(${list.length})</span></h3>
      <div class="list">${list.map((x) => `<div class="list-item">
        <div style="min-width:0">${x.m ? `<button class="linkish" data-act="open" data-id="${x.id}">${esc(x.t)}</button>` : `<b>${esc(x.t)}</b>`} <span class="muted mono" style="font-size:.85rem">${x.y ?? ''}</span>
        <div class="muted" style="font-size:.82rem">${x.on ? esc(new Date(x.on + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })) + ' · ' : ''}${x.sg.slice(0, 3).map((k) => esc(S.sgLabel.get(k) || k)).join(', ')}</div></div>
        <span aria-label="${x.st.rating || 0} of 5">${skullsText(x.st.rating)}</span></div>`).join('')}</div></div>`).join('')
    : '<div class="empty">Nothing logged yet. Open any movie and press "Seen it", or use the checklist to add the ones you have already watched.</div>'}
  </section>`;
};

views.checklist = () => {
  if (!S.user) return signInPrompt('Sign in to check off the movies you have seen.');
  const q = (S.ckq || '').toLowerCase();
  const base = S.ckAll ? S.movies.slice().sort((a, b) => b.reach - a.reach) : essentialsList();
  const list = base.filter((m) => !q || m.t.toLowerCase().includes(q)).slice(0, S.ckAll ? 300 : ESSENTIALS);
  const done = base.filter(everSeen).length;
  return `<div class="page-head"><h1>Check off what you've seen</h1><p class="muted">Tap every movie you've already watched. They go into your Trophy Case as "Before Scream Queue" so you don't need dates.</p></div>
  <div class="row"><a class="btn" href="#/trophies">Back to Trophy Case</a>
    <div class="chips"><button class="chip" data-act="ckmode" data-k="ess" aria-pressed="${!S.ckAll}">Horror Essentials</button><button class="chip" data-act="ckmode" data-k="all" aria-pressed="${!!S.ckAll}">Everything on the site</button></div>
    <span class="muted mono" id="ck-count">${done} of ${base.length} seen</span></div>
  <input type="search" id="ck-q" placeholder="Filter by title" value="${esc(S.ckq || '')}" aria-label="Filter by title" style="max-width:420px">
  <div class="checks">${list.map((m) => `<button class="check" data-act="ck" data-id="${m.id}" aria-pressed="${everSeen(m)}"><span class="box" aria-hidden="true"></span><span style="min-width:0"><b>${esc(m.t)}</b> <span class="muted mono">${m.y ?? ''}</span><br><span class="muted" style="font-size:.8rem">${esc(S.tierLabel.get(m.tier))}${m.sg.length ? ' · ' + esc(S.sgLabel.get(m.sg[0])) : ''}</span></span></button>`).join('')}</div>`;
};

// ---------- detail dialog ----------
function openDetail(id) {
  const m = S.byId.get(String(id)); if (!m) return;
  const dlg = $('#detail');
  const st = status(m.id);
  const providers = [...m.pv.map((p) => [p, 'Subscription']), ...m.fr.map((p) => [p, 'Free with ads'])].map(([p, kind]) => `<span class="tag">${esc(S.provName.get(p) || 'Service')} · ${kind}</span>`).join('');
  dlg.innerHTML = `<div style="position:relative">
    <button class="btn small ghost close" data-act="close" aria-label="Close">Close</button>
    <div class="detail-body">
      <div>${cover(m)}</div>
      <div class="stack" style="gap:14px;min-width:0">
        <div class="stack" style="gap:4px"><h2 style="font-size:1.6rem;padding-right:60px">${esc(m.t)}</h2>
          <div class="facts">${[m.y, m.rt && `${m.rt} min`, m.cert, m.dir.length && `Dir. ${m.dir.join(', ')}`].filter(Boolean).map((x) => `<span>${esc(x)}</span>`).join('')}</div></div>
        <div class="chips">${m.sg.map((k) => `<span class="tag">${esc(S.sgLabel.get(k))}</span>`).join('') || '<span class="muted" style="font-size:.85rem">No subgenre tags yet</span>'}</div>
        ${m.ov ? `<p>${esc(m.ov)}</p>` : ''}
        ${m.cast.length ? `<p class="muted" style="font-size:.9rem">With ${esc(m.cast.join(', '))}</p>` : ''}
        <div class="meters">
          <div class="stack" style="gap:6px">${meter('Buzz', m.buzz, 'var(--accent)')}<div class="why">${whyBuzz(m).map((x) => `<span>${esc(x)}</span>`).join('')}</div></div>
          <div class="stack" style="gap:6px">${meter('Reach', m.reach, 'var(--teal)')}<div class="why">${whyReach(m).map((x) => `<span>${esc(x)}</span>`).join('')}</div></div>
        </div>
        <div class="stack" style="gap:6px"><b style="font-size:.9rem">Where to watch (US)</b><div class="chips">${providers || `<span class="muted" style="font-size:.9rem">${m.rent ? 'Rent or buy only' : 'Not on a streaming service right now'}</span>`}</div>
          <span class="muted" style="font-size:.75rem">Streaming data from JustWatch via TMDB${SAMPLE() ? ' · sample data, not real' : ''}</span></div>
        <div class="row">${queueBtn(m)}<button class="btn" data-act="seen" data-id="${m.id}" aria-pressed="${st?.status === 'seen'}">${st?.status === 'seen' ? 'Seen' : 'Seen it'}</button>
          ${st?.status === 'seen' ? `<span class="skulls" role="group" aria-label="Your rating">${[1, 2, 3, 4, 5].map((n) => `<button data-act="rate" data-id="${m.id}" data-k="${n}" class="${(st.rating || 0) >= n ? 'on' : ''}" aria-label="${n} of 5">💀</button>`).join('')}</span>` : ''}
          ${st?.status === 'seen' ? `<label class="row" style="gap:6px;font-size:.85rem" class="muted">Watched <input type="date" id="seen-date" data-id="${m.id}" value="${esc(st.seenOn || '')}" max="${today()}" style="width:auto"></label>` : ''}
          ${st ? `<button class="btn ghost small" data-act="forget" data-id="${m.id}">Remove from my lists</button>` : ''}</div>
        <div class="row" style="gap:12px;font-size:.9rem">${links(m).map(([l, u]) => `<a href="${esc(u)}" target="_blank" rel="noopener">${l}</a>`).join('')}</div>
      </div></div></div>`;
  dlg.dataset.id = m.id;
  if (!dlg.open) { try { dlg.showModal(); } catch { dlg.setAttribute('open', ''); } }
}
function refreshDetail() { const d = $('#detail'); if (d.open && d.dataset.id) openDetail(d.dataset.id); }

// ---------- actions ----------
async function setStatus(id, data) {
  if (!needUser()) return;
  const m = S.byId.get(String(id));
  const prev = S.mine.get(String(id)) || {};
  const snap = m ? { title: m.t, y: m.y ?? null, sg: m.sg, rt: m.rt ?? null, tier: m.tier, date: m.date || null } : {};
  const next = { ...prev, ...snap, ...data };
  delete next.at;
  S.mine.set(String(id), { ...next, at: Date.now() });
  await store.setMovie(id, next);
}

async function patchConfig(fn) { fn(S.config); applyConfig(); await route(); }

const actions = {
  open: (el) => openDetail(el.dataset.id),
  close: () => $('#detail').close(),
  async queue(el) {
    if (!needUser()) return;
    const st = status(el.dataset.id);
    if (st?.status === 'queue') { S.mine.delete(String(el.dataset.id)); await store.removeMovie(el.dataset.id); toast('Removed from your queue'); }
    else { await setStatus(el.dataset.id, st?.status === 'seen' ? { status: 'queue', wasSeen: true } : { status: 'queue' }); toast(st?.status === 'seen' ? 'Queued for a rewatch' : 'Added to your queue'); }
    refreshAll();
  },
  async seen(el) {
    if (!needUser()) return;
    const st = status(el.dataset.id);
    if (st?.status === 'seen') return;
    await setStatus(el.dataset.id, { status: 'seen', rating: 0, seenOn: today() }); toast('Added to your Trophy Case. Rate it with the skulls.');
    refreshAll();
  },
  async rate(el) { await setStatus(el.dataset.id, { status: 'seen', rating: Number(el.dataset.k) }); refreshAll(); },
  sgbrowse(el) { S.f.sg = new Set([el.dataset.k]); S.f.hideSeen = false; location.hash = '#/browse'; },
  ckmode(el) { S.ckAll = el.dataset.k === 'all'; route(true); },
  async ck(el) {
    if (!needUser()) return;
    const id = el.dataset.id;
    if (everSeen({ id })) { S.mine.delete(String(id)); await store.removeMovie(id); el.setAttribute('aria-pressed', 'false'); }
    else { await setStatus(id, { status: 'seen', rating: 0, seenOn: '' }); el.setAttribute('aria-pressed', 'true'); }
    const base = S.ckAll ? S.movies : essentialsList();
    const c = $('#ck-count'); if (c) c.textContent = `${base.filter(everSeen).length} of ${base.length} seen`;
  },
  async forget(el) { S.mine.delete(String(el.dataset.id)); await store.removeMovie(el.dataset.id); refreshAll(); },
  more() { S.f.limit += 60; renderResults(); },
  fsg(el) { toggle(S.f.sg, el.dataset.k); el.setAttribute('aria-pressed', S.f.sg.has(el.dataset.k)); S.f.limit = 60; renderResults(); },
  ftier(el) { toggle(S.f.tier, el.dataset.k); el.setAttribute('aria-pressed', S.f.tier.has(el.dataset.k)); renderResults(); },
  fmine(el) { S.f.mine = !S.f.mine; el.setAttribute('aria-pressed', S.f.mine); renderResults(); },
  fseen(el) { S.f.hideSeen = !S.f.hideSeen; el.setAttribute('aria-pressed', S.f.hideSeen); renderResults(); },
  fclear() { Object.assign(S.f, { q: '', sg: new Set(), tier: new Set(), mine: false, decade: '', provider: '', limit: 60 }); route(); },
  pmix(el) { S.p.mix = el.dataset.k; document.querySelectorAll('[data-act="pmix"]').forEach((b) => b.setAttribute('aria-pressed', b.dataset.k === S.p.mix)); },
  psg(el) { toggle(S.p.sg, el.dataset.k); el.setAttribute('aria-pressed', S.p.sg.has(el.dataset.k)); },
  pmine(el) { S.p.mine = !S.p.mine; el.setAttribute('aria-pressed', S.p.mine); },
  pqueue(el) { S.p.queueOnly = !S.p.queueOnly; el.setAttribute('aria-pressed', S.p.queueOnly); },
  repick() {
    const m = pickOne();
    S.p.current = m ? m.id : false;
    if (m) { S.p.recent = [m.id, ...S.p.recent].slice(0, 12); }
    renderPick();
  },
  qtab(el) { S.qTab = el.dataset.k; route(); },
  async join(el) { await store.joinNight(el.dataset.id); toast('You joined the movie night'); },
  async vote(el) {
    const n = S.lastNight; if (!n) return;
    const mine = new Set(n.votes?.[S.user.uid] || []);
    if (mine.has(el.dataset.id)) mine.delete(el.dataset.id);
    else if (mine.size < VOTES_PER_PERSON) mine.add(el.dataset.id);
    await store.vote(el.dataset.night, [...mine]);
  },
  async suggest(el) { await store.suggest(el.dataset.night, el.dataset.id); toast('Suggested'); },
  async nsuggest(el) { await store.suggest($('#night').dataset.night, el.dataset.id); toast('Suggested'); const s = $('#night-search'); if (s) s.value = ''; },
  async unsuggest(el) { await store.unsuggest(el.dataset.night, el.dataset.id); },
  async decide(el) { await store.decide(el.dataset.night, el.dataset.id || null); },
  async delnight(el) {
    if (el.dataset.confirm !== 'yes') { el.dataset.confirm = 'yes'; el.textContent = 'Press again to delete for everyone'; return; }
    await store.deleteNight(el.dataset.night); location.hash = '#/nights';
  },
  async copy(el) {
    const input = document.getElementById(el.dataset.target);
    try { await navigator.clipboard.writeText(input.value); toast('Link copied'); } catch { input.select(); toast('Press Ctrl+C to copy'); }
  },
  svc(el) { const id = Number(el.dataset.k); const s = new Set(S.profile.services); s.has(id) ? s.delete(id) : s.add(id); S.profile.services = [...s]; el.setAttribute('aria-pressed', s.has(id)); },
  async signout() { await store.signOut(); location.hash = '#/'; },
  resetdemo() { store.resetDemo(); location.hash = '#/'; },
  gosignin() { S.afterSignIn = location.hash || '#/'; },
  authtab(el) { S.authTab = el.dataset.k; route(); },
  async google() { try { await store.signInGoogle(); } catch (e) { authError(e); } },
  async reset() {
    const email = $('#auth-email')?.value.trim();
    if (!email) return authError({ message: 'Type your email above, then press Forgot password.' });
    try { await store.resetPassword(email); const m = $('#auth-msg'); m.hidden = false; m.className = 'ok'; m.textContent = 'Check your email for a reset link.'; } catch (e) { authError(e); }
  },
  feature(el) { patchConfig((c) => { c.featured = [...new Set([...(c.featured || []), Number(el.dataset.id)])]; }); },
  unfeature(el) { patchConfig((c) => { c.featured = (c.featured || []).filter((x) => String(x) !== el.dataset.id); }); },
  hide(el) { patchConfig((c) => { c.hidden = [...new Set([...(c.hidden || []), Number(el.dataset.id)])]; }); },
  unhide(el) { patchConfig((c) => { c.hidden = (c.hidden || []).filter((x) => String(x) !== el.dataset.id); }); },
  fixpick(el) { S.adminFix = el.dataset.id; route(); },
  fixsg(el) {
    const m = S.byId.get(String(S.adminFix));
    const set = new Set(m.sg); toggle(set, el.dataset.k);
    patchConfig((c) => { c.sgFix = { ...(c.sgFix || {}), [m.id]: [...set] }; });
  },
  fixclear(el) { patchConfig((c) => { const f = { ...(c.sgFix || {}) }; delete f[el.dataset.id]; c.sgFix = f; }); },
  async savecfg() {
    S.config.showPosters = $('#adm-posters').checked;
    S.config.announcement = $('#adm-announce').value.trim();
    await store.saveConfig({ ...S.config }); toast('Saved for everyone'); renderChrome(); route();
  },
};
function toggle(set, k) { set.has(k) ? set.delete(k) : set.add(k); }
function authError(e) {
  const m = $('#auth-msg'); if (!m) return;
  const code = String(e?.code || '');
  m.hidden = false; m.className = 'error';
  m.textContent = {
    'auth/invalid-credential': 'That email and password do not match. Check them or reset your password.',
    'auth/email-already-in-use': 'An account already uses that email. Sign in instead.',
    'auth/weak-password': 'Use a password of at least 6 characters.',
    'auth/popup-closed-by-user': 'The Google window was closed before signing in.',
    'auth/too-many-requests': 'Too many tries. Wait a minute and try again.',
  }[code] || e?.message || 'Something went wrong. Try again.';
}

async function refreshAll() { refreshDetail(); const r = location.hash; if (!r.startsWith('#/night/')) await route(true); }

document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-act]');
  if (!el || el.disabled) return;
  const fn = actions[el.dataset.act];
  if (!fn) return;
  if (el.tagName === 'A' && el.dataset.act !== 'gosignin') e.preventDefault();
  try { await fn(el, e); } catch (err) { console.error(err); toast(err?.message || 'That did not work. Try again.'); }
});
$('#detail')?.addEventListener('click', (e) => { if (e.target.id === 'detail') e.target.close(); });

document.addEventListener('input', (e) => {
  const el = e.target;
  if (el.id === 'ck-q') { S.ckq = el.value; const pos = el.selectionStart; route(true).then(() => { const i = $('#ck-q'); if (i) { i.focus(); i.setSelectionRange(pos, pos); } }); return; }
  if (el.dataset.bind && location.hash.startsWith('#/browse')) { S.f[el.dataset.bind] = el.value; S.f.limit = 60; renderResults(); }
  if (el.dataset.bind === 'maxRt') S.p.maxRt = el.value;
  if (el.id === 'night-search') $('#night-search-results').innerHTML = searchList(el.value, 'nsuggest');
  if (el.id === 'adm-feat-search') $('#adm-feat-results').innerHTML = searchList(el.value, 'feature');
  if (el.id === 'adm-hide-search') $('#adm-hide-results').innerHTML = searchList(el.value, 'hide');
  if (el.id === 'adm-fix-search') $('#adm-fix-results').innerHTML = searchList(el.value, 'fixpick');
  if (el.hasAttribute('data-bind-theme')) setTheme(el.value);
});

document.addEventListener('change', async (e) => {
  if (e.target.id === 'seen-date') { await setStatus(e.target.dataset.id, { seenOn: e.target.value }); toast('Watch date saved'); }
});

document.addEventListener('submit', async (e) => {
  const form = e.target; if (!form.dataset.form) return;
  e.preventDefault();
  const v = Object.fromEntries(new FormData(form));
  try {
    if (form.dataset.form === 'new-night') {
      const id = await store.createNight(v.title.trim(), v.date);
      location.hash = '#/night/' + id;
    } else if (form.dataset.form === 'settings') {
      const patch = { name: (v.name || '').trim() || S.profile.name, services: S.profile.services, hideSeen: !!v.hideSeen };
      await store.saveProfile(patch); Object.assign(S.profile, patch); S.f.hideSeen = patch.hideSeen; toast('Settings saved'); renderChrome();
    } else if (form.dataset.form === 'auth') {
      if (S.authTab === 'up') await store.signUpEmail(v.name.trim(), v.email.trim(), v.password);
      else await store.signInEmail(v.email.trim(), v.password);
    }
  } catch (err) { authError(err); if (form.dataset.form !== 'auth') toast(err?.message || 'That did not save.'); }
});

function setTheme(t) {
  try { localStorage.setItem('sq-theme', t); } catch { /* ignore */ }
  if (t === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', t);
}

// ---------- chrome + router ----------
const NAV = [['#/', 'Tonight'], ['#/browse', 'Browse'], ['#/pick', 'Pick for me'], ['#/queue', 'My queue'], ['#/trophies', 'Trophy Case'], ['#/nights', 'Movie nights']];
function renderChrome() {
  const here = '#/' + (location.hash.replace(/^#\/?/, '').split('/')[0] || '');
  $('#nav').innerHTML = [...NAV, ...(S.user?.isAdmin ? [['#/admin', 'Admin']] : [])]
    .map(([h, l]) => `<a href="${h}" ${(h === here || (h === '#/nights' && here === '#/night')) ? 'aria-current="page"' : ''}>${l}</a>`).join('');
  $('#who').innerHTML = S.user
    ? `<a class="btn small ghost" href="#/settings" title="Settings">${esc(S.profile.name || S.user.name)}</a>`
    : '<a class="btn small primary" href="#/signin" data-act="gosignin">Sign in</a>';
  const notes = [];
  if (store.demo) notes.push('<strong>Demo mode</strong><span>Accounts are simulated and everything is saved in this browser only.</span>');
  if (SAMPLE()) notes.push('<strong>Sample shelf</strong><span>Scores and streaming info are made up until the first nightly data refresh.</span>');
  if (S.config.announcement) notes.push(`<strong>News</strong><span>${esc(S.config.announcement)}</span>`);
  $('#banner').hidden = !notes.length;
  $('#banner').innerHTML = notes.map((n) => `<div class="wrap">${n}</div>`).join('');
}

async function route(keepScroll) {
  if (S.stopNight) { S.stopNight(); S.stopNight = null; }
  const [name, arg] = location.hash.replace(/^#\/?/, '').split('/');
  const view = views[name || 'tonight'] || views.tonight;
  renderChrome();
  const y = window.scrollY;
  const html = await view(arg);
  $('#main').innerHTML = html;
  if (keepScroll) window.scrollTo(0, y); else window.scrollTo(0, 0);
  document.title = `${SITE_NAME}${name ? ' · ' + ({ browse: 'Browse', pick: 'Pick for me', queue: 'My queue', nights: 'Movie nights', night: 'Movie night', settings: 'Settings', admin: 'Admin', signin: 'Sign in', about: 'How it works', trophies: 'Trophy Case', checklist: 'Checklist' }[name] || '') : ''}`;
}

async function boot() {
  try { const t = localStorage.getItem('sq-theme'); if (t && t !== 'system') document.documentElement.setAttribute('data-theme', t); } catch { /* ignore */ }
  $('#version').textContent = 'v' + VERSION;
  $('#brand').textContent = SITE_NAME;
  [S.config] = await Promise.all([store.getConfig(), loadData()]);
  applyConfig();
  let first = true;
  store.init(async (u) => {
    S.user = u;
    await loadMine();
    if (u && location.hash === '#/signin') { location.hash = S.afterSignIn || '#/'; }
    else await route(!first);
    first = false;
  });
  window.addEventListener('hashchange', () => route());
  if ('serviceWorker' in navigator && location.protocol === 'https:' && !globalThis.SQ_STORE) {
    navigator.serviceWorker.register('sw.js?v=' + VERSION).catch(() => {});
  }
}
boot().catch((e) => { console.error(e); $('#main').innerHTML = `<div class="empty">The movie shelf could not load (${esc(e.message)}). Refresh to try again.</div>`; });
