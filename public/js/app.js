import { VERSION, SITE_NAME, TAGLINE, DEMO, VOTES_PER_PERSON } from './config.js';
import { icon } from './icons.js';
import { art, SG_HUE } from './art.js';
import { FAMILIES, sgIcon, familyOf } from './sg.js';

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
const SAMPLE = () => !!S.data?.sample;
const hue = (k) => (SG_HUE[k] || [350])[0];
const today = () => new Date().toISOString().slice(0, 10);
const avatarHue = (name) => [...(name || '')].reduce((s, c) => s + c.charCodeAt(0), 0) % 360;
const reduceMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

function toast(msg, ic = 'check', undo = null) {
  document.querySelectorAll('.toast').forEach((x) => x.remove());
  const t = document.createElement('div');
  t.className = 'toast'; t.setAttribute('role', 'status');
  t.innerHTML = `${icon(ic)}<span>${esc(msg)}</span>${undo ? '<button class="toast-undo" type="button">Undo</button>' : ''}`;
  if (undo) t.querySelector('.toast-undo').addEventListener('click', async () => { t.remove(); try { await undo(); } catch (e) { console.error(e); } });
  document.body.append(t);
  setTimeout(() => t.remove(), undo ? 5000 : 2600);
}
// Put a movie back the way it was before a queue/seen tap.
function undoTo(id, prev) {
  return async () => {
    if (status(id)?.status === 'seen' && prev?.status !== 'seen') await unstamp(id);
    else if (prev?.status === 'seen') markJust(id);
    if (prev) { S.mine.set(String(id), { ...prev }); const { at, ...rest } = prev; await store.setMovie(id, rest); }
    else { S.mine.delete(String(id)); await store.removeMovie(id); }
    await refreshAll(); toast('Undone', 'check');
  };
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
      ['JustWatch', `https://www.justwatch.com/us/search?q=${encodeURIComponent(m.t)}`],
    ];
  }
  const out = [['Letterboxd', `https://letterboxd.com/tmdb/${m.id}/`]];
  if (m.imdb?.id) out.push(['IMDb', `https://www.imdb.com/title/${m.imdb.id}/`]);
  out.push(['TMDB', `https://www.themoviedb.org/movie/${m.id}`]);
  if (m.wl) out.push(['All streaming options', m.wl]);
  return out;
}

// Plain-language reasons a movie is on the shelf (the scores stay behind the scenes).
function trendLine(m) {
  if (m.weekRank) return { b: `#${m.weekRank} trending horror movie this week`, s: 'Based on TMDB activity' };
  if (m.dayRank) return { b: `#${m.dayRank} trending horror movie today`, s: 'Based on TMDB activity' };
  if (m.n?.trakt) return { b: `${fmt(m.n.trakt)} people watching right now`, s: 'From Trakt' };
  if (m.flags.includes('quiet')) return { b: 'Just released, still under the radar', s: 'Not many people talking about it yet' };
  if (m.buzz >= 60) return { b: 'Getting a lot of attention lately', s: 'Busy on TMDB this week' };
  if (m.buzz >= 35) return { b: 'Steady interest', s: 'People keep coming back to it' };
  return { b: 'Quiet right now', s: 'Not much activity this week' };
}
function reachLine(m) {
  const b = { fresh: 'Too new to have many ratings', favorite: 'One of the most-watched horror movies', known: 'Widely seen by horror fans', cult: 'Smaller audience, loyal fans', deep: 'Few people have found this one' }[m.tier];
  const s = m.imdb?.v ? `${fmt(m.imdb.v)} ratings on IMDb` : m.n?.votes ? `${fmt(m.n.votes)} ratings on TMDB` : 'Based on how many people have rated it';
  return { b, s };
}
function shortLine(m) {
  if (m.weekRank) return `#${m.weekRank} trending this week`;
  if (m.flags.includes('quiet')) return 'Just released, under the radar';
  return reachLine(m).b;
}
function rating(m) { const r = m.imdb?.r ?? (m.va ? Number(m.va.toFixed(1)) : null); return r ? `${icon('star')}${r}` : ''; }

function servicesText(m) {
  const names = [...m.pv, ...m.fr].map((p) => S.provName.get(p)).filter(Boolean);
  const mine = S.profile.services.length ? names.filter((_, i) => S.profile.services.includes([...m.pv, ...m.fr][i])) : [];
  const list = mine.length ? mine : names;
  if (list.length) return list.slice(0, 2).join(', ') + (list.length > 2 ? ` +${list.length - 2}` : '');
  return m.rent ? 'Rent or buy' : 'Not streaming';
}

function poster(m, opts = {}) {
  const st = status(m.id);
  const img = S.config.showPosters && m.poster;
  const state = opts.stamp ? 'seen' : opts.noBadges || !st ? '' : st.status === 'queue' ? 'queued' : 'seen';
  return `<div class="poster ${img ? 'has-img' : ''} ${state} ${S.just === String(m.id) ? 'just' : ''}">
    ${art(m)}${img ? `<img loading="lazy" alt="" src="https://image.tmdb.org/t/p/w342${m.poster}">` : ''}
    <div class="scrim"></div>
    ${opts.noBadges ? '' : `<span class="badge-tier t-${m.tier}">${m.flags.includes('hot') ? `<span class="flame" title="Trending this week">${icon('flame')}</span>` : '<i></i>'}${esc(S.tierLabel.get(m.tier))}</span>`}
    ${state === 'queued' ? bloodDrip(m.id) : ''}
    ${state === 'seen' ? `<span class="stamp" aria-label="Seen"><b>Survived</b>${st?.rating ? `<small>${icon('skull')}${fmtRating(st.rating)}</small>` : ''}</span>` : ''}
    <span class="ttl">${esc(m.t)}<small>${m.y ?? ''}${m.rt ? ` · ${m.rt} min` : ''}</small></span>
  </div>`;
}

// Big artwork for the hero, pick card and details: the TMDB backdrop (or a blown-up poster) when posters are on, otherwise generated art.
function wideArt(m) {
  if (S.config.showPosters && m.bd) return `<div class="art photo" aria-hidden="true"><img src="https://image.tmdb.org/t/p/w1280${m.bd}" alt=""></div>`;
  if (S.config.showPosters && m.poster) return `<div class="art photo blur" aria-hidden="true"><img src="https://image.tmdb.org/t/p/w500${m.poster}" alt=""></div>`;
  return art(m, true);
}
// A streak of blood running down from the top-right corner of a queued poster (where a bookmark ribbon would sit).
// Lengths vary a little per movie so a shelf doesn't look stamped out.
function bloodDrip(id) {
  let t = (Number(id) || 7) >>> 0;
  const r = () => { t += 0x6d2b79f5; let x = Math.imul(t ^ (t >>> 15), 1 | t); x ^= x + Math.imul(x ^ (x >>> 7), 61 | x); return ((x ^ (x >>> 14)) >>> 0) / 4294967296; };
  const f = (n) => n.toFixed(1);
  const drip = (cx, w, L) => {
    const rr = w * 0.42;
    return ` L${f(cx + w / 2)} 7 C${f(cx + w * 0.2)} 9 ${f(cx + w * 0.3)} ${f(L - rr * 2.4)} ${f(cx + rr)} ${f(L - rr)} A${f(rr)} ${f(rr)} 0 1 1 ${f(cx - rr)} ${f(L - rr)} C${f(cx - w * 0.3)} ${f(L - rr * 2.4)} ${f(cx - w * 0.2)} 9 ${f(cx - w / 2)} 7`;
  };
  const mainL = 52 + r() * 22, sideL = 18 + r() * 16, tinyL = 11 + r() * 6;
  // pool along the top edge, then drips right to left
  let d = 'M0 0H40V7' + drip(33, 8, sideL) + drip(20, 13, mainL) + drip(7, 7, tinyL) + ' L0 6Z';
  const g = 'bl' + id;
  return `<span class="blood" title="In your queue" aria-label="In your queue"><svg viewBox="0 0 40 80" aria-hidden="true">
    <defs><linearGradient id="${g}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#4d000d"/><stop offset=".3" stop-color="#9e001d"/><stop offset="1" stop-color="#e3112f"/></linearGradient>
    <radialGradient id="${g}h" cx=".35" cy=".3" r=".6"><stop offset="0" stop-color="#ff8a96" stop-opacity=".8"/><stop offset="1" stop-color="#ff8a96" stop-opacity="0"/></radialGradient></defs>
    <path d="${d}" fill="url(#${g})"/>
    <circle cx="${f(20 - 1.5)}" cy="${f(mainL - 6)}" r="2.2" fill="url(#${g}h)"/>
  </svg><i class="drop" style="--top:${f((mainL / 80) * 100)}%"></i></span>`;
}
// Streaming logos for a movie: one per service (channel and ad-tier versions folded together), your services first.
function serviceLogos(m, max = 3) {
  const ids = [...m.pv, ...m.fr];
  if (!ids.length) return `<span class="svc-none">${m.rent ? 'Rent or buy' : 'Not streaming'}</span>`;
  const seen = new Map();
  for (const g of serviceGroups()) if (g.ids.some((id) => ids.includes(id))) seen.set(g.key, g);
  const list = [...seen.values()].sort((a, b) => groupOn(b) - groupOn(a));
  const shown = list.slice(0, max);
  return shown.map((g) => g.logo
    ? `<img class="svc-logo${groupOn(g) ? ' mine' : ''}" src="https://image.tmdb.org/t/p/w92${g.logo}" alt="${esc(g.label)}" title="${esc(g.label)}" loading="lazy">`
    : `<span class="svc-logo txt" title="${esc(g.label)}">${esc(g.label.slice(0, 2))}</span>`).join('')
    + (list.length > max ? `<span class="svc-more">+${list.length - max}</span>` : '');
}
function card(m) {
  const sg = m.sg.slice(0, 2).map((k) => S.sgLabel.get(k)).join(', ');
  const name = `${m.t}${m.y ? ` (${m.y})` : ''}`;
  return `<div class="card" data-id="${m.id}">
    <button class="card-open" data-act="open" data-id="${m.id}" aria-label="${esc(name)}">
      ${poster(m)}
      <span class="meta"><span class="mt">${esc(m.t)}${m.y ? ` <span class="yr">(${m.y})</span>` : ''}</span><span class="l2">${esc(sg || 'Horror')}</span></span>
    </button>
    ${quickBar(m, name)}
  </div>`;
}
// Quick actions on a poster: shown on hover/focus with a mouse, behind a + button on touch screens.
function quickBar(m, name) {
  const st = status(m.id);
  const q = st?.status === 'queue', seen = st?.status === 'seen';
  return `<button class="qa-plus" data-act="qaopen" data-id="${m.id}" aria-label="Quick actions for ${esc(name)}" aria-expanded="false">${icon('plus')}</button>
    <div class="qa" role="group" aria-label="Quick actions for ${esc(name)}">
      <button class="qa-b" data-act="queue" data-id="${m.id}" data-qa="1" aria-pressed="${q}" title="${q ? 'Remove from queue' : 'Add to queue'}" aria-label="${q ? 'Remove from queue' : 'Add to queue'}">${icon('bookmark', q ? 'filled' : '')}</button>
      <button class="qa-b" data-act="seen" data-id="${m.id}" data-qa="1" aria-pressed="${seen}" title="${seen ? 'Seen. Click to unmark' : 'Mark as seen'}" aria-label="${seen ? 'Unmark as seen' : 'Mark as seen'}">${icon('eye')}</button>
      <button class="qa-b" data-act="qarate" data-id="${m.id}" title="Rate it" aria-label="Rate it">${icon('skull')}</button>
    </div>
    <div class="qa-rate" hidden>${skullPicker(m, st?.rating || 0)}<button class="qa-x" data-act="qaclose" aria-label="Close rating">${icon('x')}</button></div>`;
}

let shelfN = 0;
function shelf(title, desc, list, emptyText, more = '') {
  const id = 'rail' + (++shelfN);
  const plain = String(title).replace(/<[^>]+>/g, '');
  return `<section class="shelf">
    <div class="shelf-head"><div><h2>${title}</h2>${desc ? `<p class="muted">${desc}</p>` : ''}</div>
      ${more ? `<div class="shelf-nav">${more}</div>` : ''}</div>
    ${list.length ? `<div class="rail" data-start="1">
      <button class="rail-btn prev" data-act="scroll" data-k="-1" data-target="${id}" aria-label="Scroll ${esc(plain)} back" tabindex="-1">${icon('left')}</button>
      <div class="track" id="${id}">${list.map(card).join('')}</div>
      <button class="rail-btn next" data-act="scroll" data-k="1" data-target="${id}" aria-label="Scroll ${esc(plain)} forward" tabindex="-1">${icon('right')}</button>
    </div>` : `<div class="empty">${icon('clock')}<span>${emptyText}</span></div>`}
  </section>`;
}
// Arrows hide at either end of a row (and both hide when everything fits).
function updateRail(rail) {
  const t = rail.querySelector('.track'); if (!t) return;
  const max = t.scrollWidth - t.clientWidth - 4;
  rail.toggleAttribute('data-start', t.scrollLeft <= 4);
  rail.toggleAttribute('data-end', t.scrollLeft >= max);
}
function updateRails() { document.querySelectorAll('.rail').forEach(updateRail); }
document.addEventListener('scroll', (e) => { const r = e.target.closest?.('.rail'); if (r) updateRail(r); }, true);
window.addEventListener('resize', () => requestAnimationFrame(updateRails));

