"""Multi-select: zip download and bulk actions. Run after reset-dev.sh with the face service on :8090."""
import os, io, zipfile
src = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'e2e.py')).read().split("anon = client()")[0]
exec(src)
A = client(); login(A, '9999900091', 'Asha', 'bride')
check(enroll(A, face_frames(('sample3.jpg', 1), 'sample1.jpg')).json().get('ok'), 'A enrolls')
for sm, ev in [('sample1.jpg', 'haldi'), ('sample2.jpg', 'haldi'), ('sample4.jpg', 'shaadi'), ('sample5.jpg', 'mehendi')]:
    upload(A, sm, ev, 'bride' if ev != 'shaadi' else 'joint')
wait_ready(A, 4)
ids = [p['id'] for p in A.get('/api/photos?scope=mine').json()['photos']]
r = A.get('/api/photos/zip?ids=' + ','.join(ids))
check(r.status_code == 200 and r.headers['content-type'] == 'application/zip', 'zip downloads')
z = zipfile.ZipFile(io.BytesIO(r.content))
check(z.testzip() is None and len(z.namelist()) == 4, f'zip is valid with 4 photos: {z.namelist()}')
check(all(z.read(n)[:3] == b'\xff\xd8\xff' for n in z.namelist()), 'zip entries are JPEGs')
B2 = client(); login(B2, '9999900092', 'Stranger')
r = B2.get('/api/photos/zip?ids=' + ','.join(ids))
check(r.status_code == 404, 'others cannot zip photos they cannot see')
check(A.get('/api/photos/zip?ids=bad').status_code == 400, 'bad ids rejected')
check(B2.post('/api/photos/bulk', json={'action': 'delete', 'ids': ids[:2]}).status_code == 403, 'cannot bulk delete others photos')
check(A.post('/api/photos/bulk', json={'action': 'highlight', 'ids': ids[:2]}).status_code == 403, 'guest cannot bulk highlight')
Adm = client(); login(Adm, '9999900001', 'Anoop'); Adm.post('/api/admin/unlock', json={'code': 'dev-admin-code'})
check(Adm.post('/api/photos/bulk', json={'action': 'highlight', 'ids': ids[:2]}).json()['done'] == 2, 'admin bulk highlight')
check(len(B2.get('/api/photos?scope=highlights').json()['photos']) == 2, 'highlights visible to others')
r = A.post('/api/photos/bulk', json={'action': 'delete', 'ids': ids[:3]})
check(r.status_code == 200 and r.json()['done'] == 3, 'owner bulk deletes 3')
check(len(A.get('/api/photos?scope=mine').json()['photos']) == 1, 'one photo left')
check(A.get(f'/img/thumb/{ids[0]}.jpg').status_code == 404, 'deleted image gone')
print(f'\nALL {ok_count} BULK CHECKS PASSED')
