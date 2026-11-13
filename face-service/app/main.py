"""Face service. Reachable only through the Worker's container binding (internet access disabled).

POST /process   raw JPEG body            -> re-encoded renditions + faces (int8 embeddings, crops)
POST /liveness  {sequence, frames[b64]}  -> pass/fail + face template
GET  /          health check
"""
import base64
import io
import os
import time

import cv2
import numpy as np
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from PIL import Image, ImageOps

from engine import Engine, quantize, yaw_ratio, blur_score

MAX_INPUT = 15 * 1024 * 1024
STRICT_DIRECTION = os.environ.get('STRICT_DIRECTION', '0') == '1'
Image.MAX_IMAGE_PIXELS = 60_000_000  # guard against decompression bombs

app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
engine = Engine()


def _b64(b: bytes) -> str:
    return base64.b64encode(b).decode('ascii')


def _jpeg(img: Image.Image, max_edge: int, quality: int) -> tuple[bytes, int, int]:
    im = img.copy()
    im.thumbnail((max_edge, max_edge), Image.LANCZOS)
    buf = io.BytesIO()
    im.save(buf, 'JPEG', quality=quality, optimize=True, progressive=True)  # no EXIF written
    return buf.getvalue(), im.width, im.height


def _emb_out(e):
    q, scale = quantize(e)
    return {'q': _b64(q.tobytes()), 's': round(scale, 6)}


@app.get('/')
def health():
    return {'ok': True}


@app.post('/process')
async def process(request: Request):
    raw = await request.body()
    if not raw or len(raw) > MAX_INPUT:
        raise HTTPException(413, 'bad size')
    t0 = time.time()
    try:
        img = Image.open(io.BytesIO(raw))
        img = ImageOps.exif_transpose(img).convert('RGB')
    except Exception:
        raise HTTPException(415, 'not an image')
    full, fw, fh = _jpeg(img, 2560, 86)
    view, _, _ = _jpeg(img, 1280, 80)
    thumb, _, _ = _jpeg(img, 480, 72)

    work = img.copy()
    work.thumbnail((2560, 2560), Image.LANCZOS)
    bgr = cv2.cvtColor(np.asarray(work), cv2.COLOR_RGB2BGR)
    H, W = bgr.shape[:2]
    faces = []
    for f in engine.faces(bgr):
        x1, y1, x2, y2 = f['box']
        cx, cy, side = (x1 + x2) / 2, (y1 + y2) / 2, max(x2 - x1, y2 - y1) * 1.6
        l, t = int(max(0, cx - side / 2)), int(max(0, cy - side / 2))
        r, b = int(min(W, cx + side / 2)), int(min(H, cy + side / 2))
        crop = cv2.resize(bgr[t:b, l:r], (160, 160), interpolation=cv2.INTER_AREA)
        ok, enc = cv2.imencode('.jpg', crop, [cv2.IMWRITE_JPEG_QUALITY, 80])
        faces.append({
            'box': [round(x1 / W, 4), round(y1 / H, 4), round((x2 - x1) / W, 4), round((y2 - y1) / H, 4)],
            'score': round(f['score'], 3),
            'quality': f['quality'],
            'yaw': round(f['yaw'], 3),
            'emb': _emb_out(f['emb']),
            'crop': _b64(enc.tobytes()) if ok else None,
        })
    return JSONResponse({
        'w': fw, 'h': fh,
        'full': _b64(full), 'view': _b64(view), 'thumb': _b64(thumb),
        'faces': faces,
        'ms': int((time.time() - t0) * 1000),
    })


