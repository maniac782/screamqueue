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
