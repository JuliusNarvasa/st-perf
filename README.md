# ST Performance — offline asset cache for SillyTavern

**Stop re-downloading 2.2 MB of JavaScript on every visit.**

SillyTavern ships its frontend as ~200 separate files (135 raw ES modules under
`/scripts/`, 39 stylesheets, no bundling) and serves them with:

```
Cache-Control: public, max-age=0
```

That header means the browser must **revalidate every single file on every single load**.
On mobile, browsers also evict the HTTP cache under storage pressure — so the whole
payload comes back down your mobile data link again and again.

This extension adds a **service worker** that keeps the frontend in the device's own
cache. Repeat visits serve the app from disk: **2 243 KB → 31 KB**, and zero network
requests for the assets.

---

## Installation

### 1. Browser half — through the SillyTavern UI

1. **Extensions → Install extension**
2. Paste `https://github.com/JuliusNarvasa/st-perf`
3. **Install for all users** (admins) or **Install just for me**

> The repository name must stay `st-perf` — the service worker path depends on it.

### 2. nginx — cache headers (recommended)

Without this the worker still works, but the browser's HTTP cache keeps revalidating the
files the worker fetches, which costs a round trip per file.

```bash
sudo python3 patch_nginx.py /etc/nginx/conf.d/<your-domain>.conf 8002
sudo nginx -t && sudo systemctl reload nginx
```

The script adds:

- `Cache-Control: public, max-age=2592000` for `/scripts/`, `/css/`, `/img/`, `/lib.js`,
  `/style.css` — and `no-cache` for everything else (the app shell must stay fresh),
- `Service-Worker-Allowed: /` on the worker script, so it can control the whole origin
  (the worker script lives in the extension folder, so without this header the browser
  would restrict it to that folder),
- `Cache-Control: no-cache` for the worker script itself, so worker updates are picked up.

`patch_nginx.py` takes the path of the vhost file and the upstream port
(`8002` = default SillyTavern port).

<details>
<summary>Manual nginx equivalent</summary>

```nginx
map $uri $st_static_cache_control {
    default "no-cache";
    ~^/(scripts|css|img|webfonts|fonts)/ "public, max-age=2592000";
    ~^/(style\.css|lib\.js|manifest\.json)$ "public, max-age=2592000";
}

location / {
    # ... your existing proxy_pass ...
    proxy_hide_header Cache-Control;
    add_header Cache-Control $st_static_cache_control always;
}

location = /scripts/extensions/third-party/st-perf/sw.js {
    # ... your existing proxy_pass ...
    add_header Service-Worker-Allowed "/" always;
    add_header Cache-Control "no-cache" always;
}
```
</details>

### 3. Switch it on

**Extensions → Performance (offline asset cache) → enable the checkbox.**

The first load after enabling still downloads everything (that is what fills the cache).
Every load after that is ~31 KB.

---

## How it works

| Request | Strategy |
|---|---|
| HTML (navigation) | **network-first**, cache as fallback → always a fresh app shell, still usable offline |
| `/scripts/`, `/css/`, `/img/`, `/lib.js`, fonts | **cache-first** → no network request at all |
| `/api/*`, thumbnails, uploads, streaming, login | never intercepted |

**Updates stay correct.** The worker checks `GET /version` (about 200 bytes) every ten
minutes. When SillyTavern's `gitRevision` changes, the worker drops its cache and
re-fetches the assets with `cache:'reload'`, so an ST update is picked up automatically —
no manual purge, no stale JavaScript.

**Accounts do not share caches.** The page passes the logged-in handle to the worker, so
two accounts on the same device keep separate caches.

## Measured result

| | before | after |
|---|---|---|
| Bytes per reload | 2 243 KB | **31 KB** (−98.6 %) |
| Asset requests over the network per reload | ~202 | **0** |
| Cached entries | – | 327 |

Measured on SillyTavern 1.19.0 (commit `7e8663cd9`), Chromium, localhost.

## Rollback

- Disable the extension (Extensions panel → *Performance*), or set
  `extension_settings.stPerf.enabled = false` in the user's `settings.json`.
- Drop the cached data with the **Purge cache now** button next to the toggle, or in the
  browser's devtools → Application → Service Workers → Unregister.
- Revert the nginx vhost.

## Requirements

- Tested on **SillyTavern 1.19.0** (commit `7e8663cd9`) only. Other versions are untested.
- HTTPS (service workers are not allowed on plain HTTP, except on `localhost`).
- nginx in front of SillyTavern for the cache headers (optional but recommended).

## Notes

- The **first** load after enabling still downloads ~2.2 MB. Reducing that further would
  require bundling SillyTavern's frontend, which is an upstream-level change.
- The worker never caches API responses, so chats, settings and character data are
  unaffected.

## License

MIT — see [LICENSE](LICENSE).

Not affiliated with SillyTavern.
