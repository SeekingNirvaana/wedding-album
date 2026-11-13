"""End-to-end test against `wrangler dev` (dev OTP code 000000) + local face service."""
import base64, os, sys, time, cv2, numpy as np, httpx
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'face-service', 'app'))
from engine import Engine

B = 'http://localhost:8787'
# Test faces: the sample photos shipped with the @vladmandic/face-api npm package (not committed here).
# Install once with: npm i --prefix /tmp/fx --no-save @vladmandic/face-api
import os
S = os.environ.get('FACE_SAMPLES', '/tmp/fx/node_modules/@vladmandic/face-api/demo/')
H = {'origin': B}
eng = Engine(os.environ.get('MODEL_DIR', '/home/claude/models'))
ok_count = 0

def check(cond, msg):
    global ok_count
    if not cond:
        print('FAIL:', msg); sys.exit(1)
    ok_count += 1; print('ok  ', msg)

def client():
    return httpx.Client(base_url=B, headers=H, timeout=60)

def login(c, phone, name, side='groom'):
    r = c.post('/api/auth/start', json={'phone': phone})
    assert r.status_code == 200, r.text
    rid = r.json()['requestId']
    r = c.post('/api/auth/verify', json={'requestId': rid, 'code': '000000', 'name': name, 'side': side, 'consent': True})
    assert r.status_code == 200, r.text
    tok = r.headers['set-cookie'].split(';')[0]
    c.headers['cookie'] = tok
    return rid

def _pick(sample, idx=None, like=None):
    fs = eng.faces(cv2.imread(S + sample), tiles=False)
    return max(fs, key=lambda f: float(f['emb'] @ like)) if like is not None else sorted(fs, key=lambda f: f['box'][0])[idx]

def _crop(sample, f, flip=False):
    img = cv2.imread(S + sample)
    x1, y1, x2, y2 = f['box']; cx, cy = (x1 + x2) / 2, (y1 + y2) / 2; s = max(x2 - x1, y2 - y1) * 2.4
    crop = cv2.resize(img[int(max(0, cy - s / 2)):int(cy + s / 2), int(max(0, cx - s / 2)):int(cx + s / 2)], (480, 480))
    # Grey out any other faces caught in the crop so the test person is the only face
    d, _ = eng.det.detect(crop, 640)
    if len(d) > 1:
        areas = (d[:, 2] - d[:, 0]) * (d[:, 3] - d[:, 1]); centre = np.abs((d[:, 0] + d[:, 2]) / 2 - 240) + np.abs((d[:, 1] + d[:, 3]) / 2 - 240)
        keep = int(np.argmin(centre))
        for i, b in enumerate(d):
            if i != keep:
                x1_, y1_, x2_, y2_ = [int(v) for v in b[:4]]; crop[max(0, y1_):y2_, max(0, x1_):x2_] = 128
    crop = cv2.flip(crop, 1) if flip else crop
    noise = np.random.randint(-3, 4, crop.shape).astype(np.int16)
    crop = np.clip(crop.astype(np.int16) + noise, 0, 255).astype(np.uint8)
    return base64.b64encode(cv2.imencode('.jpg', crop, [cv2.IMWRITE_JPEG_QUALITY, 85])[1]).decode()

def face_frames(center, turned_sample):
    """Stand-in for a live capture: a near-frontal photo of a person, another photo of the same person
    with the head turned (picked by face similarity), and its mirror image for the opposite turn."""
    c = _pick(*center); t = _pick(turned_sample, like=c['emb'])
    print(f'   test person: center yaw {c["yaw"]:.2f}, turned yaw {t["yaw"]:.2f}, similarity {float(c["emb"] @ t["emb"]):.2f}')
    return {'center': _crop(center[0], c), 'center2': _crop(center[0], c), 'left': _crop(turned_sample, t), 'right': _crop(turned_sample, t, flip=True)}

def enroll(c, frames, purpose='self', label=None):
    r = c.post('/api/enroll/challenge', json={'purpose': purpose, 'label': label})
    assert r.status_code == 200, r.text
    ch = r.json()
    seen = 0; out = []
    for k in ch['sequence']:
        out.append(frames['center2'] if (k == 'center' and seen) else frames[k]); seen += k == 'center'
    return c.post('/api/enroll/submit', json={'challengeId': ch['challengeId'], 'frames': out, 'mode': 'live'})

def upload(c, sample, event='shaadi', side='joint'):
    return c.post(f'/api/photos?event={event}&side={side}', content=open(S + sample, 'rb').read(), headers={'content-type': 'image/jpeg'})

def wait_ready(c, n, scope='mine', tries=60):
    for _ in range(tries):
        ph = c.get(f'/api/photos?scope={scope}').json()['photos']
        if len(ph) >= n and all(p['status'] == 'ready' for p in ph):
            return ph
        time.sleep(2)
    return c.get(f'/api/photos?scope={scope}').json()['photos']