function chip(act, k, label, pressed, extra = '') {
  return `<button class="chip" data-act="${act}" data-k="${k}" aria-pressed="${!!pressed}" ${extra}><span class="tick">${icon('check')}</span>${label}</button>`;
}
function sgChip(act, s, pressed) {
  return `<button class="chip sg" data-act="${act}" data-k="${s.key}" aria-pressed="${!!pressed}" style="--h:${hue(s.key)}">${sgIcon(s.key)}<span class="tick">${icon('check')}</span>${esc(s.label)}</button>`;
}
function sgTag(k) { return `<span class="tag" style="--h:${hue(k)}">${sgIcon(k)}${esc(S.sgLabel.get(k) || k)}</span>`; }
// Subgenres grouped into families: a row of family tabs, then the chips for the open family.
// Picks in other families stay on and show as a count on their tab.
S.fam = {};
function sgPicker(act, set) {
  const subs = new Map(S.data.subgenres.map((s) => [s.key, s]));
  const fams = FAMILIES.map((f) => ({ ...f, list: f.sg.map((k) => subs.get(k)).filter(Boolean) }));
  const stray = S.data.subgenres.filter((s) => !FAMILIES.some((f) => f.sg.includes(s.key)));
  if (stray.length) fams[fams.length - 1].list.push(...stray);
  const open = S.fam[act] || (set.size ? familyOf([...set][0]).key : fams[0].key);
  S.fam[act] = open;
  const cur = fams.find((f) => f.key === open) || fams[0];
  return `<div class="sgp" data-picker="${act}">
    <div class="sgp-tabs" role="tablist" aria-label="Subgenre families">${fams.map((f) => {
      const n = f.list.filter((s) => set.has(s.key)).length;
      return `<button role="tab" class="sgp-tab" title="${esc(f.label)}" data-act="sgfam" data-picker="${act}" data-k="${f.key}" aria-selected="${f.key === cur.key}">${sgIcon(f.icon)}<span>${esc(f.label)}</span>${n ? `<b class="sgp-n">${n}</b>` : ''}</button>`;
    }).join('')}</div>
    <div class="chips sgp-chips" role="tabpanel">${cur.list.map((s) => sgChip(act, s, set.has(s.key))).join('')}</div>
  </div>`;
}
function redrawPicker(act, set) { const el = document.querySelector(`.sgp[data-picker="${act}"]`); if (el) el.outerHTML = sgPicker(act, set); }
const fmtRating = (r) => (Number.isInteger(r) ? String(r) : r.toFixed(1));
function skullRow(r) {
  if (!r) return '<span class="faint">Not rated</span>';
  const parts = [];
  for (let n = 1; n <= 5; n++) if (r >= n - 0.5) parts.push(`<span class="sk ${r >= n ? 'on' : 'half'}">${icon('skull')}<span class="fill">${icon('skull')}</span></span>`);
  return `<span class="skull-row" aria-label="${fmtRating(r)} of 5">${parts.join('')}</span>`;
}
function skullPicker(m, r = 0) {
  return `<span class="skulls" role="group" aria-label="Your rating: ${r ? fmtRating(r) : 'none'} of 5">${[1, 2, 3, 4, 5].map((n) => `<span class="sk ${r >= n ? 'on' : r >= n - 0.5 ? 'half' : ''}">${icon('skull')}<span class="fill">${icon('skull')}</span>
    <button class="l" data-act="rate" data-id="${m.id}" data-k="${n - 0.5}" aria-label="Rate ${n - 0.5} of 5"></button><button class="r" data-act="rate" data-id="${m.id}" data-k="${n}" aria-label="Rate ${n} of 5"></button></span>`).join('')}
    <span class="sk-val">${r ? fmtRating(r) : ''}</span></span>`;
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
  const fix = (m) => (S.config.sgFix?.[m.id] ? { ...m, sg: S.config.sgFix[m.id] } : m);
  S.movies = S.data.movies.filter((m) => !hidden.has(String(m.id))).map(fix);
  S.byId = new Map(S.data.movies.map((m) => [String(m.id), fix(m)]));
}
async function loadMine() {
  if (!S.user) { S.mine = new Map(); S.profile = { name: '', services: [], hideSeen: false }; return; }
  [S.profile, S.mine] = await Promise.all([store.getProfile(), store.loadMyMovies()]);
  S.f.hideSeen = S.profile.hideSeen;
  if (!S.profile.services.length) S.p.mine = false;
}

// ---------- views ----------
const views = {};

function queueBtn(m, cls = '') {
  const st = status(m.id);
  const on = st?.status === 'queue';
  return `<button class="btn ${cls}" data-act="queue" data-id="${m.id}" aria-pressed="${on}">${icon('bookmark', on ? 'filled' : '')}${on ? 'In your queue' : isSeen(m) ? 'Queue a rewatch' : 'Add to queue'}</button>`;
}

views.tonight = () => {
  shelfN = 0;
  const pool = S.movies.filter((m) => !isSeen(m));
  const featured = (S.config.featured || []).map((id) => S.byId.get(String(id))).filter(Boolean);
  const mineFirst = (list) => (S.profile.services.length ? list.filter(onMine) : list);
  const hot = pool.filter((m) => m.flags.includes('hot') || m.buzz >= 70).sort((a, b) => b.buzz - a.buzz).slice(0, 18);
  const crowd = mineFirst(pool.filter((m) => m.tier === 'favorite' || m.tier === 'known')).sort((a, b) => b.buzz + b.reach - a.buzz - a.reach).slice(0, 18);
  const cult = pool.filter((m) => m.tier === 'cult').sort((a, b) => b.buzz - a.buzz).slice(0, 18);
  const newBuzz = pool.filter((m) => m.flags.includes('new') && !m.flags.includes('quiet')).sort((a, b) => b.buzz - a.buzz).slice(0, 18);
  const quiet = pool.filter((m) => m.flags.includes('quiet')).sort((a, b) => (b.date || '').localeCompare(a.date || '')).slice(0, 18);
  const shudder = pool.filter((m) => m.pv.includes(99)).sort((a, b) => b.buzz - a.buzz).slice(0, 18);
  const top = featured[0] || mineFirst(hot.filter((m) => m.ov))[0] || hot[0] || pool[0];
  const firstRun = 'This shelf fills in after the next nightly data refresh.';
  return `
  <div class="qs" id="qs-wrap">
    <label class="search qs-box"><span class="sr">Search horror movies</span>${icon('search')}<input type="search" id="qs" placeholder="Search horror movies, directors or a subgenre" autocomplete="off" role="combobox" aria-expanded="false" aria-controls="qs-list"></label>
    <div class="qs-list" id="qs-list" role="listbox" hidden></div>
  </div>
  ${top ? `<section class="hero">
    ${wideArt(top)}<div class="shade"></div>
    <div class="hero-body">
      <span class="eyebrow">${icon(featured[0] ? 'star' : 'flame')}${featured[0] ? 'Featured tonight' : esc(trendLine(top).b)}</span>
      <h1>${esc(top.t)}</h1>
      <div class="facts">${[top.y, top.rt && `${top.rt} min`, top.cert].filter(Boolean).map((x) => `<span>${esc(x)}</span>`).join('')}${rating(top) ? `<span class="star">${rating(top)}</span>` : ''}<span>${esc(servicesText(top))}</span></div>
      ${top.ov ? `<p class="ov">${esc(top.ov)}</p>` : ''}
      <div class="row"><button class="btn primary" data-act="open" data-id="${top.id}">${icon('play')}See details</button>${queueBtn(top, 'glass')}<a class="btn glass m-hide" href="#/pick">${icon('dice')}Pick for me</a></div>
    </div>
  </section>` : ''}
  ${S.profile.services.length ? '' : `<div class="intro"><p class="muted">Tell us which streaming services you have and the shelves will show what you can watch tonight.</p><a class="btn small" href="${S.user ? '#/settings' : '#/signin'}">${icon('gear')}Add your services</a></div>`}
  ${featured.length > 1 ? shelf('Featured', 'Hand-picked for the site.', featured.slice(1), '') : ''}
  ${shelf('Trending this week', 'The horror movies people are watching and talking about right now.', hot, firstRun, '<a class="btn small ghost" href="#/browse">See all</a>')}
  ${shelf(S.profile.services.length ? 'Crowd favorites on your services' : 'Crowd favorites', 'Widely seen and well liked. Easy to get a group on board.', crowd, S.profile.services.length ? 'Nothing from this shelf is on your services right now.' : firstRun)}
  ${shelf('New and catching on', 'Out in the last four months and already getting attention.', newBuzz, firstRun)}
  ${shelf('New and under the radar', 'Recently released, but few people have found them yet.', quiet, firstRun)}
  ${shelf('Cult picks', 'Smaller audiences with loyal fans.', cult, firstRun)}
  ${shelf('On Shudder now', 'The busiest titles on Shudder this week.', shudder, firstRun)}`;
};

