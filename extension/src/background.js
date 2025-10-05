// Background service worker (MV3)
// - Intercetta richieste m3u8 nella tab corrente e le memorizza per il popup
// - Avvia download TS o conversione MP4 tramite offscreen document

const SESSION_KEY = 'streams_by_tab';

// In-memory cache to minimize storage churn
const mem = {
  // tabId -> Map(url -> { type: 'hls'|'dash'|'direct', initiator?: string })
  streamsByTab: new Map(),
  // Keepalive ports for long jobs: name -> Port
  ports: new Map(),
  // Active jobs: id -> { type, phase, value, startedAt, meta }
  jobs: new Map(),
};

// Persist in session storage (MV3 keeps it ephemeral per session)
async function saveSession() {
  const obj = {};
  for (const [tabId, urlMap] of mem.streamsByTab.entries()) {
    obj[tabId] = Array.from(urlMap.entries()).map(([url, meta]) => ({ url, ...meta }));
  }
  await chrome.storage.session.set({ [SESSION_KEY]: obj });
}

async function loadSession() {
  const data = await chrome.storage.session.get(SESSION_KEY);
  const obj = data[SESSION_KEY] || {};
  mem.streamsByTab.clear();
  for (const [tabIdStr, items] of Object.entries(obj)) {
    const map = new Map();
    for (const it of items) {
      map.set(it.url, { type: it.type || 'hls', initiator: it.initiator });
    }
    mem.streamsByTab.set(Number(tabIdStr), map);
  }
}

// Initialize session cache
loadSession();

// Accept keep-alive ports from offscreen to keep SW alive during jobs
chrome.runtime.onConnect.addListener((port) => {
  try {
    if (!port?.name) return;
    if (port.name.startsWith('job:')) {
      mem.ports.set(port.name, port);
      port.onDisconnect.addListener(() => {
        mem.ports.delete(port.name);
      });
    }
  } catch {}
});

// Listen to m3u8 requests
chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    try {
      const url = details.url;
      if (!url) return;
      const tabId = details.tabId;
      if (!(tabId && tabId > 0)) return;
      let type = null;
      if (/\.m3u8(\?|$)/i.test(url)) type = 'hls';
      else if (/\.mpd(\?|$)/i.test(url)) type = 'dash';
      else if (/\.(mp4|m4v|webm|mov)(\?|$)/i.test(url)) type = 'direct';
      if (!type) return;
      let map = mem.streamsByTab.get(tabId);
      if (!map) { map = new Map(); mem.streamsByTab.set(tabId, map); }
      const initiator = details.initiator || details.documentUrl || undefined;
      map.set(url, { type, initiator });
      saveSession();
    } catch (e) {
      console.warn('Error tracking m3u8:', e);
    }
  },
  { urls: ["<all_urls>"] },
  []
);

chrome.tabs.onRemoved.addListener((tabId) => {
  if (mem.streamsByTab.has(tabId)) {
    mem.streamsByTab.delete(tabId);
    saveSession();
  }
});

