// Fallback stream detector injected into pages: watches fetch/XHR for .m3u8/.mpd/direct media
(function () {
  try {
    const seen = new Set();
    function report(url) {
      try {
        if (!url) return;
        if (seen.has(url)) return; seen.add(url);
        if (!(/\.(m3u8|mpd)(\?|$)/i.test(url) || /\.(mp4|m4v|webm|mov)(\?|$)/i.test(url))) return;
        chrome.runtime?.sendMessage?.({ type: 'TRACK_STREAM', url, initiator: location.origin }).catch?.(()=>{});
      } catch {}
    }
    // Patch fetch
    const origFetch = window.fetch;
    window.fetch = function (...args) {
      try {
        const input = args[0];
        const url = (typeof input === 'string') ? input : (input?.url || '');
        report(url);
      } catch {}
      return origFetch.apply(this, args);
    };
    // Patch XHR
    const origOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url, ...rest) {
      try { report(String(url||'')); } catch {}
      return origOpen.call(this, method, url, ...rest);
    };
  } catch {}
})();

