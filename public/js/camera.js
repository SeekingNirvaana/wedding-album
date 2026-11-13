// Live selfie with randomized head-turn prompts. Frames are captured unmirrored (the preview is mirrored
// so it feels like a mirror). All checking happens on the server.
import { h } from './core.js';
import { fill } from './core.js';
import { t } from './i18n.js';

const FRAME_EDGE = 480;

export function cameraSupported() {
  return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
}

function grab(video) {
  const vw = video.videoWidth, vh = video.videoHeight;
  const s = FRAME_EDGE / Math.max(vw, vh);
  const c = document.createElement('canvas');
  c.width = Math.round(vw * s); c.height = Math.round(vh * s);
  c.getContext('2d').drawImage(video, 0, 0, c.width, c.height);
  return c;
}

function brightness(canvas) {
  const c = document.createElement('canvas');
  c.width = c.height = 24;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(canvas, 0, 0, 24, 24);
  const d = g.getImageData(0, 0, 24, 24).data;
  let sum = 0;
  for (let i = 0; i < d.length; i += 4) sum += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
  return sum / (d.length / 4);
}

const toB64 = (canvas) => canvas.toDataURL('image/jpeg', 0.82).split(',')[1];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Runs the live capture inside `mount`. Resolves with { frames, mode: 'live' }.
 * Throws { code: 'camera_blocked' } if the camera cannot start.
 */
export async function liveCapture(mount, sequence) {
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 720 }, height: { ideal: 720 } }, audio: false });
  } catch (e) {
    throw Object.assign(new Error('camera'), { code: 'camera_blocked' });
  }
  const video = h('video', { class: 'cam-video', playsinline: true, muted: true, autoplay: true });
  video.srcObject = stream;
  const prompt = h('p', { class: 'cam-prompt', 'aria-live': 'assertive' }, t('look_straight'));
  const arrow = h('div', { class: 'cam-arrow', 'aria-hidden': 'true' });
  const ring = h('div', { class: 'cam-ring' });
  const dots = h('div', { class: 'cam-dots' }, sequence.map(() => h('i')));
  const stage = h('div', { class: 'cam-stage' }, video, h('div', { class: 'cam-oval' }), ring, arrow);
  fill(mount, stage, prompt, dots);

  try {
    await video.play().catch(() => {});
    await new Promise((r) => (video.readyState >= 2 ? r() : video.addEventListener('loadeddata', r, { once: true })));
    await wait(600);
    // Light check: warn but continue
    for (let i = 0; i < 6 && brightness(grab(video)) < 55; i++) { prompt.textContent = t('too_dark'); await wait(700); }

    const frames = [];
    for (let i = 0; i < sequence.length; i++) {
      const step = sequence[i];
      prompt.textContent = step === 'left' ? t('turn_left') : step === 'right' ? t('turn_right') : t('look_straight');
      // The preview is mirrored, so "your left" appears on the left of the screen
      arrow.className = 'cam-arrow ' + (step === 'center' ? '' : step === 'left' ? 'go-left' : 'go-right');
      ring.style.animation = 'none'; void ring.offsetWidth; ring.style.animation = '';
      ring.classList.add('run');
      await wait(step === 'center' ? 1500 : 2300);
      frames.push(toB64(grab(video)));
      dots.children[i].classList.add('done');
      if (navigator.vibrate) navigator.vibrate(15);
    }
    prompt.textContent = t('checking');
    arrow.className = 'cam-arrow';
    return { frames, mode: 'live' };
  } finally {
    stream.getTracks().forEach((tr) => tr.stop());
  }
}

/** Fallback when live video is blocked: one photo per prompt via the system camera. */
export async function stillsCapture(mount, sequence) {
  const frames = [];
  for (let i = 0; i < sequence.length; i++) {
    const step = sequence[i];
    const file = await new Promise((resolve) => {
      const input = h('input', { type: 'file', accept: 'image/*', capture: 'user', class: 'visually-hidden' });
      const btn = h('button', { class: 'btn primary wide', onclick: () => input.click() },
        t('stills_hint', { n: i + 1, total: sequence.length }) + ' · ' + (step === 'left' ? t('turn_left') : step === 'right' ? t('turn_right') : t('look_straight')));
      input.addEventListener('change', () => resolve(input.files[0]));
      fill(mount, h('p', { class: 'muted center' }, t('face_body')), btn, input);
    });
    if (!file) throw Object.assign(new Error('cancelled'), { code: 'cancelled' });
    const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }).catch(() => null);
    if (!bmp) throw Object.assign(new Error('bad photo'), { code: 'reason_no_face' });
    const s = FRAME_EDGE / Math.max(bmp.width, bmp.height);
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * s); c.height = Math.round(bmp.height * s);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    frames.push(toB64(c));
  }
  return { frames, mode: 'stills' };
}
