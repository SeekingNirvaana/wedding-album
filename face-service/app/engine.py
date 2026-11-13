"""Face engine: SCRFD-10G detection, ArcFace R50 (WebFace600K) embeddings, MiniFASNetV2 anti-spoof.

All models run on CPU through onnxruntime. Model licences:
- SCRFD / ArcFace weights (InsightFace buffalo_l): non-commercial research use only.
- MiniFASNetV2 (Minivision Silent-Face-Anti-Spoofing): Apache-2.0.
"""
import os
import numpy as np
import cv2
import onnxruntime as ort

MODEL_DIR = os.environ.get('MODEL_DIR', '/models')

ARCFACE_DST = np.array([[38.2946, 51.6963], [73.5318, 51.5014], [56.0252, 71.7366],
                        [41.5493, 92.3655], [70.7299, 92.2041]], dtype=np.float32)


def _session(path):
    opts = ort.SessionOptions()
    opts.intra_op_num_threads = int(os.environ.get('ORT_THREADS', '0')) or os.cpu_count() or 1
    opts.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    opts.log_severity_level = 3
    return ort.InferenceSession(path, sess_options=opts, providers=['CPUExecutionProvider'])


def _nms(dets, thresh):
    x1, y1, x2, y2, scores = dets[:, 0], dets[:, 1], dets[:, 2], dets[:, 3], dets[:, 4]
    areas = (x2 - x1 + 1) * (y2 - y1 + 1)
    order = scores.argsort()[::-1]
    keep = []
    while order.size > 0:
        i = order[0]
        keep.append(i)
        xx1 = np.maximum(x1[i], x1[order[1:]]); yy1 = np.maximum(y1[i], y1[order[1:]])
        xx2 = np.minimum(x2[i], x2[order[1:]]); yy2 = np.minimum(y2[i], y2[order[1:]])
        w = np.maximum(0.0, xx2 - xx1 + 1); h = np.maximum(0.0, yy2 - yy1 + 1)
        inter = w * h
        ovr = inter / (areas[i] + areas[order[1:]] - inter)
        order = order[np.where(ovr <= thresh)[0] + 1]
    return keep


class SCRFD:
    def __init__(self, path):
        self.sess = _session(path)
        self.input_name = self.sess.get_inputs()[0].name
        self.output_names = [o.name for o in self.sess.get_outputs()]
        n = len(self.output_names)
        if n not in (6, 9):
            raise RuntimeError(f'Unexpected SCRFD outputs: {n}')
        self.fmc = 3
        self.strides = [8, 16, 32]
        self.num_anchors = 2
        self.use_kps = n == 9
        self.batched = len(self.sess.get_outputs()[0].shape) == 3
        self._centers = {}

    def _anchor_centers(self, h, w, stride):
        key = (h, w, stride)
        if key not in self._centers:
            c = np.stack(np.mgrid[:h, :w][::-1], axis=-1).astype(np.float32)
            c = (c * stride).reshape((-1, 2))
            c = np.stack([c] * self.num_anchors, axis=1).reshape((-1, 2))
            self._centers[key] = c
        return self._centers[key]

    def detect(self, img_bgr, input_size=640, thresh=0.5, max_num=0):
        """Returns (N,5) boxes [x1,y1,x2,y2,score] and (N,5,2) keypoints in image pixels."""
        h0, w0 = img_bgr.shape[:2]
        im_ratio = h0 / w0
        if im_ratio > 1:
            nh, nw = input_size, int(input_size / im_ratio)
        else:
            nw, nh = input_size, int(input_size * im_ratio)
        det_scale = nh / h0
        resized = cv2.resize(img_bgr, (nw, nh))
        det_img = np.zeros((input_size, input_size, 3), dtype=np.uint8)
        det_img[:nh, :nw, :] = resized
        blob = cv2.dnn.blobFromImage(det_img, 1.0 / 128, (input_size, input_size), (127.5, 127.5, 127.5), swapRB=True)
        outs = self.sess.run(self.output_names, {self.input_name: blob})
        scores_list, boxes_list, kps_list = [], [], []
        for idx, stride in enumerate(self.strides):
            if self.batched:
                scores = outs[idx][0]; bbox = outs[idx + self.fmc][0] * stride
                kps = outs[idx + self.fmc * 2][0] * stride if self.use_kps else None
            else:
                scores = outs[idx]; bbox = outs[idx + self.fmc] * stride
                kps = outs[idx + self.fmc * 2] * stride if self.use_kps else None
            hh, ww = input_size // stride, input_size // stride
            centers = self._anchor_centers(hh, ww, stride)
            pos = np.where(scores[:, 0] >= thresh)[0]
            if pos.size == 0:
                continue
            c = centers[pos]; d = bbox[pos]
            boxes = np.stack([c[:, 0] - d[:, 0], c[:, 1] - d[:, 1], c[:, 0] + d[:, 2], c[:, 1] + d[:, 3]], axis=-1)
            scores_list.append(scores[pos]); boxes_list.append(boxes)
            if self.use_kps:
                k = kps[pos].reshape((-1, 5, 2))
                kps_list.append(k + c[:, None, :])
        if not scores_list:
            return np.zeros((0, 5), np.float32), np.zeros((0, 5, 2), np.float32)
        scores = np.vstack(scores_list).ravel()
        boxes = np.vstack(boxes_list) / det_scale
        kpss = np.vstack(kps_list) / det_scale if self.use_kps else None
        dets = np.hstack([boxes, scores[:, None]]).astype(np.float32)
        order = scores.argsort()[::-1]
        dets = dets[order]; kpss = kpss[order] if kpss is not None else None
        keep = _nms(dets, 0.4)
        dets = dets[keep]; kpss = kpss[keep] if kpss is not None else None
        if max_num and dets.shape[0] > max_num:
            dets = dets[:max_num]; kpss = kpss[:max_num]
        return dets, kpss


