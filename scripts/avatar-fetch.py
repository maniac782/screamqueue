#!/usr/bin/env python3
"""One-off: download the chosen Commons files (900px) plus their credit lines into avatar-candidates/picked/."""
import json, os, re, urllib.parse, urllib.request
UA = {'User-Agent': 'ScreamQueueAvatarFinder/1.0 (https://screamqueue.web.app; github.com/maniac782/screamqueue)'}
picks = json.load(open('avatar-candidates/picks.json'))
os.makedirs('avatar-candidates/picked', exist_ok=True)
def get(url):
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=60) as r: return r.read()
out = {}
for key, title in picks.items():
    p = {'action': 'query', 'format': 'json', 'titles': title, 'prop': 'imageinfo', 'iiprop': 'url|extmetadata', 'iiurlwidth': 900}
    page = next(iter(json.loads(get('https://commons.wikimedia.org/w/api.php?' + urllib.parse.urlencode(p)))['query']['pages'].values()))
    ii = page['imageinfo'][0]; md = ii.get('extmetadata', {})
    clean = lambda k: re.sub(r'<[^>]+>', '', (md.get(k, {}) or {}).get('value', '')).strip()
    open(f'avatar-candidates/picked/{key}.jpg', 'wb').write(get(ii['thumburl']))
    out[key] = {'title': title, 'page': ii['descriptionurl'], 'license': clean('LicenseShortName'), 'artist': clean('Artist')[:160], 'credit': clean('Credit')[:160], 'desc': clean('ImageDescription')[:200]}
    print(key, out[key]['license'])
json.dump(out, open('avatar-candidates/picked/credits.json', 'w'), indent=1, ensure_ascii=False)
