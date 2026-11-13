// Visual smoke test: renders key screens on a phone-sized viewport and saves screenshots.
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
const B = 'http://localhost:8787';
const out = '/tmp/ui'; fs.mkdirSync(out, { recursive: true });
const cookie = process.argv[2];   // optional "wa_session=..." of an enrolled user
const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new',
  args: ['--no-sandbox', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
const page = await browser.newPage();
await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
const shot = async (name) => { await new Promise((r) => setTimeout(r, 900)); await page.screenshot({ path: `${out}/${name}.png` }); console.log('shot', name); };

if (!cookie) {
  await page.goto(B, { waitUntil: 'networkidle0' });
  await shot('01-gate');
  await page.click('.gate-inner .btn.primary');
  await shot('02-signin');
  await page.type('.signin input[autocomplete=name]', 'Riya');
  await page.type('.signin input[type=tel]', '9999900077');
  await page.click('.side-card[data-side=bride]');
  await page.click('#consent');
  await page.click('.signin button[type=submit]');
  await shot('03-otp');
  await page.type('.field.otp', '000000');
  await shot('04-face-intro');
  await page.click('.face-body .btn.primary');
  await new Promise((r) => setTimeout(r, 2500));
  await shot('05-camera');
} else {
  const k = cookie.slice(0, cookie.indexOf('=')), v = cookie.slice(cookie.indexOf('=') + 1);
  await page.setCookie({ name: k, value: v, domain: 'localhost', path: '/', httpOnly: true });
  await page.goto(B, { waitUntil: 'networkidle0' });
  await shot('10-for-you');
  await page.click('.nav-btn[data-tab=highlights]'); await shot('11-highlights');
  await page.click('.chip[data-ev=haldi]').catch(() => {}); await shot('12-filter');
  await page.click('.shutter'); await shot('13-upload-sheet');
  await page.mouse.click(195, 100); await new Promise((r) => setTimeout(r, 500));
  await page.click('.nav-btn[data-tab=mine]'); await shot('14-mine');
  await page.click('.grid .tile').catch(() => {}); await shot('15-viewer');
  await page.keyboard.press('Escape');
  await page.click('.nav-btn[data-tab=profile]'); await shot('16-profile');
  if (process.argv[3]) {
    const a3 = process.argv[3]; const k2 = a3.slice(0, a3.indexOf('=')), v2 = a3.slice(a3.indexOf('=') + 1);
    await page.setCookie({ name: k2, value: v2, domain: 'localhost', path: '/', httpOnly: true });
    await page.goto(B + '/admin.html', { waitUntil: 'networkidle0' }); await shot('20-admin-overview');
    for (const [i, n] of [[1, 'suggested'], [2, 'photos'], [3, 'guests'], [7, 'share']]) { await page.click(`.admin-tabs .chip:nth-child(${i + 1})`); await shot('2' + i + '-admin-' + n); }
  }
}
console.log(errors.length ? errors.join('\n') : 'no page errors');
await browser.close();
