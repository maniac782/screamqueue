// Bump VERSION on every change (shown in the footer and used for the offline cache).
export const VERSION = '1.8.4';
export const SITE_NAME = 'Scream Queue';
export const TAGLINE = 'Find the horror movie to watch next.';

// Paste the web app config from Firebase console > Project settings > Your apps.
// These values are public identifiers, not secrets. While apiKey is 'REPLACE_ME'
// the site runs in demo mode: no real accounts, everything saved in this browser only.
export const firebaseConfig = {
  apiKey: 'AIzaSyCGQx0q7Plu3v3OQaizaWPnjZDmWB17zaI',
  authDomain: 'screamqueue.firebaseapp.com',
  projectId: 'screamqueue',
  storageBucket: 'screamqueue.firebasestorage.app',
  messagingSenderId: '931540338600',
  appId: '1:931540338600:web:0d68b3caceefe4e70b3f9d',
};

export const VOTES_PER_PERSON = 3;
export const DEMO = firebaseConfig.apiKey === 'REPLACE_ME' || new URLSearchParams(location.search).has('demo');