// Browse
function filtered() {
  const f = S.f; const q = f.q.trim().toLowerCase();
  const list = S.movies.filter((m) =>
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
  el.innerHTML = `<p class="count">${list.length} movie${list.length === 1 ? '' : 's'}</p>
    ${list.length ? `<div class="grid">${list.slice(0, S.f.limit).map(card).join('')}</div>` : `<div class="empty">${icon('search')}<span>Nothing matches all of those filters. Try removing a subgenre.</span></div>`}
    ${list.length > S.f.limit ? '<div class="row" style="justify-content:center"><button class="btn" data-act="more">Show more</button></div>' : ''}`;
}
views.browse = () => {
  const f = S.f;
  const decades = [...new Set(S.movies.map((m) => m.y && Math.floor(m.y / 10) * 10).filter(Boolean))].sort((a, b) => b - a);
  const provs = S.data.providers.filter((p) => S.movies.some((m) => m.pv.includes(p.id) || m.fr.includes(p.id)));
  S.after = renderResults;
  const any = f.sg.size || f.tier.size || f.q || f.decade || f.provider || f.mine;
  return `<div class="page-head"><h1>Browse</h1><p class="muted">Pick a few subgenres to narrow it down. Every filter you add has to match.</p></div>
  <div class="filters">
    <div class="toolbar">
      <label class="search"><span class="sr">Search</span>${icon('search')}<input type="search" id="f-q" data-bind="q" placeholder="Search titles or directors" value="${esc(f.q)}"></label>
      <select id="f-sort" data-bind="sort" aria-label="Sort">${[['buzz', 'Trending now'], ['reach', 'Most watched'], ['rating', 'Highest rated'], ['newest', 'Newest'], ['title', 'Title A to Z']].map(([v, l]) => `<option value="${v}" ${f.sort === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
      <select id="f-decade" data-bind="decade" aria-label="Decade"><option value="">Any decade</option>${decades.map((d) => `<option value="${d}" ${String(f.decade) === String(d) ? 'selected' : ''}>${d}s</option>`).join('')}</select>
      <select id="f-provider" data-bind="provider" aria-label="Streaming service"><option value="">Any service</option>${provs.map((p) => `<option value="${p.id}" ${String(f.provider) === String(p.id) ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select>
    </div>
    <div class="filter-row"><span>Subgenre</span>${sgPicker('fsg', f.sg)}</div>
    <div class="filter-row"><span>How known</span><div class="chips">${S.data.tiers.map((t) => chip('ftier', t.key, esc(t.label), f.tier.has(t.key))).join('')}</div></div>
    <div class="filter-row"><span>Show</span><div class="chips">
      ${chip('fmine', '', 'On my services', f.mine, S.profile.services.length ? '' : 'disabled title="Add services in Settings"')}
      ${chip('fseen', '', "Hide what I've seen", f.hideSeen)}
      ${any ? `<button class="chip" data-act="fclear">${icon('x')}Clear filters</button>` : ''}
    </div></div>
  </div>
  <div id="results" class="stack"></div>`;
};

// Pick for me
const MOODS = [
  ['crowd', 'Crowd pleaser', 'Popular and well liked'],
  ['different', 'Something different', 'Known, but off the main path'],
  ['deep', 'Deep cut', 'Cult and obscure picks'],
  ['any', 'Surprise me', 'Anything goes'],
];
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
function renderPick(animate) {
  const el = $('#pick-result'); if (!el) return;
  const m = S.p.current && S.byId.get(String(S.p.current));
  if (!m) {
    el.innerHTML = `<div class="pick-card empty-pick"><div class="stack" style="justify-items:center;padding:28px">${icon('dice')}<p>${S.p.current === false ? 'Nothing fits all of those choices. Loosen a filter and try again.' : 'Choose a mood, then press Pick for me.'}</p></div></div>`;
    return;
  }
  el.innerHTML = `<div class="pick-card ${animate ? 'spin' : ''}">
    ${wideArt(m)}<div class="shade"></div>
    <div class="body">
      <div class="facts">${[m.y, m.rt && `${m.rt} min`, m.cert].filter(Boolean).map((x) => `<span>${esc(x)}</span>`).join('')}${rating(m) ? `<span class="star">${rating(m)}</span>` : ''}<span>${esc(servicesText(m))}</span></div>
      <h2>${esc(m.t)}</h2>
      ${m.ov ? `<p>${esc(m.ov)}</p>` : ''}
      <div class="row">${m.sg.slice(0, 4).map(sgTag).join('')}</div>
      <div class="row"><button class="btn primary" data-act="repick">${icon('dice')}Pick another</button>${queueBtn(m)}<button class="btn" data-act="open" data-id="${m.id}">Details</button></div>
    </div></div>`;
}
views.pick = () => {
  const p = S.p;
  S.after = () => renderPick(false);
  return `<div class="page-head"><h1>Pick for me</h1><p class="muted">Set the mood and we'll pull one off the shelf. Movies you've seen are skipped.</p></div>
  <div class="pick-layout">
    <div class="panel filters">
      <div class="stack" style="gap:10px"><h3>Mood</h3><div class="seg">${MOODS.map(([k, l, d]) => `<button data-act="pmix" data-k="${k}" aria-pressed="${p.mix === k}"><b>${l}</b><span>${d}</span></button>`).join('')}</div></div>
      <div class="stack" style="gap:10px"><h3>Any of these subgenres</h3>${sgPicker('psg', p.sg)}</div>
      <div class="stack" style="gap:10px"><h3>Limits</h3><div class="chips">
        ${chip('pmine', '', 'On my services', p.mine, S.profile.services.length ? '' : 'disabled title="Add services in Settings"')}
        ${chip('pqueue', '', 'From my queue', p.queueOnly, S.user ? '' : 'disabled')}
        <select id="p-rt" data-bind="maxRt" aria-label="Maximum length" style="width:auto;min-height:36px;padding-block:6px;border-radius:999px"><option value="">Any length</option>${[90, 100, 110, 120].map((n) => `<option value="${n}" ${String(p.maxRt) === String(n) ? 'selected' : ''}>Under ${n} min</option>`).join('')}</select>
      </div></div>
      <button class="btn primary" data-act="repick" style="justify-self:start">${icon('dice')}Pick for me</button>
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
  const tab = S.qTab;
  const rows = tab === 'queue' ? q : seen;
  return `<div class="page-head"><h1>My queue</h1><p class="muted">${q.length ? `${q.length} movie${q.length === 1 ? '' : 's'} waiting for you.` : 'Save movies here to watch later.'}</p></div>
  <div class="tabs" role="tablist"><button role="tab" data-act="qtab" data-k="queue" aria-selected="${tab === 'queue'}">To watch (${q.length})</button><button role="tab" data-act="qtab" data-k="seen" aria-selected="${tab === 'seen'}">Seen (${seen.length})</button></div>
  ${tab === 'seen' ? '<p class="muted">Badges, milestones and your full watch log live in the <a href="#/bodycount">Body Count</a>.</p>' : ''}
  ${rows.length ? `<div class="grid">${rows.map((x) => card(x.m)).join('')}</div>` : `<div class="empty">${icon(tab === 'queue' ? 'bookmark' : 'check')}<span>${tab === 'queue' ? 'Your queue is empty. Open any movie and press "Add to queue".' : 'Nothing marked as seen yet. Open a movie and press "Seen it".'}</span></div>`}`;
};

// Movie nights
views.nights = async () => {
  if (!S.user) return signInPrompt('Sign in to start a movie night and vote with friends.');
  const list = (await store.listNights()).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  return `<div class="page-head"><h1>Movie nights</h1><p class="muted">Start a night and send friends the link. Everyone suggests movies and gets ${VOTES_PER_PERSON} votes.</p></div>
  <div class="two-col">
    <div class="list">${list.length ? list.map((n) => `<a class="list-item" href="#/night/${n.id}">
      <div><div class="t">${esc(n.title)}</div><div class="muted" style="font-size:.88rem">${n.date ? esc(n.date) + ', ' : ''}${n.members.length} ${n.members.length === 1 ? 'person' : 'people'}, ${Object.keys(n.candidates || {}).length} suggestions${n.winner ? `. Watching ${esc(S.byId.get(String(n.winner))?.t || '')}` : ''}</div></div>
      <span class="tag">${n.status === 'decided' ? 'Decided' : 'Voting open'}</span></a>`).join('') : `<div class="empty">${icon('users')}<span>No movie nights yet. Start one and invite your friends.</span></div>`}</div>
    <form class="panel stack" data-form="new-night">
      <h2>Start a movie night</h2>
      <label class="field">Name<input type="text" id="night-title" name="title" required maxlength="60" placeholder="Friday Fright Night"></label>
      <label class="field">Date (optional)<input type="date" id="night-date" name="date"></label>
      <button class="btn primary" type="submit">${icon('plus')}Create and get the link</button>
    </form>
  </div>`;
};

function thumb(m) { return `<span class="thumb">${art(m)}${S.config.showPosters && m.poster ? `<img src="https://image.tmdb.org/t/p/w92${m.poster}" alt="" loading="lazy">` : ''}</span>`; }
function renderNight(n, id) {
  const el = $('#night'); if (!el) return;
  if (!n) { el.innerHTML = `<div class="empty">${icon('users')}<span>This movie night was not found. It may have been deleted, or the link is incomplete.</span></div>`; return; }
  const me = S.user.uid;
  const member = n.members.includes(me);
  const owner = n.owner === me;
  if (!member) {
    el.innerHTML = `<div class="panel stack auth-card"><h1>${esc(n.title)}</h1><p class="muted">${esc(n.memberNames?.[n.owner] || 'Someone')} invited you to suggest and vote on what to watch${n.date ? ' on ' + esc(n.date) : ''}.</p><button class="btn primary" data-act="join" data-id="${id}">${icon('users')}Join this movie night</button></div>`;
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
  <div class="page-head"><h1>${esc(n.title)}</h1><p class="muted">${n.date ? esc(n.date) + '. ' : ''}With ${n.members.map((u) => esc(n.memberNames?.[u] || 'Guest')).join(', ')}</p></div>
  ${winner ? `<div class="list-item with-art winner">${thumb(winner)}<div><div class="muted" style="font-size:.88rem">We're watching</div><div class="t" style="font-size:1.3rem;font-family:var(--font-display)">${esc(winner.t)} <span class="faint">${winner.y ?? ''}</span></div><div class="muted" style="font-size:.88rem">${esc(servicesText(winner))}</div></div>
    <div class="row"><button class="btn small" data-act="open" data-id="${winner.id}">Details</button><button class="btn small" data-act="seen" data-id="${winner.id}">${icon('check')}Mark seen</button>${owner ? `<button class="btn small ghost" data-act="decide" data-night="${id}" data-id="">Reopen voting</button>` : ''}</div></div>` : ''}
  <div class="two-col">
    <section class="stack">
      <div class="shelf-head"><h2>Suggestions</h2><span class="muted" style="font-size:.9rem">${Math.max(0, VOTES_PER_PERSON - mine.length)} of ${VOTES_PER_PERSON} votes left</span></div>
      <div class="list">${cands.length ? cands.map(({ mid, c, m, v }) => {
        const voted = mine.includes(mid);
        return `<div class="list-item with-art ${winner && String(winner.id) === mid ? 'winner' : ''}">${thumb(m)}
          <div style="min-width:0"><button class="linkish" data-act="open" data-id="${mid}">${esc(m.t)}</button> <span class="faint">${m.y ?? ''}</span>
          <div class="muted" style="font-size:.85rem">${esc(servicesText(m))}. Suggested by ${esc(n.memberNames?.[c.by] || 'Guest')}</div></div>
          <div class="row"><span class="tally" aria-label="${v} votes">${v}</span>
            <button class="btn small" data-act="vote" data-night="${id}" data-id="${mid}" aria-pressed="${voted}" ${!voted && mine.length >= VOTES_PER_PERSON ? 'disabled' : ''}>${voted ? `${icon('check')}Voted` : 'Vote'}</button>
            ${owner ? `<button class="btn small" data-act="decide" data-night="${id}" data-id="${mid}">Pick</button><button class="icon-btn" data-act="unsuggest" data-night="${id}" data-id="${mid}" aria-label="Remove ${esc(m.t)}">${icon('x')}</button>` : ''}</div>
        </div>`;
      }).join('') : `<div class="empty">${icon('plus')}<span>No suggestions yet. Add a few from the right.</span></div>`}</div>
    </section>
    <aside class="stack">
      <div class="panel stack"><h3>Invite friends</h3><p class="muted" style="font-size:.9rem">Anyone with this link can sign up and join.</p>
        <input type="text" id="invite-link" readonly value="${esc(link)}" aria-label="Invite link"><button class="btn" data-act="copy" data-target="invite-link">${icon('link')}Copy link</button></div>
      <div class="panel stack"><h3>Suggest a movie</h3>
        <label class="search"><span class="sr">Search titles to suggest</span>${icon('search')}<input type="search" id="night-search" placeholder="Search titles"></label>
        <div id="night-search-results" class="list"></div>
        ${queueIdeas.length ? `<div class="muted" style="font-size:.88rem">From your queue</div><div class="chips">${queueIdeas.map((m) => `<button class="chip" data-act="suggest" data-night="${id}" data-id="${m.id}">${icon('plus')}${esc(m.t)}</button>`).join('')}</div>` : ''}
      </div>
      ${owner ? `<button class="btn ghost" data-act="delnight" data-night="${id}">Delete this movie night</button>` : ''}
    </aside>
  </div>`;
  el.dataset.night = id;
}
views.night = (id) => {
  if (!S.user) return signInPrompt('Sign in or create an account to join this movie night.');
  S.after = () => { S.stopNight = store.watchNight(id, (n) => { S.lastNight = n; renderNight(n, id); }); };
  return '<div id="night" class="stack"><div class="empty">Loading movie night…</div></div>';
};

// Streaming services, grouped so "Shudder", "Shudder Amazon Channel" and "Shudder Apple TV channel" are one choice.
const FREE_HINT = /tubi|pluto|plex|roku channel|youtube free|fawesome|xumo|fandango at home free|kanopy|hoopla|free with ads|mx player|crackle|freevee/i;
function brandOf(name) {
  let n = name.trim();
  n = n.replace(/\s+(Amazon|Apple TV|Roku Premium)\s+channel$/i, '');
  if (!/^the roku channel$/i.test(n)) n = n.replace(/\s+Channel$/i, '');
  n = n.replace(/\s+(Standard with Ads|Basic with Ads|Free with Ads|with Ads)$/i, '');
  n = n.replace(/\s+(Premium Plus|Premium|Essential)$/i, '');
  n = n.replace(/\s+Plus$/i, '+').replace(/^Amazon Prime Video$/i, 'Prime Video').replace(/^Tubi TV$/i, 'Tubi');
  return n;
}
// The big US services people actually subscribe to, in rough order of popularity. Everything else follows by JustWatch's ranking.
const POPULAR = ['netflix', 'prime video', 'hbo max', 'max', 'hulu', 'disney plus', 'disney+', 'paramount+', 'peacock', 'apple tv+', 'apple tv', 'shudder', 'tubi', 'pluto tv', 'the roku channel', 'amc+', 'starz', 'mgm+', 'youtube tv'];
let groupCache = null;
function serviceGroups() {
  if (groupCache) return groupCache;
  const count = new Map();
  for (const m of S.data.movies) for (const p of new Set([...m.pv, ...m.fr])) count.set(p, (count.get(p) || 0) + 1);
  const g = new Map();
  for (const p of S.data.providers) {
    const label = brandOf(p.name); const key = label.toLowerCase();
    if (!g.has(key)) g.set(key, { key, label, ids: [], movies: new Set(), free: true, logo: null, exact: false, pr: 999 });
    const x = g.get(key); x.ids.push(p.id); if (!FREE_HINT.test(p.name)) x.free = false;
    const exact = brandOf(p.name) === p.name.replace(/^Amazon Prime Video$/i, 'Prime Video').replace(/^Tubi TV$/i, 'Tubi') || p.name === label;
    if (p.logo && (!x.logo || (exact && !x.exact))) { x.logo = p.logo; x.exact = exact; }
    x.pr = Math.min(x.pr, p.pr ?? 999);
  }
  for (const m of S.data.movies) for (const x of g.values()) if (x.ids.some((id) => m.pv.includes(id) || m.fr.includes(id))) x.movies.add(m.id);
  const rank = (x) => { const i = POPULAR.indexOf(x.key); return i < 0 ? 1000 + x.pr : i; };
  groupCache = [...g.values()].map((x) => ({ ...x, n: x.movies.size, popular: POPULAR.includes(x.key) }))
    .filter((x) => x.popular || x.n > 0).sort((a, b) => rank(a) - rank(b) || b.n - a.n);
  return groupCache;
}
const groupOn = (x) => x.ids.some((id) => S.profile.services.includes(id));
function serviceTile(x) {
  const h = [...x.label].reduce((s, c) => s + c.charCodeAt(0) * 7, 0) % 360;
  const on = groupOn(x);
  return `<button class="svc" data-act="svcgroup" data-k="${esc(x.key)}" aria-pressed="${on}" style="--sh:${h}">
    ${x.logo ? `<img class="logo-img" src="https://image.tmdb.org/t/p/w92${x.logo}" alt="" loading="lazy" onerror="this.replaceWith(Object.assign(document.createElement('span'),{className:'mono-badge',textContent:${esc(JSON.stringify(x.label.replace(/^the /i, '').slice(0, 2)))}}))">` : `<span class="mono-badge">${esc(x.label.replace(/^the /i, '').slice(0, 2))}</span>`}
    <span class="nm"><b>${esc(x.label)}</b><small>${x.n ? `${x.n} horror movie${x.n === 1 ? '' : 's'}` : 'No horror right now'}${x.free ? ' · Free' : ''}</small></span>
    <span class="box" aria-hidden="true">${icon('check')}</span></button>`;
}
function renderServices() {
  const el = $('#svc-list'); if (!el) return;
  const all = serviceGroups();
  const q = (S.svcq || '').trim().toLowerCase();
  const picked = all.filter(groupOn);
  if (q) { const hits = all.filter((x) => x.label.toLowerCase().includes(q)); el.innerHTML = hits.length ? `<div class="svc-grid">${hits.map(serviceTile).join('')}</div>` : '<p class="muted">No service by that name carries horror movies right now.</p>'; return; }
  const popular = all.filter((x) => x.popular);
  const rest = all.filter((x) => !x.popular);
  el.innerHTML = `<h3 class="svc-h">Popular services</h3><div class="svc-grid">${popular.map(serviceTile).join('')}</div>
    ${rest.length ? `<details class="more"${S.svcMore ? ' open' : ''}><summary>${icon('plus')}${rest.length} more services</summary><div class="svc-grid">${rest.map(serviceTile).join('')}</div></details>` : ''}`;
  const c = $('#svc-count'); if (c) c.textContent = picked.length ? `${picked.length} selected: ${picked.map((x) => x.label).join(', ')}` : 'None selected yet';
}
let svcSaveTimer = null;
function saveServicesSoon() {
  clearTimeout(svcSaveTimer);
  svcSaveTimer = setTimeout(async () => { await store.saveProfile({ services: S.profile.services }); toast('Services saved'); }, 600);
}

// Profile
views.profile = (sub) => {
  if (!S.user) return signInPrompt('Sign in to save your name and streaming services.');
  let theme = 'system'; try { theme = localStorage.getItem('sq-theme') || 'system'; } catch { /* ignore */ }
  const name = S.profile.name || S.user.name || '';
  S.after = () => { renderServices(); if (sub === 'services') $('#services')?.scrollIntoView({ block: 'start' }); };
  return `<div class="profile-head"><span class="avatar xl" style="--ah:${avatarHue(name)}">${esc((name[0] || '?').toUpperCase())}</span><div><h1>${esc(name)}</h1><p class="muted">${esc(S.user.email || '')}</p></div></div>
  <div class="profile-grid">
    <section class="panel stack" id="services" style="gap:16px">
      <div class="shelf-head"><div><h2>Your streaming services</h2><p class="muted">Tap the ones you pay for or use. Shelves and Pick for me lean toward them. Saved as you go.</p></div></div>
      <p class="count" id="svc-count"></p>
      <label class="search"><span class="sr">Find a service</span>${icon('search')}<input type="search" id="svc-q" placeholder="Find a service" value="${esc(S.svcq || '')}"></label>
      <div id="svc-list"></div>
      <p class="fine">Channel versions (like Shudder through Prime Video) and ad tiers are grouped with the main service. Logos and streaming data from JustWatch via TMDB.</p>
    </section>
    <div class="stack" style="gap:24px">
      <form class="panel stack" data-form="settings" style="gap:16px">
        <h2>Profile</h2>
        <label class="field">Display name (shown on movie nights)<input type="text" id="set-name" name="name" maxlength="40" value="${esc(S.profile.name)}"></label>
        <label class="row" style="gap:10px"><input type="checkbox" id="set-hide" name="hideSeen" ${S.profile.hideSeen ? 'checked' : ''}> Hide movies I've seen when browsing</label>
        <button class="btn primary" type="submit" style="justify-self:start">Save profile</button>
      </form>
      <section class="panel stack" style="gap:14px">
        <h2>Appearance</h2>
        <div class="tabs" role="group" aria-label="Theme">${['system', 'dark', 'light'].map((t) => `<button data-act="theme" data-k="${t}" aria-selected="${theme === t}">${{ system: 'Match device', dark: 'Dark', light: 'Light' }[t]}</button>`).join('')}</div>
      </section>
      <section class="panel stack" style="gap:12px">
        <h2>Account</h2>
        <div class="row"><a class="btn" href="#/bodycount">${icon('skull')}Your Body Count</a><button class="btn ghost" type="button" data-act="signout">Sign out</button>${store.demo ? '<button class="btn ghost" type="button" data-act="resetdemo">Reset demo data</button>' : ''}</div>
      </section>
    </div>
  </div>`;
};
views.settings = views.profile;

// Sign in
function signInPrompt(msg) {
  return `<div class="panel stack auth-card" style="text-align:center;justify-items:center"><span class="logo"><span class="mark">${icon('skull')}</span></span><h2>Sign in to continue</h2><p class="muted">${msg}</p><a class="btn primary" href="#/signin" data-act="gosignin">Sign in or create an account</a></div>`;
}
views.signin = () => {
  if (S.user) { setTimeout(() => (location.hash = S.afterSignIn || '#/')); return ''; }
  return `<div class="panel stack auth-card" style="gap:18px">
    <h1 style="font-size:2rem">Welcome to ${esc(SITE_NAME)}</h1>
    <p class="muted">${esc(TAGLINE)} An account keeps your queue, Body Count and movie nights.</p>
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
  <div class="panel stack prose" style="max-width:760px;gap:18px">
    <p>Every night the site pulls the most popular, most talked-about and most-rated horror movies from TMDB, along with where they're streaming in the US.</p>
    <h3>Trending vs. widely seen</h3>
    <p class="muted">Each movie is measured two ways. How much attention it's getting this week (from TMDB's trending lists and activity), and how many people have seen it overall (from rating counts on TMDB and IMDb). That's how the site can tell a new release people are actually watching from one that just came out.</p>
    <h3>The labels on each movie</h3>
    <div class="chips">${S.data.tiers.map((t) => `<span class="tag t-${t.key}" style="--h:0"><span class="sw" style="background:var(--tc)"></span>${esc(t.label)}</span>`).join('')}</div>
    <p class="muted">New Release covers the last four months, since brand-new movies haven't had time to collect ratings. The rest go from the most-watched horror movies down to ones few people have found. The labels compare horror movies with each other, not with all movies.</p>
    <h3>Subgenres</h3><p class="muted">Tagged from TMDB keywords like "slasher", "demonic possession" or "found footage", plus overlaps like horror comedy and sci-fi horror. A movie can have several. The site admin can correct them.</p>
    <h3>The artwork</h3><p class="muted">Each movie gets its own generated artwork in the colors of its main subgenre, so the shelves stay readable without studio posters.</p>
  </div>`;

// Admin
views.admin = async () => {
  if (!S.user?.isAdmin) return `<div class="empty">${icon('shield')}<span>This page is for site admins.</span></div>`;
  const stats = await store.adminStats().catch(() => ({ users: '—' }));
  const c = S.config;
  const d = S.data;
  const listOf = (ids, act) => ids.map((id) => S.byId.get(String(id))).filter(Boolean).map((m) => `<div class="list-item"><span>${esc(m.t)} <span class="faint">${m.y ?? ''}</span></span><button class="btn small ghost" data-act="${act}" data-id="${m.id}">Remove</button></div>`).join('') || '<p class="muted">None.</p>';
  const fix = S.adminFix && S.byId.get(String(S.adminFix));
  return `<div class="page-head"><h1>Admin</h1><p class="muted">Site-wide settings. Changes apply for everyone after you press Save.</p></div>
  <div class="two-col">
  <div class="stack">
    <div class="panel stack"><h2>Data</h2>
      <p>${d.movies.length} movies, refreshed ${new Date(d.generatedAt).toLocaleString()}.</p>
      <p class="muted">TMDB ${d.sources.tmdb ? 'connected' : 'off'}. Trakt ${d.sources.trakt ? 'connected' : 'off'}. IMDb ratings (OMDb) ${d.sources.omdb ? 'connected' : 'off'}.${d.sample ? ' Showing sample data until the first nightly refresh runs.' : ''}</p>
      <p class="muted">${stats.users} account${stats.users === 1 ? '' : 's'}.</p></div>
    <div class="panel stack"><h2>Site settings</h2>
      <label class="row" style="gap:10px"><input type="checkbox" id="adm-posters" ${c.showPosters ? 'checked' : ''}> Show TMDB poster art instead of generated artwork</label>
      <p class="muted" style="font-size:.88rem">Posters belong to the studios. TMDB's API terms allow showing them with TMDB credit. Off by default.</p>
      <label class="field">Announcement (leave blank for none)<input type="text" id="adm-announce" maxlength="160" value="${esc(c.announcement || '')}"></label>
    </div>
    <div class="panel stack"><h2>Fix a movie's subgenres</h2>
      <label class="search"><span class="sr">Search a title to fix</span>${icon('search')}<input type="search" id="adm-fix-search" placeholder="Search a title"></label>
      <div id="adm-fix-results" class="list"></div>
      ${fix ? `<div class="stack"><b>${esc(fix.t)}</b><div class="chips">${d.subgenres.map((s) => sgChip('fixsg', s, fix.sg.includes(s.key))).join('')}</div>${c.sgFix?.[fix.id] ? `<button class="btn small ghost" data-act="fixclear" data-id="${fix.id}">Use automatic tags again</button>` : ''}</div>` : ''}
    </div>
  </div>
  <div class="stack">
    <div class="panel stack"><h2>Featured</h2><div class="list">${listOf(c.featured || [], 'unfeature')}</div>
      <label class="search"><span class="sr">Search a title to feature</span>${icon('search')}<input type="search" id="adm-feat-search" placeholder="Search to feature"></label><div id="adm-feat-results" class="list"></div></div>
    <div class="panel stack"><h2>Hidden from the site</h2><div class="list">${listOf(c.hidden || [], 'unhide')}</div>
      <label class="search"><span class="sr">Search a title to hide</span>${icon('search')}<input type="search" id="adm-hide-search" placeholder="Search to hide"></label><div id="adm-hide-results" class="list"></div></div>
    <button class="btn primary" data-act="savecfg">Save admin changes</button>
  </div></div>`;
};

function searchList(q, act, n = 6) {
  q = q.trim().toLowerCase(); if (!q) return '';
  return S.data.movies.filter((m) => m.t.toLowerCase().includes(q)).slice(0, n)
    .map((m) => `<div class="list-item with-art">${thumb(m)}<span>${esc(m.t)} <span class="faint">${m.y ?? ''}</span></span><button class="btn small" data-act="${act}" data-id="${m.id}">${{ feature: 'Feature', hide: 'Hide', fixpick: 'Edit tags', nsuggest: 'Suggest' }[act]}</button></div>`).join('') || '<p class="muted">No matches.</p>';
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
    { ic: 'star', name: 'Horror Essentials', desc: `See all ${ESSENTIALS} of the most widely seen horror movies`, have: essSeen, need: ESSENTIALS, steps: [10, 25, 50, 100] },
    { ic: 'grid', name: 'Well Rounded', desc: 'At least one movie in every subgenre', have: covered, need: S.data.subgenres.length },
    { ic: 'clock', name: 'Time Traveler', desc: 'Movies from six different decades', have: decades.size, need: 6 },
    { ic: 'eye', name: 'Deep Diver', desc: 'Ten Deep Cuts seen', have: deep, need: 10 },
    { ic: 'flame', name: 'Opening Night', desc: 'Watched a movie within 30 days of release', have: early, need: 1 },
    { ic: 'play', name: 'Marathoner', desc: 'Three movies logged on the same day', have: marathon, need: 3 },
    { ic: 'skull', name: 'Critic', desc: 'Rated 25 movies', have: rated, need: 25 },
    { ic: 'trophy', name: 'Spooky Season', desc: '31 movies watched this October', have: oct, need: 31 },
  ];
}
function prog(have, need, h) {
  const pct = Math.min(100, Math.round((have / Math.max(1, need)) * 100));
  return `<div class="prog" role="progressbar" aria-valuemin="0" aria-valuemax="${need}" aria-valuenow="${Math.min(have, need)}"${h != null ? ` style="--h:${h}"` : ''}><i style="width:${pct}%"></i></div>`;
}

const monthName = (k) => (k ? new Date(k + '-15T12:00:00Z').toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' }) : 'Before Scream Queue');
const shortDate = (d) => new Date(d + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
// A seen movie as a poster card; works even when the movie has left the nightly list.
function watchedCard(x) {
  const m = x.m || { id: x.id, t: x.t, y: x.y, sg: x.sg, rt: x.rt, tier: x.tier || 'known', poster: x.st.poster, flags: [], pv: [], fr: [] };
  const name = `${x.t}${x.y ? ` (${x.y})` : ''}`;
  return `<div class="card watched" data-id="${x.id}">
    <button class="card-open" ${x.m ? `data-act="open" data-id="${x.id}"` : ''} aria-label="${esc(name)}, seen">
    ${poster(m, { noBadges: true })}
    <span class="meta"><span class="mt">${esc(x.t)}${x.y ? ` <span class="yr">(${x.y})</span>` : ''}</span><span class="l1">${skullRow(x.st.rating)}</span><span class="l2">${x.on ? `Watched ${esc(shortDate(x.on))}` : 'Before Scream Queue'}${x.st.status === 'queue' ? '. Rewatch queued' : ''}</span></span>
  </button>
    ${quickBar(m, name)}
  </div>`;
}
function renderBodyList() {
  const el = $('#bc-results'); if (!el) return;
  const q = (S.bcq || '').trim().toLowerCase();
  const sg = S.bcSg || '';
  const sort = S.bcSort || 'recent';
  let seen = seenList().filter((x) => (!q || x.t.toLowerCase().includes(q)) && (!sg || x.sg.includes(sg)));
  const by = {
    recent: (a, b) => (b.on || '').localeCompare(a.on || '') || (b.st.at || 0) - (a.st.at || 0),
    rating: (a, b) => (b.st.rating || 0) - (a.st.rating || 0) || a.t.localeCompare(b.t),
    title: (a, b) => a.t.localeCompare(b.t),
    year: (a, b) => (b.y || 0) - (a.y || 0),
  }[sort];
  seen.sort(by);
  let html = '';
  if (q) {
    const notSeen = S.movies.filter((m) => m.t.toLowerCase().includes(q) && !everSeen(m) && (!sg || m.sg.includes(sg))).sort((a, b) => b.reach - a.reach).slice(0, 8);
    html += `<div class="answer ${seen.length ? 'yes' : 'no'}">${seen.length
      ? `${icon('check')}<span><b>Yes, you've seen ${seen.length === 1 ? esc(seen[0].t) : `${seen.length} movies matching "${esc(S.bcq.trim())}"`}.</b>${seen.length === 1 ? ` ${seen[0].on ? `Watched ${esc(shortDate(seen[0].on))}.` : 'Logged before Scream Queue.'}${seen[0].st.rating ? ` You gave it ${fmtRating(seen[0].st.rating)} skulls.` : ''}` : ''}</span>`
      : `${icon('eye')}<span><b>Not in your Body Count.</b> ${notSeen.length ? 'It\'s listed below if you want to add it.' : 'No horror movie on the site matches that title.'}</span>`}</div>`;
    if (seen.length) html += `<div class="grid">${seen.map(watchedCard).join('')}</div>`;
    if (notSeen.length) html += `<h3 class="muted">${seen.length ? 'Other matches you haven\'t seen' : 'Matches you haven\'t seen'}</h3><div class="list">${notSeen.map((m) => `<div class="list-item with-art">${thumb(m)}<div style="min-width:0"><button class="linkish" data-act="open" data-id="${m.id}">${esc(m.t)}</button> <span class="faint">${m.y ?? ''}</span><div class="muted" style="font-size:.85rem">${esc(S.tierLabel.get(m.tier))}</div></div><button class="btn small seen-btn" data-act="seen" data-id="${m.id}" aria-pressed="false">${icon('eye')}Mark as seen</button></div>`).join('')}</div>`;
  } else if (!seen.length) {
    html = `<div class="empty">${icon('skull')}<span>${sg ? 'Nothing seen in that subgenre yet.' : 'Nothing logged yet. Open any movie and press "Mark as seen", or check off the ones you\'ve already watched.'}</span><a class="btn small" href="#/checklist">Open the checklist</a></div>`;
  } else if (sort === 'recent') {
    const groups = new Map();
    for (const x of seen) { const k = x.on ? x.on.slice(0, 7) : ''; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(x); }
    html = [...groups.entries()].map(([k, list]) => `<div class="stack" style="gap:14px"><h3>${esc(monthName(k))} <span class="faint">${list.length}</span></h3><div class="grid">${list.map(watchedCard).join('')}</div></div>`).join('');
  } else {
    html = `<div class="grid">${seen.map(watchedCard).join('')}</div>`;
  }
  el.innerHTML = html;
}

views.bodycount = () => {
  shelfN = 0;
  if (!S.user) return signInPrompt('Sign in to keep a Body Count of every horror movie you have survived.');
  const seen = seenList();
  const mins = seen.reduce((s, x) => s + (x.rt || 0), 0);
  const rated = seen.filter((x) => x.st.rating);
  const avg = rated.length ? (rated.reduce((s, x) => s + x.st.rating, 0) / rated.length).toFixed(1) : '–';
  const counts = {};
  for (const x of seen) for (const k of x.sg) counts[k] = (counts[k] || 0) + 1;
  const tab = S.bcTab || 'watched';
  if (tab === 'watched') S.after = renderBodyList;
  const sgs = S.data.subgenres.filter((x) => counts[x.key]);
  return `<div class="bc-head">
    <div class="bc-count"><b>${seen.length}</b><span>horror movie${seen.length === 1 ? '' : 's'} survived</span></div>
    <div class="stack" style="gap:6px;min-width:0"><h1>Body Count</h1>
      <p class="muted">${Math.round(mins / 60)} hours of horror. Average rating ${avg}. ${Object.keys(counts).length} of ${S.data.subgenres.length} subgenres explored.</p></div>
  </div>
  <div class="bc-bar">
    <label class="search bc-search"><span class="sr">Have I seen it?</span>${icon('search')}<input type="search" id="bc-q" placeholder="Have I seen it? Type a title" value="${esc(S.bcq || '')}" autocomplete="off"></label>
  </div>
  ${tab === 'watched' ? `<div class="row bc-tools">
      <div class="tabs" role="tablist"><button role="tab" data-act="bctab" data-k="watched" aria-selected="true">Watched</button><button role="tab" data-act="bctab" data-k="badges" aria-selected="false">Badges</button></div>
      <select id="bc-sort" aria-label="Sort" style="width:auto">${[['recent', 'Most recent'], ['rating', 'Your highest rated'], ['title', 'Title A to Z'], ['year', 'Newest releases']].map(([v, l]) => `<option value="${v}" ${(S.bcSort || 'recent') === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
      <select id="bc-sg" aria-label="Subgenre" style="width:auto"><option value="">All subgenres</option>${sgs.map((x) => `<option value="${x.key}" ${S.bcSg === x.key ? 'selected' : ''}>${esc(x.label)} (${counts[x.key]})</option>`).join('')}</select>
      <a class="btn" href="#/checklist" style="margin-left:auto">${icon("check")}Check off movies</a>
    </div>
    <div id="bc-results" class="stack" style="gap:28px"></div>` : `<div class="row bc-tools"><div class="tabs" role="tablist"><button role="tab" data-act="bctab" data-k="watched" aria-selected="false">Watched</button><button role="tab" data-act="bctab" data-k="badges" aria-selected="true">Badges</button></div></div>${badgesSection(seen, counts)}`}`;
};

function badgesSection(seen, counts) {
  const nextMs = MILESTONES.find(([n]) => seen.length < n);
  const badges = computeBadges(seen);
  const ess = essentialsList();
  const essNext = ess.filter((m) => !everSeen(m)).slice(0, 12);
  return `<section class="panel stack" style="gap:18px">
    <div class="shelf-head"><h2>Milestones</h2>${nextMs ? `<span class="muted">${nextMs[0] - seen.length} more to ${esc(nextMs[1])}</span>` : '<span class="muted">Every milestone earned</span>'}</div>
    ${nextMs ? prog(seen.length, nextMs[0]) : ''}
    <div class="medals">${MILESTONES.map(([n, name, desc]) => `<div class="medal ${seen.length >= n ? 'won' : ''}" title="${esc(desc)}"><span class="n">${n}</span><b>${esc(name)}</b></div>`).join('')}</div>
  </section>
  <section class="stack" style="gap:16px">
    <h2>Badges</h2>
    <div class="badges">${badges.map((b) => {
      const won = b.have >= b.need;
      const step = b.steps ? b.steps.filter((s) => b.have >= s).pop() : null;
      const nextStep = b.steps ? b.steps.find((s) => b.have < s) : null;
      return `<div class="badge ${won ? 'won' : step || b.have ? 'part' : ''}">
        <div class="hd"><span class="ico">${icon(b.ic)}</span><b>${esc(b.name)}</b><span class="num">${Math.min(b.have, b.need)} of ${b.need}</span></div>
        <p>${esc(b.desc)}${step && !won ? `. Next stop: ${nextStep}` : ''}</p>
        ${prog(b.have, b.need)}</div>`;
    }).join('')}</div>
  </section>
  <section class="panel stack" style="gap:16px">
    <div class="shelf-head"><div><h2>Subgenre mastery</h2><p class="muted" style="font-size:.9rem">${LEVELS.map(([n, l]) => `${l} at ${n}`).join(', ')}. Tap one to browse it.</p></div></div>
    <div class="mastery">${S.data.subgenres.map((s) => {
      const n = counts[s.key] || 0; const { cur, next } = levelFor(n);
      return `<button class="mast" data-act="sgbrowse" data-k="${s.key}" style="--h:${hue(s.key)}">
        <span class="hd"><span class="mn">${sgIcon(s.key)}${esc(s.label)}</span><span>${n}</span></span>
        <small>${cur ? esc(cur[1]) : 'Not started'}${next ? `. ${next[0] - n} to ${next[1]}` : '. Maxed out'}</small>
        ${prog(n, next ? next[0] : Math.max(n, 1), hue(s.key))}</button>`;
    }).join('')}</div>
  </section>
  ${shelf(`Horror Essentials: ${ess.length - ess.filter((m) => !everSeen(m)).length} of ${ess.length}`, `The ${ESSENTIALS} most widely seen horror movies on the site. Here's what's next for you.`, essNext, 'You have seen every one of them.', `<a class="btn small" href="#/checklist">${icon('check')}Check off what you've seen</a>`)}`;
}

views.checklist = () => {
  if (!S.user) return signInPrompt('Sign in to check off the movies you have seen.');
  const q = (S.ckq || '').toLowerCase();
  const base = S.ckAll ? S.movies.slice().sort((a, b) => b.reach - a.reach) : essentialsList();
  const list = base.filter((m) => !q || m.t.toLowerCase().includes(q)).slice(0, S.ckAll ? 300 : ESSENTIALS);
  const done = base.filter(everSeen).length;
  return `<div class="page-head"><h1>What have you seen?</h1><p class="muted">Tap every movie you've already watched. They go into your Body Count under "Before Scream Queue", so you don't need dates.</p></div>
  <div class="row" style="justify-content:space-between">
    <div class="tabs" role="tablist"><button role="tab" data-act="ckmode" data-k="ess" aria-selected="${!S.ckAll}">Horror Essentials</button><button role="tab" data-act="ckmode" data-k="all" aria-selected="${!!S.ckAll}">Everything</button></div>
    <span class="muted" id="ck-count">${done} of ${base.length} seen</span>
  </div>
  <div class="row"><label class="search" style="flex:1;max-width:440px"><span class="sr">Filter by title</span>${icon('search')}<input type="search" id="ck-q" placeholder="Filter by title" value="${esc(S.ckq || '')}"></label><a class="btn" href="#/bodycount">${icon('trophy')}Back to Body Count</a></div>
  <div class="checks">${list.map((m) => `<button class="check" data-act="ck" data-id="${m.id}" aria-pressed="${everSeen(m)}">${thumb(m)}<span style="min-width:0"><b>${esc(m.t)}</b> <span class="faint">${m.y ?? ''}</span><br><span class="muted" style="font-size:.82rem">${esc(S.tierLabel.get(m.tier))}${m.sg.length ? ', ' + esc(S.sgLabel.get(m.sg[0])) : ''}</span></span><span class="box" aria-hidden="true">${icon('check')}</span></button>`).join('')}</div>`;
};

// ---------- quick search ----------
function quickMatches(q) {
  q = q.trim().toLowerCase(); if (!q) return [];
  const sg = S.data.subgenres.find((x) => x.label.toLowerCase().startsWith(q));
  const hits = S.movies.filter((m) => m.t.toLowerCase().includes(q) || m.dir.some((d) => d.toLowerCase().includes(q)) || m.cast.some((c) => c.toLowerCase().includes(q)));
  hits.sort((a, b) => (b.t.toLowerCase().startsWith(q) - a.t.toLowerCase().startsWith(q)) || b.reach + b.buzz - a.reach - a.buzz);
  return { sg, list: hits.slice(0, 7), total: hits.length };
}
function renderQuick() {
  const box = $('#qs-list'), inp = $('#qs'); if (!box || !inp) return;
  const q = inp.value.trim();
  if (!q) { box.hidden = true; inp.setAttribute('aria-expanded', 'false'); return; }
  const { sg, list, total } = quickMatches(q);
  const rows = list.map((m, i) => {
    const st = status(m.id);
    const tag = st?.status === 'queue' ? `<span class="qs-tag q">${icon('bookmark')}Queued</span>` : everSeen(m) ? `<span class="qs-tag s">${icon('skull')}Survived</span>` : '';
    return `<button class="qs-row" role="option" data-act="open" data-id="${m.id}" data-i="${i}">${thumb(m)}<span class="nm"><b>${esc(m.t)}</b><small>${[m.y, m.dir[0], servicesText(m)].filter(Boolean).map(esc).join(' · ')}</small></span>${tag}</button>`;
  }).join('');
  box.innerHTML = `${sg ? `<button class="qs-row qs-sg" data-act="sgbrowse" data-k="${sg.key}" style="--h:${hue(sg.key)}"><span class="sgdot">${sgIcon(sg.key)}</span><span class="nm"><b>Browse ${esc(sg.label)}</b><small>Subgenre</small></span></button>` : ''}
    ${rows || '<p class="qs-empty">No horror movie on the site matches that.</p>'}
    ${total > list.length ? `<button class="qs-more" data-act="qsall">See all ${total} results</button>` : ''}`;
  box.hidden = false; inp.setAttribute('aria-expanded', 'true');
  S.qsIdx = -1;
}
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && document.querySelector('.rate-sheet')) { closeRateSheet(); return; }
  if (e.key === 'Escape') { const c = document.querySelector('.card.qa-on'); if (c) { const b = c.querySelector('.qa-rate:not([hidden]) .qa-x') || c.querySelector('.qa-plus'); c.classList.remove('qa-on', 'rating'); c.querySelector('.qa-rate').hidden = true; c.querySelector('.card-open')?.focus(); return; } }
  if (e.target.id !== 'qs') return;
  const rows = [...document.querySelectorAll('#qs-list .qs-row, #qs-list .qs-more')];
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault(); if (!rows.length) return;
    S.qsIdx = Math.max(0, Math.min(rows.length - 1, (S.qsIdx ?? -1) + (e.key === 'ArrowDown' ? 1 : -1)));
    rows.forEach((r, i) => r.classList.toggle('on', i === S.qsIdx)); rows[S.qsIdx].scrollIntoView({ block: 'nearest' });
  } else if (e.key === 'Enter') {
    e.preventDefault();
    if (S.qsIdx >= 0 && rows[S.qsIdx]) rows[S.qsIdx].click(); else actions.qsall();
  } else if (e.key === 'Escape') { e.target.value = ''; renderQuick(); }
});
document.addEventListener('click', (e) => { if (!e.target.closest('#qs-wrap')) { const b = $('#qs-list'); if (b) b.hidden = true; } });

// ---------- detail sheet ----------
function openDetail(id) {
  const m = S.byId.get(String(id)); if (!m) return;
  const dlg = $('#detail');
  const st = status(m.id);
  const seen = st?.status === 'seen';
  const tr = trendLine(m), rc = reachLine(m);
  // One tile per service (channel and ad-tier versions folded together), your services first.
  const tiles = (ids, kind) => {
    const groups = serviceGroups().filter((g) => g.ids.some((id) => ids.includes(id))).sort((a, b) => groupOn(b) - groupOn(a));
    return groups.map((g) => {
      const mine = groupOn(g);
      const inner = `${g.logo ? `<img src="https://image.tmdb.org/t/p/w154${g.logo}" alt="" loading="lazy">` : `<span class="ph">${esc(g.label.slice(0, 2))}</span>`}
        <span class="nm"><b>${esc(g.label)}</b><small>${mine ? 'On your services' : kind}</small></span>${m.wl ? icon('right', 'go') : ''}`;
      return m.wl ? `<a class="wtw${mine ? ' mine' : ''}" href="${esc(m.wl)}" target="_blank" rel="noopener" title="Watch on ${esc(g.label)}">${inner}</a>` : `<span class="wtw${mine ? ' mine' : ''}">${inner}</span>`;
    }).join('');
  };
  const subT = tiles(m.pv, 'Included with subscription');
  const freeT = tiles(m.fr, 'Free with ads');
  const provs = (subT ? `<div class="wtw-group"><span class="wtw-h">Stream</span><div class="wtw-grid">${subT}</div></div>` : '')
    + (freeT ? `<div class="wtw-group"><span class="wtw-h">Free</span><div class="wtw-grid">${freeT}</div></div>` : '')
    + (m.rent ? `<div class="wtw-group"><span class="wtw-h">Rent or buy</span><div class="wtw-grid">${m.wl ? `<a class="wtw rent" href="${esc(m.wl)}" target="_blank" rel="noopener"><span class="ph">${icon('play')}</span><span class="nm"><b>See rental prices</b><small>Apple TV, Prime Video, Fandango and more</small></span>${icon('right', 'go')}</a>` : '<span class="muted">Available to rent or buy.</span>'}</div></div>` : '');
  const keepScroll = dlg.open ? $('.sheet', dlg)?.scrollTop : 0;
  const fxKeep = [...dlg.querySelectorAll('.fx-layer')];
  dlg.innerHTML = `<div class="sheet">
    <div class="sheet-hero">${wideArt(m)}<button class="icon-btn close" data-act="close" aria-label="Close">${icon('x')}</button></div>
    <div class="sheet-title ${S.config.showPosters && m.poster ? 'with-poster' : ''}">
      ${S.config.showPosters && m.poster ? `<img class="sheet-poster" src="https://image.tmdb.org/t/p/w342${m.poster}" alt="${esc(m.t)} poster">` : ''}
      <div class="stack" style="gap:8px;min-width:0">
      <h2>${esc(m.t)}</h2>
      <div class="facts">${[m.y, m.rt && `${m.rt} min`, m.cert, m.dir.length && `Directed by ${m.dir.join(' and ')}`].filter(Boolean).map((x) => `<span>${esc(x)}</span>`).join('')}${rating(m) ? `<span class="star">${rating(m)}</span>` : ''}</div>
    </div></div>
    <div class="sheet-body">
      <div class="row" style="gap:8px">${m.sg.map(sgTag).join('') || '<span class="faint">No subgenre tags yet</span>'}</div>
      ${m.ov ? `<p style="font-size:1.02rem;max-width:66ch">${esc(m.ov)}</p>` : ''}
      ${m.cast.length ? `<p class="muted">With ${esc(m.cast.join(', '))}</p>` : ''}
      <div class="signals">
        <div class="signal"><span class="ico">${icon('flame')}</span><div><b>${esc(tr.b)}</b><span>${esc(tr.s)}</span></div></div>
        <div class="signal reach t-${m.tier}"><span class="ico">${icon('eye')}</span><div><b>${esc(rc.b)}</b><span>${esc(rc.s)}</span></div></div>
      </div>
      <div class="actions">${queueBtn(m, seen ? '' : 'primary')}<button class="btn seen-btn" data-act="seen" data-id="${m.id}" aria-pressed="${seen}" title="${seen ? 'Click to unmark as seen' : 'Add to your Body Count'}">${icon(seen ? 'check' : 'eye')}${seen ? 'Seen' : 'Mark as seen'}</button>
        ${seen ? `${skullPicker(m, st.rating || 0)}
        <label class="date">Watched <input type="date" id="seen-date" data-id="${m.id}" value="${esc(st.seenOn || '')}" max="${today()}"></label>` : ''}
        ${st ? `<button class="btn ghost small" data-act="forget" data-id="${m.id}">Remove from my lists</button>` : ''}</div>
      <div class="stack" style="gap:10px"><h3>Where to watch in the US</h3>
        <div class="providers">${provs || '<span class="muted">Not on a streaming service right now.</span>'}</div>
        <span class="fine">Tap a service to see it on JustWatch. Streaming data from JustWatch via TMDB${SAMPLE() ? '. Sample data, not real' : ''}.</span></div>
      <div class="linkrow">${links(m).map(([l, u]) => `<a href="${esc(u)}" target="_blank" rel="noopener">${icon('link')}${l}</a>`).join('')}</div>
    </div></div>`;
  fxKeep.forEach((l) => dlg.append(l));
  dlg.dataset.id = m.id;
  if (!dlg.open) { try { dlg.showModal(); } catch { dlg.setAttribute('open', ''); } }
  else { const sh = $('.sheet', dlg); if (sh) sh.scrollTop = keepScroll; }
}
function refreshDetail() { const d = $('#detail'); if (d.open && d.dataset.id) openDetail(d.dataset.id); }


// ---------- little celebrations ----------
const QUEUE_TARGETS = '.nav a[href="#/queue"], .tabbar a[href="#/queue"]';
const COUNT_TARGETS = '.nav a[href="#/bodycount"], .acct-btn';
const canFx = () => !reduceMotion() && !!Element.prototype.animate;
const rectOf = (el) => (el?.getBoundingClientRect ? el.getBoundingClientRect() : null);
const visible = (sel) => [...document.querySelectorAll(sel)].find((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden'; });
function fxLayer() {
  const host = $('#detail')?.open ? $('#detail') : document.body;
  const layer = document.createElement('div'); layer.className = 'fx-layer'; layer.setAttribute('aria-hidden', 'true');
  host.append(layer); setTimeout(() => layer.remove(), 1400);
  return layer;
}
function burst(target, kind = 'blood', at) {
  if (!canFx()) return;
  const r = at || rectOf(target); if (!r) return;
  const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  const layer = fxLayer();
  const n = kind === 'blood' ? 14 : 9;
  for (let i = 0; i < n; i++) {
    const d = document.createElement('i'); d.className = 'fx-dot ' + kind; layer.append(d);
    const ang = (Math.PI * 2 * i) / n + Math.random() * 0.6;
    const dist = (kind === 'blood' ? 34 : 24) + Math.random() * 30;
    const size = kind === 'blood' ? 4 + Math.random() * 8 : 4 + Math.random() * 4;
    d.style.cssText = `left:${cx}px;top:${cy}px;width:${size}px;height:${size}px`;
    const dx = Math.cos(ang) * dist, dy = Math.sin(ang) * dist;
    d.animate([
      { transform: 'translate(-50%,-50%) scale(.3)', opacity: 1 },
      { transform: `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px)) scale(1)`, opacity: 1, offset: 0.55 },
      { transform: `translate(calc(-50% + ${dx * 1.1}px), calc(-50% + ${dy * 1.1 + (kind === 'blood' ? 26 : 6)}px)) scale(${kind === 'blood' ? 0.8 : 0.4})`, opacity: 0 },
    ], { duration: 700 + Math.random() * 300, easing: 'cubic-bezier(.2,.8,.2,1)', fill: 'forwards' });
  }
}
function floatUp(at, html) {
  if (!canFx() || !at) return;
  const el = document.createElement('span'); el.className = 'fx-float'; el.innerHTML = html;
  el.style.left = at.left + at.width / 2 + 'px'; el.style.top = at.top + 'px';
  fxLayer().append(el);
  el.animate([
    { transform: 'translate(-50%, 0) scale(.6)', opacity: 0 },
    { transform: 'translate(-50%, -26px) scale(1.1)', opacity: 1, offset: 0.3 },
    { transform: 'translate(-50%, -64px) scale(1)', opacity: 0 },
  ], { duration: 1100, easing: 'cubic-bezier(.2,.8,.2,1)', fill: 'forwards' });
}
function ping(el) { el?.animate?.([{ transform: 'scale(1)' }, { transform: 'scale(1.22)' }, { transform: 'scale(.96)' }, { transform: 'scale(1)' }], { duration: 520, easing: 'cubic-bezier(.34,1.4,.64,1)' }); }
function flyTo(from, sel, ic) {
  if (!canFx() || !from || $('#detail')?.open) return;
  const target = visible(sel); if (!target) return;
  const t = rectOf(target);
  const x0 = from.left + from.width / 2, y0 = from.top + from.height / 2;
  const x1 = t.left + t.width / 2, y1 = t.top + t.height / 2;
  const el = document.createElement('span'); el.className = 'fx-fly'; el.innerHTML = icon(ic);
  el.style.left = x0 + 'px'; el.style.top = y0 + 'px';
  fxLayer().append(el);
  const midX = (x1 - x0) * 0.5, midY = Math.min(0, y1 - y0) - 80;
  el.animate([
    { transform: 'translate(-50%,-50%) scale(1)', opacity: 1 },
    { transform: `translate(calc(-50% + ${midX}px), calc(-50% + ${midY}px)) scale(1.15)`, opacity: 1, offset: 0.45 },
    { transform: `translate(calc(-50% + ${x1 - x0}px), calc(-50% + ${y1 - y0}px)) scale(.45)`, opacity: 0.2 },
  ], { duration: 780, easing: 'cubic-bezier(.5,0,.3,1)', fill: 'forwards' }).finished.then(() => ping(target)).catch(() => {});
}
// The SURVIVED stamp peels off and drops away before a movie stops showing as seen.
async function unstamp(id) {
  const els = [...document.querySelectorAll(`[data-id="${id}"] .stamp`)];
  if (!els.length || !canFx()) return;
  await Promise.all(els.map((el) => el.animate([
    { transform: 'translate(-50%, -50%) rotate(-14deg) scale(1)', opacity: 1, offset: 0 },
    { transform: 'translate(-50%, -62%) rotate(-4deg) scale(1.16)', opacity: 1, offset: 0.28 },
    { transform: 'translate(-30%, 140%) rotate(24deg) scale(.82)', opacity: 0, offset: 1 },
  ], { duration: 620, easing: 'cubic-bezier(.45, 0, .7, .4)', fill: 'forwards' }).finished.catch(() => {})));
}
function markJust(id) { S.just = String(id); setTimeout(() => { if (S.just === String(id)) S.just = null; }, 1200); }

// ---------- actions ----------
async function setStatus(id, data) {
  if (!needUser()) return;
  const m = S.byId.get(String(id));
  const prev = S.mine.get(String(id)) || {};
  const snap = m ? { title: m.t, y: m.y ?? null, sg: m.sg, rt: m.rt ?? null, tier: m.tier, date: m.date || null, poster: m.poster || null } : {};
  const next = { ...prev, ...snap, ...data };
  delete next.at;
  S.mine.set(String(id), { ...next, at: Date.now() });
  await store.setMovie(id, next);
}

async function patchConfig(fn) { fn(S.config); applyConfig(); await route(true); }

const actions = {
  open: (el) => { const b = $('#qs-list'); if (b) b.hidden = true; openDetail(el.dataset.id); },
  close: () => $('#detail').close(),
  scroll(el) {
    const t = document.getElementById(el.dataset.target); if (!t) return;
    const c = t.firstElementChild; const step = c ? c.getBoundingClientRect().width + parseFloat(getComputedStyle(t).columnGap || 0) : t.clientWidth;
    const n = Math.max(1, Math.floor((t.clientWidth + 4) / step));
    t.scrollBy({ left: Number(el.dataset.k) * n * step, behavior: reduceMotion() ? 'auto' : 'smooth' });
  },
  qaopen(el) {
    const c = el.closest('.card'); const open = !c.classList.contains('qa-on');
    document.querySelectorAll('.card.qa-on').forEach((x) => { x.classList.remove('qa-on', 'rating'); x.querySelector('.qa-plus')?.setAttribute('aria-expanded', 'false'); x.querySelector('.qa-rate').hidden = true; });
    if (open) { c.classList.add('qa-on'); el.setAttribute('aria-expanded', 'true'); }
  },
  qarate(el) {
    if (!needUser()) return;
    if (window.matchMedia('(hover: none)').matches) return openRateSheet(el.dataset.id);
    const c = el.closest('.card'); c.classList.add('rating', 'qa-on'); const r = c.querySelector('.qa-rate'); r.hidden = false;
    r.querySelector('button')?.focus();
  },
  rsclose() { closeRateSheet(); },
  qaclose(el) { const c = el.closest('.card'); c.classList.remove('rating', 'qa-on'); c.querySelector('.qa-rate').hidden = true; },
  async queue(el) {
    if (!needUser()) return;
    const st = status(el.dataset.id);
    const prev = st ? { ...st } : null;
    const r = rectOf(el);
    if (st?.status === 'queue') {
      if (st.wasSeen) await setStatus(el.dataset.id, { status: 'seen' }); else { S.mine.delete(String(el.dataset.id)); await store.removeMovie(el.dataset.id); }
      toast('Removed from your queue', 'x', undoTo(el.dataset.id, prev));
      await sendOff(el.dataset.id, 'remove');
    } else {
      if (st?.status === 'seen') await unstamp(el.dataset.id);
      markJust(el.dataset.id);
      await setStatus(el.dataset.id, st?.status === 'seen' ? { status: 'queue', wasSeen: true } : { status: 'queue' });
      const leaving = await willVanish(el.dataset.id);
      burst(null, 'pop', r); if (!leaving) flyTo(r, QUEUE_TARGETS, 'bookmark');
      toast(st?.status === 'seen' ? 'Queued for a rewatch' : 'Added to your queue', 'bookmark', undoTo(el.dataset.id, prev));
      if (leaving) await sendOff(el.dataset.id, 'queue');
    }
    await refreshAll();
    if (!st || st.status !== 'queue') ping($('#detail').open ? $('#detail [data-act="queue"]') : null);
  },
  async seen(el) {
    if (!needUser()) return;
    const st = status(el.dataset.id);
    const prev = st ? { ...st } : null;
    if (st?.status === 'seen') { // tap again to take it back off your Body Count
      await unstamp(el.dataset.id);
      S.mine.delete(String(el.dataset.id)); await store.removeMovie(el.dataset.id);
      toast('Removed from your Body Count', 'x', undoTo(el.dataset.id, prev));
      await sendOff(el.dataset.id, 'remove');
      await refreshAll();
      return;
    }
    const r = rectOf(el);
    markJust(el.dataset.id);
    await setStatus(el.dataset.id, { status: 'seen', rating: st?.rating || 0, seenOn: today() });
    const leaving = await willVanish(el.dataset.id);
    burst(null, 'blood', r); floatUp(r, `${icon('skull')}<b>+1</b>`); if (!leaving) flyTo(r, COUNT_TARGETS, 'skull');
    toast('Body Count +1. Rate it with the skulls', 'skull', undoTo(el.dataset.id, prev));
    if (leaving) await sendOff(el.dataset.id, 'seen');
    await refreshAll();
    const sk = $('#detail').open && $('#detail .skulls'); if (sk && canFx()) sk.animate([{ opacity: 0, transform: 'translateY(8px) scale(.9)' }, { opacity: 1, transform: 'none' }], { duration: 420, easing: 'cubic-bezier(.34,1.4,.64,1)' });
  },
  async rate(el) {
    let k = Number(el.dataset.k);
    const st = status(el.dataset.id);
    if ((st?.rating || 0) === k) k = 0; // tap your current rating again to clear it
    const already = st?.status === 'seen' || st?.wasSeen;
    // Rating a movie you haven't marked seen counts as seeing it: same stamp, splatter and +1 as the Seen button.
    const r = !already ? rectOf(el.closest('.card') || el.closest('.skulls') || el) : null;
    if (!already) markJust(el.dataset.id);
    await setStatus(el.dataset.id, already ? { rating: k } : { status: 'seen', rating: k, seenOn: today() });
    const leaving = !already && await willVanish(el.dataset.id);
    if (!already) { burst(null, 'blood', r); floatUp(r, `${icon('skull')}<b>+1</b>`); if (!leaving) flyTo(r, COUNT_TARGETS, 'skull'); }
    if (el.closest('.rate-sheet')) closeRateSheet();
    if (el.closest('.qa-rate, .rate-sheet') || !already) toast(k ? `Rated ${fmtRating(k)} of 5${already ? '' : '. Body Count +1'}` : 'Rating cleared', 'skull', undoTo(el.dataset.id, st ? { ...st } : null));
    if (leaving) await sendOff(el.dataset.id, 'seen');
    await refreshAll();
    if (canFx()) document.querySelectorAll('#detail .skulls .sk').forEach((b, i) => { if (i < Math.ceil(k)) b.animate([{ transform: 'scale(1)' }, { transform: 'scale(1.35) rotate(-8deg)' }, { transform: 'scale(1)' }], { duration: 380, delay: i * 55, easing: 'cubic-bezier(.34,1.4,.64,1)' }); });
  },
  sgbrowse(el) { S.f.sg = new Set([el.dataset.k]); S.fam.fsg = familyOf(el.dataset.k).key; S.f.hideSeen = false; location.hash = '#/browse'; },
  qsall() { const q = $('#qs')?.value.trim() || ''; Object.assign(S.f, { q, sg: new Set(), tier: new Set(), decade: '', provider: '', mine: false, limit: 60 }); location.hash = '#/browse'; },
  bctab(el) { S.bcTab = el.dataset.k; route(true, true); },
  ckmode(el) { S.ckAll = el.dataset.k === 'all'; route(true); },
  async ck(el) {
    if (!needUser()) return;
    const id = el.dataset.id;
    if (everSeen({ id })) { S.mine.delete(String(id)); await store.removeMovie(id); el.setAttribute('aria-pressed', 'false'); }
    else { await setStatus(id, { status: 'seen', rating: 0, seenOn: '' }); el.setAttribute('aria-pressed', 'true'); burst(el.querySelector('.box'), 'blood'); }
    const base = S.ckAll ? S.movies : essentialsList();
    const c = $('#ck-count'); if (c) c.textContent = `${base.filter(everSeen).length} of ${base.length} seen`;
  },
  async forget(el) { if (status(el.dataset.id)?.status === 'seen') await unstamp(el.dataset.id); S.mine.delete(String(el.dataset.id)); await store.removeMovie(el.dataset.id); refreshAll(); },
  more() { S.f.limit += 60; renderResults(); },
  fsg(el) { toggle(S.f.sg, el.dataset.k); redrawPicker('fsg', S.f.sg); S.f.limit = 60; renderResults(); },
  sgfam(el) { S.fam[el.dataset.picker] = el.dataset.k; redrawPicker(el.dataset.picker, el.dataset.picker === 'psg' ? S.p.sg : S.f.sg); document.querySelector(`.sgp[data-picker="${el.dataset.picker}"] [data-k="${el.dataset.k}"]`)?.focus(); },
  ftier(el) { toggle(S.f.tier, el.dataset.k); el.setAttribute('aria-pressed', S.f.tier.has(el.dataset.k)); renderResults(); },
  fmine(el) { S.f.mine = !S.f.mine; el.setAttribute('aria-pressed', S.f.mine); renderResults(); },
  fseen(el) { S.f.hideSeen = !S.f.hideSeen; el.setAttribute('aria-pressed', S.f.hideSeen); renderResults(); },
  fclear() { Object.assign(S.f, { q: '', sg: new Set(), tier: new Set(), mine: false, decade: '', provider: '', limit: 60 }); route(true); },
  pmix(el) { S.p.mix = el.dataset.k; document.querySelectorAll('[data-act="pmix"]').forEach((b) => b.setAttribute('aria-pressed', b.dataset.k === S.p.mix)); },
  psg(el) { toggle(S.p.sg, el.dataset.k); redrawPicker('psg', S.p.sg); },
  pmine(el) { S.p.mine = !S.p.mine; el.setAttribute('aria-pressed', S.p.mine); },
  pqueue(el) { S.p.queueOnly = !S.p.queueOnly; el.setAttribute('aria-pressed', S.p.queueOnly); },
  repick() {
    const m = pickOne();
    S.p.current = m ? m.id : false;
    if (m) S.p.recent = [m.id, ...S.p.recent].slice(0, 12);
    renderPick(true);
    if (window.innerWidth < 900) $('#pick-result')?.scrollIntoView({ behavior: reduceMotion() ? 'auto' : 'smooth', block: 'start' });
  },
  qtab(el) { S.qTab = el.dataset.k; route(true); },
  async join(el) { await store.joinNight(el.dataset.id); toast('You joined the movie night', 'users'); },
  async vote(el) {
    const n = S.lastNight; if (!n) return;
    const mine = new Set(n.votes?.[S.user.uid] || []);
    if (mine.has(el.dataset.id)) mine.delete(el.dataset.id);
    else if (mine.size < VOTES_PER_PERSON) mine.add(el.dataset.id);
    await store.vote(el.dataset.night, [...mine]);
  },
  async suggest(el) { await store.suggest(el.dataset.night, el.dataset.id); toast('Suggested', 'plus'); },
  async nsuggest(el) { await store.suggest($('#night').dataset.night, el.dataset.id); toast('Suggested', 'plus'); const s = $('#night-search'); if (s) s.value = ''; },
  async unsuggest(el) { await store.unsuggest(el.dataset.night, el.dataset.id); },
  async decide(el) { await store.decide(el.dataset.night, el.dataset.id || null); },
  async delnight(el) {
    if (el.dataset.confirm !== 'yes') { el.dataset.confirm = 'yes'; el.textContent = 'Press again to delete for everyone'; return; }
    await store.deleteNight(el.dataset.night); location.hash = '#/nights';
  },
  async copy(el) {
    const input = document.getElementById(el.dataset.target);
    try { await navigator.clipboard.writeText(input.value); toast('Link copied', 'link'); } catch { input.select(); toast('Press Ctrl+C to copy', 'link'); }
  },
  svcgroup(el) {
    const x = serviceGroups().find((g) => g.key === el.dataset.k); if (!x) return;
    const set = new Set(S.profile.services);
    const on = groupOn(x);
    x.ids.forEach((id) => (on ? set.delete(id) : set.add(id)));
    S.profile.services = [...set];
    el.setAttribute('aria-pressed', String(!on));
    if (!on) burst(el.querySelector('.box'), 'pop');
    const picked = serviceGroups().filter(groupOn);
    const c = $('#svc-count'); if (c) c.textContent = picked.length ? `${picked.length} selected: ${picked.map((g) => g.label).join(', ')}` : 'None selected yet';
    if (!S.p.mine && picked.length) S.p.mine = true;
    saveServicesSoon();
  },
  theme(el) { setTheme(el.dataset.k); document.querySelectorAll('[data-act="theme"]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.k === el.dataset.k))); },
  acct(el, e) { e.stopPropagation(); setMenu(!S.menuOpen); },
  async install() { setMenu(false); if (S.installEvt) { S.installEvt.prompt(); S.installEvt = null; renderChrome(); } },
  svc(el) { const id = Number(el.dataset.k); const s = new Set(S.profile.services); s.has(id) ? s.delete(id) : s.add(id); S.profile.services = [...s]; el.setAttribute('aria-pressed', s.has(id)); },
  async signout() { setMenu(false); await store.signOut(); location.hash = '#/'; },
  resetdemo() { store.resetDemo(); location.hash = '#/'; },
  gosignin() { S.afterSignIn = location.hash || '#/'; },
  authtab(el) { S.authTab = el.dataset.k; route(true); },
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
  fixpick(el) { S.adminFix = el.dataset.id; route(true); },
  fixsg(el) {
    const m = S.byId.get(String(S.adminFix));
    const set = new Set(m.sg); toggle(set, el.dataset.k);
    patchConfig((c) => { c.sgFix = { ...(c.sgFix || {}), [m.id]: [...set] }; });
  },
  fixclear(el) { patchConfig((c) => { const f = { ...(c.sgFix || {}) }; delete f[el.dataset.id]; c.sgFix = f; }); },
  async savecfg() {
    S.config.showPosters = $('#adm-posters').checked;
    S.config.announcement = $('#adm-announce').value.trim();
    await store.saveConfig({ ...S.config }); toast('Saved for everyone'); renderChrome(); route(true);
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

async function refreshAll() {
  refreshDetail();
  if (location.hash.startsWith('#/night/')) return;
  await flip(async () => {
    if (location.hash.startsWith('#/bodycount') && $('#bc-results')) { renderBodyList(); renderChrome(); return; }
    await route(true, true);
  });
}

// ---------- cards leaving a screen ----------
// Remember where every card sits, re-render, then slide the survivors from their old spots (FLIP),
// so a row closes up smoothly instead of jumping.
function cardKeys() {
  const out = new Map();
  document.querySelectorAll('#main .track, #main .grid, #main #bc-results').forEach((box, bi) => {
    box.querySelectorAll('.card[data-id]').forEach((c) => { const r = c.getBoundingClientRect(); if (r.bottom > -200 && r.top < innerHeight + 200) out.set(bi + ':' + c.dataset.id, { c, r }); });
  });
  return out;
}
async function flip(fn) {
  if (!canFx()) return fn();
  const before = cardKeys();
  await fn();
  const after = cardKeys();
  for (const [k, { c, r }] of after) {
    const b = before.get(k); if (!b) continue;
    const dx = b.r.left - r.left, dy = b.r.top - r.top;
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
    c.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], { duration: 420, easing: 'cubic-bezier(.2,.8,.2,1)' });
  }
}
// After a status change, will this movie's card drop off the current screen?
async function willVanish(id) {
  id = String(id);
  const [name, arg] = location.hash.replace(/^#\/?/, '').split('/');
  if (!document.querySelector(`#main .card[data-id="${id}"]`)) return false;
  if (name === 'browse') return !filtered().slice(0, S.f.limit).some((m) => String(m.id) === id);
  if (name === 'bodycount' || name === 'trophies') return !everSeen({ id });
  if (!name || name === 'tonight' || name === 'queue') {
    const keep = S.after; const n = shelfN;
    const html = await views[name || 'tonight'](arg);
    S.after = keep; shelfN = n;
    return !html.includes(`<div class="card" data-id="${id}">`);
  }
  return false;
}
// Send a card off screen: 'seen' stamps it and flies it to Body Count, 'queue' flies it to My queue,
// 'remove' just shrinks it away. Returns true if the card was animated out.
async function sendOff(id, kind) {
  if (!canFx() || $('#detail')?.open || !(await willVanish(id))) return false;
  const cards = [...document.querySelectorAll(`#main .card[data-id="${id}"]`)];
  const m = S.byId.get(String(id));
  cards.forEach((c) => { c.classList.remove('qa-on', 'rating'); c.querySelector('.qa-rate')?.setAttribute('hidden', ''); c.classList.add('leaving'); });
  if (kind === 'seen' && m) {
    for (const c of cards) { const p = c.querySelector('.poster'); if (p) p.outerHTML = poster(m); }
    await new Promise((r) => setTimeout(r, 850));
  }
  const target = kind === 'remove' ? null : visible(kind === 'seen' ? COUNT_TARGETS : QUEUE_TARGETS);
  const anims = [];
  for (const c of cards) {
    const p = c.querySelector('.poster'); if (!p) continue;
    const r = p.getBoundingClientRect();
    if (r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) { c.style.opacity = '0'; continue; }
    if (!target) { anims.push(c.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'scale(.8)' }], { duration: 320, easing: 'ease-in', fill: 'forwards' }).finished); continue; }
    const t = target.getBoundingClientRect();
    const ghost = p.cloneNode(true); ghost.classList.add('ghost-fly');
    Object.assign(ghost.style, { left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' });
    document.body.append(ghost); c.style.opacity = '0';
    const dx = t.left + t.width / 2 - (r.left + r.width / 2), dy = t.top + t.height / 2 - (r.top + r.height / 2);
    const a = ghost.animate([
      { transform: 'none', opacity: 1 },
      { transform: `translate(${dx * 0.35}px, ${dy * 0.35 - 60}px) scale(.62) rotate(-6deg)`, opacity: 1, offset: 0.45 },
      { transform: `translate(${dx}px, ${dy}px) scale(.08) rotate(8deg)`, opacity: 0.3 },
    ], { duration: 760, easing: 'cubic-bezier(.5,0,.25,1)', fill: 'forwards' });
    a.finished.then(() => { ghost.remove(); ping(target); }).catch(() => ghost.remove());
    anims.push(new Promise((res) => setTimeout(res, 380)));
  }
  await Promise.all(anims);
  return true;
}

document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-act]');
  if (!el || el.disabled) return;
  const fn = actions[el.dataset.act];
  if (!fn) return;
  if (el.tagName === 'A' && el.dataset.act !== 'gosignin') e.preventDefault();
  try { await fn(el, e); } catch (err) { console.error(err); toast(err?.message || 'That did not work. Try again.', 'x'); }
});
$('#detail')?.addEventListener('click', (e) => { if (e.target.id === 'detail') e.target.close(); });
document.addEventListener('click', (e) => { if (!e.target.closest('.card.qa-on')) document.querySelectorAll('.card.qa-on').forEach((x) => { x.classList.remove('qa-on', 'rating'); x.querySelector('.qa-rate').hidden = true; x.querySelector('.qa-plus')?.setAttribute('aria-expanded', 'false'); }); }, true);

document.addEventListener('input', (e) => {
  const el = e.target;
  if (el.id === 'qs') { renderQuick(); return; }
  if (el.id === 'bc-q') { S.bcq = el.value; if ((S.bcTab || 'watched') !== 'watched') { S.bcTab = 'watched'; const pos = el.selectionStart; route(true, true).then(() => { const i = $('#bc-q'); if (i) { i.focus(); i.setSelectionRange(pos, pos); } }); } else renderBodyList(); return; }
  if (el.id === 'bc-sort') { S.bcSort = el.value; renderBodyList(); return; }
  if (el.id === 'bc-sg') { S.bcSg = el.value; renderBodyList(); return; }
  if (el.id === 'svc-q') { S.svcq = el.value; renderServices(); return; }
  if (el.id === 'ck-q') { S.ckq = el.value; const pos = el.selectionStart; route(true, true).then(() => { const i = $('#ck-q'); if (i) { i.focus(); i.setSelectionRange(pos, pos); } }); return; }
  if (el.dataset.bind && location.hash.startsWith('#/browse')) { S.f[el.dataset.bind] = el.value; S.f.limit = 60; renderResults(); }
  if (el.dataset.bind === 'maxRt') S.p.maxRt = el.value;
  if (el.id === 'night-search') $('#night-search-results').innerHTML = searchList(el.value, 'nsuggest');
  if (el.id === 'adm-feat-search') $('#adm-feat-results').innerHTML = searchList(el.value, 'feature');
  if (el.id === 'adm-hide-search') $('#adm-hide-results').innerHTML = searchList(el.value, 'hide');
  if (el.id === 'adm-fix-search') $('#adm-fix-results').innerHTML = searchList(el.value, 'fixpick');
  if (el.hasAttribute('data-bind-theme')) setTheme(el.value);
});

// Rating preview: glow the skulls up to the half you're pointing at.
// Phones: rating opens a sheet with big skulls you can tap or slide across.
function openRateSheet(id) {
  closeRateSheet();
  const m = S.byId.get(String(id)) || { id, t: status(id)?.title || 'This movie', y: status(id)?.y };
  const r = status(id)?.rating || 0;
  const el = document.createElement('div');
  el.className = 'rate-sheet';
  el.innerHTML = `<div class="rs-back" data-act="rsclose"></div>
    <div class="rs-panel" role="dialog" aria-modal="true" aria-label="Rate ${esc(m.t)}">
      <div class="rs-grab"></div>
      <h3>${esc(m.t)}${m.y ? ` <span class="faint">(${m.y})</span>` : ''}</h3>
      <p class="muted">Tap a skull, or slide your finger across. Left half of a skull is a half.</p>
      ${skullPicker(m, r).replace('class="skulls"', 'class="skulls big"')}
      <button class="btn ghost" data-act="rsclose">Cancel</button>
    </div>`;
  document.body.append(el);
  requestAnimationFrame(() => el.classList.add('on'));
}
function closeRateSheet() { document.querySelectorAll('.rate-sheet').forEach((x) => x.remove()); }
// Work out a half-step rating from a finger position across a row of skulls.
function ratingAt(group, x) {
  const sks = [...group.querySelectorAll('.sk')];
  for (let i = 0; i < sks.length; i++) { const b = sks[i].getBoundingClientRect(); if (x < b.right) return x < b.left + b.width / 2 ? Math.max(0.5, i + 0.5) : i + 1; }
  return sks.length;
}
const drag = { g: null, k: null, moved: false, x0: 0 };
document.addEventListener('pointerdown', (e) => {
  const g = e.target.closest?.('.skulls'); if (!g || e.pointerType === 'mouse') return;
  Object.assign(drag, { g, k: ratingAt(g, e.clientX), moved: false, x0: e.clientX });
});
document.addEventListener('pointermove', (e) => {
  if (!drag.g) return;
  if (Math.abs(e.clientX - drag.x0) > 6) drag.moved = true;
  if (!drag.moved) return;
  drag.k = ratingAt(drag.g, e.clientX); previewRating(drag.g, drag.k);
});
document.addEventListener('pointerup', (e) => {
  const { g, k, moved } = drag; drag.g = null;
  if (!g || !moved) return; // a plain tap goes through the normal button click
  drag.skipClick = Date.now();
  previewRating(g, null);
  g.querySelector(`button[data-act="rate"][data-k="${k}"]`)?.click();
});
document.addEventListener('pointercancel', () => { if (drag.g) previewRating(drag.g, null); drag.g = null; });
document.addEventListener('click', (e) => {
  if (drag.skipClick && Date.now() - drag.skipClick < 400 && e.isTrusted && e.target.closest?.('.skulls')) { e.stopPropagation(); e.preventDefault(); drag.skipClick = 0; }
}, true);

function previewRating(group, k) {
  group.classList.toggle('pv', k != null);
  group.querySelectorAll('.sk').forEach((sk, i) => {
    const n = i + 1;
    sk.classList.toggle('pv-on', k != null && k >= n);
    sk.classList.toggle('pv-half', k != null && k === n - 0.5);
  });
  const v = group.querySelector('.sk-val');
  if (v) { if (k != null) { v.dataset.cur ??= v.textContent; v.textContent = fmtRating(k); v.classList.add('pv'); } else { v.textContent = v.dataset.cur ?? v.textContent; delete v.dataset.cur; v.classList.remove('pv'); } }
}
document.addEventListener('pointerover', (e) => { const b = e.target.closest?.('.skulls button[data-act="rate"]'); if (b) previewRating(b.closest('.skulls'), Number(b.dataset.k)); });
document.addEventListener('pointerout', (e) => { const g = e.target.closest?.('.skulls'); if (g && !g.contains(e.relatedTarget)) previewRating(g, null); });
document.addEventListener('focusin', (e) => { const b = e.target.closest?.('.skulls button[data-act="rate"]'); if (b) previewRating(b.closest('.skulls'), Number(b.dataset.k)); });
document.addEventListener('focusout', (e) => { const g = e.target.closest?.('.skulls'); if (g && !g.contains(e.relatedTarget)) previewRating(g, null); });

document.addEventListener('toggle', (e) => { if (e.target.matches?.('details.more')) S.svcMore = e.target.open; }, true);
document.addEventListener('change', async (e) => {
  if (e.target.id === 'seen-date') { await setStatus(e.target.dataset.id, { seenOn: e.target.value }); toast('Watch date saved', 'clock'); }
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
  } catch (err) { authError(err); if (form.dataset.form !== 'auth') toast(err?.message || 'That did not save.', 'x'); }
});

function setTheme(t) {
  try { localStorage.setItem('sq-theme', t); } catch { /* ignore */ }
  if (t === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', t);
}

// ---------- chrome + router ----------
const NAV = [['#/', 'Tonight', 'home'], ['#/browse', 'Browse', 'grid'], ['#/pick', 'Pick for me', 'dice'], ['#/queue', 'My queue', 'bookmark'], ['#/bodycount', 'Body Count', 'trophy'], ['#/nights', 'Movie nights', 'users']];
const TABS = ['#/', '#/browse', '#/pick', '#/queue', '#/nights'];
function renderChrome() {
  const here = '#/' + (location.hash.replace(/^#\/?/, '').split('/')[0] || '');
  const cur = (h) => (h === here || (h === '#/nights' && here === '#/night') || (h === '#/bodycount' && (here === '#/checklist' || here === '#/trophies')) ? 'aria-current="page"' : '');
  $('#nav').innerHTML = NAV.map(([h, l]) => `<a href="${h}" ${cur(h)}>${l}</a>`).join('');
  $('#tabbar').innerHTML = NAV.filter(([h]) => TABS.includes(h)).map(([h, l, ic]) => `<a href="${h}" ${cur(h)}>${icon(ic)}<span>${l.replace('Movie nights', 'Nights').replace('My queue', 'Queue').replace('Pick for me', 'Pick')}</span></a>`).join('');
  const name = S.profile.name || S.user?.name || '';
  const av = (cls = '') => `<span class="avatar ${cls}" style="--ah:${avatarHue(name)}">${esc((name[0] || '?').toUpperCase())}</span>`;
  $('#who').innerHTML = S.user
    ? `<div class="acct"><button class="acct-btn" data-act="acct" aria-haspopup="menu" aria-expanded="${!!S.menuOpen}" aria-label="Your account">${av()}<span class="acct-name">${esc(name)}</span>${icon('down', 'caret')}</button>
      <div class="acct-menu" role="menu" ${S.menuOpen ? '' : 'hidden'}>
        <div class="acct-head">${av('lg')}<span><b>${esc(name)}</b><small>${esc(S.user.email || '')}</small></span></div>
        <a role="menuitem" href="#/profile">${icon('gear')}Profile</a>
        <a role="menuitem" href="#/profile/services">${icon('tv')}Streaming services<small>${serviceGroups().filter(groupOn).length || 'None yet'}</small></a>
        <a role="menuitem" href="#/bodycount">${icon('skull')}Body Count<small>${seenList().length}</small></a>
        ${S.user.isAdmin ? `<a role="menuitem" href="#/admin">${icon('shield')}Admin</a>` : ''}
        ${S.installEvt ? `<button role="menuitem" data-act="install">${icon('plus')}Install app</button>` : ''}
        <button role="menuitem" data-act="signout">${icon('x')}Sign out</button>
        <span class="acct-ver">${esc(SITE_NAME)} v${VERSION}</span>
      </div></div>`
    : '<a class="btn small primary" href="#/signin" data-act="gosignin">Sign in</a>';
  const notes = [];
  if (store.demo) notes.push('<span class="note"><span class="dot"></span><b>Demo mode.</b> Accounts are simulated and saved in this browser only.</span>');
  if (SAMPLE()) notes.push('<span class="note"><span class="dot"></span><b>Sample shelf.</b> Streaming info is made up until the first nightly refresh.</span>');
  if (S.config.announcement) notes.push(`<span class="note"><span class="dot"></span>${esc(S.config.announcement)}</span>`);
  $('#banner').hidden = !notes.length;
  $('#banner').innerHTML = `<div class="wrap">${notes.join('')}</div>`;
}

function setMenu(v) {
  S.menuOpen = v;
  const m = $('.acct-menu'), b = $('.acct-btn');
  if (m) m.hidden = !v; if (b) b.setAttribute('aria-expanded', String(v));
  if (v) { $('.acct-menu')?.querySelector('a,button')?.focus({ preventScroll: true }); m?.classList.remove('in'); void m?.offsetWidth; m?.classList.add('in'); }
}
document.addEventListener('click', (e) => { if (S.menuOpen && !e.target.closest('.acct-menu, .acct-btn')) setMenu(false); else if (S.menuOpen && e.target.closest('.acct-menu a')) setMenu(false); }, true);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && S.menuOpen) { setMenu(false); $('.acct-btn')?.focus(); } });
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); S.installEvt = e; if (S.user) renderChrome(); });

async function route(keepScroll, quiet) {
  if (S.stopNight) { S.stopNight(); S.stopNight = null; }
  const [name, arg] = location.hash.replace(/^#\/?/, '').split('/');
  S.menuOpen = false;
  const view = views[{ trophies: 'bodycount' }[name] || name || 'tonight'] || views.tonight;
  renderChrome();
  const y = window.scrollY;
  const html = await view(arg);
  const after = S.after; S.after = null;
  const rails = keepScroll ? [...document.querySelectorAll('#main .track')].map((t) => t.scrollLeft) : [];
  const swap = () => {
    $('#main').classList.toggle('quiet', !!quiet); $('#main').innerHTML = html; after?.();
    if (rails.length) document.querySelectorAll('#main .track').forEach((t, i) => { if (rails[i]) t.scrollLeft = rails[i]; });
    window.scrollTo(0, keepScroll ? y : 0); updateRails();
  };
  if (!quiet && document.startViewTransition && !reduceMotion() && !window.matchMedia('(hover: none)').matches) { const vt = document.startViewTransition(swap); vt.ready.catch(() => {}); vt.finished.catch(() => {}); await vt.updateCallbackDone.catch(() => {}); }
  else swap();
  document.title = `${SITE_NAME}${name ? ' · ' + ({ browse: 'Browse', pick: 'Pick for me', queue: 'My queue', nights: 'Movie nights', night: 'Movie night', settings: 'Settings', admin: 'Admin', signin: 'Sign in', about: 'How it works', trophies: 'Body Count', bodycount: 'Body Count', profile: 'Profile', checklist: 'Checklist' }[name] || '') : ''}`;
}

async function boot() {
  try { const t = localStorage.getItem('sq-theme'); if (t && t !== 'system') document.documentElement.setAttribute('data-theme', t); } catch { /* ignore */ }
  $('#version').textContent = 'v' + VERSION;
  if (/^#\/settings/.test(location.hash)) history.replaceState(null, '', '#/profile');
  $('#brand').textContent = SITE_NAME;
  $('#mark').innerHTML = icon('skull');
  [S.config] = await Promise.all([store.getConfig(), loadData()]);
  applyConfig();
  let first = true;
  store.init(async (u) => {
    S.user = u;
    await loadMine();
    if (u && location.hash === '#/signin') { location.hash = S.afterSignIn || '#/'; }
    else await route(!first, !first);
    first = false;
  });
  window.addEventListener('hashchange', () => route());
  window.addEventListener('keydown', (e) => { if (e.key === '/' && !/input|textarea|select/i.test(document.activeElement?.tagName || '')) { const q = $('#f-q'); if (q) { e.preventDefault(); q.focus(); } } });
  if ('serviceWorker' in navigator && location.protocol === 'https:' && !globalThis.SQ_STORE) {
    navigator.serviceWorker.register('sw.js?v=' + VERSION).then((r) => r.update()).catch(() => {});
    let reloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => { if (!reloaded && navigator.serviceWorker.controller) { reloaded = true; } });
  }
}
boot().catch((e) => { console.error(e); $('#main').innerHTML = `<div class="empty">The movie shelf could not load (${esc(e.message)}). Refresh to try again.</div>`; });
