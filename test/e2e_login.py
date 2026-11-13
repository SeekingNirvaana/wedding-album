"""Login counter and daily sign-in limit. Run after reset-dev.sh."""
import os
src = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'e2e.py')).read().split("anon = client()")[0]
exec(src)
Adm = client(); login(Adm, '9999900001', 'Anoop'); Adm.post('/api/admin/unlock', json={'code': 'dev-admin-code'})
check(Adm.put('/api/admin/settings', json={'login_daily_cap': '3'}).status_code == 200, 'set limit to 3 a day')

def signin(phone):
    c = client()
    r = c.post('/api/auth/start', json={'phone': phone})
    if r.status_code != 200: return r
    return c.post('/api/auth/verify', json={'requestId': r.json()['requestId'], 'code': '000000', 'name': 'G', 'consent': True})

# The 30-second resend wait would block quick repeats; clearing it simulates time passing
import subprocess
def wipe_otp_wait():
    subprocess.run(['node_modules/.bin/wrangler', 'd1', 'execute', 'wedding-album', '--local', '-c', 'wrangler.dev.jsonc', '--command',
                    "DELETE FROM otp_requests; DELETE FROM rate WHERE k LIKE 'otp:ph:%'"], capture_output=True)

codes = []
for i in range(4):
    wipe_otp_wait()
    codes.append(signin('9999900095').status_code)
check(codes[:3] == [200, 200, 200], f'three sign-ins allowed: {codes}')
check(codes[3] == 429, 'fourth refused before any SMS is sent')
u = next(x for x in Adm.get('/api/admin/users?q=0095').json()['users'])
check(u['login_count'] == 3 and u['logins_today'] == 3, f"counter shows 3 total, 3 today: {u['login_count']}, {u['logins_today']}")
check(any(f['kind'] == 'login_limit' for f in Adm.get('/api/admin/flags').json()['flags']), 'flag raised for the couple')
check(any(x['phone_last4'] == '0095' for x in Adm.get('/api/admin/users?filter=frequent').json()['users']), 'shows under Frequent sign-ins')
check(Adm.post(f"/api/admin/users/{u['id']}", json={'action': 'reset_login'}).status_code == 200, 'admin resets the limit')
wipe_otp_wait()
check(signin('9999900095').status_code == 200, 'can sign in again after reset')

adm_codes = []
for i in range(5):
    adm_codes.append(signin('9999900001').status_code)
check(all(c == 200 for c in adm_codes), f'admins are never limited (and skip the resend wait): {adm_codes}')
me = next(x for x in Adm.get('/api/admin/users?filter=admins').json()['users'] if x['phone_last4'] == '0001')
check(me['login_count'] >= 6, f"admin sign-ins still counted: {me['login_count']}")
print(f'\nALL {ok_count} LOGIN CHECKS PASSED')
