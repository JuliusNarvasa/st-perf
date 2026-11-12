# AGENTS.md — installing ST Performance (agent instructions)

Instructions for an **AI agent or automated installer**. Ordered, deterministic and
verifiable. Detect paths, never guess them.

## What you are installing

A SillyTavern **UI extension** (this repo's root) that registers a **service worker**,
plus an optional **nginx** change that gives the frontend long-lived cache headers.

| Part | Files | Where it goes |
|---|---|---|
| UI extension | `manifest.json`, `index.js`, `style.css` | `<ST>/data/<user>/extensions/st-perf/` (per user) or `<ST>/public/scripts/extensions/third-party/st-perf/` (global) |
| Service worker | `sw.js` | same directory — it is served from `/scripts/extensions/third-party/st-perf/sw.js` |
| nginx patch | `patch_nginx.py` | applied to the vhost of the SillyTavern host |

## Prerequisites

- SillyTavern **1.19.0** — the only version tested so far (commit `7e8663cd9`). Other
  versions are untested.
- **HTTPS** — service workers require a secure context (`localhost` is exempt).
- nginx in front of SillyTavern (recommended, not required).
- Write access to `<ST>/data/<user>/extensions/` and to the nginx vhost.

## Step 1 — locate SillyTavern and its vhost

```bash
ls -d /path/to/SillyTavern            # contains server.js, src/, plugins/, public/
ps aux | grep '[s]erver.js'            # running instance -> WorkingDirectory
sudo nginx -T 2>/dev/null | grep -n "proxy_pass http://127.0.0.1:8002"   # the vhost
```

The nginx vhost is usually `/etc/nginx/conf.d/<domain>.conf` or
`/etc/nginx/sites-enabled/<domain>.conf`. Determine the **upstream port** from the
`proxy_pass` directive (default SillyTavern port: 8002).

## Step 2 — install the extension

Preferred (through the UI): the user opens **Extensions → Install extension** and pastes

```
https://github.com/JuliusNarvasa/st-perf
```

then clicks **Install for all users** (admins) or **Install just for me**.

Automated alternative (identical to what ST's installer does):

```bash
git clone --depth 1 https://github.com/JuliusNarvasa/st-perf <ST>/data/<user>/extensions/st-perf
```

Rules:

- Directory name **must be `st-perf`** — the worker path is hardcoded to
  `/scripts/extensions/third-party/st-perf/sw.js`.
- `manifest.json` **must be in the repository root** (ST's installer removes the clone
  otherwise).
- Repeat for every user that should get the cache, or install it globally into
  `<ST>/public/scripts/extensions/third-party/st-perf/` as an admin.

## Step 3 — nginx cache headers

```bash
sudo cp /etc/nginx/conf.d/<domain>.conf /etc/nginx/conf.d/<domain>.conf.bak
sudo python3 patch_nginx.py /etc/nginx/conf.d/<domain>.conf 8002
sudo nginx -t && sudo systemctl reload nginx
```

The script is idempotent (it refuses to patch a file that already contains the marker
`st_static_cache_control`).

Verify:

```bash
curl -sI https://<domain>/scripts/extensions/third-party/st-perf/sw.js | grep -i 'service-worker-allowed\|cache-control'
# expect: service-worker-allowed: /   and   cache-control: no-cache
curl -sI https://<domain>/scripts/extensions/third-party/st-perf/index.js | grep -i cache-control
# expect: cache-control: public, max-age=2592000
```

## Step 4 — enable it

**Extensions → Performance (offline asset cache) → enable the checkbox**, or set
`extension_settings.stPerf.enabled = true` in the user's `settings.json`.

## Step 5 — verify

1. Reload the page once — this fills the cache (~2.2 MB, one time).
2. Reload again and check the Network panel: the asset requests should be served by the
   service worker and the transferred size should be tiny.

In the browser console:

```js
await navigator.serviceWorker.getRegistration('/')   // scope must be '/'
await caches.keys()                                   // e.g. ['st-static:<handle>:v1']
```

Programmatic check of the transfer size:

```js
performance.getEntriesByType('resource')
    .reduce((sum, r) => sum + (r.transferSize || 0), 0) / 1024   // ~31 KB after the first load
```

## Failure modes

| Symptom | Fix |
|---|---|
| `ServiceWorker registration failed` with a scope error | The `Service-Worker-Allowed: /` header is missing → run Step 3 |
| Extension invisible in the UI | `manifest.json` is not in the repo root, or the folder is not named `st-perf` |
| Everything still re-downloads | The worker is not registered (HTTPS required) or the toggle is off |
| Stale JavaScript after an ST update | The version check runs every 10 minutes — use the **Purge cache now** button to force it |
| `patch_nginx.py` does nothing | The vhost already contains `st_static_cache_control` (already patched) |

## Do not

- Do not modify SillyTavern core files.
- Do not rename the repository: the worker path depends on the folder name `st-perf`.
- Do not cache API responses in the worker — chat data must never be served stale.
