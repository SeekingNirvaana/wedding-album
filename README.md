# Anoop weds Sanghmitra · Wedding album

`album.anoopsanghmitra.com`: guests sign in with their mobile number, set up their face once with a live selfie, upload photos, and see only the photos they uploaded, the photos their face appears in, and the Highlights you pick.

```
phone ──► Worker (src/)  ──► R2  photos (private; every image request is checked)
            │  sessions,       D1  users, faces, who-can-see-what
            │  OTP, admin      Queue ──► FaceService container (face-service/)
            └──────────────────────────► SCRFD + ArcFace + anti-spoof, internet access off
```

| Folder | What it is |
|---|---|
| `src/` | Cloudflare Worker: API, sign-in, access rules, matching, admin, jobs |
| `face-service/` | Python container: face detection, recognition, liveness (`tools/` converts the anti-spoof model) |
| `public/` | Guest app (`index.html`), admin (`admin.html`), phone diagnostics (`check.html`) |
| `migrations/` | Database schema |
| `test/` | End-to-end test (51 checks) and screenshot scripts |

## One-time setup (about an hour, on a computer)

Run these from this folder after `npm ci`. Everything after this is automatic.

1. **Cloudflare plan.** Turn on *Workers Paid* ($5/month). Containers need it.

2. **Create the storage.**
   ```bash
   npx wrangler d1 create wedding-album          # copy the database_id into wrangler.jsonc
   npx wrangler r2 bucket create wedding-album
   npx wrangler queues create wedding-album-jobs
   npx wrangler queues create wedding-album-dlq
   ```

3. **Turnstile bot check.** Cloudflare dashboard → Turnstile → Add widget for `album.anoopsanghmitra.com`. Put the **site key** in `wrangler.jsonc` → `vars.TURNSTILE_SITE_KEY`, and the secret in step 5.

4. **Message Central (SMS codes).** Sign up at messagecentral.com and add some credit. From the console note your **Customer ID** and either an **auth token** or your password.

5. **Secrets.** Never commit these. `bash scripts/make-secrets.sh` prints strong random values for the first two.
   ```bash
   npx wrangler secret put PHONE_PEPPER      # long random string; never change it after launch
   npx wrangler secret put ADMIN_CODE        # long random passcode for the admin page
   npx wrangler secret put ADMIN_PHONES      # e.g. 98XXXXXXXX,97XXXXXXXX (yours and Sanghmitra's)
   npx wrangler secret put TURNSTILE_SECRET
   npx wrangler secret put MC_CUSTOMER_ID
   npx wrangler secret put MC_AUTH_TOKEN     # or MC_KEY_B64 = base64 of your Message Central password
   ```

6. **GitHub → automatic deploys.** Create a **private** repo and push this folder. In the repo's Settings → Secrets → Actions add:
   - `CLOUDFLARE_ACCOUNT_ID`
   - `CLOUDFLARE_API_TOKEN`: create it from the *Edit Cloudflare Workers* template, and add D1, Queues and Containers edit permissions.

   Every push to `main` now runs `.github/workflows/deploy.yml`. It applies database changes, builds the face-service image on GitHub's machine and deploys. The first deploy also creates `album.anoopsanghmitra.com`, because the domain is already in your Cloudflare account.

7. **Images and sounds.** Drop your generated files in `public/art/` and `public/icons/`, and the chosen ElevenLabs takes in `public/audio/` as `welcome.mp3`, `shutter.mp3`, `bell.mp3` and `found.mp3`. Anything missing is simply skipped.

### Firebase fallback (only if SMS delivery is poor)

1. In the Firebase console, enable Phone sign-in and add `album.anoopsanghmitra.com` to the authorized domains.
2. In `wrangler.jsonc` set `OTP_PROVIDER` to `firebase`, and fill in `FIREBASE_PROJECT_ID` and `FIREBASE_API_KEY`.
3. Push.

Firebase charges more per SMS; see the cost notes below.

## Before the wedding

1. **Reserve your faces first.** Sign in on your phone and Sanghmitra's and set up your faces. The admin numbers then unlock `/admin.html` with the passcode. Ask close family to do the same.
2. **Test run with 4–6 phones,** including a cheap Android and an iPhone. Each person signs in, sets up their face, and uploads ~20 photos of each other. Then:
   - Check that everyone sees only their own photos.
   - Open `/check.html` on any phone that struggles and screenshot it.
   - Note borderline matches in *Admin → Overview*. Adjust the two match thresholds if needed: raise *show automatically* if strangers' photos appear, lower it if many photos are missed.
3. **Liveness direction check.** Once the test run confirms that a real left turn passes, turn on strict left/right checking: set `envVars = { STRICT_DIRECTION: '1' }` on `FaceService` in `src/index.js` and push.
4. **Retention date.** Set *Delete all face data on* in Admin → Overview (e.g. `2027-01-31`). After that date, face data is deleted automatically. Photos stay.
5. **Share.** Admin → Share has the WhatsApp message and a printable QR table card.

## During and after

- **During the wedding:** nothing to do. Optionally hide a photo or add Highlights from the admin page on your phone.
- **Photographer's photos:** Admin → Upload. Pick many files at once; faces are scanned on the server.
- **Export everything:**
  ```bash
  npx wrangler r2 object get wedding-album/full/<id>.jpg   # or point rclone at the R2 S3 endpoint
  ```

## Local development

```bash
npm ci
pip install -r face-service/requirements.txt
# models: det_10g.onnx + w600k_r50.onnx from InsightFace buffalo_l, minifasnet_v2.onnx from face-service/models/
cd face-service/app && MODEL_DIR=/path/to/models uvicorn main:app --port 8090 &
cd ../.. && cp .dev.vars.example .dev.vars && bash test/reset-dev.sh
npm i --prefix /tmp/fx --no-save @vladmandic/face-api   # sample faces for tests only
python3 test/e2e.py                                      # 51 checks
```

Local dev uses OTP code `000000` and calls the face service directly. Both shortcuts work only when `ENVIRONMENT=development`.

## Honest limits

- **Liveness checks** use random head-turn prompts plus a fake-face model. They stop printed photos and simple screen replays. A determined attacker with video of a specific guest might still pass sometimes. The main protections are the OTP-verified number, one face per account, and your flags and revoke tools.
- **Model licences:** the InsightFace models (SCRFD, ArcFace) are licensed for non-commercial research only. Fine for a personal wedding, not for a business. MiniFASNet (anti-spoof) is Apache-2.0.
- **Costs I could not confirm exactly:** Cloudflare Containers usage (expected to be small), and Message Central's live India rate (their pages say ₹0.12–0.30 per SMS). Set a billing alert in both.
- **Message Central API:** written from their published docs, which disagree with each other on a couple of parameters. Watch the first real SMS sign-in and the Worker logs.
- **Hindi wording** in `public/js/i18n.js` should be checked by a native speaker.
- **Matching** is tuned on public sample photos. Use the test run to set the final thresholds.
