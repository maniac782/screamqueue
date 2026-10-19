// Demo store: same interface as store-firebase.js, saved in this browser only.
const KEY = 'screamqueue-demo-v1';
let mem = null;

function load() {
  if (mem) return mem;
  try { mem = JSON.parse(localStorage.getItem(KEY)) || null; } catch { mem = null; }
  if (!mem) {
    mem = {
      signedIn: true,
      profile: { name: 'Demo Viewer', services: [99, 8, 1899], hideSeen: false },
      movies: {
        '493922': { status: 'seen', rating: 5, at: Date.now() - 86400000 * 9 },
        '1078605': { status: 'queue', at: Date.now() - 86400000 },
        '270303': { status: 'queue', at: Date.now() - 86400000 * 2 },
        '1059064': { status: 'queue', at: Date.now() - 86400000 * 3 },
      },
      nights: {
        demo1: {
          id: 'demo1', title: 'Friday Fright Night', date: '', owner: 'demo', status: 'open', winner: null,
          members: ['demo', 'pal1', 'pal2'],
          memberNames: { demo: 'Demo Viewer', pal1: 'Sample friend A', pal2: 'Sample friend B' },
          candidates: { '1078605': { by: 'demo' }, '1008042': { by: 'pal1' }, '17577': { by: 'pal2' } },
          votes: { pal1: ['1008042', '1078605'], pal2: ['17577', '1008042'], demo: [] },
          createdAt: Date.now(),
        },
      },
      config: { showPosters: false, featured: [], hidden: [], sgFix: {}, announcement: '' },
    };
  }
  return mem;
}
function save() { try { localStorage.setItem(KEY, JSON.stringify(mem)); } catch { /* storage unavailable */ } }

const DAY = 86400000;

// Demo VS: one open matchup and an 8-movie bracket in round 2, with made-up votes from other fans.
function vsAll() {
  const m = load();
  if (!m.vs) {
    const now = Date.now();
    m.vs = {
      vs1: { id: 'vs1', title: 'Which one scared you more?', cat: 'movies', size: 2, rounds: 1, start: now - DAY / 3, dur: DAY, entries: [{ l: 'The Exorcist', m: 9552 }, { l: 'Hereditary', m: 493922 }] },
      vs2: { id: 'vs2', title: 'Slasher showdown', cat: 'killers', size: 8, rounds: 3, start: now - DAY * 1.4, dur: DAY,
        entries: [{ l: 'Michael Myers', m: 948 }, { l: 'Ghostface', m: 4232 }, { l: 'Freddy Krueger', m: 377 }, { l: 'Jason Voorhees', m: 4488 }, { l: 'Leatherface', m: 30497 }, { l: 'Chucky', m: 10585 }, { l: 'Candyman', m: 9529 }, { l: 'Art the Clown', m: 420634 }] },
      vs3: { id: 'vs3', title: 'Best final girl movie', cat: 'final girls', size: 2, rounds: 1, start: now - DAY * 5, dur: DAY, entries: [{ l: 'Laurie Strode', m: 948 }, { l: 'Sidney Prescott', m: 4232 }] },
    };
    m.vsVotes = {};
    save();
  }
  return m;
}
const fakeTally = (id, mk) => { let h = 0; for (const c of id + mk) h = (h * 31 + c.charCodeAt(0)) >>> 0; return { a: 20 + (h % 60), b: 20 + ((h >> 8) % 60) }; };
const DEMO_PEOPLE = {
  pal1: { name: 'Sample friend A', handle: 'finalgirl', av: 'pd:orlok', privacy: { profile: 'friends', reviews: 'public' }, movies: {
    '493922': { status: 'seen', rating: 4.5, seenOn: '2026-10-01', at: Date.now() - DAY * 2, rv: true },
    '1078605': { status: 'seen', rating: 3, seenOn: '2026-10-10', at: Date.now() - DAY },
    '17577': { status: 'queue', at: Date.now() - DAY * 3 },
    '948': { status: 'seen', rating: 5, seenOn: '2026-09-20', at: Date.now() - DAY * 6 } } },
  pal2: { name: 'Sample friend B', handle: 'ghostface_fan', av: 'ic:ghost', privacy: { profile: 'public', reviews: 'public' }, movies: {
    '493922': { status: 'seen', rating: 3.5, seenOn: '2026-08-12', at: Date.now() - DAY * 9, rv: true },
    '4232': { status: 'seen', rating: 5, seenOn: '2026-10-14', at: Date.now() - DAY * 4 },
    '1008042': { status: 'queue', at: Date.now() - DAY * 5 } } },
  pal3: { name: 'Sample stranger', handle: 'creepshow', privacy: { profile: 'private', reviews: 'friends' }, movies: {} },
};
function social() {
  const m = load();
  m.social ||= { handle: (m.profile?.name || 'fan').toLowerCase().replace(/[^a-z0-9_]+/g, '').slice(0, 16) || 'fan', privacy: { profile: 'friends', reviews: 'public' }, friends: ['pal1', 'pal2'], incoming: ['pal3'], outgoing: [] };
  return m.social;
}
function reviews() {
  const m = load();
  m.reviews ||= {
    '493922|pal1': { uid: 'pal1', name: 'Sample friend A', handle: 'finalgirl', text: 'The dinner scene still haunts me. Toni Collette deserved every award.', spoiler: false, vis: 'public', rating: 4.5, at: Date.now() - DAY * 2 },
    '493922|pal2': { uid: 'pal2', name: 'Sample friend B', handle: 'ghostface_fan', text: 'That ending on the treehouse is wild once you know who Paimon is.', spoiler: true, vis: 'public', rating: 3.5, at: Date.now() - DAY * 9 },
  };
  return m.reviews;
}

