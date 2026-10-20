/* Scream Queue server functions (need the Blaze plan).
   - friendRequestEmail: when someone sends you a friend request, email you (unless you turned it off in Profile).
   - contactEmail: email each Contact form message to the site owner, with Reply going to the sender.
   - queueStreamingEmail: once a day, after the nightly data refresh, email people whose queued movies just
     started streaming (on their services, if they've set any).
   Mail goes out through Gmail (MAIL_FROM in .env) with the app password kept in Secret Manager (GMAIL_APP_PASSWORD).
   Emails are only sent while the admin has "Email notifications are set up" on (config/site.emailOn).
   - dtddLookup / dtddCleanup: content warnings from DoesTheDogDie.com (free API key in Secret Manager as DTDD_API_KEY).
     A movie is only looked up when someone opens its warnings (their terms don't allow bulk downloading), results are
     kept at most 30 days (their terms), and a monthly budget keeps us inside the free plan's 5,000 calls. */
const {onDocumentCreated, onDocumentWritten} = require('firebase-functions/v2/firestore');
const {onSchedule} = require('firebase-functions/v2/scheduler');
const {defineSecret, defineString} = require('firebase-functions/params');
const logger = require('firebase-functions/logger');
const admin = require('firebase-admin');
const nodemailer = require('nodemailer');

admin.initializeApp();
const db = admin.firestore();

const GMAIL_APP_PASSWORD = defineSecret('GMAIL_APP_PASSWORD');
const MAIL_FROM = defineString('MAIL_FROM');
const CONTACT_TO = defineString('CONTACT_TO');
const SITE_URL = defineString('SITE_URL', {default: 'https://screamqueue.web.app'});
const HOUR = 3600 * 1000;

let transport = null;
function mailer() {
  if (!transport) transport = nodemailer.createTransport({service: 'gmail', auth: {user: MAIL_FROM.value(), pass: GMAIL_APP_PASSWORD.value().replace(/\s+/g, '')}});
  return transport;
}
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
const oneLine = (s) => String(s == null ? '' : s).replace(/[\r\n]+/g, ' ').trim().slice(0, 120);

function page(title, paras, button, footer) {
  return '<div style="font-family:Helvetica,Arial,sans-serif;max-width:540px;margin:0 auto;padding:24px;color:#1b1d22">' +
    '<div style="font-size:13px;font-weight:800;letter-spacing:.1em;text-transform:uppercase;color:#d6223b">Scream Queue</div>' +
    '<h1 style="font-size:22px;margin:8px 0 16px">' + esc(title) + '</h1>' +
    paras.map((p) => '<p style="font-size:15px;line-height:1.5;margin:0 0 12px">' + p + '</p>').join('') +
    (button ? '<p style="margin:20px 0"><a href="' + esc(button.href) + '" style="background:#d6223b;color:#fff;text-decoration:none;padding:11px 20px;border-radius:999px;font-size:15px;font-weight:700;display:inline-block">' + esc(button.label) + '</a></p>' : '') +
    '<p style="font-size:12px;color:#6b7280;line-height:1.5;margin-top:24px">' + footer + '</p></div>';
}
const prefsFooter = () => 'You can turn these emails off in <a href="' + esc(SITE_URL.value()) + '/#/profile" style="color:#6b7280">your Profile</a>.';
async function send(to, subject, text, html, replyTo) {
  await mailer().sendMail({from: '"Scream Queue" <' + MAIL_FROM.value() + '>', to, subject, text, html, ...(replyTo ? {replyTo} : {})});
}
async function emailOn() { return !!(await db.doc('config/site').get()).data()?.emailOn; }
async function emailOf(uid) { try { return (await admin.auth().getUser(uid)).email || null; } catch { return null; } }

// ---------- friend requests ----------
exports.friendRequestEmail = onDocumentCreated({document: 'requests/{to}/from/{from}', secrets: [GMAIL_APP_PASSWORD]}, async (event) => {
  const {to, from} = event.params;
  if (!(await emailOn())) return;
  const u = (await db.doc('users/' + to).get()).data() || {};
  if (u.notify?.friends === false) return;
  // at most 10 of these a day per person, so nobody can flood an inbox
  const since = Date.now() - 24 * HOUR;
  const recent = (await db.collection('requests/' + to + '/from').where('at', '>', since).count().get()).data().count;
  if (recent > 10) return;
  const email = await emailOf(to); if (!email) return;
  const r = event.data?.data() || {};
  const name = oneLine(r.name || 'Someone'), handle = r.handle ? '@' + oneLine(r.handle) : '';
  const link = SITE_URL.value() + '/#/friends';
  await send(email, name + ' wants to be friends on Scream Queue',
    name + (handle ? ' (' + handle + ')' : '') + ' sent you a friend request on Scream Queue. Accept it here: ' + link,
    page(name + ' sent you a friend request', [esc(name) + (handle ? ' <span style="color:#6b7280">' + esc(handle) + '</span>' : '') + ' wants to be friends on Scream Queue. Friends can see each other\'s Body Count, ratings and reviews, and the site suggests movies your friends loved.'],
      {href: link, label: 'See the request'}, prefsFooter()));
  logger.info('friend request email', {to});
});

