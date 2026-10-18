// Firebase store: Google + email sign-in, Firestore for profiles, queues, movie nights and site settings.
import { firebaseConfig } from './config.js';

const V = '10.14.1';
const { initializeApp } = await import(`https://www.gstatic.com/firebasejs/${V}/firebase-app.js`);
const A = await import(`https://www.gstatic.com/firebasejs/${V}/firebase-auth.js`);
const F = await import(`https://www.gstatic.com/firebasejs/${V}/firebase-firestore.js`);

const app = initializeApp(firebaseConfig);
const auth = A.getAuth(app);
const db = F.initializeFirestore(app, { localCache: F.persistentLocalCache() });

let current = null;
const uid = () => auth.currentUser?.uid;
const userDoc = () => F.doc(db, 'users', uid());

export const store = {
  demo: false,

  init(onUser) {
    A.onAuthStateChanged(auth, async (u) => {
      if (!u) { current = null; onUser(null); return; }
      let isAdmin = false;
      try { isAdmin = (await F.getDoc(F.doc(db, 'admins', u.uid))).exists(); } catch { /* not admin */ }
      const ref = F.doc(db, 'users', u.uid);
      const snap = await F.getDoc(ref);
      const name = snap.data()?.name || u.displayName || (u.email || 'Viewer').split('@')[0];
      if (!snap.exists()) await F.setDoc(ref, { name, services: [], hideSeen: false, createdAt: F.serverTimestamp(), lastSeen: F.serverTimestamp() });
      else F.updateDoc(ref, { lastSeen: F.serverTimestamp() }).catch(() => {});
      current = { uid: u.uid, name, email: u.email, isAdmin };
      onUser(current);
    });
  },
  async signInGoogle() { await A.signInWithPopup(auth, new A.GoogleAuthProvider()); },
  async signInEmail(email, password) { await A.signInWithEmailAndPassword(auth, email, password); },
  async signUpEmail(name, email, password) {
    const cred = await A.createUserWithEmailAndPassword(auth, email, password);
    if (name) await A.updateProfile(cred.user, { displayName: name });
  },
  async resetPassword(email) { await A.sendPasswordResetEmail(auth, email); },
  async signOut() { await A.signOut(auth); },

  async getProfile() { const d = (await F.getDoc(userDoc())).data() || {}; return { name: d.name || current?.name || '', services: d.services || [], hideSeen: !!d.hideSeen }; },
  async saveProfile(patch) {
    await F.updateDoc(userDoc(), patch);
    if (patch.name && current) current.name = patch.name;
  },

  async loadMyMovies() {
    const snap = await F.getDocs(F.collection(db, 'users', uid(), 'movies'));
    return new Map(snap.docs.map((d) => [d.id, d.data()]));
  },
  async setMovie(id, data) { await F.setDoc(F.doc(db, 'users', uid(), 'movies', String(id)), { ...data, at: Date.now() }); },
  async removeMovie(id) { await F.deleteDoc(F.doc(db, 'users', uid(), 'movies', String(id))); },

  async listNights() {
    const q = F.query(F.collection(db, 'nights'), F.where('members', 'array-contains', uid()));
    return (await F.getDocs(q)).docs.map((d) => ({ id: d.id, ...d.data() }));
  },
  watchNight(id, cb) {
    return F.onSnapshot(F.doc(db, 'nights', id), (s) => cb(s.exists() ? { id: s.id, ...s.data() } : null), () => cb(null));
  },
  async createNight(title, date) {
    const ref = await F.addDoc(F.collection(db, 'nights'), {
      title, date: date || '', owner: uid(), status: 'open', winner: null,
      members: [uid()], memberNames: { [uid()]: current?.name || 'Host' }, candidates: {}, votes: {}, createdAt: Date.now(),
    });
    return ref.id;
  },
  async joinNight(id) {
    await F.updateDoc(F.doc(db, 'nights', id), { members: F.arrayUnion(uid()), [`memberNames.${uid()}`]: current?.name || 'Guest' });
  },
  async suggest(id, movieId) { await F.updateDoc(F.doc(db, 'nights', id), { [`candidates.${movieId}`]: { by: uid() } }); },
  async unsuggest(id, movieId) {
    // Owner only (rules): removes the movie and any votes for it.
    const ref = F.doc(db, 'nights', id);
    await F.runTransaction(db, async (tx) => {
      const n = (await tx.get(ref)).data();
      const votes = {};
      for (const [k, v] of Object.entries(n.votes || {})) votes[k] = v.filter((x) => x !== String(movieId));
      tx.update(ref, { [`candidates.${movieId}`]: F.deleteField(), votes });
    });
  },
  async vote(id, movieIds) { await F.updateDoc(F.doc(db, 'nights', id), { [`votes.${uid()}`]: movieIds.map(String) }); },
  async decide(id, winner) { await F.updateDoc(F.doc(db, 'nights', id), { status: winner ? 'decided' : 'open', winner: winner ? String(winner) : null }); },
  async deleteNight(id) { await F.deleteDoc(F.doc(db, 'nights', id)); },

  // ---------- social: usernames, privacy, friends, reviews ----------
  // profiles/{uid}       public card: name, handle, privacy { profile: public|friends|private, reviews: public|friends }
  // usernames/{handle}   { uid }  (claims a unique @handle)
  // requests/{to}/from/{from}, sent/{from}/to/{to}   friend requests
  // friends/{uid}/list/{friendUid}                    { name, handle, since }
  // reviews/{movieId}/by/{uid}                        { uid, name, handle, text, spoiler, vis, rating, at }
  me() { return current; },
  async getSocial() {
    const snap = await F.getDoc(F.doc(db, 'profiles', uid())).catch(() => null);
    let d = snap?.data();
    // Everyone gets a profile card on first visit so friends can find them, with a username taken from
    // their display name (dani, dani2, ...) until they pick their own.
    if (snap && (!snap.exists() || !d?.handle)) {
      const nm = d?.name || current?.name || '';
      const handle = await this.claimDefaultHandle(nm).catch(() => '');
      d = { name: nm, nameLower: nm.toLowerCase(), handle, privacy: { profile: 'friends', reviews: 'public', ...(d?.privacy || {}) }, at: Date.now() };
      await F.setDoc(F.doc(db, 'profiles', uid()), d).catch((e) => console.warn('profile card', e));
    } else if (d && d.name !== current?.name && current?.name) {
      F.updateDoc(F.doc(db, 'profiles', uid()), { name: current.name, nameLower: current.name.toLowerCase() }).catch(() => {});
    }
    return { handle: d?.handle || '', privacy: { profile: 'friends', reviews: 'public', ...(d?.privacy || {}) } };
  },
  async claimDefaultHandle(name) {
    let base = String(name || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9_]+/g, '').slice(0, 16);
    if (base.length < 3) base = (base + 'fan').slice(0, 16);
    for (let i = 0; i < 12; i++) {
      const h = i === 0 ? base : `${base}${i < 9 ? i + 1 : Math.floor(Math.random() * 9000 + 1000)}`;
      const ref = F.doc(db, 'usernames', h);
      const ok = await F.runTransaction(db, async (tx) => { const s = await tx.get(ref); if (s.exists()) return s.data().uid === uid(); tx.set(ref, { uid: uid() }); return true; }).catch(() => false);
      if (ok) return h;
    }
    return '';
  },
  async saveSocial({ handle, privacy, name }, reviewedIds = []) {
    const prev = await this.getSocial();
    const h = (handle || '').toLowerCase();
    const batch = F.writeBatch(db);
    if (h && h !== prev.handle) {
      const taken = await F.getDoc(F.doc(db, 'usernames', h));
      if (taken.exists() && taken.data().uid !== uid()) throw new Error(`@${h} is taken. Try another.`);
      batch.set(F.doc(db, 'usernames', h), { uid: uid() });
      if (prev.handle) batch.delete(F.doc(db, 'usernames', prev.handle));
    }
    const nm = name || current?.name || '';
    batch.set(F.doc(db, 'profiles', uid()), { name: nm, nameLower: nm.toLowerCase(), handle: h || prev.handle || '', privacy: { ...prev.privacy, ...(privacy || {}) }, at: Date.now() });
    await batch.commit();
    if (privacy?.reviews && privacy.reviews !== prev.privacy.reviews) {
      // keep existing reviews in step with the new setting
      await Promise.all(reviewedIds.map((mid) => F.updateDoc(F.doc(db, 'reviews', String(mid), 'by', uid()), { vis: privacy.reviews }).catch(() => {})));
    }
  },
  // Look people up by @username or by the start of their name.
  async findUser(q) {
    q = String(q || '').trim().replace(/^@/, '').toLowerCase(); if (q.length < 2) return [];
    const by = (field) => F.getDocs(F.query(F.collection(db, 'profiles'), F.orderBy(field), F.startAt(q), F.endAt(q + '\uf8ff'), F.limit(8))).catch((e) => { console.warn('findUser', field, e); return null; });
    const [a, b] = await Promise.all([by('handle'), by('nameLower')]);
    const out = new Map();
    for (const snap of [a, b]) for (const d of snap?.docs || []) if (d.id !== uid()) out.set(d.id, { uid: d.id, ...d.data() });
    return [...out.values()];
  },
  async getProfileCard(idOrHandle) {
    let id = idOrHandle;
    if (!/^[A-Za-z0-9]{20,}$/.test(id)) { const u = await F.getDoc(F.doc(db, 'usernames', String(id).toLowerCase())); if (!u.exists()) return null; id = u.data().uid; }
    const d = await F.getDoc(F.doc(db, 'profiles', id));
    return d.exists() ? { uid: id, ...d.data() } : null;
  },
  async friendState(other) {
    const [f, inc, out] = await Promise.all([
      F.getDoc(F.doc(db, 'friends', uid(), 'list', other)), F.getDoc(F.doc(db, 'requests', uid(), 'from', other)), F.getDoc(F.doc(db, 'sent', uid(), 'to', other)),
    ]);
    return f.exists() ? 'friends' : inc.exists() ? 'incoming' : out.exists() ? 'outgoing' : 'none';
  },
  async sendRequest(other, card) {
    const mine = await this.getSocial();
    const b = F.writeBatch(db);
    b.set(F.doc(db, 'requests', other, 'from', uid()), { name: current?.name || '', handle: mine.handle || '', at: Date.now() });
    b.set(F.doc(db, 'sent', uid(), 'to', other), { name: card?.name || '', handle: card?.handle || '', at: Date.now() });
    await b.commit();
  },
  async listRequests() {
    const [inc, out] = await Promise.all([F.getDocs(F.collection(db, 'requests', uid(), 'from')), F.getDocs(F.collection(db, 'sent', uid(), 'to'))]);
    return { incoming: inc.docs.map((d) => ({ uid: d.id, ...d.data() })), outgoing: out.docs.map((d) => ({ uid: d.id, ...d.data() })) };
  },
  async acceptRequest(from) {
    const req = (await F.getDoc(F.doc(db, 'requests', uid(), 'from', from))).data() || {};
    const mine = await this.getSocial();
    const b = F.writeBatch(db);
    b.set(F.doc(db, 'friends', uid(), 'list', from), { name: req.name || '', handle: req.handle || '', since: Date.now() });
    b.set(F.doc(db, 'friends', from, 'list', uid()), { name: current?.name || '', handle: mine.handle || '', since: Date.now() });
    b.delete(F.doc(db, 'requests', uid(), 'from', from));
    b.delete(F.doc(db, 'sent', from, 'to', uid()));
    await b.commit();
  },
  async declineRequest(from) {
    const b = F.writeBatch(db);
    b.delete(F.doc(db, 'requests', uid(), 'from', from)); b.delete(F.doc(db, 'sent', from, 'to', uid()));
    await b.commit();
  },
  async cancelRequest(to) {
    const b = F.writeBatch(db);
    b.delete(F.doc(db, 'requests', to, 'from', uid())); b.delete(F.doc(db, 'sent', uid(), 'to', to));
    await b.commit();
  },
  async unfriend(other) {
    const b = F.writeBatch(db);
    b.delete(F.doc(db, 'friends', uid(), 'list', other)); b.delete(F.doc(db, 'friends', other, 'list', uid()));
    await b.commit();
  },
  async listFriends() {
    const snap = await F.getDocs(F.collection(db, 'friends', uid(), 'list'));
    return snap.docs.map((d) => ({ uid: d.id, ...d.data() }));
  },
  // Someone else's watch list (allowed by the rules when their profile is public, or friends-only and you're friends).
  async moviesOf(other) {
    const snap = await F.getDocs(F.collection(db, 'users', other, 'movies'));
    return new Map(snap.docs.map((d) => [d.id, d.data()]));
  },
  async movieOf(other, movieId) { const d = await F.getDoc(F.doc(db, 'users', other, 'movies', String(movieId))).catch(() => null); return d?.exists() ? d.data() : null; },
  async recentOf(other, n = 12) {
    const snap = await F.getDocs(F.query(F.collection(db, 'users', other, 'movies'), F.orderBy('at', 'desc'), F.limit(n)));
    return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  },
  async getReview(movieId, who) { const d = await F.getDoc(F.doc(db, 'reviews', String(movieId), 'by', who || uid())).catch(() => null); return d?.exists() ? d.data() : null; },
  async listReviews(movieId, friendIds = []) {
    const pub = await F.getDocs(F.query(F.collection(db, 'reviews', String(movieId), 'by'), F.where('vis', '==', 'public'), F.limit(60))).catch(() => null);
    const out = new Map((pub?.docs || []).map((d) => [d.id, d.data()]));
    const extra = [...new Set([...friendIds, uid()].filter((x) => x && !out.has(x)))];
    await Promise.all(extra.map(async (f) => { const r = await this.getReview(movieId, f); if (r) out.set(f, r); }));
    return [...out.values()];
  },
  async saveReview(movieId, { text, spoiler, rating }) {
    const mine = await this.getSocial();
    await F.setDoc(F.doc(db, 'reviews', String(movieId), 'by', uid()), {
      uid: uid(), name: current?.name || '', handle: mine.handle || '', text, spoiler: !!spoiler, vis: mine.privacy.reviews || 'public', rating: rating || 0, at: Date.now(),
    });
  },
  async deleteReview(movieId, who) { await F.deleteDoc(F.doc(db, 'reviews', String(movieId), 'by', who || uid())); },

  // Fan-reported kill counts: kills/{movieId}/votes/{uid} = { n }, and kills/{movieId} = { verified } set by an admin.
  async getKills(id) {
    const [top, votes] = await Promise.all([
      F.getDoc(F.doc(db, 'kills', String(id))).catch(() => null),
      F.getDocs(F.collection(db, 'kills', String(id), 'votes')).catch(() => null),
    ]);
    const list = votes ? votes.docs.map((d) => ({ uid: d.id, n: d.data().n })) : [];
    return { votes: list.map((v) => v.n), mine: list.find((v) => v.uid === uid())?.n ?? null, verified: top?.data()?.verified ?? null };
  },
  async setKill(id, n) {
    const ref = F.doc(db, 'kills', String(id), 'votes', uid());
    if (n == null) await F.deleteDoc(ref); else await F.setDoc(ref, { n, at: Date.now() });
  },
  async verifyKill(id, n) { await F.setDoc(F.doc(db, 'kills', String(id)), { verified: n, by: uid(), at: Date.now() }); },

  async getConfig() {
    try { return { showPosters: false, featured: [], hidden: [], sgFix: {}, announcement: '', ...((await F.getDoc(F.doc(db, 'config', 'site'))).data() || {}) }; }
    catch { return { showPosters: false, featured: [], hidden: [], sgFix: {}, announcement: '' }; }
  },
  async saveConfig(full) { await F.setDoc(F.doc(db, 'config', 'site'), full); },
  async adminStats() {
    const c = await F.getCountFromServer(F.collection(db, 'users'));
    return { users: c.data().count };
  },
};