anon = client()
check(anon.get('/api/me').status_code == 401, 'anonymous /api/me is 401')
check(anon.post('/api/auth/start', json={'phone': '12345'}).status_code == 400, 'invalid phone rejected')
check(httpx.post(B + '/api/auth/start', json={'phone': '9999900002'}, headers={'origin': 'https://evil.example'}).status_code == 403, 'cross-origin POST blocked')

A = client()
r = A.post('/api/auth/start', json={'phone': '9999900002'}); rid = r.json()['requestId']
check(A.post('/api/auth/verify', json={'requestId': rid, 'code': '123456', 'consent': True}).status_code == 400, 'wrong OTP rejected')
check(A.post('/api/auth/verify', json={'requestId': rid, 'code': '000000', 'name': 'Asha', 'consent': False}).status_code == 400, 'consent required for new account')
r = A.post('/api/auth/verify', json={'requestId': rid, 'code': '000000', 'name': 'Asha', 'side': 'bride', 'consent': True})
check(r.status_code == 200 and 'HttpOnly' in r.headers['set-cookie'], 'OTP sign-in sets HttpOnly cookie')
A.headers['cookie'] = r.headers['set-cookie'].split(';')[0]
check(A.post('/api/auth/start', json={'phone': '9999900002'}).status_code == 429, 'resend too soon is rate limited')
check(upload(A, 'sample1.jpg').status_code == 403, 'upload blocked before face setup')

framesP = face_frames(('sample3.jpg', 1), 'sample1.jpg')   # person P
r = enroll(A, framesP); print('   enroll A:', r.json())
check(r.status_code == 200 and r.json().get('ok'), 'A enrolls with live head-turn frames')
check(A.post('/api/enroll/challenge', json={'purpose': 'self'}).status_code == 409, 'face is locked once set')

Bc = client(); login(Bc, '9999900003', 'Bunty')
r = enroll(Bc, framesP); print('   enroll B with A\'s face:', r.json())
check(r.json().get('reason') == 'already_enrolled', "B cannot enroll A's face (one face, one account)")
framesQ = face_frames(('sample6.jpg', 2), 'sample4.jpg')   # person Q
r = enroll(Bc, framesQ); print('   enroll B:', r.json())
check(r.json().get('ok'), 'B enrolls own face')

static = {k: framesP['center'] for k in framesP}
C = client(); login(C, '9999900004', 'Chintu')
r = enroll(C, static); print('   static photo attack:', r.json())
check(r.json().get('reason') == 'turn_not_detected', 'static photo fails liveness')

check(upload(A, 'sample2.jpg').status_code == 201, 'A uploads sample2 (no P, no Q)')
check(upload(Bc, 'sample1.jpg').status_code == 201, 'B uploads sample1 (contains P)')
check(upload(A, 'sample4.jpg').status_code == 201, 'A uploads sample4 (contains Q)')
check(upload(A, 'sample5.jpg', event='haldi', side='bride').status_code == 201, 'A uploads sample5 to Haldi/bride')
check(A.post('/api/photos?event=haldi&side=joint', content=open(S+'sample1.jpg','rb').read()).status_code == 400, 'invalid event/side rejected')
check(A.post('/api/photos?event=shaadi&side=joint', content=b'GIF89a....', headers={'content-type':'image/jpeg'}).status_code == 415, 'non-JPEG rejected')

wait_ready(A, 3); wait_ready(Bc, 1)
time.sleep(4)
meA = A.get('/api/photos?scope=me').json()['photos']
meB = Bc.get('/api/photos?scope=me').json()['photos']
allB = Bc.get('/api/photos?scope=all').json()['photos']
print('   A matched:', [(p['id'][:6], p['reason']) for p in meA]); print('   B matched:', [(p['id'][:6], p['reason']) for p in meB])
b_uploads = {p['id']: p for p in Bc.get('/api/photos?scope=mine').json()['photos']}
a_uploads = {p['id']: p for p in A.get('/api/photos?scope=mine').json()['photos']}
s3 = [i for i, p in b_uploads.items() if p['faces'] == 3 and p['event'] == 'shaadi']
check(any(p['id'] in b_uploads for p in meA), "A sees B's photo that contains A's face")
q_photo = [i for i, p in a_uploads.items() if p['faces'] == 4]
check(any(p['id'] in q_photo for p in meB), "B sees A's photo that contains B's face")
a_only = [i for i, p in a_uploads.items() if p['faces'] == 3][0]   # sample2: neither P nor Q
check(all(p['id'] != a_only for p in allB), "B cannot list A's photo that doesn't contain B")
check(Bc.get(f'/img/thumb/{a_only}.jpg').status_code == 404, "B cannot open A's photo by ID")
check(A.get(f'/img/view/{a_only}.jpg').status_code == 200, 'A can open own photo')
check(anon.get(f'/img/thumb/{a_only}.jpg').status_code == 401, 'anonymous image request is 401')
check(A.get('/api/photos?scope=all&event=haldi').json()['photos'][0]['event'] == 'haldi', 'event filter works')