class ArcFace:
    def __init__(self, path):
        self.sess = _session(path)
        self.input_name = self.sess.get_inputs()[0].name

    @staticmethod
    def align(img_bgr, kps, size=112):
        M, _ = cv2.estimateAffinePartial2D(kps.astype(np.float32), ARCFACE_DST, method=cv2.LMEDS)
        return cv2.warpAffine(img_bgr, M, (size, size), borderValue=0.0)

    def embed(self, aligned_list):
        if not aligned_list:
            return np.zeros((0, 512), np.float32)
        blob = cv2.dnn.blobFromImages(aligned_list, 1.0 / 127.5, (112, 112), (127.5, 127.5, 127.5), swapRB=True)
        out = []
        for i in range(0, blob.shape[0], 16):
            out.append(self.sess.run(None, {self.input_name: blob[i:i + 16]})[0])
        emb = np.vstack(out).astype(np.float32)
        return emb / np.linalg.norm(emb, axis=1, keepdims=True)


class AntiSpoof:
    """MiniFASNetV2, 80x80 crop at 2.7x the face box, raw BGR 0-255 input. Class 1 = real face."""

    def __init__(self, path):
        self.sess = _session(path)
        self.input_name = self.sess.get_inputs()[0].name

    @staticmethod
    def _crop(img, box, scale=2.7, out=80):
        h, w = img.shape[:2]
        x, y, bw, bh = box[0], box[1], box[2] - box[0], box[3] - box[1]
        scale = min((h - 1) / bh, (w - 1) / bw, scale)
        nw, nh = bw * scale, bh * scale
        cx, cy = x + bw / 2, y + bh / 2
        l, t, r, b = cx - nw / 2, cy - nh / 2, cx + nw / 2, cy + nh / 2
        if l < 0: r -= l; l = 0
        if t < 0: b -= t; t = 0
        if r > w - 1: l -= r - w + 1; r = w - 1
        if b > h - 1: t -= b - h + 1; b = h - 1
        crop = img[int(t):int(b) + 1, int(l):int(r) + 1]
        return cv2.resize(crop, (out, out))

    def real_prob(self, img_bgr, box):
        crop = self._crop(img_bgr, box).astype(np.float32)
        x = crop.transpose(2, 0, 1)[None]
        p = self.sess.run(None, {self.input_name: x})[0][0]
        return float(p[1])


