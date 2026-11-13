#!/bin/sh
# Prints strong random values for PHONE_PEPPER and ADMIN_CODE. Paste each into `npx wrangler secret put ...`.
echo "PHONE_PEPPER: $(head -c 32 /dev/urandom | base64 | tr -d '=+/' | cut -c1-40)"
echo "ADMIN_CODE:   $(head -c 24 /dev/urandom | base64 | tr -d '=+/' | cut -c1-24)"
