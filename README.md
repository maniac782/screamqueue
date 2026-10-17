# Scream Queue

Find the horror movie to watch next. Each movie gets two scores so a buzzy hit is easy to tell from something that just came out:

- **Buzz** (0–100): activity right now — TMDB daily/weekly trending rank and popularity, plus Trakt watchers if connected.
- **Reach** (0–100): how widely it has been seen — TMDB and IMDb rating counts, plus Trakt watchers if connected. Reach sets the tier sticker: Crowd Favorite, Well-Known, Cult Pick, Deep Cut. Movies released in the last four months get a New Release sticker instead, since they have not had time to collect ratings.

Movies are tagged with subgenres (slasher, possession, demonic, ghosts, folk horror, found footage, creature feature and more) from TMDB keywords, and show where they stream in the US, including Shudder.

Features: Google and email sign-in, open sign-ups, watch queue, a Trophy Case (milestones, badges, subgenre mastery, Horror Essentials checklist, dated watch log with 1–5 skull ratings), "Pick for me", movie nights with shared suggestions and voting, streaming-service filters, an admin page (featured movies, hidden movies, subgenre fixes, poster toggle, announcement banner), installable app, offline cache.

## How it fits together

```
public/                  the site (plain HTML/CSS/JS, no build step)
  js/config.js           site name, VERSION, Firebase web config
  js/app.js              pages, filters, pick-for-me, movie nights
  js/store-firebase.js   Firebase Auth + Firestore
  js/store-local.js      demo mode (used while config.js still says REPLACE_ME)
  data/movies.json       written nightly by the refresh job (ships with sample data)
scripts/refresh-data.mjs pulls TMDB (+ optional Trakt, OMDb), tags and scores movies
scripts/lib.mjs          subgenre rules and scoring (edit SUBGENRES to tune tags)
.github/workflows/       refresh-data.yml (nightly) and deploy.yml (Firebase Hosting)
firestore.rules          security rules
```

API keys live only in GitHub Actions secrets. The site never sees them.

## Setup

1. **GitHub repo.** Create `screamqueue` and push these files to `main`.
2. **Firebase project.** Create a new project with ID `screamqueue` (separate from the other sites).
   - Authentication → Sign-in method: turn on **Google** and **Email/Password**.
   - Firestore Database → create it, then open the Rules tab and paste in `firestore.rules`.
   - Project settings → Your apps → add a Web app, then copy its config values into `public/js/config.js`. These are public identifiers, not secrets.
3. **Deploys.** In the repo folder run `firebase init hosting:github` and let it create the `FIREBASE_SERVICE_ACCOUNT_SCREAMQUEUE` secret. Keep the existing workflow files when it asks. Every push to `main` then deploys to `screamqueue.web.app`.
4. **TMDB key (required).** Make a free account at themoviedb.org → Settings → API → request a developer key. Copy the **API Read Access Token** into the repo's Settings → Secrets and variables → Actions as `TMDB_READ_TOKEN`.
5. **Optional keys** (same place):
   - `OMDB_API_KEY` — free key from omdbapi.com. Adds IMDb ratings and vote counts to Reach.
   - `TRAKT_CLIENT_ID` — Trakt now requires a VIP account to create API apps. Adds live watcher counts.
6. **First data pull.** Actions → "Refresh movie data" → Run workflow. After that it runs every morning around 5am Eastern and redeploys when the data changes.
7. **Make yourself admin.** Sign in once, copy your user UID from Authentication → Users, then in Firestore create collection `admins` with a document whose ID is that UID (no fields needed).

## Day-to-day

- **Version:** bump `VERSION` in `public/js/config.js` on every change. It shows in the footer and refreshes the offline cache.
- **Renaming the site:** change `SITE_NAME` in `public/js/config.js`, the `<title>` in `public/index.html`, and the names in `public/manifest.webmanifest`.
- **Tuning subgenres:** edit the keyword patterns in `scripts/lib.mjs`, or fix single movies from the Admin page.
- **Posters:** off by default. Posters belong to the studios; TMDB's API terms allow showing them with TMDB credit. Turn them on from the Admin page if you want them.
- **Tests:** `npm test` checks the tagging and scoring rules.
- **Local preview:** `npm run serve`, then open http://localhost:5050. With `REPLACE_ME` still in the config it runs in demo mode.

## Credits

Movie data from TMDB. This product uses the TMDB API but is not endorsed or certified by TMDB. Streaming availability from JustWatch via TMDB.