// Messages from popup
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    if (msg?.type === 'GET_STREAMS_FOR_TAB') {
      const tabId = msg.tabId;
      const map = mem.streamsByTab.get(tabId) || new Map();
      const items = Array.from(map.entries()).map(([url, meta]) => ({ url, ...meta }));
      sendResponse({ items });
    } else if (msg?.type === 'TRACK_STREAM' && msg.url) {
      // Content-script fallback detector
      try {
        const tabId = sender?.tab?.id;
        if (!(tabId && tabId > 0)) { sendResponse({ ok: true }); return; }
        let type = null;
        const url = msg.url;
        if (/\.m3u8(\?|$)/i.test(url)) type = 'hls';
        else if (/\.mpd(\?|$)/i.test(url)) type = 'dash';
        else if (/\.(mp4|m4v|webm|mov)(\?|$)/i.test(url)) type = 'direct';
        if (!type) { sendResponse({ ok: true }); return; }
        let map = mem.streamsByTab.get(tabId);
        if (!map) { map = new Map(); mem.streamsByTab.set(tabId, map); }
        map.set(url, { type, initiator: msg.initiator || sender?.origin || undefined });
        saveSession();
        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({ ok: false, error: String(e) });
      }
    } else if (msg?.type === 'GET_VARIANTS') {
      const { playlistUrl } = msg;
      try {
        await ensureOffscreen();
        // attach referrer if we have it
        const tabId = sender?.tab?.id;
        const ref = (tabId && mem.streamsByTab.get(tabId)?.get(playlistUrl)?.initiator) || undefined;
        const result = await chrome.runtime.sendMessage({
          type: 'OFFSCREEN_GET_VARIANTS',
          playlistUrl,
          referrer: ref,
        });
        sendResponse(result);
      } catch (e) {
        sendResponse({ ok: false, error: String(e) });
      }
    } else if (msg?.type === 'DASH_GET_VARIANTS') {
      const { mpdUrl } = msg;
      try {
        await ensureOffscreen();
        const tabId = sender?.tab?.id;
        const ref = (tabId && mem.streamsByTab.get(tabId)?.get(mpdUrl)?.initiator) || undefined;
        const result = await chrome.runtime.sendMessage({ type: 'OFFSCREEN_DASH_GET_VARIANTS', mpdUrl, referrer: ref });
        sendResponse(result);
      } catch (e) {
        sendResponse({ ok: false, error: String(e) });
      }
    } else if (msg?.type === 'DASH_DOWNLOAD_MP4') {
      const { mpdUrl, filename, repId, progressId, compress } = msg;
      try {
        await ensureOffscreen();
        const tabId = sender?.tab?.id;
        const ref = (tabId && mem.streamsByTab.get(tabId)?.get(mpdUrl)?.initiator) || undefined;
        // Fire-and-forget: start job in offscreen and return immediately
        if (progressId) mem.jobs.set(progressId, { type: 'dash-mp4', phase: 'download', value: 0, startedAt: Date.now(), meta: { url: mpdUrl, filename, compress: !!compress } });
        chrome.runtime.sendMessage({ type: 'OFFSCREEN_DASH_DOWNLOAD_MP4', mpdUrl, filename, repId, progressId, referrer: ref, compress });
        sendResponse({ ok: true, started: true });
      } catch (e) {
        sendResponse({ ok: false, error: String(e) });
      }
    } else if (msg?.type === 'DOWNLOAD_DIRECT') {
      const { url, filename } = msg;
      try {
        await chrome.downloads.download({ url, filename, saveAs: true });
        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({ ok: false, error: String(e) });
      }
    } else if (msg?.type === 'DOWNLOAD_TS') {
      const { playlistUrl, filename, variantUrl, progressId } = msg;
      try {
        await ensureOffscreen();
        const tabId = sender?.tab?.id;
        const ref = (tabId && mem.streamsByTab.get(tabId)?.get(playlistUrl)?.initiator) || undefined;
        if (progressId) mem.jobs.set(progressId, { type: 'ts', phase: 'download', value: 0, startedAt: Date.now(), meta: { url: playlistUrl, filename } });
        chrome.runtime.sendMessage({
          type: 'OFFSCREEN_DOWNLOAD_TS',
          playlistUrl,
          filename,
          variantUrl,
          progressId,
          referrer: ref,
        });
        sendResponse({ ok: true, started: true });
      } catch (e) {
        sendResponse({ ok: false, error: String(e) });
      }
    } else if (msg?.type === 'DOWNLOAD_MP4') {
      const { playlistUrl, filename, variantUrl, progressId, compress } = msg;
      try {
        await ensureOffscreen();
        const tabId = sender?.tab?.id;
        const ref = (tabId && mem.streamsByTab.get(tabId)?.get(playlistUrl)?.initiator) || undefined;
        if (progressId) mem.jobs.set(progressId, { type: 'hls-mp4', phase: 'download', value: 0, startedAt: Date.now(), meta: { url: playlistUrl, filename, compress: !!compress } });
        chrome.runtime.sendMessage({
          type: 'OFFSCREEN_DOWNLOAD_MP4',
          playlistUrl,
          filename,
          variantUrl,
          progressId,
          referrer: ref,
          compress,
        });
        sendResponse({ ok: true, started: true });
      } catch (e) {
        sendResponse({ ok: false, error: String(e) });
      }
    } else if (msg?.type === 'GET_ACTIVE_JOBS') {
      try {
        const jobs = Array.from(mem.jobs.entries()).map(([id, v]) => ({ id, ...v }));
        sendResponse({ ok: true, jobs });
      } catch (e) {
        sendResponse({ ok: false, error: String(e) });
      }
    } else if (msg?.type === 'DOWNLOAD_PROGRESS' && msg.id) {
      const it = mem.jobs.get(msg.id);
      if (it) {
        it.phase = msg.phase || it.phase;
        if (typeof msg.value === 'number') it.value = msg.value;
        mem.jobs.set(msg.id, it);
        // Auto-finish bookkeeping
        if ((msg.phase === 'convert' && msg.value >= 1) || (msg.phase === 'error')) {
          setTimeout(() => mem.jobs.delete(msg.id), 10_000);
        }
      }
      // also let other listeners receive it
      sendResponse?.({ ok: true });
    } else if (msg?.type === 'JOB_DONE' && msg.id) {
      mem.jobs.delete(msg.id);
      sendResponse?.({ ok: true });
    } else if (msg?.type === 'JOB_ERROR' && msg.id) {
      mem.jobs.delete(msg.id);
      sendResponse?.({ ok: true });
    } else if (msg?.type === 'JOB_CANCELED' && msg.id) {
      mem.jobs.delete(msg.id);
      sendResponse?.({ ok: true });
    } else if (msg?.type === 'CANCEL_JOB' && msg.id) {
      try {
        await ensureOffscreen();
        chrome.runtime.sendMessage({ type: 'OFFSCREEN_CANCEL_JOB', id: msg.id });
        sendResponse?.({ ok: true });
      } catch (e) {
        sendResponse?.({ ok: false, error: String(e) });
      }
    }
  })();
  return true; // async
});

// Ensure offscreen document exists for long-running work
async function ensureOffscreen() {
  const reasons = await chrome.offscreen.hasDocument?.();
  // hasDocument is not yet widely available; fallback to getContexts
  try {
    const contexts = await chrome.runtime.getContexts?.({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
    if (contexts && contexts.length > 0) return;
  } catch (_) {
    // ignore
  }
  const existing = await chrome.offscreen?.hasDocument?.();
  if (existing) return;
  await chrome.offscreen.createDocument({
    url: 'src/offscreen.html',
    reasons: ['BLOBS', 'IFRAME_SCRIPTING'],
    justification: 'Scaricare segmenti HLS/DASH e convertire con ffmpeg.wasm; necessita scripting di pagina offscreen e gestione Blob a lungo termine',
  });
}
