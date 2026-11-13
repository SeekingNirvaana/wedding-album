import { device, net } from './core.js';
const list = document.getElementById('list');
const row = (k, v) => { const li = document.createElement('li'); li.textContent = `${k}: ${v}`; list.append(li); };
const c = navigator.connection || {};
row('Browser', navigator.userAgent);
row('Memory (GB)', navigator.deviceMemory ?? 'unknown');
row('CPU cores', navigator.hardwareConcurrency ?? 'unknown');
row('Lite mode', device.lite ? 'yes' : 'no');
row('Network', `${c.effectiveType || 'unknown'} · ${c.downlink ?? '?'} Mbps hint · upload tier ${net.tier()}`);
row('Data saver', c.saveData ? 'on' : 'off');
row('Camera API', navigator.mediaDevices?.getUserMedia ? 'yes' : 'no');
row('Resize on decode', 'createImageBitmap' in window ? 'yes' : 'no');
row('Offline storage', 'indexedDB' in window ? 'yes' : 'no');
row('Screen', `${screen.width}x${screen.height} @${devicePixelRatio}x`);
navigator.storage?.estimate?.().then((e) => row('Free storage', e.quota ? Math.round((e.quota - e.usage) / 1e6) + ' MB' : 'unknown'));
document.getElementById('cam').onclick = async () => {
  try {
    const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' } });
    const v = document.getElementById('v'); v.srcObject = s; await v.play();
    row('Camera', `${v.videoWidth}x${v.videoHeight} OK`);
  } catch (e) { row('Camera', 'blocked: ' + e.name); }
};
