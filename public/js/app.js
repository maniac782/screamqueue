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
  f: { q: '', sg: new Set(), tier: new Set(), mine: false, hideSeen: false, decade: '', sort: 'buzz', provider: '', tom: '', limit: 60 },
  p: { sg: new Set(), mix: 'crowd', mine: true, queueOnly: false, recent: [], current: null },
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
// Release status from US dates (th = theatrical, dig = digital). 'soon' = coming to theaters,
// 'in' = opened in theaters in the last 60 days and not streaming or on digital yet.
const longDate = (d) => new Date(d + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
function theaterStatus(m) {
  const t = today();
  if (m.th && m.th > t) return 'soon';
  if (m.th && (Date.parse(t) - Date.parse(m.th)) / 86400000 <= 60 && !(m.dig && m.dig <= t) && !m.pv?.length && !m.fr?.length) return 'in';
  return null;
}
function releaseLine(m) {
  const t = today(); const th = theaterStatus(m);
  const dig = m.dig ? (m.dig > t ? `Coming to digital ${longDate(m.dig)}` : `On digital since ${longDate(m.dig)}`) : '';
  if (th === 'soon') return { pill: 'Coming to theaters', cls: 'soon', text: `Opens in US theaters ${longDate(m.th)}`, sub: m.dig && m.dig > t ? dig : '' };
  if (th === 'in') return { pill: 'In theaters', cls: 'in', text: `Opened in US theaters ${longDate(m.th)}`, sub: dig };
  const d = m.th || m.date;
  if (!d) return null;
  if (d > t) return { pill: 'Coming soon', cls: 'soon', text: `Releases ${longDate(d)}`, sub: '' };
  return { pill: '', cls: '', text: `${m.th ? 'Released in US theaters' : 'Released'} ${longDate(d)}`, sub: m.dig && m.dig > m.th ? dig : '' };
}
function releaseHTML(m) {
  const r = releaseLine(m); if (!r) return '';
  return `<div class="release">${r.pill ? `<span class="rel-pill ${r.cls}">${icon(r.cls === 'in' ? 'play' : 'clock')}${r.pill}</span>` : icon('clock')}<span>${esc(r.text)}${r.sub ? `<small>${esc(r.sub)}</small>` : ''}</span></div>`;
}
function rating(m) { const r = m.imdb?.r ?? (m.va ? Number(m.va.toFixed(1)) : null); return r ? `${icon('star')}${r}` : ''; }
// Critics score from Rotten Tomatoes (via OMDb). Fresh is 60% and up. Icons are drawn for this site, not RT's logos.
const tom = (m) => m.imdb?.tom ?? null;
const TOMATO = '<svg class="ic tom" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 6.4c4.9 0 8.6 3 8.6 7.1S16.9 20.8 12 20.8 3.4 17.6 3.4 13.5 7.1 6.4 12 6.4z" fill="#f2332a"/><path d="M12 6.8 9.4 4.2l2.6 1.1 1.2-2.1.6 2.4 2.6-.4-2 2.1" fill="#3aa64c"/><ellipse cx="8.6" cy="11.4" rx="1.8" ry="1.1" fill="#fff" opacity=".45"/></svg>';
const SPLAT = '<svg class="ic tom" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4.2l1.6 3.4 3.4-2-.6 3.8 3.9.4-2.9 2.6 3 2.4-3.9.6.8 3.8-3.5-1.8-1.8 3.4-1.6-3.5-3.5 1.7.9-3.8-3.9-.7 3.1-2.3-2.8-2.7 3.9-.3-.5-3.8 3.3 2.1z" fill="#2f9e52"/></svg>';
// Trailer on YouTube (opens the YouTube app on phones). Falls back to a YouTube search when TMDB has none.
function trailerUrl(m) { return m.yt ? `https://www.youtube.com/watch?v=${encodeURIComponent(m.yt)}` : `https://www.youtube.com/results?search_query=${encodeURIComponent(`${m.t} ${m.y || ''} trailer`)}`; }
function trailerBtn(m, cls = '') {
  return m.yt ? `<button class="btn trailer ${cls}" data-act="trailer" data-id="${m.id}">${icon('play')}Watch trailer</button>`
    : `<a class="btn trailer ${cls}" href="${esc(trailerUrl(m))}" target="_blank" rel="noopener">${icon('play')}Find the trailer</a>`;
}
// Trailer plays in a pop-up over the page (YouTube's privacy-enhanced player). Closing it removes the player so the sound stops.
function openTrailer(id, which = 'yt') {
  const m = S.byId.get(String(id)); const vid = m?.[which]; if (!vid) return;
  const label = which === 'kc' ? 'Kill Count' : 'trailer';
  const dlg = $('#player');
  dlg.innerHTML = `<div class="player-box">
    <div class="player-head"><b>${esc(m.t)}${m.y ? ` <span class="faint">(${m.y})</span>` : ''}${which === 'kc' ? ' <span class="faint">· Kill Count by Dead Meat</span>' : ''}</b><button class="icon-btn" data-act="closeplayer" aria-label="Close ${label}">${icon('x')}</button></div>
    <div class="frame"><iframe src="https://www.youtube-nocookie.com/embed/${encodeURIComponent(vid)}?autoplay=1&playsinline=1&rel=0&modestbranding=1" title="${esc(m.t)} ${label}" allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowfullscreen></iframe></div>
    <a class="player-yt" href="https://www.youtube.com/watch?v=${encodeURIComponent(vid)}" target="_blank" rel="noopener">${icon('link')}Open on YouTube</a>
  </div>`;
  try { dlg.showModal(); } catch { dlg.setAttribute('open', ''); }
}
// Cast photos and characters live in small shard files (data/cast/N.json), fetched when a movie is opened.
const castCache = new Map(); const castShards = new Map();
function loadCast(id) {
  const k = Number(id) % 100;
  if (!castShards.has(k)) castShards.set(k, fetch(`data/cast/${k}.json`).then((r) => (r.ok ? r.json() : {})).catch(() => ({})));
  return castShards.get(k).then((sh) => {
    const e = sh[id];
    castCache.set(String(id), Array.isArray(e) ? { c: e, d: [] } : e || { c: [], d: [] });
    return castCache.get(String(id));
  });
}
const initials = (n) => n.split(/\s+/).map((w) => w[0]).slice(0, 2).join('');
function face(p, n, size = 'w185') { return p && S.config.showPosters ? `<img src="https://image.tmdb.org/t/p/${size}${p}" alt="" loading="lazy">` : `<span class="ini" style="--ah:${avatarHue(n)}">${esc(initials(n))}</span>`; }
function castHTML(m, cr) {
  const list = [...(cr.d || []).map((d) => ({ ...d, c: 'Director' })), ...(cr.c || [])];
  if (!list.length) return m.cast.length ? `<p class="muted">With ${esc(m.cast.join(', '))}</p>` : '';
  return `<div class="stack" style="gap:10px"><h3>Cast &amp; director</h3><div class="cast-row">${list.map((c) => {
    const inner = `${face(c.p, c.n)}<b>${esc(c.n)}</b>${c.c ? `<small>${esc(c.c)}</small>` : ''}`;
    return c.i ? `<button class="person" data-act="person" data-k="${c.i}" aria-label="${esc(c.n)}: more horror movies">${inner}</button>` : `<div class="person">${inner}</div>`;
  }).join('')}</div></div>`;
}
// ---------- kill counts: fan-reported numbers + Dead Meat's "Kill Count" videos ----------
const killCache = new Map();
const median = (a) => { const s = [...a].sort((x, y) => x - y); const n = s.length; return n ? (n % 2 ? s[(n - 1) / 2] : Math.round((s[n / 2 - 1] + s[n / 2]) / 2)) : null; };
function killCountUrl(m) { return `https://www.youtube.com/results?search_query=${encodeURIComponent(`Dead Meat Kill Count ${m.t} ${m.y || ''}`)}`; }
function killHTML(m, k) {
  const n = k ? (k.verified ?? median(k.votes)) : null;
  const fans = k?.votes.length || 0;
  const lo = fans ? Math.min(...k.votes) : 0, hi = fans ? Math.max(...k.votes) : 0;
  const editing = S.killEdit === String(m.id);
  const mine = k?.mine;
  let you = '';
  if (!S.user) you = `<a href="#/signin" data-act="gosignin" class="linkish">Sign in to add your count</a>`;
  else if (editing || mine == null) you = `<form class="kill-form" data-id="${m.id}" novalidate><label>${mine == null ? 'Know the count?' : 'Your count'} <input type="number" name="n" min="0" max="1000" step="1" inputmode="numeric" value="${mine ?? ''}" placeholder="0" required></label><button class="btn small primary" type="submit">${mine == null ? 'Add it' : 'Save'}</button>${mine != null ? `<button class="btn small ghost" type="button" data-act="killclear" data-id="${m.id}">Remove mine</button>` : ''}</form>`;
  else you = `<span class="muted">You said ${mine}.</span> <button class="linkish" data-act="killedit" data-id="${m.id}">Change</button>`;
  const admin = S.user?.isAdmin && n != null ? `<button class="btn small ghost" data-act="killverify" data-id="${m.id}" data-k="${k.verified != null ? '' : n}">${k.verified != null ? 'Unverify' : `Verify as ${n}`}</button>` : '';
  return `<div class="killbox">
    <div class="kill-num ${n == null ? 'none' : ''}">${icon('skull')}<b>${n ?? '?'}</b></div>
    <div class="kill-body">
      <h3>Kill count</h3>
      <p class="muted">${k == null ? 'Loading…' : n == null ? 'No one has added a count yet.' : k.verified != null ? `Verified${fans ? `. ${fans} fan${fans === 1 ? '' : 's'} reported` : ''}` : `Reported by ${fans} fan${fans === 1 ? '' : 's'}${hi > lo ? ` (answers range ${lo} to ${hi})` : ''}`}</p>
      <div class="kill-you">${you}</div>
      <div class="row" style="gap:8px">${m.kc ? `<button class="btn small" data-act="killvid" data-id="${m.id}">${icon('play')}Watch the Kill Count</button>` : `<a class="btn small" href="${esc(killCountUrl(m))}" target="_blank" rel="noopener">${icon('search')}Find a Kill Count video</a>`}${admin}</div>
    </div></div>`;
}
function killBlock(m) {
  const k = killCache.get(String(m.id));
  if (!k && store.getKills) store.getKills(m.id).then((x) => { killCache.set(String(m.id), x); const el = document.querySelector(`#detail[data-id="${m.id}"] .kill-wrap`); if (el) el.innerHTML = killHTML(m, x); }).catch(() => {});
  return `<div class="kill-wrap">${killHTML(m, k || null)}</div>`;
}
async function reloadKills(id) { killCache.delete(String(id)); S.killEdit = null; refreshDetail(); }

function castBlock(m) {
  const have = castCache.get(String(m.id));
  if (have) return `<div class="cast-wrap">${castHTML(m, have)}</div>`;
  loadCast(m.id).then((list) => { const el = document.querySelector(`#detail[data-id="${m.id}"] .cast-wrap`); if (el) el.innerHTML = castHTML(m, list); });
  return `<div class="cast-wrap">${m.cast.length ? `<p class="muted">With ${esc(m.cast.join(', '))}</p>` : ''}</div>`;
}
function tomBadge(m) { const t = tom(m); return t == null ? '' : `<span class="tomato" title="Rotten Tomatoes critics score">${t >= 60 ? TOMATO : SPLAT}${t}%</span>`; }
function scoreRow(m) {
  const parts = [];
  const t = tom(m);
  if (t != null) parts.push(`<div class="score"><span class="ico">${t >= 60 ? TOMATO : SPLAT}</span><span><b>${t}%</b><small>Critics on Rotten Tomatoes</small></span></div>`);
  if (m.imdb?.r) parts.push(`<div class="score"><span class="ico imdb">${icon('star')}</span><span><b>${m.imdb.r}<i>/10</i></b><small>IMDb${m.imdb.v ? `, ${fmt(m.imdb.v)} ratings` : ''}</small></span></div>`);
  if (m.imdb?.mc != null) parts.push(`<div class="score"><span class="ico mc ${m.imdb.mc >= 61 ? 'hi' : m.imdb.mc >= 40 ? 'mid' : 'lo'}">${m.imdb.mc}</span><span><b>${m.imdb.mc}<i>/100</i></b><small>Metacritic</small></span></div>`);
  if (!parts.length && m.va) parts.push(`<div class="score"><span class="ico imdb">${icon('star')}</span><span><b>${m.va.toFixed(1)}<i>/10</i></b><small>TMDB users</small></span></div>`);
  return parts.length ? `<div class="scores">${parts.join('')}</div>` : '';
}

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
    ${opts.noBadges ? '' : (() => { const th = theaterStatus(m); const label = th === 'in' ? 'In Theaters' : th === 'soon' ? 'Coming Soon' : S.tierLabel.get(m.tier); return `<span class="badge-tier t-${th ? 'th-' + th : m.tier}">${m.flags.includes('hot') ? `<span class="flame" title="Trending this week">${icon('flame')}</span>` : '<i></i>'}${esc(label)}</span>`; })()}
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
// Poster size for grids on bigger screens (Browse, My Queue, Body Count, cast pages). Saved per browser.
const SIZES = [['s', 'Small'], ['m', 'Medium'], ['l', 'Large']];
function posterSize() { try { return localStorage.getItem('sq-psize') || 'm'; } catch { return 'm'; } }
function applyPosterSize() { document.documentElement.dataset.psize = posterSize(); }
function sizePicker() {
  const cur = posterSize();
  return `<div class="size-pick" role="group" aria-label="Poster size">${SIZES.map(([k, l]) => `<button data-act="psize" data-k="${k}" aria-pressed="${cur === k}" title="${l} posters" aria-label="${l} posters"><span class="sz sz-${k}"></span></button>`).join('')}</div>`;
}
function card(m, opts) {
  const sub = typeof opts === 'object' && opts?.sub;
  const plain = typeof opts === 'object' && opts?.plain;
  const sg = sub || m.sg.slice(0, 2).map((k) => S.sgLabel.get(k)).join(', ');
  const name = `${m.t}${m.y ? ` (${m.y})` : ''}`;
  return `<div class="card" data-id="${m.id}">
    <button class="card-open" data-act="open" data-id="${m.id}" aria-label="${esc(name)}">
      ${poster(m, plain ? { noBadges: true } : {})}
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
  return `<section class="shelf" data-key="${esc(plain.split(':')[0].trim().toLowerCase())}">
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
  S.hasTom = S.data.movies.some((m) => m.imdb?.tom != null);
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
  const inTheaters = pool.filter((m) => theaterStatus(m) === 'in').sort((a, b) => b.buzz - a.buzz).slice(0, 18);
  // the 18 most talked-about upcoming releases, then shown soonest first
  const comingSoon = S.movies.filter((m) => theaterStatus(m) === 'soon').sort((a, b) => b.buzz - a.buzz).slice(0, 18).sort((a, b) => a.th.localeCompare(b.th));
  const critics = pool.filter((m) => (tom(m) ?? 0) >= 90 && m.reach >= 35).sort((a, b) => tom(b) - tom(a) || b.reach - a.reach).slice(0, 18);
  const divisive = pool.filter((m) => tom(m) != null && tom(m) <= 40 && (m.imdb?.r ?? 0) >= 6.3 && (m.imdb?.v ?? 0) >= 20000).sort((a, b) => (b.imdb.r * 10 - tom(b)) - (a.imdb.r * 10 - tom(a))).slice(0, 18);
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
      <div class="facts">${[top.y, top.rt && `${top.rt} min`, top.cert].filter(Boolean).map((x) => `<span>${esc(x)}</span>`).join('')}${rating(top) ? `<span class="star">${rating(top)}</span>` : ''}${tomBadge(top)}<span>${esc(servicesText(top))}</span></div>
      ${top.ov ? `<p class="ov">${esc(top.ov)}</p>` : ''}
      <div class="row"><button class="btn primary" data-act="open" data-id="${top.id}">${icon('play')}See details</button>${queueBtn(top, 'glass')}${top.yt ? trailerBtn(top, 'glass') : ''}<a class="btn glass m-hide" href="#/pick">${icon('dice')}Pick for Me</a></div>
    </div>
  </section>` : ''}
  ${S.profile.services.length ? '' : `<div class="intro"><p class="muted">Tell us which streaming services you have and the shelves will show what you can watch tonight.</p><a class="btn small" href="${S.user ? '#/settings' : '#/signin'}">${icon('gear')}Add your services</a></div>`}
  ${featured.length > 1 ? shelf('Featured', 'Hand-picked for the site.', featured.slice(1), '') : ''}
  ${shelf('Trending this week', 'The horror movies people are watching and talking about right now.', hot, firstRun, '<a class="btn small ghost" href="#/browse">See all</a>')}
  ${shelf(S.profile.services.length ? 'Crowd favorites on your services' : 'Crowd favorites', 'Widely seen and well liked. Easy to get a group on board.', crowd, S.profile.services.length ? 'Nothing from this shelf is on your services right now.' : firstRun)}
  ${inTheaters.length ? shelf('In theaters now', 'Playing in US theaters and not streaming yet.', inTheaters, '') : ''}
  ${comingSoon.length ? shelf('Coming to theaters', 'Horror opening in US theaters soon, earliest first.', comingSoon, '') : ''}
  ${shelf('New and catching on', 'Out in the last four months and already getting attention.', newBuzz, firstRun)}
  ${shelf('New and under the radar', 'Recently released, but few people have found them yet.', quiet, firstRun)}
  ${shelf('Cult picks', 'Smaller audiences with loyal fans.', cult, firstRun)}
  ${shelf('On Shudder now', 'The busiest titles on Shudder this week.', shudder, firstRun)}
  ${critics.length >= 6 ? shelf('Critics loved these', '90% or better with critics on Rotten Tomatoes.', critics, '') : ''}
  ${divisive.length >= 6 ? shelf('Critics hated it, fans didn\'t', 'Rotten with critics, but well rated by viewers on IMDb.', divisive, '') : ''}`;
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
    (!f.decade || (m.y && Math.floor(m.y / 10) * 10 === Number(f.decade))) &&
    (!f.tom || (tom(m) ?? -1) >= Number(f.tom)));
  const by = {
    buzz: (a, b) => b.buzz - a.buzz,
    reach: (a, b) => b.reach - a.reach,
    rating: (a, b) => (b.imdb?.r ?? b.va ?? 0) - (a.imdb?.r ?? a.va ?? 0),
    critics: (a, b) => (tom(b) ?? -1) - (tom(a) ?? -1) || b.reach - a.reach,
    newest: (a, b) => (b.date || '').localeCompare(a.date || ''),
    title: (a, b) => a.t.localeCompare(b.t),
  }[f.sort];
  return list.sort(by);
}
function renderResults() {
  const list = filtered();
  const el = $('#results'); if (!el) return;
  setHTML(el, `<div class="results-head"><p class="count">${list.length} movie${list.length === 1 ? '' : 's'}</p>${sizePicker()}</div>
    ${list.length ? `<div class="grid">${list.slice(0, S.f.limit).map(card).join('')}</div>` : `<div class="empty">${icon('search')}<span>Nothing matches all of those filters. Try removing a subgenre.</span></div>`}
    ${list.length > S.f.limit ? '<div class="row" style="justify-content:center"><button class="btn" data-act="more">Show more</button></div>' : ''}`);
}
views.browse = () => {
  const f = S.f;
  const decades = [...new Set(S.movies.map((m) => m.y && Math.floor(m.y / 10) * 10).filter(Boolean))].sort((a, b) => b - a);
  const provs = S.data.providers.filter((p) => S.movies.some((m) => m.pv.includes(p.id) || m.fr.includes(p.id)));
  S.after = renderResults;
  const any = f.sg.size || f.tier.size || f.q || f.decade || f.provider || f.mine || f.tom;
  return `<div class="page-head"><h1>Browse</h1><p class="muted">Pick a few subgenres to narrow it down. Every filter you add has to match.</p></div>
  <div class="filters">
    <div class="toolbar">
      <label class="search"><span class="sr">Search</span>${icon('search')}<input type="search" id="f-q" data-bind="q" placeholder="Search titles or directors" value="${esc(f.q)}"></label>
      <select id="f-sort" data-bind="sort" aria-label="Sort">${[['buzz', 'Trending now'], ['reach', 'Most watched'], ['rating', 'Highest rated'], ...(S.hasTom ? [['critics', 'Best reviewed by critics']] : []), ['newest', 'Newest'], ['title', 'Title A to Z']].map(([v, l]) => `<option value="${v}" ${f.sort === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
      <select id="f-decade" data-bind="decade" aria-label="Decade"><option value="">Any decade</option>${decades.map((d) => `<option value="${d}" ${String(f.decade) === String(d) ? 'selected' : ''}>${d}s</option>`).join('')}</select>
      ${S.hasTom ? `<select id="f-tom" data-bind="tom" aria-label="Critics score"><option value="">Any critics score</option>${[[60, 'Fresh (60%+)'], [75, '75% and up'], [90, '90% and up']].map(([v, l]) => `<option value="${v}" ${String(f.tom) === String(v) ? 'selected' : ''}>${l}</option>`).join('')}</select>` : ''}
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
    (!p.queueOnly || status(m.id)?.status === 'queue'));
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
    el.innerHTML = `<div class="pick-card empty-pick"><div class="stack" style="justify-items:center;padding:28px">${icon('dice')}<p>${S.p.current === false ? 'Nothing fits all of those choices. Loosen a filter and try again.' : 'Choose a mood, then press Pick for Me.'}</p></div></div>`;
    return;
  }
  el.innerHTML = `<div class="pick-card ${animate ? 'spin' : ''}">
    ${wideArt(m)}<div class="shade"></div>
    <div class="body">
      <div class="facts">${[m.y, m.rt && `${m.rt} min`, m.cert].filter(Boolean).map((x) => `<span>${esc(x)}</span>`).join('')}${rating(m) ? `<span class="star">${rating(m)}</span>` : ''}${tomBadge(m)}<span>${esc(servicesText(m))}</span></div>
      <h2>${esc(m.t)}</h2>
      ${m.ov ? `<p>${esc(m.ov)}</p>` : ''}
      <div class="row">${m.sg.slice(0, 4).map(sgTag).join('')}</div>
      <div class="row"><button class="btn primary" data-act="repick">${icon('dice')}Pick another</button>${queueBtn(m)}<button class="btn" data-act="open" data-id="${m.id}">Details</button></div>
    </div></div>`;
}
views.pick = () => {
  const p = S.p;
  S.after = () => renderPick(false);
  return `<div class="page-head"><h1>Pick for Me</h1><p class="muted">Set the mood and we'll pull one off the shelf. Movies you've seen are skipped.</p></div>
  <div class="pick-layout">
    <div class="panel filters">
      <div class="stack" style="gap:10px"><h3>Mood</h3><div class="seg">${MOODS.map(([k, l, d]) => `<button data-act="pmix" data-k="${k}" aria-pressed="${p.mix === k}"><b>${l}</b><span>${d}</span></button>`).join('')}</div></div>
      <div class="stack" style="gap:10px"><h3>Any of these subgenres</h3>${sgPicker('psg', p.sg)}</div>
      <div class="stack" style="gap:10px"><h3>Limits</h3><div class="chips">
        ${chip('pmine', '', 'On my services', p.mine, S.profile.services.length ? '' : 'disabled title="Add services in Settings"')}
        ${chip('pqueue', '', 'From my queue', p.queueOnly, S.user ? '' : 'disabled')}
      </div></div>
      <button class="btn primary" data-act="repick" style="justify-self:start">${icon('dice')}Pick for Me</button>
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
  return `<div class="page-head"><h1>My Queue</h1><p class="muted">${q.length ? `${q.length} movie${q.length === 1 ? '' : 's'} waiting for you.` : 'Save movies here to watch later.'}</p></div>
  <div class="tabs" role="tablist"><button role="tab" data-act="qtab" data-k="queue" aria-selected="${tab === 'queue'}">To watch (${q.length})</button><button role="tab" data-act="qtab" data-k="seen" aria-selected="${tab === 'seen'}">Seen (${seen.length})</button></div>
  ${tab === 'seen' ? '<p class="muted">Badges, milestones and your full watch log live in the <a href="#/bodycount">Body Count</a>.</p>' : ''}
  ${rows.length ? `<div class="grid">${rows.map((x) => card(x.m)).join('')}</div>` : `<div class="empty">${icon(tab === 'queue' ? 'bookmark' : 'check')}<span>${tab === 'queue' ? 'Your queue is empty. Open any movie and press "Add to queue".' : 'Nothing marked as seen yet. Open a movie and press "Seen it".'}</span></div>`}`;
};

// Movie nights
views.nights = async () => {
  if (!S.user) return signInPrompt('Sign in to start a movie night and vote with friends.');
  const list = (await store.listNights()).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  return `<div class="page-head"><h1>Movie Nights</h1><p class="muted">Start a night and send friends the link. Everyone suggests movies and gets ${VOTES_PER_PERSON} votes.</p></div>
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
  if (!S.social && store.getSocial) loadSocial().then(() => { if (location.hash.startsWith('#/profile')) route(true, true); });
  S.after = () => { renderServices(); if (sub === 'services') $('#services')?.scrollIntoView({ block: 'start' }); };
  return `<div class="profile-head"><span class="avatar xl" style="--ah:${avatarHue(name)}">${esc((name[0] || '?').toUpperCase())}</span><div><h1>${esc(name)}</h1><p class="muted">${esc(S.user.email || '')}</p></div></div>
  <div class="profile-grid">
    <section class="panel stack" id="services" style="gap:16px">
      <div class="shelf-head"><div><h2>Your streaming services</h2><p class="muted">Tap the ones you pay for or use. Shelves and Pick for Me lean toward them. Saved as you go.</p></div></div>
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
      ${store.getSocial && S.social ? avatarPicker() : ''}
      ${store.getSocial ? `<form class="panel stack" data-form="social" style="gap:14px">
        <h2>Friends &amp; privacy</h2>
        <label class="field">Username (so friends can find you)<span class="handle-in"><span>@</span><input type="text" name="handle" maxlength="20" pattern="[A-Za-z0-9_]{3,20}" value="${esc(S.social?.handle || '')}" placeholder="pick one" autocomplete="off"></span></label>
        <label class="field">Who can see my Body Count, ratings and queue<select name="pv">${Object.entries(PRIVACY).map(([k, l]) => `<option value="${k}" ${(S.social?.privacy?.profile || 'friends') === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
        <label class="field">Who can read my reviews<select name="rv">${['public', 'friends'].map((k) => `<option value="${k}" ${(S.social?.privacy?.reviews || 'public') === k ? 'selected' : ''}>${k === 'public' ? 'Everyone' : 'Friends only'}</option>`).join('')}</select></label>
        <div class="row" style="gap:8px"><button class="btn primary" type="submit">Save</button><a class="btn ghost" href="#/u/${esc(S.social?.handle || S.user.uid)}">${icon('eye')}See my profile</a><a class="btn ghost" href="#/friends">${icon('users')}Friends</a></div>
      </form>` : ''}
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
  return `<div class="panel stack auth-card" style="text-align:center;justify-items:center"><img class="logo-full" src="icons/logo-full.jpg" alt="${esc(SITE_NAME)}"><h2>Sign in to continue</h2><p class="muted">${msg}</p><a class="btn primary" href="#/signin" data-act="gosignin">Sign in or create an account</a></div>`;
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
views.about = () => `<div class="page-head"><h1>How ${esc(SITE_NAME)} Works</h1></div>
  <div class="panel stack prose" style="max-width:760px;gap:18px">
    <p>Every night the site pulls the most popular, most talked-about and most-rated horror movies from TMDB, along with where they're streaming in the US.</p>
    <h3>Trending vs. widely seen</h3>
    <p class="muted">Each movie is measured two ways. How much attention it's getting this week (from TMDB's trending lists and activity), and how many people have seen it overall (from rating counts on TMDB and IMDb). That's how the site can tell a new release people are actually watching from one that just came out.</p>
    <h3>The labels on each movie</h3>
    <div class="chips">${S.data.tiers.map((t) => `<span class="tag t-${t.key}" style="--h:0"><span class="sw" style="background:var(--tc)"></span>${esc(t.label)}</span>`).join('')}</div>
    <p class="muted">New Release covers the last four months, since brand-new movies haven't had time to collect ratings. The rest go from the most-watched horror movies down to ones few people have found. The labels compare horror movies with each other, not with all movies.</p>
    <h3>Subgenres</h3><p class="muted">Tagged from TMDB keywords like "slasher", "demonic possession" or "found footage", plus overlaps like horror comedy and sci-fi horror. A movie can have several. The site admin can correct them.</p>
    <h3>The artwork</h3><p class="muted">Each movie gets its own generated artwork in the colors of its main subgenre, so the shelves stay readable without studio posters.</p>
    <h3 id="credits">Profile picture credits</h3>
    <p class="muted">The classic horror profile pictures are public-domain film stills from Wikimedia Commons.</p>
    <ul class="credits">${AVATARS.map((a) => `<li><img src="avatars/${a.id}.jpg" alt=""><span><b>${esc(a.name)}</b>, ${esc(a.film)} (${a.year}). <a href="${esc(a.source)}" target="_blank" rel="noopener">${esc(a.file)}</a>, ${esc(a.license)}, via Wikimedia Commons.</span></li>`).join('')}</ul>
  </div>`;
const aboutView = views.about;
views.about = () => { S.after = S.afterAbout; return aboutView(); };
S.afterAbout = () => { if (S.scrollCredits) { S.scrollCredits = false; requestAnimationFrame(() => $('#credits')?.scrollIntoView({ block: 'start' })); } };

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
    <span class="meta"><span class="mt">${esc(x.t)}${x.y ? ` <span class="yr">(${x.y})</span>` : ''}</span><span class="l1">${skullRow(x.st.rating)}</span><span class="l2">${x.on ? `Watched ${esc(shortDate(x.on))}` : 'Before Scream Queue'}${x.st.status === 'queue' ? '. Rewatch queued' : ''}${x.st.rv ? '. Reviewed' : ''}</span></span>
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
  setHTML(el, html);
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

// A person's horror movies on the site, built from the nightly cast data (data/people/N.json).
const peopleShards = new Map();
async function loadPerson(id) {
  const k = Number(id) % 100;
  if (!peopleShards.has(k)) peopleShards.set(k, fetch(`data/people/${k}.json`).then((r) => (r.ok ? r.json() : {})).catch(() => ({})));
  return (await peopleShards.get(k))[id] || null;
}
views.person = async (id) => {
  const p = await loadPerson(id);
  if (!p) return `<div class="empty">${icon('users')}<span>We don't have that person yet. Cast lists fill in with the nightly data refresh.</span></div>`;
  const credits = p.m.map(([mid, role]) => ({ m: S.byId.get(String(mid)), role })).filter((x) => x.m)
    .sort((a, b) => (b.m.date || '').localeCompare(a.m.date || ''));
  const seen = credits.filter((x) => everSeen(x.m)).length;
  const directed = credits.filter((x) => x.role === 'Director').length;
  const known = [...credits].sort((a, b) => b.m.reach - a.m.reach).slice(0, 3).map((x) => x.m.t);
  const back = S.trail?.[S.trail.length - 1];
  const backLabel = back ? (back.movie ? S.byId.get(String(back.movie))?.t : null) || ({ '#/': 'Tonight', '#/browse': 'Browse', '#/queue': 'My Queue', '#/bodycount': 'Body Count', '#/pick': 'Pick for Me' }[back.hash.split('?')[0]] || (back.hash.startsWith('#/person/') ? 'previous person' : 'previous page')) : null;
  return `${back ? `<button class="back-link" data-act="goback">${icon('left')}Back to ${esc(backLabel)}</button>` : ''}<div class="person-head">
      <span class="person-face">${face(p.p, p.n, 'w300')}</span>
      <div class="stack" style="gap:6px;min-width:0"><h1>${esc(p.n)}</h1>
        <p class="muted">${credits.length} horror movie${credits.length === 1 ? '' : 's'} on ${esc(SITE_NAME)}${directed ? `, ${directed} as director` : ''}.${S.user && credits.length ? ` You've seen ${seen} of them.` : ''}</p>
        ${known.length ? `<p class="faint">Known for ${esc(known.join(', '))}</p>` : ''}
        <div class="row"><a class="btn small ghost" href="https://www.themoviedb.org/person/${encodeURIComponent(id)}" target="_blank" rel="noopener">${icon('link')}Full filmography on TMDB</a></div>
      </div></div>
    ${credits.length ? `<div class="grid">${credits.map((x) => card(x.m, { sub: x.role === 'Director' ? 'Director' : x.role ? `as ${x.role}` : '' })).join('')}</div>` : ''}`;
};

// ---------- social: friends, profiles, reviews ----------
const PRIVACY = { public: 'Anyone signed in', friends: 'Friends only', private: 'Only me' };
// ---------- profile pictures ----------
// A person's picture is av = 'pd:<id>' (classic public-domain horror portrait), 'ic:<icon>' (drawn icon),
// 'up' (their uploaded photo), or '' (initials). Other people's choices are looked up from their profile card.
let AVATARS = [];
fetch('avatars/avatars.json').then((r) => (r.ok ? r.json() : [])).then((x) => { AVATARS = x; }).catch(() => {});
// Original drawings made for this site (generic slasher props, no specific characters).
const AV_PROPS = [['hockeymask', 'Hockey mask'], ['knife', 'Kitchen knife'], ['sackmask', 'Sack mask'], ['doll', 'Creepy doll'], ['chainsaw', 'Chainsaw'], ['pigmask', 'Pig mask'],
  ['phone', 'The phone call'], ['pumpkin', 'Jack-o\'-lantern'], ['machete', 'Machete'], ['clawglove', 'Claw glove'], ['vhs', 'Cursed tape'], ['beartrap', 'Bear trap']];
const AV_ICONS = ['ghost', 'demonic', 'vampire', 'werewolf', 'zombie', 'slasher', 'creature', 'cosmic', 'occult', 'classic', 'body', 'folk'];
S.cards = new Map();
function renderAvatar(name, c, cls = '') {
  const a = c?.av || '';
  const ah = `--ah:${avatarHue(name || '?')}`;
  if (a === 'up' && c.photo) return `<span class="avatar pic ${cls}"><img src="${esc(c.photo)}" alt=""></span>`;
  if (a.startsWith('og:')) return `<span class="avatar pic ${cls}"><img src="avatars/og/${esc(a.slice(3))}.svg" alt=""></span>`;
  if (a.startsWith('pd:')) return `<span class="avatar pic ${cls}"><img src="avatars/${esc(a.slice(3))}.jpg" alt=""></span>`;
  if (a.startsWith('ic:')) return `<span class="avatar ic ${cls}" style="${ah}">${sgIcon(a.slice(3))}</span>`;
  return `<span class="avatar ${cls}" style="${ah}">${esc(((name || '?')[0] || '?').toUpperCase())}</span>`;
}
function myCard() { return { name: S.profile.name || S.user?.name || '', av: S.social?.av || '', photo: S.social?.photo || '' }; }
// Someone's avatar. Unknown people show initials first and are filled in once their card loads.
function av(name, cls = '', uid = '') {
  if (uid && uid === S.user?.uid) return renderAvatar(name, myCard(), cls);
  const c = uid && S.cards.get(uid);
  if (c || !uid) return renderAvatar(name, c, cls);
  return `<span data-av-uid="${esc(uid)}" data-av-name="${esc(name || '')}" data-av-cls="${esc(cls)}">${renderAvatar(name, null, cls)}</span>`;
}
let avTimer = 0;
async function hydrateAvatars() {
  const els = [...document.querySelectorAll('[data-av-uid]')]; if (!els.length || !store.getProfileCard) return;
  const need = [...new Set(els.map((e) => e.dataset.avUid))].filter((u) => !S.cards.has(u)).slice(0, 40);
  await Promise.all(need.map(async (u) => { S.cards.set(u, (await store.getProfileCard(u).catch(() => null)) || {}); }));
  for (const e of document.querySelectorAll('[data-av-uid]')) {
    const c = S.cards.get(e.dataset.avUid); if (!c) continue;
    e.outerHTML = renderAvatar(e.dataset.avName, c, e.dataset.avCls);
  }
}
new MutationObserver(() => { clearTimeout(avTimer); avTimer = setTimeout(hydrateAvatars, 60); }).observe(document.body, { childList: true, subtree: true });
// Shrink an uploaded picture to a 160px square JPEG (small enough to keep in the profile card).
function squarePhoto(file) {
  return new Promise((resolve, reject) => {
    const img = new Image(); const url = URL.createObjectURL(file);
    img.onload = () => {
      const n = 160; const cv = document.createElement('canvas'); cv.width = cv.height = n;
      const s = Math.min(img.width, img.height);
      cv.getContext('2d').drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, n, n);
      URL.revokeObjectURL(url);
      let q = 0.85, out = cv.toDataURL('image/jpeg', q);
      while (out.length > 80000 && q > 0.4) { q -= 0.1; out = cv.toDataURL('image/jpeg', q); }
      resolve(out);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('That file is not a picture we can read.')); };
    img.src = url;
  });
}
function avatarPicker() {
  const cur = S.social?.av || '';
  const opt = (k, inner, title) => `<button type="button" class="av-opt" data-act="setav" data-k="${esc(k)}" aria-pressed="${cur === k}" title="${esc(title)}" aria-label="${esc(title)}">${inner}</button>`;
  return `<section class="panel stack" id="avpick" style="gap:14px">
    <h2>Profile picture</h2>
    <div class="av-now">${renderAvatar(S.profile.name || S.user?.name, myCard(), 'xl')}
      <div class="stack" style="gap:8px"><label class="btn small">${icon('plus')}Upload a photo<input type="file" id="av-file" accept="image/*" hidden></label>
      <span class="fine">Only upload pictures you have the right to use.</span>
      ${cur ? `<button type="button" class="btn small ghost" data-act="setav" data-k="">Use my initials</button>` : ''}</div></div>
    <h3>Slasher props</h3>
    <div class="av-grid">${AV_PROPS.map(([k, l]) => opt(`og:${k}`, `<img src="avatars/og/${k}.svg" alt="" loading="lazy">`, l)).join('')}</div>
    <h3>Classic horror icons</h3>
    <div class="av-grid">${AVATARS.map((a) => opt(`pd:${a.id}`, `<img src="avatars/${a.id}.jpg" alt="" loading="lazy">`, `${a.name}, ${a.film} (${a.year})`)).join('')}</div>
    <p class="fine">Public-domain film stills from Wikimedia Commons. <a href="#/about" data-act="credits">Picture credits</a></p>
    <h3>Icons</h3>
    <div class="av-grid">${AV_ICONS.map((k) => opt(`ic:${k}`, `<span class="avatar ic" style="--ah:${(SG_HUE[k] || [350])[0]}">${sgIcon(k)}</span>`, `${S.sgLabel.get(k) || k} icon`)).join('')}</div>
  </section>`;
}
const handleOf = (p) => (p?.handle ? `@${p.handle}` : '');
function inviteLink() { return `${location.origin}${location.pathname}#/u/${encodeURIComponent(S.social?.handle || S.user?.uid || '')}`; }
// One load at a time: overlapping calls share the same request instead of racing each other.
let socialLoading = null;
function loadSocial() { if (!socialLoading) socialLoading = loadSocialNow().finally(() => { socialLoading = null; }); return socialLoading; }
async function loadSocialNow() {
  if (!S.user || !store.getSocial) { S.social = null; S.friends = []; S.requests = { incoming: [], outgoing: [] }; return; }
  try {
    [S.social, S.friends, S.requests] = await Promise.all([store.getSocial(), store.listFriends(), store.listRequests()]);
    await Promise.all(S.friends.filter((f) => !S.cards.has(f.uid)).map(async (f) => { S.cards.set(f.uid, (await store.getProfileCard(f.uid).catch(() => null)) || {}); }));
  } catch (e) { console.warn('social', e); S.social ||= { handle: '', privacy: { profile: 'friends', reviews: 'public' } }; }
}
const friendIds = () => (S.friends || []).map((f) => f.uid);

// Friend button for someone else's page or a search result
function friendBtn(uid, state) {
  if (!S.user || uid === S.user.uid) return '';
  if (state === 'friends') return `<button class="btn small" data-act="unfriend" data-k="${uid}">${icon('check')}Friends</button>`;
  if (state === 'incoming') return `<button class="btn small primary" data-act="accept" data-k="${uid}">${icon('plus')}Accept request</button><button class="btn small ghost" data-act="decline" data-k="${uid}">Decline</button>`;
  if (state === 'outgoing') return `<button class="btn small ghost" data-act="cancelreq" data-k="${uid}">Requested · Cancel</button>`;
  return `<button class="btn small primary" data-act="addfriend" data-k="${uid}">${icon('plus')}Add friend</button>`;
}
function stateFor(uid) {
  if (friendIds().includes(uid)) return 'friends';
  if (S.requests?.incoming.some((r) => r.uid === uid)) return 'incoming';
  if (S.requests?.outgoing.some((r) => r.uid === uid)) return 'outgoing';
  return 'none';
}

// Friends page: requests, find people, invite link, your friends, and what they've been watching
views.friends = async () => {
  if (!S.user) return signInPrompt('Sign in to add friends and see what they are watching.');
  await loadSocial();
  const { incoming, outgoing } = S.requests;
  const feed = [];
  await Promise.all(S.friends.map(async (f) => {
    try { for (const x of await store.recentOf(f.uid, 8)) feed.push({ f, x }); } catch { /* private or gone */ }
  }));
  feed.sort((a, b) => b.x.at - a.x.at);
  const line = ({ f, x }) => {
    const m = S.byId.get(String(x.id)); const t = m?.t || x.title || 'a movie';
    const what = x.status === 'seen' ? `survived <b>${esc(t)}</b>${x.rating ? ` and gave it ${skullRow(x.rating)}` : ''}` : `queued <b>${esc(t)}</b>`;
    return `<div class="feed-item">${av(f.name, '', f.uid)}<div class="feed-body"><span><a href="#/u/${esc(f.handle || f.uid)}" class="linkish">${esc(f.name)}</a> ${what}</span><small class="faint">${esc(timeAgo(x.at))}</small></div>${m ? `<button class="feed-thumb" data-act="open" data-id="${m.id}" aria-label="${esc(t)}">${thumb(m)}</button>` : ''}</div>`;
  };
  const handle = S.social?.handle;
  const everyone = store.listPublic ? (await store.listPublic().catch(() => [])).filter((p) => p.uid !== S.user.uid) : [];
  return `<div class="page-head"><h1>Friends</h1><p class="muted">See what your friends are watching, compare Body Counts, and read each other's reviews.</p></div>
  <div class="friends-grid">
    <div class="stack" style="gap:24px">
      ${incoming.length ? `<section class="panel stack" style="gap:12px"><h2>Friend requests <span class="pill-n">${incoming.length}</span></h2>
        ${incoming.map((r) => `<div class="person-row">${av(r.name, '', r.uid)}<div class="pr-name"><b>${esc(r.name || 'Someone')}</b><small>${esc(handleOf(r))}</small></div><div class="row" style="gap:6px">${friendBtn(r.uid, 'incoming')}</div></div>`).join('')}</section>` : ''}
      <section class="panel stack" style="gap:12px">
        <h2>Find people</h2>
        <label class="search"><span class="sr">Search by username</span>${icon('search')}<input type="search" id="fr-q" placeholder="Search by name or @username" autocomplete="off"></label>
        <div id="fr-results" class="stack" style="gap:8px"></div>
        <div class="stack" style="gap:8px"><b>Or send your invite link</b>
          <div class="row" style="gap:8px"><input type="text" id="invite-me" readonly value="${esc(inviteLink())}" aria-label="Your invite link" style="flex:1;min-width:0"><button class="btn" data-act="copy" data-target="invite-me">${icon('link')}Copy</button></div>
          ${handle ? '' : `<p class="fine">Pick a username in <a href="#/profile">Profile</a> so friends can find you and your link looks nicer.</p>`}
        </div>
      </section>
      <section class="panel stack" style="gap:12px">
        <h2>Your friends${S.friends.length ? ` <span class="faint">${S.friends.length}</span>` : ''}</h2>
        ${S.friends.length ? S.friends.map((f) => `<a class="person-row link" href="#/u/${esc(f.handle || f.uid)}">${av(f.name, '', f.uid)}<div class="pr-name"><b>${esc(f.name || 'Friend')}</b><small>${esc(handleOf(f))}</small></div>${icon('right')}</a>`).join('') : '<p class="muted">No friends yet. Search for someone above, or send them your invite link.</p>'}
        ${outgoing.length ? `<h3 class="muted" style="margin-top:6px">Waiting on</h3>${outgoing.map((r) => `<div class="person-row">${av(r.name, '', r.uid)}<div class="pr-name"><b>${esc(r.name || 'Someone')}</b><small>${esc(handleOf(r))}</small></div>${friendBtn(r.uid, 'outgoing')}</div>`).join('')}` : ''}
      </section>
    </div>
    <div class="stack" style="gap:24px">
    <section class="panel stack" style="gap:6px"><h2>What your friends are watching</h2>
      ${feed.length ? feed.slice(0, 40).map(line).join('') : `<p class="muted">${S.friends.length ? 'Nothing yet. Activity shows up here when friends queue or survive a movie.' : 'Add friends to see their activity here.'}</p>`}
    </section>
    <section class="panel stack" style="gap:10px"><h2>People on ${esc(SITE_NAME)}</h2>
      <p class="muted" style="font-size:.9rem">Everyone with a public profile. ${S.social?.privacy?.profile === 'public' ? 'You are listed here too.' : 'Set your profile to "Anyone signed in" in <a href="#/profile">Profile</a> to be listed.'}</p>
      ${everyone.length ? everyone.map((p) => `<div class="person-row">${renderAvatar(p.name, p)}<a class="pr-name linkish" href="#/u/${esc(p.handle || p.uid)}"><b>${esc(p.name || 'Horror fan')}</b><small>${esc(handleOf(p))}</small></a><div class="row" style="gap:6px">${friendBtn(p.uid, stateFor(p.uid))}</div></div>`).join('') : '<p class="muted">No public profiles yet.</p>'}
    </section>
    </div>
  </div>`;
};
function timeAgo(t) {
  const d = (Date.now() - t) / 1000;
  if (d < 3600) return `${Math.max(1, Math.round(d / 60))} min ago`;
  if (d < 86400) return `${Math.round(d / 3600)} hr ago`;
  if (d < 86400 * 30) return `${Math.round(d / 86400)} day${Math.round(d / 86400) === 1 ? '' : 's'} ago`;
  return new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}
async function renderFriendSearch() {
  const box = $('#fr-results'); const q = $('#fr-q')?.value.trim(); if (!box) return;
  if (!q || q.replace(/^@/, '').length < 2) { box.innerHTML = ''; return; }
  const found = await store.findUser(q).catch(() => []);
  if ($('#fr-q')?.value.trim() !== q) return;
  box.innerHTML = found.length ? found.map((p) => `<div class="person-row">${renderAvatar(p.name, p)}<a class="pr-name linkish" href="#/u/${esc(p.handle || p.uid)}"><b>${esc(p.name || 'Someone')}</b><small>${esc(handleOf(p))}</small></a><div class="row" style="gap:6px">${friendBtn(p.uid, stateFor(p.uid))}</div></div>`).join('') : '<p class="muted">No one by that name or username yet. They may need to sign in once, or send them your invite link.</p>';
}

// Someone's page: their Body Count, ratings, reviews and queue (if their privacy setting lets you), plus a comparison with yours
views.u = async (key) => {
  if (!S.user) return signInPrompt('Sign in to see people\'s Body Counts and add friends.');
  key = decodeURIComponent(key || '');
  if (!S.social) await loadSocial();
  const pc = await store.getProfileCard(key).catch(() => null);
  if (!pc) return `<div class="empty">${icon('users')}<span>We couldn't find that person. Their username may have changed.</span></div>`;
  const isMe = pc.uid === S.user.uid;
  const state = isMe ? 'me' : stateFor(pc.uid);
  let movies = null;
  try { movies = isMe ? S.mine : await store.moviesOf(pc.uid); } catch { movies = null; }
  const priv = pc.privacy?.profile || 'friends';
  const head = `<div class="profile-head">${pc.uid === S.user.uid ? renderAvatar(pc.name, myCard(), 'xl') : renderAvatar(pc.name, pc, 'xl')}<div class="stack" style="gap:6px;min-width:0"><h1>${esc(pc.name || 'Horror fan')}</h1><p class="muted">${esc(handleOf(pc))}${handleOf(pc) ? ' · ' : ''}${isMe ? `This is how others see you (${esc(PRIVACY[priv].toLowerCase())})` : { public: 'Public profile', friends: 'Friends-only profile', private: 'Private profile' }[priv]}</p>
    <div class="row" style="gap:8px">${isMe ? `<a class="btn small" href="#/profile">${icon('gear')}Edit profile &amp; privacy</a>` : friendBtn(pc.uid, state)}</div></div></div>`;
  if (!movies) return `${head}<div class="empty">${icon('shield')}<span>${priv === 'private' ? `${esc(pc.name || 'This person')} keeps their Body Count private.` : `${esc(pc.name || 'This person')} shares their Body Count with friends only.${state === 'none' ? ' Send a friend request to see it.' : ''}`}</span></div>`;
  const list = [...movies.entries()].map(([id, st]) => ({ id, st, m: S.byId.get(String(id)) }));
  const seen = list.filter((x) => x.st.status === 'seen' || x.st.wasSeen).sort((a, b) => (b.st.seenOn || '').localeCompare(a.st.seenOn || '') || b.st.at - a.st.at);
  const queue = list.filter((x) => x.st.status === 'queue' && x.m).sort((a, b) => b.st.at - a.st.at);
  const rated = seen.filter((x) => x.st.rating);
  const avg = rated.length ? (rated.reduce((s, x) => s + x.st.rating, 0) / rated.length).toFixed(1) : '—';
  const both = isMe ? [] : seen.filter((x) => everSeen({ id: x.id }));
  const loved = isMe ? [] : seen.filter((x) => x.m && x.st.rating >= 4 && !everSeen({ id: x.id })).sort((a, b) => b.st.rating - a.st.rating);
  const diffs = both.filter((x) => x.st.rating && status(x.id)?.rating).map((x) => ({ ...x, mine: status(x.id).rating, d: x.st.rating - status(x.id).rating })).sort((a, b) => Math.abs(b.d) - Math.abs(a.d));
  const tab = S.uTab || 'seen';
  S.after = () => loadProfileReviews(pc, seen);
  // Posters here show their ratings, not your own queue/seen marks (which would look like theirs).
  const ratedCard = (x) => x.m ? card(x.m, { plain: !isMe, sub: x.st.rating ? `${fmtRating(x.st.rating)} skulls` : 'Survived' }) : '';
  return `${head}
    <div class="stat-row">
      <div class="stat"><b>${seen.length}</b><span>Body Count</span></div>
      <div class="stat"><b>${avg}</b><span>Average rating</span></div>
      <div class="stat"><b>${queue.length}</b><span>In their queue</span></div>
      ${isMe ? '' : `<div class="stat"><b>${both.length}</b><span>You've both seen</span></div>`}
    </div>
    ${!isMe && (loved.length || diffs.length) ? `<section class="panel stack" style="gap:14px">
      <h2>You vs. ${esc(pc.name || 'them')}</h2>
      ${diffs.length ? `<div class="stack" style="gap:6px">${diffs.slice(0, 5).map((x) => `<div class="cmp-row"><button class="linkish" data-act="open" data-id="${x.id}">${esc(x.m?.t || x.st.title || 'Movie')}</button><span>You ${skullRow(x.mine)}</span><span>${esc(pc.name || 'Them')} ${skullRow(x.st.rating)}</span></div>`).join('')}</div>` : ''}
      ${loved.length ? `<h3>They loved it, you haven't seen it</h3><div class="grid">${loved.slice(0, 12).map(ratedCard).join('')}</div>` : ''}
    </section>` : ''}
    <div class="tabs" role="tablist" style="margin-top:8px">${[['seen', `Body Count (${seen.length})`], ['reviews', 'Reviews'], ['queue', `Queue (${queue.length})`]].map(([k, l]) => `<button role="tab" data-act="utab" data-k="${k}" aria-selected="${tab === k}">${l}</button>`).join('')}</div>
    <div id="u-pane">${tab === 'queue' ? (queue.length ? `<div class="grid">${queue.map((x) => card(x.m, { plain: !isMe })).join('')}</div>` : '<p class="muted">Nothing queued.</p>')
      : tab === 'reviews' ? '<div id="u-reviews" class="stack" style="gap:12px"><p class="muted">Loading reviews…</p></div>'
      : (seen.length ? `<div class="grid">${seen.map(ratedCard).join('')}</div>` : '<p class="muted">Nothing survived yet.</p>')}</div>`;
};
async function loadProfileReviews(pc, seen) {
  const box = $('#u-reviews'); if (!box) return;
  const ids = seen.filter((x) => x.st.rv).map((x) => x.id);
  const got = (await Promise.all(ids.map((id) => store.getReview(id, pc.uid).then((r) => r && { id, r }).catch(() => null)))).filter(Boolean).sort((a, b) => b.r.at - a.r.at);
  box.innerHTML = got.length ? got.map(({ id, r }) => { const m = S.byId.get(String(id)); return `<div class="review"><div class="rv-movie">${m ? `<button class="feed-thumb" data-act="open" data-id="${m.id}">${thumb(m)}</button>` : ''}<div><b>${esc(m?.t || 'Movie')}</b>${m?.y ? ` <span class="faint">(${m.y})</span>` : ''}<div>${r.rating ? skullRow(r.rating) : ''}</div></div></div>${reviewText(r, `${id}-${pc.uid}`)}</div>`; }).join('')
    : '<p class="muted">No reviews they can show you yet.</p>';
}
function reviewText(r, key) {
  const shown = !r.spoiler || S.spoilersShown?.has(key);
  return `<div class="rv-text ${shown ? '' : 'blur'}">${esc(r.text).replace(/\n/g, '<br>')}</div>${r.spoiler && !shown ? `<button class="btn small ghost" data-act="spoiler" data-k="${esc(key)}">${icon('eye')}Show spoilers</button>` : ''}`;
}

// ---------- reviews + "friends who've seen this" in movie details ----------
const reviewCache = new Map();
function reviewsBlock(m) {
  const c = reviewCache.get(String(m.id));
  if (!c && store.listReviews) loadReviewsFor(m);
  return `<div class="reviews-wrap">${reviewsHTML(m, c)}</div>`;
}
async function loadReviewsFor(m) {
  const ids = friendIds();
  const [reviews, friendsSeen] = await Promise.all([
    store.listReviews(m.id, ids).catch(() => []),
    S.user ? Promise.all((S.friends || []).slice(0, 40).map(async (f) => ({ f, st: await store.movieOf(f.uid, m.id).catch(() => null) }))).then((a) => a.filter((x) => x.st && (x.st.status === 'seen' || x.st.wasSeen))) : [],
  ]);
  reviewCache.set(String(m.id), { reviews, friendsSeen });
  const el = document.querySelector(`#detail[data-id="${m.id}"] .reviews-wrap`); if (el) el.innerHTML = reviewsHTML(m, reviewCache.get(String(m.id)));
}
function reviewsHTML(m, c) {
  const st = status(m.id); const seen = st?.status === 'seen' || st?.wasSeen;
  const mine = c?.reviews.find((r) => r.uid === S.user?.uid);
  const fset = new Set(friendIds());
  const others = (c?.reviews || []).filter((r) => r.uid !== S.user?.uid).sort((a, b) => (fset.has(b.uid) - fset.has(a.uid)) || b.at - a.at);
  const editing = S.reviewEdit === String(m.id) || (seen && !mine && S.reviewOpen === String(m.id));
  let me = '';
  if (!S.user) me = '';
  else if (editing) me = `<form class="review-form" data-id="${m.id}"><textarea name="text" rows="4" maxlength="5000" placeholder="What did you think? No one can see this until you post it." required>${esc(mine?.text || '')}</textarea>
      <div class="row" style="gap:10px;justify-content:space-between"><label class="row" style="gap:8px"><input type="checkbox" name="spoiler" ${mine?.spoiler ? 'checked' : ''}> Contains spoilers</label>
      <span class="row" style="gap:8px"><button class="btn small ghost" type="button" data-act="reviewcancel" data-id="${m.id}">Cancel</button><button class="btn small primary" type="submit">${mine ? 'Save review' : 'Post review'}</button></span></div>
      <p class="fine">Visible to ${esc((PRIVACY[S.social?.privacy?.reviews || 'public'] || '').toLowerCase())}. Change this in <a href="#/profile">Profile</a>.</p></form>`;
  else if (mine) me = `<div class="review mine"><div class="rv-head">${av(S.profile.name || S.user.name, '', S.user.uid)}<b>Your review</b>${mine.rating ? skullRow(mine.rating) : ''}<span class="faint">${esc(timeAgo(mine.at))}</span></div>${reviewText(mine, `${m.id}-me`)}<div class="row" style="gap:8px"><button class="btn small ghost" data-act="reviewedit" data-id="${m.id}">Edit</button><button class="btn small ghost" data-act="reviewdel" data-id="${m.id}">Delete</button></div></div>`;
  else if (seen) me = `<button class="btn small" data-act="reviewwrite" data-id="${m.id}">${icon('plus')}Write a review</button>`;
  else me = '<p class="fine">Mark it as seen to write a review.</p>';
  const fs = c?.friendsSeen || [];
  return `<div class="stack" style="gap:12px">
    ${fs.length ? `<div class="friends-seen"><span class="fs-avs">${fs.slice(0, 6).map(({ f }) => av(f.name, 'sm', f.uid)).join('')}</span><span>${fs.length === 1 ? `<b>${esc(fs[0].f.name)}</b> has seen this` : `<b>${fs.length} friends</b> have seen this`}${fs.some((x) => x.st.rating) ? `: ${fs.filter((x) => x.st.rating).slice(0, 3).map((x) => `${esc(x.f.name.split(' ')[0])} ${skullRow(x.st.rating)}`).join(', ')}` : ''}</span></div>` : ''}
    <h3>Reviews${others.length || mine ? ` <span class="faint">${others.length + (mine ? 1 : 0)}</span>` : ''}</h3>
    ${me}
    ${c == null ? '<p class="muted">Loading reviews…</p>' : others.length ? others.slice(0, 20).map((r) => `<div class="review"><div class="rv-head">${av(r.name, '', r.uid)}<a class="linkish" href="#/u/${esc(r.handle || r.uid)}" data-act="gouser"><b>${esc(r.name || 'A fan')}</b></a>${fset.has(r.uid) ? '<span class="tag">Friend</span>' : ''}${r.rating ? skullRow(r.rating) : ''}<span class="faint">${esc(timeAgo(r.at))}</span>${S.user?.isAdmin ? `<button class="linkish danger" data-act="reviewmod" data-id="${m.id}" data-k="${r.uid}">Remove</button>` : ''}</div>${reviewText(r, `${m.id}-${r.uid}`)}</div>`).join('') : (mine ? '' : '<p class="muted">No reviews yet.</p>')}
  </div>`;
}
function rerenderReviews(id) { const m = S.byId.get(String(id)); const el = $('#detail .reviews-wrap'); if (m && el) el.innerHTML = reviewsHTML(m, reviewCache.get(String(id))); }

views.checklist = () => {
  if (!S.user) return signInPrompt('Sign in to check off the movies you have seen.');
  const q = (S.ckq || '').toLowerCase();
  const base = S.ckAll ? S.movies.slice().sort((a, b) => b.reach - a.reach) : essentialsList();
  const list = base.filter((m) => !q || m.t.toLowerCase().includes(q)).slice(0, S.ckAll ? 300 : ESSENTIALS);
  const done = base.filter(everSeen).length;
  return `<div class="page-head"><h1>What Have You Seen?</h1><p class="muted">Tap every movie you've already watched. They go into your Body Count under "Before Scream Queue", so you don't need dates.</p></div>
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
  // People (cast and directors), from a small index loaded the first time someone searches.
  if (!S.peopleIdx) { S.peopleIdx = []; fetch('data/people-index.json').then((r) => (r.ok ? r.json() : [])).then((x) => { S.peopleIdx = x; if (x.length && $('#qs')?.value.trim()) renderQuick(); }).catch(() => {}); }
  const ql = q.toLowerCase();
  const ppl = ql.length >= 3 ? S.peopleIdx.filter(([, n]) => n.toLowerCase().split(/\s+/).some((w) => w.startsWith(ql)) || n.toLowerCase().startsWith(ql)).slice(0, 3) : [];
  const pplRows = ppl.map(([id, n, c, ph]) => `<button class="qs-row qs-person" data-act="person" data-k="${id}"><span class="qs-face">${face(ph || null, n, 'w92')}</span><span class="nm"><b>${esc(n)}</b><small>${c} horror movie${c === 1 ? '' : 's'}</small></span></button>`).join('');
  const rows = list.map((m, i) => {
    const st = status(m.id);
    const tag = st?.status === 'queue' ? `<span class="qs-tag q">${icon('bookmark')}Queued</span>` : everSeen(m) ? `<span class="qs-tag s">${icon('skull')}Survived</span>` : '';
    return `<button class="qs-row" role="option" data-act="open" data-id="${m.id}" data-i="${i}">${thumb(m)}<span class="nm"><b>${esc(m.t)}</b><small>${[m.y, m.dir[0], servicesText(m)].filter(Boolean).map(esc).join(' · ')}</small></span>${tag}</button>`;
  }).join('');
  box.innerHTML = `${sg ? `<button class="qs-row qs-sg" data-act="sgbrowse" data-k="${sg.key}" style="--h:${hue(sg.key)}"><span class="sgdot">${sgIcon(sg.key)}</span><span class="nm"><b>Browse ${esc(sg.label)}</b><small>Subgenre</small></span></button>` : ''}
    ${pplRows}
    ${rows || (pplRows ? '' : '<p class="qs-empty">No horror movie on the site matches that.</p>')}
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
  dlg.innerHTML = `<div class="sheet"><span class="grab" aria-hidden="true"></span>
    <div class="sheet-hero">${wideArt(m)}<button class="icon-btn close" data-act="close" aria-label="Close">${icon('x')}</button></div>
    <div class="sheet-title ${S.config.showPosters && m.poster ? 'with-poster' : ''}">
      ${S.config.showPosters && m.poster ? `<img class="sheet-poster" src="https://image.tmdb.org/t/p/w342${m.poster}" alt="${esc(m.t)} poster">` : ''}
      <div class="stack" style="gap:8px;min-width:0">
      <h2>${esc(m.t)}</h2>
      <div class="facts">${[m.y, m.rt && `${m.rt} min`, m.cert, m.dir.length && `Directed by ${m.dir.join(' and ')}`].filter(Boolean).map((x) => `<span>${esc(x)}</span>`).join('')}</div>
    </div></div>
    <div class="sheet-body">
      ${releaseHTML(m)}
      <div class="row" style="gap:10px">${trailerBtn(m)}</div>
      ${scoreRow(m)}
      <div class="row" style="gap:8px">${m.sg.map(sgTag).join('') || '<span class="faint">No subgenre tags yet</span>'}</div>
      ${m.ov ? `<p style="font-size:1.02rem;max-width:66ch">${esc(m.ov)}</p>` : ''}
      ${castBlock(m)}
      ${killBlock(m)}
      ${reviewsBlock(m)}
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
const COUNT_TARGETS = '.nav a[href="#/bodycount"], .tabbar a[href="#/bodycount"], .acct-btn';
const canFx = () => !reduceMotion() && !!Element.prototype.animate;
const rectOf = (el) => (el?.getBoundingClientRect ? el.getBoundingClientRect() : null);
// First visible match, trying each selector in the order listed (so the phone tab bar beats the avatar).
const visible = (sel) => { for (const one of sel.split(',')) { const el = [...document.querySelectorAll(one)].find((x) => { const r = x.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(x).visibility !== 'hidden'; }); if (el) return el; } return null; };
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
  trailer: (el) => openTrailer(el.dataset.id),
  async addfriend(el) {
    if (!needUser()) return;
    if (!S.social?.handle) toast('Tip: pick a username in Profile so friends can find you', 'users');
    const pc = await store.getProfileCard(el.dataset.k).catch(() => null);
    await store.sendRequest(el.dataset.k, pc || {}); await loadSocial();
    toast('Friend request sent', 'users'); await afterFriendChange();
  },
  async accept(el) { await store.acceptRequest(el.dataset.k); await loadSocial(); toast('You are now friends', 'users'); await afterFriendChange(); },
  async decline(el) { await store.declineRequest(el.dataset.k); await loadSocial(); toast('Request declined', 'x'); await afterFriendChange(); },
  async cancelreq(el) { await store.cancelRequest(el.dataset.k); await loadSocial(); toast('Request canceled', 'x'); await afterFriendChange(); },
  async unfriend(el) {
    if (el.dataset.confirm !== '1') { el.dataset.confirm = '1'; el.innerHTML = `${icon('x')}Unfriend?`; el.classList.add('danger'); setTimeout(() => { if (el.isConnected) { el.dataset.confirm = ''; el.innerHTML = `${icon('check')}Friends`; el.classList.remove('danger'); } }, 3000); return; }
    await store.unfriend(el.dataset.k); await loadSocial(); toast('Removed from friends', 'x'); await afterFriendChange();
  },
  async setav(el) {
    try { await store.setAvatar(el.dataset.k); S.social = { ...S.social, av: el.dataset.k, photo: '' }; toast('Profile picture updated', 'check'); renderChrome(); route(true, true); }
    catch (e) { console.error(e); toast('Could not save that picture. Try again.', 'x'); }
  },
  credits() { S.scrollCredits = true; location.hash = '#/about'; },
  gouser(el) { const d = $('#detail'); if (d.open) d.close(); location.hash = el.getAttribute('href'); },
  utab(el) { S.uTab = el.dataset.k; route(true, true); },
  spoiler(el) { (S.spoilersShown ||= new Set()).add(el.dataset.k); const box = el.previousElementSibling; if (box) box.classList.remove('blur'); el.remove(); },
  reviewwrite(el) { if (!needUser()) return; S.reviewOpen = el.dataset.id; rerenderReviews(el.dataset.id); $('#detail .review-form textarea')?.focus(); },
  reviewedit(el) { S.reviewEdit = el.dataset.id; rerenderReviews(el.dataset.id); $('#detail .review-form textarea')?.focus(); },
  reviewcancel(el) { S.reviewEdit = null; S.reviewOpen = null; rerenderReviews(el.dataset.id); },
  async reviewdel(el) {
    if (el.dataset.confirm !== '1') { el.dataset.confirm = '1'; el.textContent = 'Delete for good?'; el.classList.add('danger'); return; }
    const id = el.dataset.id; await store.deleteReview(id); await setStatus(id, { rv: false });
    const c = reviewCache.get(String(id)); if (c) c.reviews = c.reviews.filter((r) => r.uid !== S.user.uid);
    toast('Review deleted', 'x'); rerenderReviews(id);
  },
  async reviewmod(el) {
    if (el.dataset.confirm !== '1') { el.dataset.confirm = '1'; el.textContent = 'Remove for good?'; return; }
    await store.deleteReview(el.dataset.id, el.dataset.k);
    const c = reviewCache.get(String(el.dataset.id)); if (c) c.reviews = c.reviews.filter((r) => r.uid !== el.dataset.k);
    toast('Review removed', 'shield'); rerenderReviews(el.dataset.id);
  },
  killvid: (el) => openTrailer(el.dataset.id, 'kc'),
  killedit(el) { S.killEdit = el.dataset.id; const m = S.byId.get(el.dataset.id); const w = $('#detail .kill-wrap'); if (w && m) w.innerHTML = killHTML(m, killCache.get(el.dataset.id)); w?.querySelector('input')?.focus(); },
  async killclear(el) { await store.setKill(el.dataset.id, null); toast('Removed your kill count', 'x'); await reloadKills(el.dataset.id); },
  async killverify(el) { await store.verifyKill(el.dataset.id, el.dataset.k === '' ? null : Number(el.dataset.k)); toast(el.dataset.k === '' ? 'Verification removed' : 'Kill count verified', 'check'); await reloadKills(el.dataset.id); },
  psize(el) {
    try { localStorage.setItem('sq-psize', el.dataset.k); } catch { /* ignore */ }
    applyPosterSize();
    document.querySelectorAll('.size-pick [data-act="psize"]').forEach((b) => b.setAttribute('aria-pressed', b.dataset.k === el.dataset.k));
  },
  person(el) {
    // Remember where we came from (page, scroll spot, and the movie that was open) so Back can return there.
    const d = $('#detail');
    const movie = d.open ? d.dataset.id : null;
    S.trail = [...(S.trail || []), { hash: location.hash || '#/', y: window.scrollY, movie, rails: [...document.querySelectorAll('#main .track')].map((t) => t.scrollLeft) }].slice(-20);
    if (d.open) d.close();
    location.hash = `#/person/${el.dataset.k}`;
  },
  goback() { history.back(); },
  closeplayer: () => $('#player').close(),
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
  qsall() { const q = $('#qs')?.value.trim() || ''; Object.assign(S.f, { q, sg: new Set(), tier: new Set(), decade: '', provider: '', mine: false, tom: '', limit: 60 }); location.hash = '#/browse'; },
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
  fclear() { Object.assign(S.f, { q: '', sg: new Set(), tier: new Set(), mine: false, decade: '', provider: '', tom: '', limit: 60 }); route(true); },
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
    await route(true, true);
  });
}

// Re-render a region but keep any card (or hero) whose markup didn't change, so its poster image
// isn't torn down and reloaded. Swapping everything made phones flash after every tap.
// Update a region in place instead of replacing it: elements that didn't change are left alone,
// changed ones get their attributes/text patched, and cards are matched by movie id so a row losing
// one card keeps every other card (and its already-decoded poster). Rebuilding everything made phones flash.
const keyOf = (n) => n.nodeType === 1 ? (n.dataset.key ? 'k:' + n.dataset.key : n.matches('.card[data-id]') ? 'c:' + n.dataset.id : null) : null;
function syncAttrs(o, n) {
  for (const a of [...o.attributes]) if (!n.hasAttribute(a.name)) o.removeAttribute(a.name);
  for (const a of [...n.attributes]) if (o.getAttribute(a.name) !== a.value) o.setAttribute(a.name, a.value);
}
function morphKids(o, n, skip) {
  const olds = [...o.childNodes];
  const keyed = new Map(); const loose = [];
  for (const c of olds) { const k = keyOf(c); if (k && !keyed.has(k)) keyed.set(k, c); else if (!k) loose.push(c); }
  // 1) pair every new child with an old one (by movie id / data-key, else by position and tag)
  const used = new Set();
  const pairs = [...n.childNodes].map((nc) => {
    const k = keyOf(nc);
    let m = k ? keyed.get(k) : loose.find((c) => !used.has(c) && c.nodeType === nc.nodeType && c.nodeName === nc.nodeName);
    if (m && used.has(m)) m = null;
    if (m) used.add(m);
    return [nc, m];
  });
  // 2) drop old children that have no partner, so the survivors don't have to move
  for (const c of olds) if (!used.has(c)) c.remove();
  // 3) walk in order: patch partners in place, insert new ones, only move a node when it's out of order
  let cursor = o.firstChild;
  for (const [nc, m] of pairs) {
    if (m) {
      if (m !== cursor) o.insertBefore(m, cursor); else cursor = cursor.nextSibling;
      const node = morph(m, nc, skip);
      if (node !== m && cursor === m) cursor = node.nextSibling;
    } else o.insertBefore(nc, cursor);
  }
}
function morph(o, n, skip) {
  if (o.nodeType !== n.nodeType || o.nodeName !== n.nodeName) { o.replaceWith(n); return n; }
  if (o.nodeType !== 1) { if (o.nodeValue !== n.nodeValue) o.nodeValue = n.nodeValue; return o; }
  if (o.isEqualNode(n)) return o;
  syncAttrs(o, n);
  if (!(skip && n.id && skip.includes(n.id))) morphKids(o, n, skip); // skipped regions are filled by their own render function
  return o;
}
function setHTML(host, html, skip) {
  const tpl = document.createElement('template'); tpl.innerHTML = html;
  morphKids(host, tpl.content, skip);
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
    // Scroll snapping fights transformed cards (the row jumps), so switch it off while the row closes up.
    const t = c.closest('.track');
    if (t && !t.dataset.flip) { t.dataset.flip = '1'; const keep = t.scrollLeft; t.style.scrollSnapType = 'none'; t.scrollLeft = keep; setTimeout(() => { t.style.scrollSnapType = ''; delete t.dataset.flip; }, 480); }
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
    anims.push(new Promise((res) => setTimeout(res, 140)));
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
$('#player')?.addEventListener('click', (e) => { if (e.target.id === 'player') e.target.close(); });
$('#player')?.addEventListener('close', (e) => { e.target.innerHTML = ''; });
// Phones: drag the details sheet down to dismiss it (like the X). Only starts when the sheet is
// scrolled to the top and the finger moves mostly downward, so normal scrolling still works.
(() => {
  const dlg = $('#detail'); if (!dlg) return;
  let y0 = 0, x0 = 0, dy = 0, t0 = 0, mode = null, sheet = null;
  const phone = () => window.matchMedia('(max-width: 700px)').matches;
  dlg.addEventListener('touchstart', (e) => {
    if (!phone() || e.touches.length !== 1 || e.target.closest('.skulls, input, select, textarea, .wtw-grid')) { mode = 'off'; return; }
    sheet = dlg.querySelector('.sheet');
    y0 = e.touches[0].clientY; x0 = e.touches[0].clientX; dy = 0; t0 = performance.now(); mode = null;
  }, { passive: true });
  dlg.addEventListener('touchmove', (e) => {
    if (mode === 'off' || mode === 'scroll') return;
    const d = e.touches[0].clientY - y0, dx = e.touches[0].clientX - x0;
    if (mode === null) {
      if (Math.abs(d) < 6 && Math.abs(dx) < 6) return;
      mode = d > 0 && Math.abs(d) > Math.abs(dx) && (sheet?.scrollTop || 0) <= 0 ? 'drag' : 'scroll';
      if (mode !== 'drag') return;
      dlg.style.transition = 'none';
    }
    e.preventDefault();
    dy = Math.max(0, d);
    dlg.style.transform = `translateY(${dy}px)`;
    dlg.style.setProperty('--drag', String(Math.min(1, dy / 400)));
  }, { passive: false });
  const end = () => {
    if (mode !== 'drag') { mode = null; return; }
    mode = null;
    const v = dy / Math.max(1, performance.now() - t0); // px per ms
    dlg.style.transition = 'transform .28s cubic-bezier(.2,.8,.2,1)';
    if (dy > 110 || v > 0.6) {
      dlg.style.transform = 'translateY(100%)';
      setTimeout(() => { dlg.close(); dlg.style.transform = ''; dlg.style.transition = ''; dlg.style.removeProperty('--drag'); }, 260);
    } else {
      dlg.style.transform = '';
      dlg.style.removeProperty('--drag');
      setTimeout(() => { dlg.style.transition = ''; }, 300);
    }
  };
  dlg.addEventListener('touchend', end);
  dlg.addEventListener('touchcancel', end);
})();
document.addEventListener('click', (e) => { if (!e.target.closest('.card.qa-on')) document.querySelectorAll('.card.qa-on').forEach((x) => { x.classList.remove('qa-on', 'rating'); x.querySelector('.qa-rate').hidden = true; x.querySelector('.qa-plus')?.setAttribute('aria-expanded', 'false'); }); }, true);

document.addEventListener('change', async (e) => {
  if (e.target.id !== 'av-file' || !e.target.files?.[0]) return;
  try {
    const photo = await squarePhoto(e.target.files[0]);
    await store.setAvatar('up', photo); S.social = { ...S.social, av: 'up', photo };
    toast('Profile picture updated', 'check'); renderChrome(); route(true, true);
  } catch (err) { console.error(err); toast(err?.message || 'Could not use that picture.', 'x'); }
});
let frTimer = 0;
document.addEventListener('input', (e) => {
  const el = e.target;
  if (el.id === 'fr-q') { clearTimeout(frTimer); frTimer = setTimeout(renderFriendSearch, 250); return; }
  if (el.id === 'qs') { renderQuick(); return; }
  if (el.id === 'bc-q') { S.bcq = el.value; if ((S.bcTab || 'watched') !== 'watched') { S.bcTab = 'watched'; const pos = el.selectionStart; route(true, true).then(() => { const i = $('#bc-q'); if (i) { i.focus(); i.setSelectionRange(pos, pos); } }); } else renderBodyList(); return; }
  if (el.id === 'bc-sort') { S.bcSort = el.value; renderBodyList(); return; }
  if (el.id === 'bc-sg') { S.bcSg = el.value; renderBodyList(); return; }
  if (el.id === 'svc-q') { S.svcq = el.value; renderServices(); return; }
  if (el.id === 'ck-q') { S.ckq = el.value; const pos = el.selectionStart; route(true, true).then(() => { const i = $('#ck-q'); if (i) { i.focus(); i.setSelectionRange(pos, pos); } }); return; }
  if (el.dataset.bind && location.hash.startsWith('#/browse')) { S.f[el.dataset.bind] = el.value; S.f.limit = 60; renderResults(); }
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

async function afterFriendChange() {
  renderChrome();
  if (/^#\/(friends|u\/)/.test(location.hash)) await route(true, true); else renderFriendSearch();
}
document.addEventListener('submit', async (e) => {
  if (e.target.classList?.contains('review-form')) {
    e.preventDefault();
    const id = e.target.dataset.id; const fd = new FormData(e.target);
    const text = String(fd.get('text') || '').trim(); if (!text) { toast('Write something first', 'x'); return; }
    try {
      const rating = status(id)?.rating || 0;
      await store.saveReview(id, { text, spoiler: !!fd.get('spoiler'), rating });
      await setStatus(id, { rv: true });
      const c = reviewCache.get(String(id)) || { reviews: [], friendsSeen: [] };
      c.reviews = [...c.reviews.filter((r) => r.uid !== S.user.uid), { uid: S.user.uid, name: S.profile.name || S.user.name, handle: S.social?.handle || '', text, spoiler: !!fd.get('spoiler'), vis: S.social?.privacy?.reviews || 'public', rating, at: Date.now() }];
      reviewCache.set(String(id), c); S.reviewEdit = null; S.reviewOpen = null;
      toast('Review posted', 'check'); rerenderReviews(id);
    } catch (err) { console.error(err); toast('Could not save your review. Try again.', 'x'); }
    return;
  }
  if (e.target.dataset?.form === 'social') {
    e.preventDefault();
    const fd = new FormData(e.target);
    const handle = String(fd.get('handle') || '').trim().replace(/^@/, '').toLowerCase();
    if (handle && !/^[a-z0-9_]{3,20}$/.test(handle)) { toast('Usernames are 3 to 20 letters, numbers or _', 'x'); return; }
    try {
      const reviewed = [...S.mine.entries()].filter(([, st]) => st.rv).map(([id]) => id);
      await store.saveSocial({ handle, name: S.profile.name, privacy: { profile: fd.get('pv'), reviews: fd.get('rv') } }, reviewed);
      S.social = await store.getSocial(); reviewCache.clear();
      toast('Privacy and username saved'); route(true, true);
    } catch (err) { toast(err?.message || 'That did not save.', 'x'); }
    return;
  }
  if (e.target.classList?.contains('kill-form')) {
    e.preventDefault();
    if (!needUser()) return;
    const id = e.target.dataset.id; const n = Math.round(Number(new FormData(e.target).get('n')));
    if (!Number.isFinite(n) || n < 0 || n > 1000) { toast('Enter a number from 0 to 1000', 'x'); return; }
    try { await store.setKill(id, n); toast(`Thanks! Kill count: ${n}`, 'skull'); await reloadKills(id); }
    catch (err) { console.error(err); toast('Could not save that. Try again.', 'x'); }
    return;
  }
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
      if (store.saveSocial && S.social) store.saveSocial({ name: patch.name }).catch(() => {});
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
const NAV = [['#/', 'Tonight', 'home'], ['#/browse', 'Browse', 'grid'], ['#/pick', 'Pick for Me', 'dice'], ['#/queue', 'My Queue', 'bookmark'], ['#/bodycount', 'Body Count', 'skull'], ['#/friends', 'Friends', 'users'], ['#/nights', 'Movie Nights', 'clock']];
const TABS = ['#/', '#/browse', '#/pick', '#/queue', '#/bodycount'];
function renderChrome() {
  const here = '#/' + (location.hash.replace(/^#\/?/, '').split('/')[0] || '');
  const cur = (h) => (h === here || (h === '#/nights' && here === '#/night') || (h === '#/bodycount' && (here === '#/checklist' || here === '#/trophies')) ? 'aria-current="page"' : '');
  const nReqs = S.requests?.incoming.length || 0;
  $('#nav').innerHTML = NAV.map(([h, l]) => `<a href="${h}" ${cur(h)}>${l}${h === '#/friends' && nReqs ? `<b class="nav-n">${nReqs}</b>` : ''}</a>`).join('');
  $('#tabbar').innerHTML = NAV.filter(([h]) => TABS.includes(h)).map(([h, l, ic]) => `<a href="${h}" ${cur(h)}>${icon(ic)}<span>${l.replace('Movie Nights', 'Nights').replace('My Queue', 'Queue').replace('Pick for Me', 'Pick')}</span></a>`).join('');
  const name = S.profile.name || S.user?.name || '';
  const av = (cls = '') => renderAvatar(name, myCard(), cls);
  const nReq = S.requests?.incoming.length || 0;
  $('#who').innerHTML = S.user
    ? `<a class="icon-btn m-friends" href="#/friends" aria-label="Friends${nReq ? `, ${nReq} new request${nReq === 1 ? '' : 's'}` : ''}">${icon('users')}${nReq ? `<b class="nav-n">${nReq}</b>` : ''}</a><div class="acct"><button class="acct-btn" data-act="acct" aria-haspopup="menu" aria-expanded="${!!S.menuOpen}" aria-label="Your account">${av()}${S.requests?.incoming.length ? '<i class="acct-dot" aria-label="New friend request"></i>' : ''}<span class="acct-name">${esc(name)}</span>${icon('down', 'caret')}</button>
      <div class="acct-menu" role="menu" ${S.menuOpen ? '' : 'hidden'}>
        <div class="acct-head">${av('lg')}<span><b>${esc(name)}</b><small>${esc(S.user.email || '')}</small></span></div>
        <a role="menuitem" href="#/profile">${icon('gear')}Profile</a>
        <a role="menuitem" href="#/profile/services">${icon('tv')}Streaming services<small>${serviceGroups().filter(groupOn).length || 'None yet'}</small></a>
        <a role="menuitem" href="#/bodycount">${icon('skull')}Body Count<small>${seenList().length}</small></a>
        <a role="menuitem" href="#/friends">${icon('users')}Friends${S.requests?.incoming.length ? `<small class="pill-n">${S.requests.incoming.length}</small>` : `<small>${(S.friends || []).length || ''}</small>`}</a>
        <a role="menuitem" class="m-only-item" href="#/nights">${icon('users')}Movie Nights</a>
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

// Every render gets a number; a slower, older render that finishes late is thrown away
// instead of painting over a newer one.
let routeGen = 0;
async function route(keepScroll, quiet) {
  const gen = ++routeGen;
  if (S.stopNight) { S.stopNight(); S.stopNight = null; }
  if (!quiet && !keepScroll && $('#detail')?.open) $('#detail').close();
  const [name, arg] = location.hash.replace(/^#\/?/, '').split('/');
  S.menuOpen = false;
  const view = views[{ trophies: 'bodycount' }[name] || name || 'tonight'] || views.tonight;
  renderChrome();
  const y = window.scrollY;
  const html = await view(arg);
  if (gen !== routeGen) return;
  const after = S.after; S.after = null;
  const rails = keepScroll ? [...document.querySelectorAll('#main .track')].map((t) => t.scrollLeft) : [];
  const swap = () => {
    if (gen !== routeGen) return;
    $('#main').classList.toggle('quiet', !!quiet);
    if (quiet) setHTML($('#main'), html, ['results', 'bc-results']); else $('#main').innerHTML = html;
    after?.();
    if (!quiet && rails.length) document.querySelectorAll('#main .track').forEach((t, i) => { if (rails[i]) t.scrollLeft = rails[i]; });
    window.scrollTo(0, keepScroll ? y : 0); updateRails();
  };
  if (!quiet && document.startViewTransition && !reduceMotion() && !window.matchMedia('(hover: none)').matches) { const vt = document.startViewTransition(swap); vt.ready.catch(() => {}); vt.finished.catch(() => {}); await vt.updateCallbackDone.catch(() => {}); }
  else swap();
  if (S.restore) {
    const r = S.restore; S.restore = null;
    requestAnimationFrame(() => { document.querySelectorAll('#main .track').forEach((t, i) => { if (r.rails?.[i]) t.scrollLeft = r.rails[i]; }); updateRails(); window.scrollTo(0, r.y); if (r.movie) openDetail(r.movie); });
  }
  document.title = `${SITE_NAME}${name ? ' · ' + ({ browse: 'Browse', pick: 'Pick for Me', queue: 'My Queue', nights: 'Movie Nights', night: 'Movie Night', settings: 'Settings', admin: 'Admin', signin: 'Sign In', about: 'How It Works', trophies: 'Body Count', bodycount: 'Body Count', profile: 'Profile', checklist: 'Checklist', person: 'Cast', friends: 'Friends', u: 'Profile' }[name] || '') : ''}`;
}

async function boot() {
  applyPosterSize();
  try { const t = localStorage.getItem('sq-theme'); if (t && t !== 'system') document.documentElement.setAttribute('data-theme', t); } catch { /* ignore */ }
  $('#version').textContent = 'v' + VERSION;
  if (/^#\/settings/.test(location.hash)) history.replaceState(null, '', '#/profile');
  $('#brand').textContent = SITE_NAME;
  $('#mark').innerHTML = '<img src="icons/logo-96.png" alt="" width="48" height="48">';
  [S.config] = await Promise.all([store.getConfig(), loadData()]);
  applyConfig();
  let first = true;
  store.init(async (u) => {
    S.user = u;
    await loadMine();
    loadSocial().then(() => { renderChrome(); if (/^#\/(profile|friends)/.test(location.hash)) route(true, true); }).catch(() => {});
    if (u && location.hash === '#/signin') { location.hash = S.afterSignIn || '#/'; }
    else await route(!first, !first);
    first = false;
  });
  window.addEventListener('hashchange', () => {
    // Coming back from a person page (our Back button, the browser's, or a swipe): restore the spot and reopen the movie.
    const top = S.trail?.[S.trail.length - 1];
    if (top && (location.hash || '#/') === top.hash) { S.trail.pop(); S.restore = top; }
    else if (!location.hash.startsWith('#/person/')) S.trail = [];
    route();
  });
  window.addEventListener('keydown', (e) => { if (e.key === '/' && !/input|textarea|select/i.test(document.activeElement?.tagName || '')) { const q = $('#f-q'); if (q) { e.preventDefault(); q.focus(); } } });
  if ('serviceWorker' in navigator && location.protocol === 'https:' && !globalThis.SQ_STORE) {
    navigator.serviceWorker.register('sw.js?v=' + VERSION).then((r) => r.update()).catch(() => {});
    let reloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => { if (!reloaded && navigator.serviceWorker.controller) { reloaded = true; } });
  }
}
boot().catch((e) => { console.error(e); $('#main').innerHTML = `<div class="empty">The movie shelf could not load (${esc(e.message)}). Refresh to try again.</div>`; });
