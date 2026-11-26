import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
const B = 'http://localhost:8787', c0 = process.argv[2];
const k = c0.slice(0, c0.indexOf('=')), v = c0.slice(c0.indexOf('=') + 1);
const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const errs = []; page.on('pageerror', (e) => errs.push(e.message));
await page.setCookie({ name: k, value: v, domain: 'localhost', path: '/', httpOnly: true });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
// Make every 7th upload fail once with a server error, to prove retries happen on their own
let n = 0; const failedOnce = new Set();
await page.setRequestInterception(true);
page.on('request', (req) => {
  if (req.method() === 'POST' && req.url().includes('/api/photos?')) {
    n++;
    if (n % 7 === 0 && !failedOnce.has(n)) { failedOnce.add(n); return req.respond({ status: 503, contentType: 'application/json', body: '{"error":"busy"}' }); }
  }
  req.continue();
});
await page.goto(B, { waitUntil: 'networkidle0' }); await wait(600);
await page.click('.shutter'); await wait(500);
const input = await page.$('input[type=file][multiple]');
const files = fs.readdirSync('/tmp/batch').map((f) => '/tmp/batch/' + f);
const t0 = Date.now();
await input.uploadFile(...files);
await wait(2500); await page.screenshot({ path: '/tmp/wow/u1-progress.png' });
let line = '';
for (let i = 0; i < 90; i++) {
  await wait(2000);
  line = await page.evaluate(() => document.querySelector('.queue-card .q-head b')?.textContent + ' | ' + (document.querySelector('.queue-card .q-line')?.textContent || '') + ' | ' + [...document.querySelectorAll('.q-line.warn')].map((e) => e.textContent).join(' / ') || 'queue empty');
  if (i % 5 === 0) console.log(Math.round((Date.now() - t0) / 1000) + 's', line);
  const sentTxt = await page.evaluate(() => document.querySelector('.queue-card .q-head b')?.textContent || '');
  const m = sentTxt.match(/(\d+) \/ (\d+)/);
  if (m && Number(m[1]) >= 60) { await wait(3000); break; }
}
await page.screenshot({ path: '/tmp/wow/u2-end.png' });
console.log('final:', line, '| injected failures:', failedOnce.size, '| total POSTs:', n);
console.log(errs.join('\n') || 'no page errors');
await browser.close();
