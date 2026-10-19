// Subgenre families and icons. The nightly data job decides which subgenres a movie has;
// this file only decides how they are grouped and drawn on the site.

export const FAMILIES = [
  { key: 'killers', label: 'Killers', icon: 'slasher', sg: ['slasher', 'extreme', 'survival', 'terror', 'teen', 'home'] },
  { key: 'super', label: 'Supernatural', icon: 'ghost', sg: ['ghost', 'occult', 'demonic', 'possession', 'folk', 'cosmic'] },
  { key: 'monsters', label: 'Monsters', icon: 'creature', sg: ['creature', 'scifi', 'zombie', 'vampire', 'werewolf', 'classic'] },
  { key: 'mind', label: 'Mind & Body', icon: 'psych', sg: ['psych', 'body', 'tech'] },
  { key: 'style', label: 'Style', icon: 'found', sg: ['fun', 'comedy', 'found', 'anthology'] },
];

// 24px line icons, one per subgenre.
const P = {
  slasher: '<path d="M20 3.5c-4.2 1-8.6 4.8-11.3 9.4l2 2c4.6-2.7 8.4-7.1 9.3-11.4z"/><path d="m8.7 12.9 2.4 2.4-4.9 4.9a1.7 1.7 0 0 1-2.4-2.4z"/>',
  possession: '<path d="M12 3v18M7 8.5h10"/>',
  demonic: '<circle cx="12" cy="14" r="6"/><path d="M7.6 10.4 5 3.8l5.2 4.6M16.4 10.4 19 3.8l-5.2 4.6"/><path d="M9.6 13.2h.01M14.4 13.2h.01" stroke-width="2.6"/><path d="M10 16.6c1.2.8 2.8.8 4 0"/>',
  ghost: '<path d="M6 20.5V11a6 6 0 0 1 12 0v9.5l-2-1.6-2 1.6-2-1.6-2 1.6-2-1.6z"/><path d="M10 11h.01M14 11h.01" stroke-width="2.6"/>',
  occult: '<circle cx="12" cy="12.4" r="8.6"/><path d="M12 4 16.7 18.5 4.4 9.5h15.2L7.3 18.5z"/>',
  folk: '<path d="M12 21v-8.5M12 12.5 7.5 8.6V3.8M7.5 8.6 4.2 7M7.5 6.2 9.6 4M12 12.5l4.5-3.9V3.8M16.5 8.6 19.8 7M16.5 6.2 14.4 4"/>',
  found: '<rect x="2.8" y="7" width="13" height="10.5" rx="2"/><path d="m15.8 11 5.4-3.2v9.4l-5.4-3.2"/><circle cx="6.6" cy="10.4" r="1.3" fill="currentColor" stroke="none"/>',
  creature: '<path d="M2.5 12S6 6 12 6s9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6z"/><path d="M12 7.8c-1.4 1.6-1.4 6.8 0 8.4 1.4-1.6 1.4-6.8 0-8.4z" fill="currentColor"/>',
  zombie: '<path d="M3 21h18"/><path d="M8.6 21v-8.2L6.9 11a1.2 1.2 0 0 0-1.8 1.6L8.6 17"/><path d="M8.6 13V7.8a1.2 1.2 0 0 1 2.4 0V12M11 12V5.8a1.2 1.2 0 0 1 2.4 0V12M13.4 12V7a1.2 1.2 0 0 1 2.4 0v6.8c0 3-1.2 4.8-1.6 7.2"/>',
  vampire: '<path d="M4.5 8.5c3.2 2.3 11.8 2.3 15 0"/><path d="M8.2 10.3 9.4 15l1.2-4.3M13.4 10.7l1.2 4.3 1.2-4.7"/><path d="M5.5 15.5c2.5 3.5 10.5 3.5 13 0"/>',
  werewolf: '<path d="M15.5 3.6A8.6 8.6 0 1 0 20.4 15 7 7 0 0 1 15.5 3.6z"/><path d="M8.6 9.5 7.4 16M11.4 9l-.6 7.5M14.2 10l.2 6"/>',
  body: '<path d="M8 3c0 6 8 6 8 9s-8 3-8 9M16 3c0 6-8 6-8 9s8 3 8 9M9.4 6h5.2M9.4 18h5.2M10.6 9.3h2.8M10.6 14.7h2.8"/>',
  psych: '<path d="M11.4 12.0 L11.3 11.8 L11.3 11.6 L11.3 11.3 L11.5 11.0 L11.7 10.8 L12.1 10.6 L12.5 10.6 L12.9 10.7 L13.3 10.9 L13.7 11.2 L14.0 11.7 L14.1 12.3 L14.1 12.9 L13.9 13.5 L13.5 14.0 L12.9 14.5 L12.2 14.7 L11.5 14.8 L10.7 14.7 L9.9 14.3 L9.2 13.7 L8.8 13.0 L8.5 12.1 L8.5 11.1 L8.7 10.1 L9.3 9.2 L10.1 8.5 L11.1 8.0 L12.2 7.7 L13.4 7.8 L14.5 8.2 L15.5 9.0 L16.3 10.0 L16.8 11.2 L17.0 12.5 L16.8 13.9 L16.2 15.2 L15.3 16.3 L14.0 17.2 L12.6 17.6 L11.0 17.7 L9.5 17.4 L8.0 16.6 L6.9 15.4 L6.0 13.9 L5.6 12.3 L5.6 10.5 L6.1 8.8 L7.1 7.2 L8.5 6.0 L10.2 5.2 L12.2 4.8 L14.1 5.0 L16.0 5.7 L17.6 6.9 L18.9 8.6 L19.7 10.5 L19.9 12.7 L19.6 14.8 L18.6 16.8"/>',
  home: '<path d="M4 11 12 4.5l8 6.5v9.5H4z"/><path d="M10 20.5V15h4v5.5"/><path d="M14.6 9.6h2.6v2.6"/>',
  survival: '<path d="M8 3 3.6 12.5h8.8zM8 12.5V19M16 7.5l-4.2 9h8.4zM16 16.5V21"/>',
  cosmic: '<circle cx="12" cy="8.2" r="4.6"/><path d="M8.8 12c-2 2.6 1.2 4.6-1.8 8.6M12 12.8v8M15.2 12c2 2.6-1.2 4.6 1.8 8.6"/><path d="M3.5 5h.01M20.5 4h.01M20 12h.01" stroke-width="2.4"/>',
  tech: '<rect x="3" y="4" width="18" height="12.5" rx="2"/><path d="M8 20.5h8M12 16.5v4M6.5 8.5h4.5M13.5 8.5h4M6.5 12h7.5M16.5 12h1"/>',
  teen: '<path d="M2.8 20.5 12 5l9.2 15.5z"/><path d="M9.4 20.5 12 15.6l2.6 4.9"/>',
  extreme: '<path d="M12 3.4c-3 4.6-5.6 7.6-5.6 10.8a5.6 5.6 0 0 0 11.2 0c0-3.2-2.6-6.2-5.6-10.8z"/><path d="M9.6 14.4a2.5 2.5 0 0 0 2 2.3"/>',
  classic: '<path d="M6.8 4.5h10.4V16a3 3 0 0 1-3 3H9.8a3 3 0 0 1-3-3z"/><path d="M6.8 8.4h10.4M4.2 13h2.6M17.2 13h2.6M14.2 15.6h-4.4"/><path d="M10 11.4h.01M14 11.4h.01" stroke-width="2.6"/>',
  anthology: '<rect x="4" y="6.5" width="11" height="14" rx="1.6"/><path d="M8 3.5h10.4A1.6 1.6 0 0 1 20 5.1v12.4"/>',
  scifi: '<ellipse cx="12" cy="11.5" rx="9" ry="3"/><path d="M8 9.6a4 4 0 0 1 8 0M8.4 16.6 7 20M12 17v3.6M15.6 16.6 17 20"/>',
  comedy: '<circle cx="12" cy="12" r="8.6"/><path d="M7.8 13.4h8.4a4.2 4.2 0 0 1-8.4 0z"/><path d="m8.4 9.8 1.4-1.2 1.4 1.2M12.8 9.8l1.4-1.2 1.4 1.2"/>',
  fun: '<path d="M12 7.2c-5 0-8.2 3.3-8.2 7.1S7 21 12 21s8.2-2.9 8.2-6.7S17 7.2 12 7.2z"/><path d="M12 7.2c-1.6 1.4-2.2 7.9 0 13.8M12 7.2c1.6 1.4 2.2 7.9 0 13.8M12 7.2c0-1.8.6-3.2 2-4.2"/>',
  terror: '<path d="M2.8 12.5h4l2.1-5.2 3.2 10.4 2.5-7.2 1.6 2H21.2"/>',
};

export function sgIcon(key, cls = '') {
  return `<svg class="ic sgi ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[key] || P.ghost}</svg>`;
}

export function familyOf(key) { return FAMILIES.find((f) => f.sg.includes(key)) || FAMILIES[FAMILIES.length - 1]; }