const listeners = new Set();
const nightWatchers = new Map();
const user = () => (load().signedIn ? { uid: 'demo', name: load().profile.name, email: 'demo@example.com', isAdmin: true } : null);
function emitUser() { for (const fn of listeners) fn(user()); }
function emitNight(id) { for (const fn of nightWatchers.get(id) || []) fn(structuredClone(load().nights[id] || null)); }

export const store = {
  demo: true,
  init(onUser) { listeners.add(onUser); onUser(user()); },
  async signInGoogle() { load().signedIn = true; save(); emitUser(); },
  async signInEmail() { load().signedIn = true; save(); emitUser(); },
  async signUpEmail(name) { const s = load(); s.signedIn = true; if (name) s.profile.name = name; save(); emitUser(); },
  async resetPassword() {},
  async signOut() { load().signedIn = false; save(); emitUser(); },

  async getProfile() { return { setup: true, notify: { friends: true, streaming: true }, ...structuredClone(load().profile) }; },
  async handleFree(h) { return !['finalgirl', 'ghostface_fan', 'creepshow', 'midnightmovies'].includes(h); },
  async saveProfile(patch) { Object.assign(load().profile, patch); save(); emitUser(); },

  async loadMyMovies() { return new Map(Object.entries(load().movies)); },
  async importMovies(entries) { for (const [id, data] of entries) load().movies[String(id)] = { ...data, at: Date.now() }; save(); },
  async setMovie(id, data) { load().movies[String(id)] = { ...data, at: Date.now() }; save(); },
  async removeMovie(id) { delete load().movies[String(id)]; save(); },

  async listNights() { return Object.values(load().nights).map((n) => structuredClone(n)); },
  watchNight(id, cb) {
    if (!nightWatchers.has(id)) nightWatchers.set(id, new Set());
    nightWatchers.get(id).add(cb);
    cb(structuredClone(load().nights[id] || null));
    return () => nightWatchers.get(id)?.delete(cb);
  },
  async createNight(title, date) {
    const id = 'n' + Math.random().toString(36).slice(2, 10);
    load().nights[id] = { id, title, date, owner: 'demo', status: 'open', winner: null, members: ['demo'], memberNames: { demo: load().profile.name }, candidates: {}, votes: {}, createdAt: Date.now() };
    save(); return id;
  },
  async joinNight(id) { const n = load().nights[id]; if (n && !n.members.includes('demo')) { n.members.push('demo'); n.memberNames.demo = load().profile.name; save(); emitNight(id); } },
  async suggest(id, movieId) { const n = load().nights[id]; n.candidates[String(movieId)] = { by: 'demo' }; save(); emitNight(id); },
  async unsuggest(id, movieId) { const n = load().nights[id]; delete n.candidates[String(movieId)]; for (const k in n.votes) n.votes[k] = n.votes[k].filter((x) => x !== String(movieId)); save(); emitNight(id); },
  async vote(id, movieIds) { load().nights[id].votes.demo = movieIds.map(String); save(); emitNight(id); },
  async decide(id, winner) { const n = load().nights[id]; n.status = winner ? 'decided' : 'open'; n.winner = winner ? String(winner) : null; save(); emitNight(id); },
  async deleteNight(id) { delete load().nights[id]; save(); },

  // ---------- social (demo): two sample friends and one pending request ----------
  me() { return user(); },
  async getSocial() { const so = social(); return { handle: so.handle, av: so.av || '', photo: so.photo || '', privacy: { ...so.privacy } }; },
  async setAvatar(av, photo = '') { const so = social(); so.av = av; so.photo = av === 'up' ? photo : ''; save(); },
  async saveSocial({ handle, privacy }) {
    const so = social();
    if (handle && Object.values(DEMO_PEOPLE).some((p) => p.handle === handle)) throw new Error(`@${handle} is taken. Try another.`);
    if (handle) so.handle = handle; if (privacy) Object.assign(so.privacy, privacy); save();
  },
  async findUser(q) { q = String(q || '').replace(/^@/, '').toLowerCase(); return Object.entries(DEMO_PEOPLE).filter(([, p]) => p.handle.startsWith(q) || p.name.toLowerCase().split(/\s+/).some((w) => w.startsWith(q)) || p.name.toLowerCase().startsWith(q)).map(([uid, p]) => ({ uid, name: p.name, handle: p.handle, privacy: p.privacy })); },
  async listPublic() { const me = social().privacy.profile === 'public' ? [{ uid: 'demo', name: load().profile.name, handle: social().handle, av: social().av, photo: social().photo }] : []; return [...me, ...Object.entries(DEMO_PEOPLE).filter(([, p]) => p.privacy.profile === 'public').map(([uid, p]) => ({ uid, ...p })), { uid: 'pal4', name: 'Sample public fan', handle: 'midnightmovies', av: 'og:hockeymask', privacy: { profile: 'public' } }]; },
  async getProfileCard(id) { const e = Object.entries(DEMO_PEOPLE).find(([uid, p]) => uid === id || p.handle === id); if (e) return { uid: e[0], ...e[1] }; if (id === 'demo' || id === social().handle) return { uid: 'demo', name: load().profile.name, handle: social().handle, privacy: social().privacy, av: social().av, photo: social().photo }; return null; },
  async friendState(o) { const so = social(); return so.friends.includes(o) ? 'friends' : so.incoming.includes(o) ? 'incoming' : so.outgoing.includes(o) ? 'outgoing' : 'none'; },
  async sendRequest(o) { const so = social(); if (!so.outgoing.includes(o)) so.outgoing.push(o); save(); },
  async listRequests() { const so = social(); const card = (u) => ({ uid: u, name: DEMO_PEOPLE[u]?.name, handle: DEMO_PEOPLE[u]?.handle }); return { incoming: so.incoming.map(card), outgoing: so.outgoing.map(card) }; },
  async acceptRequest(f) { const so = social(); so.incoming = so.incoming.filter((x) => x !== f); if (!so.friends.includes(f)) so.friends.push(f); save(); },
  async declineRequest(f) { const so = social(); so.incoming = so.incoming.filter((x) => x !== f); save(); },
  async cancelRequest(t) { const so = social(); so.outgoing = so.outgoing.filter((x) => x !== t); save(); },
  async unfriend(o) { const so = social(); so.friends = so.friends.filter((x) => x !== o); save(); },
  async listFriends() { return social().friends.map((u) => ({ uid: u, name: DEMO_PEOPLE[u]?.name, handle: DEMO_PEOPLE[u]?.handle })); },
  async moviesOf(o) {
    if (o === 'demo') return new Map(Object.entries(load().movies));
    const p = DEMO_PEOPLE[o]; if (!p || (p.privacy.profile !== 'public' && !(p.privacy.profile === 'friends' && social().friends.includes(o)))) throw new Error('Private');
    return new Map(Object.entries(p.movies));
  },
  async movieOf(o, id) { try { return (await this.moviesOf(o)).get(String(id)) || null; } catch { return null; } },
  async recentOf(o, n = 12) { return [...(await this.moviesOf(o)).entries()].map(([id, x]) => ({ id, ...x })).sort((a, b) => b.at - a.at).slice(0, n); },
  async getReview(id, who = 'demo') { return reviews()[`${id}|${who}`] || null; },
  async listReviews(id) { return Object.entries(reviews()).filter(([k]) => k.startsWith(`${id}|`)).map(([, r]) => r); },
  async saveReview(id, { text, spoiler, rating }) { reviews()[`${id}|demo`] = { uid: 'demo', name: load().profile.name, handle: social().handle, text, spoiler: !!spoiler, vis: social().privacy.reviews, rating: rating || 0, at: Date.now() }; save(); },
  async deleteReview(id, who = 'demo') { delete reviews()[`${id}|${who}`]; save(); },

  async getKills(id) {
    const k = (load().kills ||= {})[id] || { votes: { pal1: 13, pal2: 12 }, verified: null };
    return { votes: Object.values(k.votes), mine: k.votes.demo ?? null, verified: k.verified };
  },
  async setKill(id, n) {
    const all = (load().kills ||= {}); const k = all[id] ||= { votes: { pal1: 13, pal2: 12 }, verified: null };
    if (n == null) delete k.votes.demo; else k.votes.demo = n; save();
  },
  async verifyKill(id, n) { const all = (load().kills ||= {}); (all[id] ||= { votes: {}, verified: null }).verified = n; save(); },

  async getConfig() { return structuredClone(load().config); },
  async saveConfig(patch) { Object.assign(load().config, patch); save(); },
  async adminStats() { return { users: 1 }; },
  async listVs() { return Object.values(vsAll().vs).sort((a, b) => b.start - a.start).map((x) => structuredClone(x)); },
  async getVs(id) { const x = vsAll().vs[id]; return x ? structuredClone(x) : null; },
  async createVs(data) { const id = 'vs' + Date.now(); vsAll().vs[id] = { id, ...data, at: Date.now() }; save(); return id; },
  async deleteVs(id) { delete vsAll().vs[id]; save(); },
  async tallyVs(id, mk) { const t = fakeTally(id, mk); const mine = vsAll().vsVotes[`${id}|${mk}`]; if (mine) t[mine]++; return t; },
  async myVotesVs(id, mks) { const v = vsAll().vsVotes; return Object.fromEntries(mks.filter((mk) => v[`${id}|${mk}`]).map((mk) => [mk, v[`${id}|${mk}`]])); },
  async voteVs(id, mk, r, pick) { vsAll().vsVotes[`${id}|${mk}`] = pick; save(); },
  async adminUsers() {
    const me = load(), sc = social(), mine = Object.values(me.movies || {});
    const out = [{ uid: 'demo', name: me.profile.name, handle: sc.handle, av: sc.av || '', photo: sc.photo || '', privacy: sc.privacy.profile, created: Date.now() - DAY * 20, lastSeen: Date.now(), services: me.profile.services.length, admin: true,
      seen: mine.filter((x) => x.status === 'seen').length, queued: mine.filter((x) => x.status === 'queue').length, friends: (me.friends || ['pal1', 'pal2']).length }];
    Object.entries(DEMO_PEOPLE).forEach(([uid, p], i) => { const mv = Object.values(p.movies); out.push({ uid, name: p.name, handle: p.handle, av: p.av || '', photo: '', privacy: p.privacy.profile, created: Date.now() - DAY * (3 + i * 9), lastSeen: Date.now() - DAY * (i * 4 + 0.3), services: 2 + i, admin: false, seen: mv.filter((x) => x.status === 'seen').length, queued: mv.filter((x) => x.status === 'queue').length, friends: i < 2 ? 1 : 0 }); });
    return out;
  },
  async adminRemovePhoto() {},
  async sendFeedback(d) { (load().feedback ||= []).unshift({ id: 'f' + Date.now(), ...d, uid: 'demo', t: Date.now() }); save(); },
  async sendContact(d) { (load().contact ||= []).unshift({ id: 'c' + Date.now(), ...d, t: Date.now() }); save(); },
  async listInbox(kind) { return structuredClone(load()[kind] || []); },
  async clearInbox(kind, id) { load()[kind] = (load()[kind] || []).filter((x) => x.id !== id); save(); },
  signInMethod() { return 'password'; },
  async deleteAccount(password, progress = () => {}) { progress('Removing everything…'); await new Promise((r) => setTimeout(r, 400)); this.resetDemo(); },
  resetDemo() { mem = null; try { localStorage.removeItem(KEY); } catch { /* ignore */ } load(); emitUser(); },
};
