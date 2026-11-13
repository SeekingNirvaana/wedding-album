#!/bin/sh
# Fresh local state + restart wrangler dev
cd "$(dirname "$0")/.."
pkill -f "wrangler dev" 2>/dev/null; pkill -f workerd 2>/dev/null; sleep 1
rm -rf .wrangler/state
node_modules/.bin/wrangler d1 migrations apply wedding-album --local -c wrangler.dev.jsonc >/dev/null 2>&1
nohup node_modules/.bin/wrangler dev -c wrangler.dev.jsonc --port 8787 --local --test-scheduled > /tmp/wd.log 2>&1 &
for i in $(seq 1 30); do curl -s localhost:8787/api/config >/dev/null 2>&1 && break; sleep 1; done
echo "dev ready"
