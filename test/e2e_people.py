"""People list, access levels, helpers and face-from-photo. Run after reset-dev.sh, with the face service on :8090."""
import os, time
src = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'e2e.py')).read().split("anon = client()")[0]
exec(src)

# Admin + an uploader with photos on both sides
Adm = client(); login(Adm, '9999900001', 'Anoop')
check(Adm.post('/api/admin/unlock', json={'code': 'dev-admin-code'}).status_code == 200, 'admin unlocks')
U = client(); login(U, '9999900050', 'Uploader', 'groom')
check(enroll(U, face_frames(('sample3.jpg', 1), 'sample1.jpg')).json().get('ok'), 'uploader enrolls')
for sm, ev, sd in [('sample2.jpg', 'haldi', 'groom'), ('sample4.jpg', 'haldi', 'bride'), ('sample5.jpg', 'shaadi', 'joint'), ('sample6.jpg', 'mehendi', 'bride')]:
    check(upload(U, sm, ev, sd).status_code == 201, f'upload {ev}/{sd}')
wait_ready(U, 4)

# Add people: one by one and as a list
r = Adm.post('/api/admin/people', json={'people': [
    {'name': 'Mausi', 'phone': '99999 00061', 'side': 'bride', 'category': 'Family', 'subcategory': 'Maternal side', 'relation': 'Mausi', 'closeness': 2, 'access': 'family'},
    {'name': 'Bhaiya', 'phone': '+91 9999900062', 'side': 'groom', 'category': 'Family', 'closeness': 1, 'access': 'inner'},
    {'name': 'Rohan', 'phone': '9999900063', 'side': 'groom', 'category': 'Friends', 'subcategory': 'IIT Madras', 'closeness': 1, 'access': 'helper'},
    {'name': 'Colleague', 'phone': '9999900064', 'side': 'groom', 'category': 'Colleagues', 'closeness': 3},
    {'name': 'Bad', 'phone': '12345'},
]})
d = r.json()
check(r.status_code == 200 and len(d['added']) == 4 and d['invalid'] == ['Bad'], 'people added, bad number reported')
r = Adm.post('/api/admin/people', json={'people': [{'name': 'Mausi ji', 'phone': '9999900061', 'side': 'bride', 'access': 'family', 'closeness': 1}]})
check(len(r.json()['updated']) == 1, 'same number updates instead of duplicating')
users = Adm.get('/api/admin/users?filter=listed').json()['users']
check(len([u for u in users if u['listed']]) == 4, 'four listed people')
check(all('phone' not in u and len(u['phone_last4']) == 4 for u in users), 'only last 4 digits returned')
check(len(Adm.get('/api/admin/users?category=Friends').json()['users']) == 1, 'filter by category')
check('Maternal side' in Adm.get('/api/admin/users').json()['subcategories'], 'sub-groups listed for suggestions')

# A listed person must still accept the privacy notice on first sign-in
c = client()
rid = c.post('/api/auth/start', json={'phone': '9999900061'}).json()['requestId']
r = c.post('/api/auth/verify', json={'requestId': rid, 'code': '000000', 'name': 'typo name', 'side': 'groom'})
check(r.status_code == 400 and r.json().get('code') == 'consent', 'listed person still needs consent')
r = c.post('/api/auth/verify', json={'requestId': rid, 'code': '000000', 'name': 'typo name', 'side': 'groom', 'consent': True})
check(r.status_code == 200, 'same code works once consent is given')
Mausi = client(); Mausi.headers['cookie'] = r.headers['set-cookie'].split(';')[0]
me = Mausi.get('/api/me').json()
check(me['access'] == 'family' and me['user']['name'] == 'Mausi ji' and me['user']['side'] == 'bride', 'listed name, side and access kept on sign-in')

# Visibility by access level
def scope_all(c):
    return {(p['event'], p['side']) for p in c.get('/api/photos?scope=all').json()['photos']}
seen = scope_all(Mausi)
check(('haldi', 'bride') in seen and ('mehendi', 'bride') in seen and ('shaadi', 'joint') in seen, 'family sees their side and joint events')
check(('haldi', 'groom') not in seen, 'family does not see the other side')
groom_photo = next(p for p in U.get('/api/photos?scope=mine').json()['photos'] if p['side'] == 'groom')
check(Mausi.get(f"/img/thumb/{groom_photo['id']}.jpg").status_code == 404, 'family cannot open other-side image by URL')
Bhaiya = client(); login(Bhaiya, '9999900062', 'Bhaiya')
check(len(scope_all(Bhaiya)) == 4, 'inner circle sees everything')
Col = client(); login(Col, '9999900064', 'Colleague')
check(len(scope_all(Col)) == 0, 'standard guest sees nothing they are not in')

