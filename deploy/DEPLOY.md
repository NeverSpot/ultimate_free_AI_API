# Deploying Ultimate Free AI on one Oracle Cloud box

Single-box production runbook: ARM `A1.Flex`, Docker Compose, nginx TLS, images from GHCR.
Run every command on the box as a user in the `docker` group. `<host>` is defined in section 1.

## 0. What you need

- An Oracle Cloud account with A1.Flex (ARM) capacity
- A public IPv4 address
- A Brevo SMTP relay login
- GitHub + Google OAuth apps (created later)
- The GHCR image tags produced by the release workflow

## 1. Provision the instance

In the Oracle Cloud console, create an instance with shape VM.Standard.A1.Flex, 2 OCPU / 12 GB memory, Ubuntu 24.04, a 200 GB boot volume, and a public IPv4 address. Record that public IP; `<host>` in this runbook is the dashed form of that IP with the sslip.io suffix, e.g. 129.146.1.2 becomes 129-146-1-2.sslip.io. Use this exact compose command everywhere below:

```bash
cd /opt/ultimate
DC="docker compose --env-file .env.prod -f docker-compose.yml -f docker-compose.prod.yml -f deploy/docker-compose.deploy.yml --profile app"
```

`--env-file .env.prod` is required because compose only auto-loads `.env`, and the production overlay uses `${VAR:?}` so any missing value aborts the command instead of booting a broken gateway.

## 2. Open the VCN security list

Networking -> VCN -> Security Lists -> default security list -> Add Ingress Rules: source 0.0.0.0/0, IP protocol TCP, destination port range 80; repeat for 443.

## 3. Open the host firewall (Oracle Ubuntu images ship a REJECT rule)

The Oracle Ubuntu image pre-seeds a REJECT at the end of INPUT, so opening the VCN is not enough and this is the classic "works locally, dead from outside" trap.

```bash
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 80 -j ACCEPT
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 443 -j ACCEPT
sudo netfilter-persistent save
```

Verify from your laptop, not from the box: `curl -sS -o /dev/null -w '%{http_code}\n' http://<host>/` (connection refused vs 301 tells you the firewall is still closed).

## 4. Add 2 GB of swap

```bash
sudo fallocate -l 2G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

## 5. Install Docker

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker "$USER"
```

Log out and back in (or `newgrp docker`) so the group change applies, then `docker run --rm hello-world`.

## 6. Clone the repository

```bash
sudo mkdir -p /opt/ultimate && sudo chown "$USER":"$USER" /opt/ultimate
git clone https://github.com/neverspot/Ultimate_frre_ai.git /opt/ultimate
cd /opt/ultimate
```

## 7. Create .env.prod

```bash
cp deploy/.env.prod.example .env.prod
chmod 600 .env.prod
openssl rand -hex 32   # run once per secret below, never reuse a value
```

Fill these values:

- `POSTGRES_PASSWORD` = `openssl rand -hex 24`.
- `ADMIN_TOKEN`, `MASTER_ENCRYPTION_KEY`, `JWT_SECRET` = `openssl rand -hex 32` each, all distinct (`MASTER_ENCRYPTION_KEY` decrypts provider keys, gateway keys and OAuth accounts - rotating it later silently orphans all three).
- `MAIL_TRANSPORT=smtp` and `MAIL_FROM` = the verified Brevo sender.
- `SMTP_USER` / `SMTP_PASS` = Brevo SMTP login and key.
- `CORS_ORIGIN` = `https://<host>`.
- `FRONTEND_URL` = `https://<host>`.
- `OAUTH_CALLBACK_BASE` = `https://<host>` with NO trailing slash.
- The four `GOOGLE_*`/`GITHUB_*` client values.
- Leave `NEXT_PUBLIC_SITE_URL=` to be set at build time (see Gotchas).
- Provider `*_KEYS` stay unset - strict BYOK.

`NEXT_PUBLIC_API_URL` is deliberately unset so the frontend uses relative `/v1` on the same origin.

## 8. Write the placeholder certificate

```bash
./deploy/gen-dev-cert.sh
```

nginx.conf points at `/etc/letsencrypt/live/app/fullchain.pem`; without a file there the container crash-loops on a missing `ssl_certificate`. The script writes a 30-day self-signed cert only if none exists, so it is safe to re-run.

## 9. Pull and start the stack

```bash
$DC pull
$DC up -d --wait
$DC ps
```

Expected: `migrate` exited 0, `gateway`, `frontend`, `nginx`, `postgres`, `redis` healthy, no restart loop. If a container dies with `exec format error` the GHCR package is amd64, not arm64. The site is now reachable over HTTPS with a certificate warning (self-signed placeholder).

## 10. Issue the real certificate

