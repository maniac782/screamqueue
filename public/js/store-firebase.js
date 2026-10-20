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
  // How this account signs in, so deleting it can ask for the right confirmation.
  signInMethod() { return auth.currentUser?.providerData?.[0]?.providerId === 'password' ? 'password' : 'google'; },
  // Delete the account and everything stored with it. Sign in again first (Firebase only lets a recent sign-in
  // delete itself), then remove the data, then the sign-in. progress(text) reports each step.
  async deleteAccount(password, progress = () => {}) {
    const u = auth.currentUser; if (!u) throw new Error('Not signed in');
    progress('Checking it\'s you…');
    if (this.signInMethod() === 'password') await A.reauthenticateWithCredential(u, A.EmailAuthProvider.credential(u.email, password));
    else await A.reauthenticateWithPopup(u, new A.GoogleAuthProvider());
    const me = u.uid;
    const refs = [];
    const del = async (list) => { for (let i = 0; i < list.length; i += 400) { const b = F.writeBatch(db); list.slice(i, i + 400).forEach((r) => b.delete(r)); await b.commit(); } };
    progress('Removing your movies, ratings and reviews…');
    const mv = await F.getDocs(F.collection(db, 'users', me, 'movies'));
    for (const d of mv.docs) {
      refs.push(d.ref);
      if (d.data().status === 'seen' || d.data().wasSeen || d.data().rv) refs.push(F.doc(db, 'reviews', d.id, 'by', me), F.doc(db, 'kills', d.id, 'votes', me), F.doc(db, 'cw', d.id, 'by', me));
    }
    await del(refs.splice(0));
    progress('Removing friends and requests…');
    const [fr, inc, out] = await Promise.all([F.getDocs(F.collection(db, 'friends', me, 'list')), F.getDocs(F.collection(db, 'requests', me, 'from')), F.getDocs(F.collection(db, 'sent', me, 'to'))]);
    for (const d of fr.docs) refs.push(d.ref, F.doc(db, 'friends', d.id, 'list', me));
    for (const d of inc.docs) refs.push(d.ref, F.doc(db, 'sent', d.id, 'to', me));
    for (const d of out.docs) refs.push(d.ref, F.doc(db, 'requests', d.id, 'from', me));
    await del(refs.splice(0));
    progress('Leaving movie nights…');
    const nights = await F.getDocs(F.query(F.collection(db, 'nights'), F.where('members', 'array-contains', me)));
    for (const d of nights.docs) {
      const n = d.data();
      if (n.owner === me) await F.deleteDoc(d.ref);
      else {
        const votes = { ...(n.votes || {}) }; delete votes[me];
        const names = { ...(n.memberNames || {}) }; delete names[me];
        await F.updateDoc(d.ref, { members: n.members.filter((x) => x !== me), memberNames: names, votes }).catch((e) => console.warn('leave night', e));
      }
    }
    const inbox = await F.getDocs(F.collection(db, 'rxin', me, 'by')).catch(() => null);
    for (const d of inbox?.docs || []) refs.push(d.ref);
    progress('Removing your lists…');
    const mine = await F.getDocs(F.query(F.collection(db, 'lists'), F.where('owner', '==', me))).catch(() => null);
    for (const d of mine?.docs || []) refs.push(d.ref);
    for (const id of (await F.getDoc(F.doc(db, 'users', me)).catch(() => null))?.data()?.follows || []) refs.push(F.doc(db, 'lists', id, 'fans', me));
    await del(refs.splice(0)).catch((e) => console.warn('lists', e));
    progress('Removing your profile…');
    const card = (await F.getDoc(F.doc(db, 'profiles', me)).catch(() => null))?.data();
    if (card?.handle) refs.push(F.doc(db, 'usernames', card.handle));
    refs.push(F.doc(db, 'profiles', me), F.doc(db, 'users', me));
    await del(refs.splice(0));
    progress('Deleting your sign-in…');
    await A.deleteUser(u);
  },
  async resetPassword(email) { await A.sendPasswordResetEmail(auth, email); },
  async signOut() { await A.signOut(auth); },

  async getProfile() { const d = (await F.getDoc(userDoc())).data() || {}; return { name: d.name || current?.name || '', services: d.services || [], hideSeen: !!d.hideSeen, setup: !!d.setup, follows: d.follows || [], notify: { friends: true, streaming: true, ...(d.notify || {}) } }; },
  async saveProfile(patch) {
    await F.updateDoc(userDoc(), patch);
    if (patch.name && current) current.name = patch.name;
  },

  async loadMyMovies() {
    const snap = await F.getDocs(F.collection(db, 'users', uid(), 'movies'));
    return new Map(snap.docs.map((d) => [d.id, d.data()]));
  },
  async setMovie(id, data) { await F.setDoc(F.doc(db, 'users', uid(), 'movies', String(id)), { ...data, at: Date.now() }); },
  // Many movies at once (Letterboxd import), 400 per batch write.
  async importMovies(entries) {
    for (let i = 0; i < entries.length; i += 400) {
      const b = F.writeBatch(db);
      for (const [id, data] of entries.slice(i, i + 400)) b.set(F.doc(db, 'users', uid(), 'movies', String(id)), { ...data, at: Date.now() });
      await b.commit();
    }
  },
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
    // New people get no public card until they've picked a username and display name (the welcome step),
    // so a real name from Google is never shown without them choosing it.
    if (snap && !snap.exists()) return { handle: '', av: '', photo: '', privacy: { profile: 'friends', reviews: 'public' }, missing: true };
    if (snap && !d?.handle) {
      const nm = d?.name || current?.name || '';
      const handle = await this.claimDefaultHandle(nm).catch(() => '');
      d = { name: nm, nameLower: nm.toLowerCase(), handle, privacy: { profile: 'friends', reviews: 'public', ...(d?.privacy || {}) }, at: Date.now() };
      await F.setDoc(F.doc(db, 'profiles', uid()), d, { merge: true }).catch((e) => console.warn('profile card', e));
      d = { ...snap.data(), ...d };
    } else if (d && d.name !== current?.name && current?.name) {
      F.updateDoc(F.doc(db, 'profiles', uid()), { name: current.name, nameLower: current.name.toLowerCase() }).catch(() => {});
    }
    return { handle: d?.handle || '', av: d?.av || '', photo: d?.photo || '', privacy: { profile: 'friends', reviews: 'public', ...(d?.privacy || {}) } };
  },
  // Profile picture: av = 'pd:<id>' (classic horror portrait), 'ic:<icon>' (drawn icon), 'up' (uploaded photo in `photo`), or '' (initials)
  async setAvatar(av, photo = '') {
    await F.updateDoc(F.doc(db, 'profiles', uid()), { av, photo: av === 'up' ? photo : '' });
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
  async handleFree(h) { const s = await F.getDoc(F.doc(db, 'usernames', h)).catch(() => null); return !s?.exists() || s.data().uid === uid(); },
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
    batch.set(F.doc(db, 'profiles', uid()), { name: nm, nameLower: nm.toLowerCase(), handle: h || prev.handle || '', privacy: { ...prev.privacy, ...(privacy || {}) }, at: Date.now() }, { merge: true });
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
  // Everyone who set their profile to public (most recently active first).
  async listPublic() {
    const snap = await F.getDocs(F.query(F.collection(db, 'profiles'), F.where('privacy.profile', '==', 'public'), F.limit(100)));
    return snap.docs.map((d) => ({ uid: d.id, ...d.data() })).sort((a, b) => (b.at || 0) - (a.at || 0));
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
  // Incoming friend requests, live: cb(list) runs now and whenever one arrives or is withdrawn.
  watchRequests(cb) {
    return F.onSnapshot(F.collection(db, 'requests', uid(), 'from'), (s) => cb(s.docs.map((d) => ({ uid: d.id, ...d.data() }))), () => {});
  },
  // Reactions: rx/{target}/by/{uid} = { k: 'skull' | 'same' }. target is a_<owner>_<movie> (activity) or
  // r_<movie>_<owner> (a review). The owner also gets a note in rxin/{owner}/by so they can see who reacted.
  async listRx(keys) {
    const out = new Map();
    await Promise.all(keys.map(async (k) => { const s = await F.getDocs(F.collection(db, 'rx', k, 'by')).catch(() => null); out.set(k, (s?.docs || []).map((d) => ({ uid: d.id, ...d.data() }))); }));
    return out;
  },
  async setRx(key, k, owner, meta) {
    const me = uid(), b = F.writeBatch(db);
    b.set(F.doc(db, 'rx', key, 'by', me), { k, at: Date.now() });
    if (owner && owner !== me) b.set(F.doc(db, 'rxin', owner, 'by', `${me}_${key}`), { from: me, name: meta.name || '', handle: meta.handle || '', k, key, movie: Number(meta.movie) || 0, kind: meta.kind, at: Date.now() });
    await b.commit();
  },
  async delRx(key, owner) {
    const me = uid(), b = F.writeBatch(db);
    b.delete(F.doc(db, 'rx', key, 'by', me));
    if (owner && owner !== me) b.delete(F.doc(db, 'rxin', owner, 'by', `${me}_${key}`));
    await b.commit();
  },
  async listRxIn(n = 30) {
    const s = await F.getDocs(F.query(F.collection(db, 'rxin', uid(), 'by'), F.orderBy('at', 'desc'), F.limit(n)));
    return s.docs.map((d) => ({ id: d.id, ...d.data() }));
  },
  // Content warnings: cw/{movie}/by/{uid} = { v: { dog: 1 | -1, ... } } (1 = yes, it happens; -1 = no).
  async getWarnings(movieId) {
    const s = await F.getDocs(F.collection(db, 'cw', String(movieId), 'by'));
    return s.docs.map((d) => ({ uid: d.id, v: d.data().v || {} }));
  },
  async setWarning(movieId, key, val) {
    const ref = F.doc(db, 'cw', String(movieId), 'by', uid());
    const cur = (await F.getDoc(ref).catch(() => null))?.data()?.v || {};
    const v = { ...cur }; if (val) v[key] = val; else delete v[key];
    if (Object.keys(v).length) await F.setDoc(ref, { v, at: Date.now() }); else await F.deleteDoc(ref);
  },
  // DoesTheDogDie.com warnings, saved by the server in dtdd/{movie}. When there's no copy younger than 25 days we ask the
  // server for one (dtddq/{movie}) and keep listening until it arrives. cb gets the doc, or null when there's nothing.
  watchDtdd(movieId, cb) {
    const id = String(movieId); let asked = false, got = false, timer = null;
    const fresh = (d) => d && Date.now() - (d.at || 0) < 30 * 864e5;
    const stop = F.onSnapshot(F.doc(db, 'dtdd', id), (s) => {
      const d = s.exists() ? s.data() : null;
      if (fresh(d)) { got = true; clearTimeout(timer); cb(d); }
      if ((d && Date.now() - d.at < 25 * 864e5) || asked) return;
      asked = true;
      F.setDoc(F.doc(db, 'dtddq', id), { at: F.serverTimestamp() }).catch(() => {});
      if (!got) { cb(undefined); timer = setTimeout(() => { if (!got) cb(null); }, 25000); }
    }, () => cb(null));
    return () => { clearTimeout(timer); stop(); };
  },
  // Lists: lists/{id} = { owner, name, handle, title, desc, items: [movie ids], vis: public|friends|private, at, upd }
  // Following a list adds a fan doc (lists/{id}/fans/{uid}, for the count) and its id to users/{uid}.follows.
  async myLists() { const s = await F.getDocs(F.query(F.collection(db, 'lists'), F.where('owner', '==', uid()))); return s.docs.map((d) => ({ id: d.id, ...d.data() })); },
  async publicLists(n = 60) { const s = await F.getDocs(F.query(F.collection(db, 'lists'), F.where('vis', '==', 'public'), F.limit(n))); return s.docs.map((d) => ({ id: d.id, ...d.data() })); },
  async listsOf(other) {
    const q = (vis) => F.getDocs(F.query(F.collection(db, 'lists'), F.where('owner', '==', other), F.where('vis', '==', vis))).then((s) => s.docs.map((d) => ({ id: d.id, ...d.data() }))).catch(() => []);
    const [a, b] = await Promise.all([q('public'), q('friends')]);
    return [...a, ...b];
  },
  async getList(id) { const d = await F.getDoc(F.doc(db, 'lists', id)); return d.exists() ? { id: d.id, ...d.data() } : null; },
  async createList(data) { const ref = await F.addDoc(F.collection(db, 'lists'), { ...data, owner: uid(), at: Date.now(), upd: Date.now() }); return ref.id; },
  async updateList(id, patch) { await F.updateDoc(F.doc(db, 'lists', id), { ...patch, upd: Date.now() }); },
  async deleteList(id) { await F.deleteDoc(F.doc(db, 'lists', id)); },
  async fanCount(id) { return F.getCountFromServer(F.collection(db, 'lists', id, 'fans')).then((c) => c.data().count).catch(() => 0); },
  async followList(id, on, follows) {
    const b = F.writeBatch(db);
    if (on) b.set(F.doc(db, 'lists', id, 'fans', uid()), { at: Date.now() }); else b.delete(F.doc(db, 'lists', id, 'fans', uid()));
    b.update(userDoc(), { follows });
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
  // ---------- VS matchups and brackets ----------
  // vs/{id}: { title, cat, entries: [{ l: label, m: movie id or null }], size, rounds, start, dur, by, at }
  // vs/{id}/m/{r1m0}/votes/{uid}: { pick: 'a'|'b', r, at }. Tallies are count queries, so nobody can edit a total.
  async listVs() {
    const snap = await F.getDocs(F.query(F.collection(db, 'vs'), F.orderBy('start', 'desc'), F.limit(60)));
    return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  },
  async getVs(id) { const d = await F.getDoc(F.doc(db, 'vs', id)); return d.exists() ? { id: d.id, ...d.data() } : null; },
  async createVs(data) { const ref = await F.addDoc(F.collection(db, 'vs'), { ...data, by: uid(), at: Date.now() }); return ref.id; },
  async deleteVs(id) { await F.deleteDoc(F.doc(db, 'vs', id)); },
  async tallyVs(id, mk) {
    const col = F.collection(db, 'vs', id, 'm', mk, 'votes');
    const [a, b] = await Promise.all(['a', 'b'].map((p) => F.getCountFromServer(F.query(col, F.where('pick', '==', p))).then((c) => c.data().count).catch(() => 0)));
    return { a, b };
  },
  async myVotesVs(id, mks) {
    const me = auth.currentUser; if (!me) return {};
    const out = {};
    await Promise.all(mks.map(async (mk) => { const d = await F.getDoc(F.doc(db, 'vs', id, 'm', mk, 'votes', me.uid)).catch(() => null); if (d?.exists()) out[mk] = d.data().pick; }));
    return out;
  },
  async voteVs(id, mk, r, pick) {
    await F.setDoc(F.doc(db, 'vs', id, 'm', mk, 'votes', auth.currentUser.uid), { pick, r, at: Date.now() });
  },

  // Send feedback (signed in) and Contact (anyone). Only admins can read them, on the Admin page.
  async sendFeedback(d) { await F.addDoc(F.collection(db, 'feedback'), { ...d, uid: uid(), t: Date.now() }); },
  async sendContact(d) { await F.addDoc(F.collection(db, 'contact'), { ...d, t: Date.now() }); },
  async listInbox(kind) {
    const snap = await F.getDocs(F.query(F.collection(db, kind), F.orderBy('t', 'desc'), F.limit(200)));
    return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  },
  async clearInbox(kind, id) { await F.deleteDoc(F.doc(db, kind, id)); },
  // Everyone on the site for the Admin page: account (joined, last seen), public card, and a few counts.
  async adminUsers() {
    const ms = (v) => (v == null ? 0 : typeof v === 'number' ? v : v.toMillis ? v.toMillis() : v.seconds ? v.seconds * 1000 : 0);
    const [us, ps, ad] = await Promise.all([F.getDocs(F.collection(db, 'users')), F.getDocs(F.collection(db, 'profiles')), F.getDocs(F.collection(db, 'admins')).catch(() => null)]);
    const cards = new Map(ps.docs.map((d) => [d.id, d.data()]));
    const admins = new Set(ad ? ad.docs.map((d) => d.id) : []);
    const count = (q) => F.getCountFromServer(q).then((c) => c.data().count).catch(() => null);
    return Promise.all(us.docs.map(async (d) => {
      const u = d.data(), p = cards.get(d.id) || {}, mv = F.collection(db, 'users', d.id, 'movies');
      const [seen, queued, friends] = await Promise.all([count(F.query(mv, F.where('status', '==', 'seen'))), count(F.query(mv, F.where('status', '==', 'queue'))), count(F.collection(db, 'friends', d.id, 'list'))]);
      return { uid: d.id, name: p.name || u.name || '', handle: p.handle || '', av: p.av || '', photo: p.photo || '', privacy: p.privacy?.profile || '', created: ms(u.createdAt), lastSeen: ms(u.lastSeen), services: (u.services || []).length, admin: admins.has(d.id), seen, queued, friends };
    }));
  },
  async adminRemovePhoto(other) { await F.updateDoc(F.doc(db, 'profiles', other), { av: '', photo: '' }); },
  async adminStats() {
    const c = await F.getCountFromServer(F.collection(db, 'users'));
    return { users: c.data().count };
  },
};
