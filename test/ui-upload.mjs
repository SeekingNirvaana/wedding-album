// Uploads two photos through the real UI (adaptive resize + IndexedDB queue + XHR) and waits for them to appear.
import puppeteer from 'puppeteer-core';
const [, , cookie] = process.argv;
const S = '/tmp/fx/node_modules/@vladmandic/face-api/demo/';
const b = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox'] });
const page = await b.newPage();
await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
const errs = []; page.on('pageerror', (e) => errs.push(e.message));
const [k, v] = cookie.split('=');
await page.setCookie({ name: k, value: v, domain: 'localhost', path: '/' });
await page.goto('http://localhost:8787/', { waitUntil: 'networkidle0' });
const before = await page.evaluate(async () => (await (await fetch('/api/photos?scope=mine')).json()).photos.length);
await page.click('.shutter');
await new Promise((r) => setTimeout(r, 500));
const [chooser] = await Promise.all([page.waitForFileChooser(), page.click('.big-act.gal')]);
await chooser.accept([S + 'sample2.jpg', S + 'sample5.jpg']);
let after = before;
for (let i = 0; i < 40 && after < before + 2; i++) {
  await new Promise((r) => setTimeout(r, 1000));
  after = await page.evaluate(async () => (await (await fetch('/api/photos?scope=mine')).json()).photos.length);
}
const sizes = await page.evaluate(async () => (await (await fetch('/api/photos?scope=mine')).json()).photos.slice(0, 2).map((p) => [p.status, p.w, p.h]));
console.log(after === before + 2 ? 'UI upload OK' : 'UI upload FAILED', before, '->', after, JSON.stringify(sizes), errs.join(' | ') || 'no page errors');
await b.close();