```bash
sudo apt-get update && sudo apt-get install -y certbot
sudo certbot certonly --webroot -w /opt/ultimate/deploy/acme --config-dir /opt/ultimate/deploy/certs --cert-name app -d <host>
$DC exec nginx nginx -s reload
```

`--config-dir` must be `/opt/ultimate/deploy/certs` because that directory is bind-mounted at `/etc/letsencrypt`; the default `/etc/letsencrypt` on the host would leave nginx serving the placeholder. `--webroot` works because nginx serves `/var/www/certbot` on port 80 for `/.well-known/acme-challenge/`. `--cert-name app` must match the `/live/app/` path nginx.conf expects. Renewal: `echo '17 3 * * * certbot renew --webroot -w /opt/ultimate/deploy/acme --config-dir /opt/ultimate/deploy/certs --quiet && docker compose --env-file /opt/ultimate/.env.prod -f /opt/ultimate/docker-compose.yml -f /opt/ultimate/docker-compose.prod.yml -f /opt/ultimate/deploy/docker-compose.deploy.yml exec nginx nginx -s reload' | sudo tee /etc/cron.d/certbot-renew`.

## 11. Create the OAuth apps

GitHub: Settings -> Developer settings -> OAuth Apps -> New. Homepage `https://<host>`, Authorization callback URL `https://<host>/v1/auth/oauth/github/callback`. Google: Cloud console -> APIs & Services -> Credentials -> OAuth client ID (Web application), authorised JavaScript origin `https://<host>`, authorised redirect URI `https://<host>/v1/auth/oauth/google/callback`. Put the four values in `.env.prod`, then `$DC up -d --wait` to restart the gateway with them.

`OAUTH_CALLBACK_BASE` must equal the public origin exactly, with no trailing slash, or the redirect 404s and the session cookie never sets.

## 12. Set SITE_URL and publish images

In GitHub: Settings -> Secrets and variables -> Actions -> Variables -> New repository variable `SITE_URL` = `https://<host>`. Then push a tag (`git tag v1.0.0 && git push origin v1.0.0`) or re-run the Release workflow. It builds both arm64 images and pushes `:v1.0.0` and `:latest` to GHCR. Pin the deploy to the tag you just built by editing `.env.prod`:

```bash
GATEWAY_IMAGE=ghcr.io/neverspot/ultimate_frre_ai-gateway:v1.0.0
FRONTEND_IMAGE=ghcr.io/neverspot/ultimate_frre_ai-frontend:v1.0.0
```

If the packages are private, `docker login ghcr.io` on the box first with a PAT that has `read:packages`.

## 13. Verify

```bash
curl -sS -o /dev/null -w '%{http_code}\n' https://<host>/healthz
curl -sS https://<host>/ | grep -o '/_next/static/[^"]*\.css' | head -1
```

Expected: `200` and a real `/_next/static/...css` path that also returns 200 when fetched. Run this from outside the box. Then in a browser: sign in with GitHub, add an OpenRouter key, press Test, send a chat with model `free` and confirm tokens arrive incrementally - `/healthz` returning 200 does not prove SSE or BYOK works.

## 14. Rollback

Pin `.env.prod` to the previous image tags (the `GATEWAY_IMAGE` / `FRONTEND_IMAGE` lines above), then:

```bash
$DC pull
$DC up -d --wait
```

Every release is an immutable tag, so a rollback is an env change plus `up -d`, never a rebuild.

## 15. Backups

```bash
sudo mkdir -p /var/backups/gateway
sudo timedatectl set-timezone Asia/Kolkata
sudo crontab -e
```

crontab entry (04:30 IST):

```cron
30 4 * * * cd /opt/ultimate && set -a && . ./.env.prod && set +a && ./deploy/backup.sh >> /var/log/gateway-backup.log 2>&1
```

The cron line sources `.env.prod` because `backup.sh` runs `docker compose exec`, which still interpolates the overlay's `${VAR:?}` values. `backup.sh` writes `/var/backups/gateway/gateway-<date>.sql.gz` and deletes dumps older than 7 days. Run it once by hand (`sudo /opt/ultimate/deploy/backup.sh`) and confirm a `.sql.gz` exists.

## Gotchas

- `PORT` must be `8080` or unset in `.env.prod`. The base compose gateway healthcheck probes `127.0.0.1:8080` while the port publish maps `${PORT}:8080`, so any other value (the local dev `.env` sets `PORT=8081`) makes the gateway report unhealthy under this overlay. This was observed locally.
- `NEXT_PUBLIC_SITE_URL` must be non-empty. Set the GitHub repository variable `SITE_URL` before tagging, and export `NEXT_PUBLIC_SITE_URL=https://<host>` before any local `docker compose build`; an empty value makes `next build` fail with `ERR_INVALID_URL`. This was observed locally, and `src` is not modifiable.
- `docker compose config` echoes `.env` secrets verbatim - never paste its output into an issue, chat or commit.
