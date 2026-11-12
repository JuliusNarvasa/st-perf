/*
 * st-perf — registers a service worker so SillyTavern's ~200 static files are served
 * from the local cache instead of being re-downloaded on every visit.
 *
 * Why: ST serves its frontend with `Cache-Control: public, max-age=0`, so every file is
 * revalidated on every load, and mobile browsers frequently evict the HTTP cache
 * entirely -> the full ~2 MB is downloaded again on mobile data. The service worker keeps
 * its own copy (Cache Storage), which is far stickier, and serves assets cache-first.
 *
 * Nothing here changes the app's behaviour: only static GET requests are intercepted.
 * API calls, thumbnails, streaming and login are untouched.
 */
import { extension_settings } from '../../../extensions.js';
import { eventSource, event_types, saveSettingsDebounced } from '../../../../script.js';

const SW_PATH = '/scripts/extensions/third-party/st-perf/sw.js';
const SW_SCOPE = '/';

const settings = (extension_settings.stPerf ??= { enabled: false });

async function registerWorker() {
    if (!('serviceWorker' in navigator)) return { ok: false, reason: 'unsupported' };
    try {
        const reg = await navigator.serviceWorker.register(SW_PATH, { scope: SW_SCOPE });
        // Tell the worker which account is active so caches are not shared between users.
        const handle = await currentHandle();
        navigator.serviceWorker.controller?.postMessage({ type: 'set-user', handle });
        reg.addEventListener('updatefound', () => {
            navigator.serviceWorker.controller?.postMessage({ type: 'set-user', handle });
        });
        return { ok: true, scope: reg.scope };
    } catch (err) {
        console.error('[st-perf] service worker registration failed', err);
        return { ok: false, reason: String(err?.message ?? err) };
    }
}

async function currentHandle() {
    try {
        const res = await fetch('/api/users/me', { credentials: 'same-origin' });
        if (!res.ok) return 'anonymous';
        const data = await res.json();
        return data?.handle ?? data?.profile?.handle ?? 'anonymous';
    } catch {
        return 'anonymous';
    }
}

async function purge() {
    const reg = await navigator.serviceWorker.getRegistration(SW_SCOPE);
    if (!reg) return false;
    const worker = reg.active || reg.waiting || reg.installing;
    if (!worker) return false;
    worker.postMessage({ type: 'purge' });
    // also drop the browser's HTTP cache for this origin
    if ('caches' in window) {
        const names = await caches.keys();
        await Promise.all(names.filter(n => n.startsWith('st-static')).map(n => caches.delete(n)));
    }
    return true;
}

function addSettingsUI() {
    const html = `
    <div class="st-perf-settings">
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>Performance (offline asset cache)</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <label class="checkbox_label" for="st_perf_enabled">
                    <input id="st_perf_enabled" type="checkbox" ${settings.enabled ? 'checked' : ''} />
                    <span>Cache the frontend locally (service worker)</span>
                </label>
                <small class="opacity70p">Keeps ~2 MB of scripts/styles in the device cache, so repeat visits load instantly and do not re-download on mobile data. Updates are picked up automatically when SillyTavern is updated.</small>
                <div class="st-perf-actions">
                    <button class="menu_button" id="st_perf_purge">Purge cache now</button>
                    <span id="st_perf_status" class="opacity70p"></span>
                </div>
            </div>
        </div>
    </div>`;
    const target = document.getElementById('extensions_settings2') ?? document.getElementById('extensions_settings');
    if (!target) return;
    target.insertAdjacentHTML('beforeend', html);

    document.getElementById('st_perf_enabled')?.addEventListener('change', async (event) => {
        settings.enabled = Boolean(event.target.checked);
        saveSettingsDebounced();
        if (settings.enabled) {
            const res = await registerWorker();
            updateStatus(res.ok ? 'service worker active' : `registration failed: ${res.reason}`);
        }
    });

    document.getElementById('st_perf_purge')?.addEventListener('click', async () => {
        await purge();
        updateStatus('cache purged - reload the page');
    });

    updateStatus(settings.enabled ? 'service worker active' : 'disabled');
}

function updateStatus(text) {
    const el = document.getElementById('st_perf_status');
    if (el) el.textContent = text;
}

async function init() {
    addSettingsUI();
    if (!settings.enabled) return;
    const res = await registerWorker();
    if (!res.ok) console.warn('[st-perf]', res.reason);
    else updateStatus('service worker active');
}

eventSource.on(event_types.APP_READY, init);

// Debug handle
window.__stPerf = { registerWorker, purge, currentHandle, get settings() { return settings; } };
