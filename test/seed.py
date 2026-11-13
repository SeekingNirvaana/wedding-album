"""Seeds a demo user with face + photos for UI screenshots; prints the session cookie."""
import sys, time
import os
src = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'e2e.py')).read().split("anon = client()")[0]
exec(src)
A = client(); login(A, '9999900021', 'Asha', 'bride')
assert enroll(A, face_frames(('sample3.jpg', 1), 'sample1.jpg')).json().get('ok')
for sm, ev, sd in [('sample1.jpg', 'mehendi', 'bride'), ('sample2.jpg', 'haldi', 'groom'), ('sample3.jpg', 'shaadi', 'joint'), ('sample4.jpg', 'vidai', 'joint'), ('sample5.jpg', 'haldi', 'bride'), ('sample6.jpg', 'shaadi', 'joint')]:
    upload(A, sm, ev, sd)
wait_ready(A, 6)
Adm = client(); login(Adm, '9999900001', 'Anoop'); Adm.post('/api/admin/unlock', json={'code': 'dev-admin-code'})
for p in Adm.get('/api/photos?scope=admin').json()['photos'][:3]:
    Adm.patch(f"/api/admin/photos/{p['id']}", json={'highlight': True})
print(A.headers['cookie'])
print(Adm.headers['cookie'])