r = A.get(f'/img/full/{a_only}.jpg'); from PIL import Image; import io
check(len(Image.open(io.BytesIO(r.content)).getexif()) == 0, 'served photo has no EXIF/GPS')

Adm = client(); login(Adm, '9999900001', 'Anoop')
me = Adm.get('/api/me').json()
check(me['adminNeedsCode'] and not me['isAdmin'], 'admin phone still needs passcode')
check(Adm.get('/api/admin/overview').status_code == 403, 'admin API locked before passcode')
check(Adm.post('/api/admin/unlock', json={'code': 'nope'}).status_code == 401, 'wrong admin passcode rejected')
check(Adm.post('/api/admin/unlock', json={'code': 'dev-admin-code'}).status_code == 200, 'admin unlock with passcode')
ov = Adm.get('/api/admin/overview').json(); print('   overview:', ov['users'], ov['photos'], 'faces', ov['faces'])
check(ov['photos']['total'] == 4, 'admin sees all 4 photos')
check(Adm.patch(f'/api/admin/photos/{a_only}', json={'highlight': True}).status_code == 200, 'admin highlights a photo')
check(Bc.get(f'/img/thumb/{a_only}.jpg').status_code == 200, 'highlighted photo visible to everyone')
check(Adm.patch(f'/api/admin/photos/{a_only}', json={'hidden': True}).status_code == 200, 'admin hides a photo')
check(A.get(f'/img/thumb/{a_only}.jpg').status_code == 404, 'hidden photo invisible even to uploader')
check(Bc.get('/api/admin/overview').status_code == 403, 'guest cannot use admin API')
check(Adm.get('/api/photos?scope=admin').status_code == 200, 'admin moderation list works')
check(Bc.get('/api/photos?scope=highlights').status_code == 200, 'highlights list works')
check({p['id'] for p in Bc.get('/api/photos?scope=admin').json()['photos']} <= {p['id'] for p in Bc.get('/api/photos?scope=all').json()['photos']} | {p['id'] for p in Bc.get('/api/photos?scope=mine').json()['photos']}, 'guest asking for admin scope only gets what they may see')
check(Adm.put('/api/admin/settings', json={'family_max': '1', 'signup_cap': '20'}).status_code == 200, 'admin changes settings')
check(Adm.put('/api/admin/settings', json={'signup_cap': '99999'}).status_code == 400, 'out-of-range setting rejected')
fl = Adm.get('/api/admin/flags').json()['flags']; print('   flags:', [f['kind'] for f in fl])
check(any(f['kind'] == 'face_already_enrolled' for f in fl), 'duplicate face attempt flagged to admin')

r = enroll(A, face_frames(('sample1.jpg', 1), 'sample4.jpg'), purpose='family', label='Dadi'); print('   family:', r.json())
check(r.json().get('ok'), 'A adds a family face')
r = A.post('/api/enroll/challenge', json={'purpose': 'family', 'label': 'Nana'})
check(r.status_code == 403, 'family limit (set to 1 by admin) enforced')
time.sleep(5)
fam = A.get('/api/me').json()['family']
gid = fam[0]['id']; ph = A.get(f'/api/photos?scope=group:{gid}').json()['photos']
print('   Dadi photos:', len(ph))
check(len(ph) >= 1, "family member's photos appear for A")
check(Bc.get(f'/api/photos?scope=group:{gid}').json()['photos'] == [], "B cannot read A's family scope")

r = C.request('DELETE', '/api/me', json={'deleteUploads': True})
check(r.status_code == 200, 'guest can delete own account')
check(C.get('/api/me').status_code == 401, 'deleted account session is gone')

# candidates ("Is this you?") only expose face crops to the right user
cands = A.get('/api/candidates').json()['candidates']
print('   A candidates:', len(cands))
crop_ids = [c['faceId'] for c in cands]
if crop_ids:
    check(A.get(f'/img/crop/{crop_ids[0]}.jpg').status_code == 200, 'A can see own candidate face crop')
    check(Bc.get(f'/img/crop/{crop_ids[0]}.jpg').status_code == 404, "B cannot see A's candidate crop")
check(Bc.get('/img/crop/1.jpg').status_code in (404,), 'random crop IDs are not served')

# scheduled cleanup runs
check(httpx.get(B + '/__scheduled?cron=*/30+*+*+*+*').status_code == 200, 'scheduled cleanup runs')
print(f'\nALL {ok_count} CHECKS PASSED')
