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

  async getProfile() { return structuredClone(load().profile); },
  async saveProfile(patch) { Object.assign(load().profile, patch); save(); emitUser(); },

  async loadMyMovies() { return new Map(Object.entries(load().movies)); },
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

  async getConfig() { return structuredClone(load().config); },
  async saveConfig(patch) { Object.assign(load().config, patch); save(); },
  async adminStats() { return { users: 1 }; },
  resetDemo() { mem = null; try { localStorage.removeItem(KEY); } catch { /* ignore */ } load(); emitUser(); },
};
