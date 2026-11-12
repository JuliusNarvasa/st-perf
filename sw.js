/*
 * st-perf service worker — makes SillyTavern load fast on high-latency / mobile links.
 *
 * Strategy
 *  - navigation (HTML): network-first, cache fallback  -> always a fresh app shell,
 *    still usable when the network is down.
 *  - static assets (scripts, css, images, fonts, lib): cache-first -> zero network
 *    requests on repeat visits, so no re-download of ~2 MB on mobile data.
 *  - update safety: the worker checks GET /version (cheap, ~200 bytes) every few
 *    minutes. When the ST gitRevision changes it drops its cache and re-fetches the
 *    assets with cache:'reload', so an ST update is picked up automatically without
 *    a manual cache purge.
 *  - per-user cache names: the page passes the logged-in handle to the worker, so two
 *    accounts sharing a browser never share cached extension files.
 *
 * API requests, thumbnails and anything non-GET are never touched.
 */

const CACHE_VERSION = 'v1';          // bump to force a full refresh of all caches
const STATIC_CACHE_PREFIX = 'st-static';
const VERSION_CHECK_INTERVAL = 10 * 60 * 1000;   // 10 minutes
const VERSION_ENDPOINT = '/version';

const BYPASS_PATHS = [
    '/api/',
    '/csrf-token',
    '/thumbnail',
    '/socket.io',
    '/ping',
    '/content',
    '/stats',
    '/save',
    '/upload',
    '/logs',
];

const STATIC_PATHS = [
    '/scripts/',
    '/lib.js',
    '/lib/',
    '/css/',
    '/img/',
    '/webfonts/',
    '/fonts/',
    '/style.css',
    '/manifest.json',
    '/lib.js.map',
];

/**
 * Extension code lives under this path and is updated independently of SillyTavern
 * (git pull on the extension), so the ST version check cannot invalidate it.
 * These files are therefore served network-first; the cache is only a fallback.
 */
const EXTENSION_PATH = '/scripts/extensions/';

let userHandle = 'anonymous';
let lastVersionCheck = 0;
let knownRevision = null;

self.addEventListener('install', (event) => {
    // Take over immediately so the first page load after enabling is already served
    // by the worker (otherwise the user waits a full load before it kicks in).
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil((async () => {
        await self.clients.claim();
        await cleanupOldCaches();
    })());
});

self.addEventListener('message', (event) => {
    const data = event.data || {};
    if (data.type === 'set-user' && typeof data.handle === 'string') {
        userHandle = data.handle;
    }
    if (data.type === 'purge') {
        event.waitUntil(purgeCaches());
    }
    if (data.type === 'status' && event.source) {
        event.source.postMessage({ type: 'status', handle: userHandle, revision: knownRevision });
    }
});

function cacheName() {
    return `${STATIC_CACHE_PREFIX}:${userHandle}:${CACHE_VERSION}`;
}

async function cleanupOldCaches() {
    const names = await caches.keys();
    const current = cacheName();
    await Promise.all(names.map((name) => {
        if (name.startsWith(STATIC_CACHE_PREFIX) && name !== current) {
            return caches.delete(name);
        }
        return Promise.resolve(false);
    }));
}

async function purgeCaches() {
    const names = await caches.keys();
    await Promise.all(names
        .filter((name) => name.startsWith(STATIC_CACHE_PREFIX))
        .map((name) => caches.delete(name)));
}

function isBypassed(url) {
    return BYPASS_PATHS.some((p) => url.pathname.startsWith(p));
}

function isStatic(url) {
    return STATIC_PATHS.some((p) => url.pathname.startsWith(p) || url.pathname === p.replace(/\/$/, ''));
}

/**
 * Cheap update check. Runs at most every VERSION_CHECK_INTERVAL.
 * If the ST revision changed, the static cache is dropped and the caller refetches.
 */
async function checkVersion() {
    const now = Date.now();
    if (now - lastVersionCheck < VERSION_CHECK_INTERVAL) return false;
    lastVersionCheck = now;
    try {
        const res = await fetch(VERSION_ENDPOINT, { cache: 'no-store' });
        if (!res.ok) return false;
        const data = await res.json();
        const revision = data?.gitRevision || data?.pkgVersion || null;
        if (!revision) return false;
        if (knownRevision === null) {
            knownRevision = revision;      // first run: remember, do not purge
            return false;
        }
        if (revision !== knownRevision) {
            knownRevision = revision;
            await purgeCaches();
            return true;                    // caller should refetch from the network
        }
        return false;
    } catch {
        return false;                       // offline: keep serving the cache
    }
}

self.addEventListener('fetch', (event) => {
    const request = event.request;
    if (request.method !== 'GET') return;

    const url = new URL(request.url);
    if (url.origin !== self.location.origin) return;
    if (isBypassed(url)) return;

    // Navigation: always try the network first so the app shell is current.
    if (request.mode === 'navigate') {
        event.respondWith((async () => {
            try {
                const fresh = await fetch(request);
                const cache = await caches.open(cacheName());
                cache.put('/__st_app_shell__', fresh.clone());
                return fresh;
            } catch {
                const cache = await caches.open(cacheName());
                const cached = await cache.match('/__st_app_shell__');
                if (cached) return cached;
                return new Response('Offline', { status: 503, statusText: 'Offline' });
            }
        })());
        return;
    }

    if (!isStatic(url)) return;

    // Extension files: network-first. They change when the extension is updated,
    // which the ST version check cannot see.
    if (url.pathname.startsWith(EXTENSION_PATH)) {
        event.respondWith((async () => {
            const cache = await caches.open(cacheName());
            try {
                const fresh = await fetch(request, { cache: 'no-store' });
                if (fresh.ok) cache.put(request, fresh.clone());
                return fresh;
            } catch {
                const cached = await cache.match(request);
                if (cached) return cached;
                throw new Error('offline and not cached: ' + url.pathname);
            }
        })());
        return;
    }

    event.respondWith((async () => {
        const cache = await caches.open(cacheName());
        const cached = await cache.match(request);
        const invalidated = await checkVersion();
        if (cached && !invalidated) {
            return cached;                   // cache-first: no network at all
        }
        try {
            // cache:'reload' bypasses the HTTP cache so an updated ST is not shadowed
            // by a stale entry in the browser cache.
            const fresh = await fetch(request, invalidated ? { cache: 'reload' } : {});
            if (fresh.ok) cache.put(request, fresh.clone());
            return fresh;
        } catch {
            if (cached) return cached;
            throw new Error('offline and not cached: ' + url.pathname);
        }
    })());
});
