#!/usr/bin/env python3
"""One-off helper: find public-domain horror film images on Wikimedia Commons for profile avatars.
Writes thumbnails + license info to avatar-candidates/ so they can be reviewed and cropped by hand."""
import json, os, re, urllib.parse, urllib.request

UA = {'User-Agent': 'ScreamQueueAvatarFinder/1.0 (https://screamqueue.web.app; github.com/maniac782/screamqueue)'}
OUT = 'avatar-candidates'
SUBJECTS = {
    'orlok': 'Nosferatu 1922 Max Schreck Orlok',
    'cesare': 'Cabinet of Dr. Caligari 1920 Cesare Conrad Veidt',
    'caligari': 'Cabinet of Dr. Caligari 1920 Werner Krauss',
    'phantom': 'Phantom of the Opera 1925 Lon Chaney',
    'hyde': 'Dr. Jekyll and Mr. Hyde 1920 John Barrymore',
    'nightdead': 'Night of the Living Dead 1968',
    'golem': 'Der Golem 1920 Paul Wegener',
    'haxan': 'Häxan 1922',
    'frankenstein1910': 'Frankenstein 1910 Edison Charles Ogle',
    'hunchback': 'Hunchback of Notre Dame 1923 Lon Chaney',
    'londonaftermidnight': 'London After Midnight 1927 Lon Chaney',
    'vampyr': 'Vampyr 1932 Dreyer',
    'whitezombie': 'White Zombie 1932 Bela Lugosi',
    'carnival': 'Carnival of Souls 1962',
    'househaunted': 'House on Haunted Hill 1959 Vincent Price',
    'manwholaughs': 'The Man Who Laughs 1928 Conrad Veidt',
}

def get(url):
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=60) as r:
        return r.read()

def search(q):
    p = {'action': 'query', 'format': 'json', 'generator': 'search', 'gsrsearch': f'{q} filetype:bitmap', 'gsrnamespace': 6, 'gsrlimit': 12,
         'prop': 'imageinfo', 'iiprop': 'url|extmetadata|size', 'iiurlwidth': 360}
    data = json.loads(get('https://commons.wikimedia.org/w/api.php?' + urllib.parse.urlencode(p)))
    out = []
    for page in (data.get('query', {}).get('pages', {}) or {}).values():
        ii = (page.get('imageinfo') or [{}])[0]; md = ii.get('extmetadata', {})
        lic = (md.get('LicenseShortName', {}) or {}).get('value', '')
        out.append({'title': page['title'], 'thumb': ii.get('thumburl'), 'url': ii.get('url'), 'page': ii.get('descriptionurl'),
                    'license': lic, 'artist': re.sub('<[^>]+>', '', (md.get('Artist', {}) or {}).get('value', ''))[:120],
                    'w': ii.get('width'), 'h': ii.get('height'), 'idx': page.get('index', 99)})
    return sorted(out, key=lambda x: x['idx'])

os.makedirs(OUT, exist_ok=True)
manifest = {}
for key, q in SUBJECTS.items():
    try:
        cands = [c for c in search(q) if c['thumb'] and re.search(r'public domain|PD|CC0', c['license'], re.I)][:6]
    except Exception as e:
        print('search failed', key, e); continue
    manifest[key] = []
    for i, c in enumerate(cands):
        fn = f'{key}-{i}.jpg'
        try:
            open(os.path.join(OUT, fn), 'wb').write(get(c['thumb']))
            manifest[key].append({**c, 'file': fn})
        except Exception as e:
            print('download failed', c['title'], e)
    print(key, len(manifest[key]))
json.dump(manifest, open(os.path.join(OUT, 'manifest.json'), 'w'), indent=1, ensure_ascii=False)