def yaw_ratio(kps):
    """Signed horizontal nose offset relative to the eye midpoint, in eye-distance units.
    About 0 when facing the camera; magnitude grows as the head turns."""
    le, re, nose = kps[0], kps[1], kps[2]
    eye_dist = float(np.linalg.norm(re - le)) + 1e-6
    return float((nose[0] - (le[0] + re[0]) / 2) / eye_dist)


def blur_score(aligned_bgr):
    g = cv2.cvtColor(aligned_bgr, cv2.COLOR_BGR2GRAY)
    return float(cv2.Laplacian(g, cv2.CV_64F).var())


def quantize(emb):
    """int8 + per-vector scale; cosine similarity survives with negligible loss."""
    scale = float(np.max(np.abs(emb))) or 1e-6
    q = np.clip(np.round(emb / scale * 127), -127, 127).astype(np.int8)
    return q, scale


class Engine:
    def __init__(self, model_dir=MODEL_DIR):
        self.det = SCRFD(os.path.join(model_dir, 'det_10g.onnx'))
        self.rec = ArcFace(os.path.join(model_dir, 'w600k_r50.onnx'))
        self.spoof = AntiSpoof(os.path.join(model_dir, 'minifasnet_v2.onnx'))

    def faces(self, img_bgr, min_face=28, tiles=True):
        """Detect on the whole image and, for large images, on 2x2 overlapping tiles; merge with NMS."""
        h, w = img_bgr.shape[:2]
        size = 1280 if max(h, w) >= 1280 else 640
        dets, kpss = self.det.detect(img_bgr, input_size=size, thresh=0.5)
        all_d, all_k = [dets], [kpss]
        # Tiles only when the scene looks crowded or distant (tiny or no faces found): saves ~60% CPU otherwise
        small = len(dets) == 0 or float(np.min(np.minimum(dets[:, 2] - dets[:, 0], dets[:, 3] - dets[:, 1]))) < 0.035 * max(h, w)
        if tiles and max(h, w) >= 1600 and small:
            tw, th = int(w * 0.6), int(h * 0.6)
            for x0 in (0, w - tw):
                for y0 in (0, h - th):
                    d, k = self.det.detect(img_bgr[y0:y0 + th, x0:x0 + tw], input_size=1024, thresh=0.5)
                    if len(d):
                        d = d.copy(); d[:, [0, 2]] += x0; d[:, [1, 3]] += y0
                        k = k.copy(); k[:, :, 0] += x0; k[:, :, 1] += y0
                        all_d.append(d); all_k.append(k)
        dets = np.vstack(all_d); kpss = np.vstack(all_k)
        if len(dets) == 0:
            return []
        order = dets[:, 4].argsort()[::-1]
        dets, kpss = dets[order], kpss[order]
        keep = _nms(dets, 0.4)
        out = []
        for i in keep:
            x1, y1, x2, y2, s = dets[i]
            if min(x2 - x1, y2 - y1) < min_face:
                continue
            out.append({'box': [float(x1), float(y1), float(x2), float(y2)], 'score': float(s), 'kps': kpss[i]})
        if not out:
            return []
        aligned = [ArcFace.align(img_bgr, f['kps']) for f in out]
        embs = self.rec.embed(aligned)
        for f, a, e in zip(out, aligned, embs):
            f['emb'] = e
            f['blur'] = blur_score(a)
            f['yaw'] = yaw_ratio(f['kps'])
            side = min(f['box'][2] - f['box'][0], f['box'][3] - f['box'][1])
            # 0..1 quality from size, sharpness, pose and detector confidence
            q_size = min(1.0, side / 96.0)
            q_blur = min(1.0, f['blur'] / 120.0)
            q_pose = max(0.0, 1.0 - abs(f['yaw']) / 0.6)
            f['quality'] = float(round(0.35 * q_size + 0.25 * q_blur + 0.2 * q_pose + 0.2 * f['score'], 3))
        return out
