# Deploying to a DigitalOcean droplet

Serves the app at **`http://YOUR_DROPLET_IP/components-inventory/`** — no domain
needed. Everything it owns lives under that one path prefix, so it is easy to
remove later and easy to put other apps alongside it.

The app is a static Vite bundle plus **one** server-side dependency: the
`/components-inventory/api/lcsc-detail` proxy that the "Add Manually" LCSC
lookup calls. On Cloudflare Pages that is `functions/api/lcsc-detail.ts`; on the
droplet, nginx does the same job via `deploy/nginx.conf`. Skip it and the app
still loads and imports CSV/BOM fine, but every LCSC lookup fails.

No Node process runs on the droplet — nginx serves the built files and proxies
that one path. There is no service user to create: nothing here executes.

## One-time droplet setup

Ubuntu 22.04/24.04, from your machine:

```bash
DROPLET=root@YOUR_DROPLET_IP ./deploy/setup.sh
```

That installs nginx and rsync, creates `/var/www/components-inventory`, uploads
and enables the site config, removes Ubuntu's stock nginx site, and opens the
firewall if `ufw` is active. It is idempotent — re-run it any time the droplet's
nginx config looks wrong.

**Removing the stock site matters.** It declares `listen 80 default_server`, so
while it is enabled it wins every request on the bare IP and this app 404s.
`deploy/nginx.conf` also declares `default_server`, so if both are enabled
`nginx -t` fails loudly with "duplicate default server" rather than silently
serving the wrong site.

## Deploying

```bash
DROPLET=root@YOUR_DROPLET_IP ./deploy/deploy.sh
```

Builds locally and rsyncs `dist/` up, so the droplet needs no Node toolchain.
Re-run it for every deploy. It also:

- **preflights** — refuses to build if nginx is missing, the site is not
  enabled, or the stock default site is back, and names the fix
- **re-pushes `deploy/nginx.conf`** every run, so the repo stays the source of
  truth and the droplet cannot drift onto a stale config
- **smoke tests** the deployed URL afterwards and exits non-zero on anything
  but a 200

## The base path

The build is base-path aware. `npm run build` targets the site root (Cloudflare
Pages); `deploy.sh` builds with `BASE_PATH=/components-inventory/` so every
asset URL *and* the API call are prefixed. The two must agree — if you change
the prefix, change it in **both** `deploy/deploy.sh` and `deploy/nginx.conf`.

To serve from the droplet's root instead, set `BASE_PATH=/` and strip the
`/components-inventory` prefix from the location blocks in `nginx.conf`.

## Removing it later

No user, no service, no cron — just files and one nginx site:

```bash
DROPLET=root@YOUR_DROPLET_IP ./deploy/teardown.sh
```

It lists what it found, asks before deleting, and verifies afterwards. It
leaves nginx installed, since other sites may need it. `FORCE=1` skips the
prompt.

By hand, if you prefer:

```bash
rm -rf /var/www/components-inventory
rm -f /etc/nginx/sites-enabled/components-inventory
rm -f /etc/nginx/sites-available/components-inventory
rm -f /var/log/nginx/components-inventory.*
nginx -t && systemctl reload nginx
```

## HTTPS (optional)

Plain HTTP is fine for this app — there is no login, nothing secret in transit,
and no browser API here needs a secure context. You get a "Not secure" label and
anyone on the network path can read or tamper with the traffic; for a personal
parts inventory that is usually an acceptable trade.

If you do want a real certificate without buying a domain, the least-effort
route is a free wildcard-DNS hostname that resolves to your IP, then ordinary
Let's Encrypt. `sslip.io` needs no signup — `203.0.113.10.sslip.io` resolves to
`203.0.113.10`:

```bash
# on the droplet — replace the IP in the hostname with yours
sed -i 's/server_name _;/server_name 203.0.113.10.sslip.io;/' \
  /etc/nginx/sites-available/components-inventory
nginx -t && systemctl reload nginx

apt install -y certbot python3-certbot-nginx
certbot --nginx -d 203.0.113.10.sslip.io
```

Certbot rewrites the config for TLS and installs a renewal timer. The app is
then at `https://203.0.113.10.sslip.io/components-inventory/`.

`duckdns.org` is the same idea with a nicer hostname, at the cost of a signup.
A real domain works identically — point an A record at the droplet and use it
in place of the hostname above.

**Whichever you pick: the origin changes.** The inventory lives in
`localStorage`, which is per-origin, so moving from `http://IP` to
`https://hostname` starts you with an empty inventory. **Export CSV first**,
then Import CSV on the new URL.

## Why the proxy config looks the way it does

LCSC's product API returns everything the app needs but sends no CORS headers,
so the browser cannot call it directly. It also sits behind Akamai, which
returns **403** in two cases worth knowing about:

- a request with **no** `User-Agent` (nginx would forward the browser's, but the
  Cloudflare Worker sends none by default — hence the explicit UA in both)
- a request carrying the **browser's own** forwarded header set (`Origin`,
  `Referer`, `Sec-Fetch-*`, `sec-ch-ua`, `Cookie`)

So `deploy/nginx.conf` clears those headers (`proxy_set_header X "";` makes
nginx drop a header) and sends a minimal `Accept` + `User-Agent` pair instead.
If LCSC lookups start returning 502/403 after a config edit, that is the first
thing to check.

## Verifying

```bash
curl -s "http://YOUR_DROPLET_IP/components-inventory/api/lcsc-detail?productCode=C14663" | head -c 200
```

Expect JSON starting with `{"code":200,...,"productCode":"C14663"`. An Akamai
"Access Denied" HTML page means a header is leaking through.

## Note on the Cloudflare path

`npm run deploy` still deploys to Cloudflare Pages at the site root, and
`functions/` is still the proxy there. The two targets are independent — keep
both or drop whichever you stop using.