@app.post('/liveness')
async def liveness(request: Request):
    body = await request.json()
    seq = body.get('sequence') or []
    frames_b64 = body.get('frames') or []
    if not (3 <= len(seq) <= 6) or len(seq) != len(frames_b64):
        raise HTTPException(400, 'bad sequence')

    frames = []
    for s in frames_b64:
        try:
            raw = base64.b64decode(s, validate=True)
        except Exception:
            raise HTTPException(400, 'bad frame')
        if len(raw) > 400_000:
            raise HTTPException(413, 'frame too large')
        arr = cv2.imdecode(np.frombuffer(raw, np.uint8), cv2.IMREAD_COLOR)
        if arr is None:
            raise HTTPException(400, 'bad frame')
        frames.append(arr)

    per = []
    for kind, img in zip(seq, frames):
        dets, kpss = engine.det.detect(img, input_size=640, thresh=0.5)
        if len(dets) == 0:
            return {'pass': False, 'reason': 'no_face', 'frame': kind}
        areas = (dets[:, 2] - dets[:, 0]) * (dets[:, 3] - dets[:, 1])
        i = int(np.argmax(areas))
        box, kps = dets[i][:4], kpss[i]
        if min(box[2] - box[0], box[3] - box[1]) < 64:
            return {'pass': False, 'reason': 'too_far', 'frame': kind}
        aligned = engine.rec.align(img, kps)
        emb = engine.rec.embed([aligned])[0]
        per.append({
            'kind': kind, 'emb': emb, 'yaw': yaw_ratio(kps),
            'real': engine.spoof.real_prob(img, box) if kind == 'center' else None,
            'blur': blur_score(aligned), 'gray': cv2.cvtColor(cv2.resize(img, (64, 64)), cv2.COLOR_BGR2GRAY).astype(np.float32),
        })

    centers = [p for p in per if p['kind'] == 'center']
    turns = {p['kind']: p for p in per if p['kind'] in ('left', 'right')}
    if not centers or set(turns) != {'left', 'right'}:
        raise HTTPException(400, 'sequence must include center, left and right')

    ref = np.mean([p['emb'] for p in centers], axis=0)
    ref /= np.linalg.norm(ref)
    sims = {p['kind'] + str(i): float(p['emb'] @ ref) for i, p in enumerate(per)}
    yaws = {p['kind'] + str(i): round(p['yaw'], 3) for i, p in enumerate(per)}
    real = [p['real'] for p in centers]
    result = {'yaws': yaws, 'sims': {k: round(v, 3) for k, v in sims.items()}, 'real': [round(r, 3) for r in real]}

    # 1. same person throughout
    for p in per:
        need = 0.40 if p['kind'] == 'center' else 0.28
        if float(p['emb'] @ ref) < need:
            return {**result, 'pass': False, 'reason': 'identity_changed'}
    # 2. real head turns in both directions
    yl, yr = turns['left']['yaw'], turns['right']['yaw']
    yc = float(np.mean([p['yaw'] for p in centers]))
    if abs(yc) > 0.30 or abs(yl - yc) < 0.15 or abs(yr - yc) < 0.15 or np.sign(yl - yc) == np.sign(yr - yc):
        return {**result, 'pass': False, 'reason': 'turn_not_detected'}
    # Turning to your own left moves the nose toward image-right in an unmirrored front-camera frame
    if STRICT_DIRECTION and not (yl - yc > 0 and yr - yc < 0):
        return {**result, 'pass': False, 'reason': 'wrong_direction'}
    # 3. not a print or a screen
    if np.mean(real) < 0.6 or min(real) < 0.35:
        return {**result, 'pass': False, 'reason': 'spoof_suspected'}
    # 4. frames are not one frozen image
    diffs = [float(np.mean(np.abs(per[i]['gray'] - per[i + 1]['gray']))) for i in range(len(per) - 1)]
    if max(diffs) < 1.5:
        return {**result, 'pass': False, 'reason': 'static_frames'}

    template = [_emb_out(ref), _emb_out(turns['left']['emb']), _emb_out(turns['right']['emb'])]
    quality = float(np.clip(np.mean([min(1.0, p['blur'] / 120.0) for p in centers]), 0, 1))
    return {**result, 'pass': True, 'template': template, 'quality': round(quality, 3)}