// ---------- contact form ----------
const CONTACT_TOPICS = {general: 'General', bug: 'Something\'s broken', data: 'Movie info is wrong', privacy: 'Privacy or my data'};
exports.contactEmail = onDocumentCreated({document: 'contact/{id}', secrets: [GMAIL_APP_PASSWORD]}, async (event) => {
  const snap = event.data; if (!snap) return;
  const m = snap.data(), since = Date.now() - 24 * HOUR;
  // At most 50 a day overall and 5 a day from one address get emailed; the rest stay on the Admin page.
  const all = (await db.collection('contact').where('t', '>', since).count().get()).data().count;
  const mine = (await db.collection('contact').where('email', '==', m.email).get()).docs.filter((d) => d.data().t > since).length;
  if (all > 50 || mine > 5) { await snap.ref.update({held: 'daily limit'}).catch(() => {}); return; }
  const topic = CONTACT_TOPICS[m.topic] || 'General';
  const who = (m.name ? oneLine(m.name) + ' ' : '') + '<' + oneLine(m.email) + '>';
  await send(CONTACT_TO.value(), '[Scream Queue] ' + topic + ': ' + oneLine(m.msg).slice(0, 60),
    'From: ' + who + '\nAbout: ' + topic + '\n\n' + m.msg + '\n\nPage ' + m.page + ' · v' + m.v + ' · ' + m.ua,
    '<div style="font-family:Helvetica,Arial,sans-serif;max-width:620px;color:#1b1d22"><p style="margin:0 0 12px"><b>From:</b> ' + esc(who) + '<br><b>About:</b> ' + esc(topic) + '</p>' +
    '<div style="white-space:pre-wrap;line-height:1.5;border-left:3px solid #d6223b;padding:4px 12px;margin:0 0 16px">' + esc(m.msg) + '</div>' +
    '<p style="color:#6b7280;font-size:12px;margin:0">Page ' + esc(m.page) + ' · v' + esc(m.v) + ' · ' + esc(m.ua) + '<br>Reply to this email to answer them.</p></div>',
    {name: oneLine(m.name || ''), address: m.email});
  await snap.ref.update({sent: Date.now()}).catch(() => {});
});

// ---------- queued movies that started streaming ----------
// Runs at 7:30 AM Eastern, after the nightly data refresh. Uses the site's own movies.json (ns = newly streaming).
exports.queueStreamingEmail = onSchedule({schedule: '30 7 * * *', timeZone: 'America/New_York', secrets: [GMAIL_APP_PASSWORD]}, async () => {
  if (!(await emailOn())) return;
  const data = await (await fetch(SITE_URL.value() + '/data/movies.json')).json();
  const state = db.doc('config/mail');
  const last = (await state.get()).data()?.streamingSince || new Date(Date.now() - 2 * 24 * HOUR).toISOString().slice(0, 10);
  const fresh = data.movies.filter((m) => m.ns && m.ns.d > last);
  const today = new Date().toISOString().slice(0, 10);
  if (!fresh.length) { await state.set({streamingSince: today}, {merge: true}); return; }
  const prov = new Map((data.providers || []).map((p) => [p.id, p.name]));
  const users = await db.collection('users').get();
  let sent = 0;
  for (const u of users.docs) {
    const d = u.data();
    if (d.notify?.streaming === false) continue;
    const refs = fresh.map((m) => db.doc('users/' + u.id + '/movies/' + m.id));
    const got = await db.getAll(...refs);
    const services = d.services || [];
    const hits = [];
    got.forEach((s, i) => {
      if (!s.exists || s.data().status !== 'queue') return;
      const m = fresh[i];
      const p = services.length ? m.ns.p.filter((x) => services.includes(x)) : m.ns.p;
      if (p.length) hits.push({m, where: [...new Set(p.map((x) => prov.get(x)).filter(Boolean))].slice(0, 2).join(', ')});
    });
    if (!hits.length) continue;
    const email = await emailOf(u.id); if (!email) continue;
    const title = hits.length === 1 ? hits[0].m.t + ' is now streaming' : hits.length + ' movies in your queue are now streaming';
    const link = SITE_URL.value() + '/#/queue';
    try {
      await send(email, title,
        hits.map((h) => h.m.t + (h.m.y ? ' (' + h.m.y + ')' : '') + ': ' + h.where).join('\n') + '\n\nYour queue: ' + link,
        page(title, ['From your queue:', '<ul style="padding-left:20px;margin:0">' + hits.map((h) => '<li style="margin:0 0 6px"><b>' + esc(h.m.t) + '</b>' + (h.m.y ? ' (' + h.m.y + ')' : '') + ' <span style="color:#6b7280">on ' + esc(h.where) + '</span></li>').join('') + '</ul>'],
          {href: link, label: 'Open your queue'}, prefsFooter()));
      sent++;
    } catch (e) { logger.warn('streaming email failed', {uid: u.id, e: String(e)}); }
  }
  await state.set({streamingSince: today}, {merge: true});
  logger.info('queue streaming emails', {movies: fresh.length, sent});
});