# Helpers moderate; others cannot
Rohan = client(); login(Rohan, '9999900063', 'Rohan')
me = Rohan.get('/api/me').json()
check(me['canModerate'] and me['access'] == 'helper', 'helper flagged')
check(Rohan.get('/api/mod/suggestions').status_code == 200, 'helper sees suggestions')
check(Rohan.patch(f"/api/mod/photos/{groom_photo['id']}", json={'highlight': True}).status_code == 200, 'helper adds a Highlight')
check(Col.patch(f"/api/mod/photos/{groom_photo['id']}", json={'highlight': False}).status_code == 403, 'guest cannot moderate')
check(Rohan.get('/api/admin/users').status_code == 403, 'helper cannot open admin people list')
check(Rohan.patch(f"/api/mod/photos/{groom_photo['id']}", json={'event': 'vidai'}).status_code == 400, 'helper cannot move photos')
check(('haldi', 'groom') in scope_all(Col), 'Highlight now visible to everyone')

# Change access later
uid = next(u['id'] for u in Adm.get('/api/admin/users?q=Colleague').json()['users'])
check(Adm.patch(f'/api/admin/users/{uid}', json={'access': 'inner', 'closeness': 2, 'category': 'Friends', 'subcategory': 'Bajaj'}).status_code == 200, 'admin edits a person')
check(len(scope_all(Col)) == 4, 'new access applies immediately')
check(Adm.patch(f'/api/admin/users/{uid}', json={'access': 'superuser'}).status_code == 400, 'invalid access rejected')

# Face from a photo: grandparent without a phone, attached to Bhaiya's album; and a listed person set up in advance
Adm.post('/api/admin/people', json={'people': [{'name': 'Dadaji', 'phone': '9999900070', 'side': 'groom', 'category': 'Family', 'closeness': 1}]})
dada = next(u for u in Adm.get('/api/admin/users?q=Dadaji').json()['users'])
r = Adm.post('/api/admin/faces/preview', content=open(S + 'sample2.jpg', 'rb').read(), headers={'content-type': 'image/jpeg'})
check(r.status_code == 200 and len(r.json()['faces']) >= 1, 'faces found in photo')
pv = r.json()
best = max(pv['faces'], key=lambda f: f['quality'])
r = Adm.post('/api/admin/faces', json={'previewId': pv['previewId'], 'index': best['i'], 'userId': dada['id'], 'as': 'self'})
check(r.status_code == 200, 'face set for listed person before they join')
dada = next(u for u in Adm.get('/api/admin/users?q=Dadaji').json()['users'])
check(dada['enrolled'] == 1 and dada['signed_in'] == 0, 'shows face set, not joined')
r = Adm.post('/api/admin/faces', json={'previewId': pv['previewId'], 'index': best['i'], 'userId': dada['id'], 'as': 'self'})
check(r.status_code in (400, 409), 'preview cannot be reused')
check(Mausi.post('/api/admin/faces/preview', content=b'x', headers={'content-type': 'image/jpeg'}).status_code == 403, 'non-admin cannot add faces')
Dada = client(); login(Dada, '9999900070', 'Dadaji')
check(Dada.get('/api/me').json()['user']['enrolled'], 'person lands already set up on first sign-in')
time.sleep(3)
mine = Dada.get('/api/photos?scope=me').json()['photos']
check(len(mine) >= 1, f'their photos were found ({len(mine)})')

# Scheduled cleanup keeps listed people who have not joined yet
Adm.post('/api/admin/people', json={'people': [{'name': 'Later', 'phone': '9999900071'}]})
httpx.get(B + '/__scheduled?cron=*/30+*+*+*+*')
check(any(u['name'] == 'Later' for u in Adm.get('/api/admin/users?q=Later').json()['users']), 'cleanup keeps listed people')

# Unlisting someone who never joined removes them
later = next(u for u in Adm.get('/api/admin/users?q=Later').json()['users'])
Adm.post(f"/api/admin/users/{later['id']}", json={'action': 'unlist'})
check(not Adm.get('/api/admin/users?q=Later').json()['users'], 'unlisting a never-joined person removes them')

print(f'\nALL {ok_count} PEOPLE CHECKS PASSED')
