#!/usr/bin/env python3
"""Patch an nginx vhost for the st-perf service worker + long-lived static caching.

Usage: patch_nginx.py <conf-file> <upstream-port>

Adds:
  * a `map` that assigns a long Cache-Control to static frontend assets and "no-cache"
    to everything else (the app shell must never be served stale);
  * `proxy_hide_header Cache-Control` + `add_header Cache-Control $st_cache_control`
    inside the main `location /` block (so ST's own `max-age=0` is replaced);
  * an exact-match location for the service worker script with
    `Service-Worker-Allowed: /` (widens the worker scope to the whole origin) and
    `no-cache` (so worker updates are picked up).
"""
import re
import sys

conf_path = sys.argv[1]
port = sys.argv[2]

with open(conf_path, 'r', encoding='utf-8') as fh:
    conf = fh.read()

if 'st_static_cache_control' in conf:
    print('already patched')
    sys.exit(0)

MAP = """
# ── st-perf: cache policy for frontend assets ──
map $uri $st_static_cache_control {
    default "no-cache";
    ~^/(scripts|css|img|webfonts|fonts)/ "public, max-age=2592000";
    ~^/(style\\.css|lib\\.js|manifest\\.json)$ "public, max-age=2592000";
}
"""

SW_LOCATION = """
    # ── st-perf service worker (scope widened to the whole origin) ──
    location = /scripts/extensions/third-party/st-perf/sw.js {
        proxy_pass http://127.0.0.1:__PORT__;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection upgrade;
        add_header Service-Worker-Allowed "/" always;
        add_header Cache-Control "no-cache" always;
    }
""".replace('__PORT__', port)

# 1) inject the map before the first `server {` block
server_match = re.search(r'(?m)^server \{', conf)
if not server_match:
    sys.exit('no server block found')
conf = conf[:server_match.start()] + MAP.lstrip('\n') + conf[server_match.start():]

# 2) inject the cache headers into the LAST `location / {` block (the https vhost)
loc_matches = list(re.finditer(r'(?m)^    location / \{', conf))
if not loc_matches:
    sys.exit('no location / block found')
last = loc_matches[-1]
insert_at = last.end()
cache_lines = (
    '        proxy_hide_header Cache-Control;\n'
    '        add_header Cache-Control $st_static_cache_control always;\n'
)
conf = conf[:insert_at] + cache_lines + conf[insert_at:]

# 3) add the service worker location right before the closing brace of the https server block
#    (the last `}` that closes the final server block)
last_brace = conf.rstrip().rfind('\n}')
conf = conf[:last_brace + 1] + SW_LOCATION + conf[last_brace + 1:]

with open(conf_path, 'w', encoding='utf-8') as fh:
    fh.write(conf)

print('patched', conf_path)