// ---------- content warnings from DoesTheDogDie.com ----------
// The site writes dtddq/{tmdbId} when someone opens a movie's warnings and there's no fresh copy in dtdd/{tmdbId}.
// This looks the movie up (1-2 API calls), saves the yes/no totals to dtdd/{tmdbId} and removes the request.
const DTDD_API_KEY = defineSecret('DTDD_API_KEY');
const DTDD = 'https://www.doesthedogdie.com/api/v3';
const DAY = 24 * HOUR;
const DTDD_FRESH = 25 * DAY; // looked up again after this; never shown after 30 days
const DTDD_MONTHLY = 4500;  // free plan: 5,000 calls a month (and 30 a minute)
let catalog = null, catalogAt = 0;
async function inCatalog(id) {
  if (!catalog || Date.now() - catalogAt > HOUR) {
    const d = await (await fetch(SITE_URL.value() + '/data/movies.json')).json();
    catalog = new Set(d.movies.map((m) => String(m.id))); catalogAt = Date.now();
  }
  return catalog.has(String(id));
}
// Reserve n calls from this month's budget. False when it's used up.
function spend(n) {
  const ref = db.doc('config/dtdd'), month = new Date().toISOString().slice(0, 7);
  return db.runTransaction(async (t) => {
    const d = (await t.get(ref)).data() || {};
    const used = d.month === month ? d.used || 0 : 0;
    if (used + n > DTDD_MONTHLY) return false;
    t.set(ref, {month, used: used + n}, {merge: true});
    return true;
  });
}
async function dtddGet(key, path) {
  const r = await fetch(DTDD + path, {headers: {'X-API-KEY': key, Accept: 'application/json'}});
  if (!r.ok) throw new Error('DoesTheDogDie ' + r.status + ' on ' + path.split('?')[0]);
  return r.json();
}
const listOf = (j) => Array.isArray(j) ? j : j?.items || j?.data || j?.results || (j?.item ? [j.item] : []);
const statsOf = (j) => j?.topicItemStats || j?.item?.topicItemStats || j?.data?.topicItemStats || null;

exports.dtddLookup = onDocumentWritten({document: 'dtddq/{id}', secrets: [DTDD_API_KEY], maxInstances: 2}, async (event) => {
  const req = event.data?.after;
  if (!req?.exists) return;
  const id = event.params.id;
  const done = () => req.ref.delete().catch(() => {});
  try {
    const key = (DTDD_API_KEY.value() || '').trim();
    if (!key || key === 'unset') return done();
    const out = db.doc('dtdd/' + id);
    const have = (await out.get()).data();
    if (have && Date.now() - have.at < DTDD_FRESH) return done();
    if (!(await inCatalog(id))) return done();
    if (!(await spend(2))) { logger.warn('DoesTheDogDie monthly budget used up'); return done(); }
    const found = listOf(await dtddGet(key, '/items?tmdb=' + encodeURIComponent(id)));
    const item = found.find((x) => /movie/i.test(x.itemTypeName || '')) || found[0];
    if (!item) { await out.set({at: Date.now(), item: null}); return done(); }
    let stats = statsOf(item);
    if (!stats) stats = statsOf(await dtddGet(key, '/items/' + item.id)) || [];
    const topics = stats.map((t) => ({n: String(t.topicName || '').slice(0, 120), y: +t.yesSum || 0, no: +t.noSum || 0}))
      .filter((t) => t.n && t.y + t.no > 0)
      .sort((a, b) => b.y - a.y || a.no - b.no);
    await out.set({at: Date.now(), item: item.id, name: String(item.name || '').slice(0, 200), topics});
  } catch (e) {
    logger.warn('DoesTheDogDie lookup failed', {id, e: String(e)});
  }
  return done();
});

// Their terms: cached data has to be refreshed (or dropped) within 30 days.
exports.dtddCleanup = onSchedule({schedule: '15 4 * * *', timeZone: 'America/New_York'}, async () => {
  const old = await db.collection('dtdd').where('at', '<', Date.now() - 30 * DAY).limit(400).get();
  const b = db.batch(); old.docs.forEach((d) => b.delete(d.ref));
  if (!old.empty) await b.commit();
  logger.info('DoesTheDogDie cleanup', {removed: old.size});
});
