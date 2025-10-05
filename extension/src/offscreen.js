// Offscreen document script: download HLS TS and optional MP4 conversion

// Optional referrer to satisfy origin checks on some CDNs
let CURRENT_REFERRER = null;
// Track canceled job ids
const CANCELED_JOBS = new Set();

// Minimal HLS playlist parser and downloader
class HLS {
  static async fetchText(url) {
    // Include cookies for origins that require session/auth to access playlists
    const res = await fetch(url, { credentials: 'include', referrer: CURRENT_REFERRER || undefined });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return await res.text();
  }

  static resolve(baseUrl, relative) {
    return new URL(relative, baseUrl).toString();
  }

  static parseAttributes(line) {
    const attrs = {};
    const s = line.replace(/^#EXT[^:]+:/, '');
    // Split on commas not inside quotes
    const parts = s.match(/(?:[^",]|"[^"]*")+/g) || [];
    for (const p of parts) {
      const [k, v] = p.split('=');
      if (!k) continue;
      const val = v?.replace(/^"|"$/g, '')
        .replace(/\\n/g, '\n');
      attrs[k.trim()] = val;
    }
    return attrs;
  }

  static isMasterPlaylist(text) {
    return /#EXT-X-STREAM-INF/i.test(text);
  }

  static parseMasterForAudioAndVariants(text, baseUrl) {
    const lines = text.split(/\r?\n/);
    // Map audio group id -> chosen audio URI (prefer DEFAULT=YES)
    const audioGroups = new Map();
    const audioCandidates = new Map(); // id -> {defaults: [uris], others: [uris]}
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line.startsWith('#EXT-X-MEDIA')) {
        const attrs = HLS.parseAttributes(line);
        if ((attrs['TYPE'] || '').toUpperCase() === 'AUDIO' && attrs['GROUP-ID'] && attrs['URI']) {
          const gid = attrs['GROUP-ID'];
          const uri = HLS.resolve(baseUrl, attrs['URI']);
          const isDefault = String(attrs['DEFAULT'] || '').toUpperCase() === 'YES';
          if (!audioCandidates.has(gid)) audioCandidates.set(gid, { defaults: [], others: [] });
          const entry = audioCandidates.get(gid);
          (isDefault ? entry.defaults : entry.others).push(uri);
        }
      }
    }
    for (const [gid, entry] of audioCandidates.entries()) {
      const pick = entry.defaults[0] || entry.others[0] || null;
      if (pick) audioGroups.set(gid, pick);
    }

    const variants = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.startsWith('#EXT-X-STREAM-INF')) {
        const attrs = HLS.parseAttributes(line);
        // find next non-tag line (URI)
        let j = i + 1;
        while (j < lines.length && ((lines[j] || '').trim() === '' || (lines[j] || '').trim().startsWith('#'))) j++;
        const next = (lines[j] || '').trim();
        if (next && !next.startsWith('#')) {
          const uri = HLS.resolve(baseUrl, next);
          const bw = parseInt(attrs['BANDWIDTH'] || attrs['AVERAGE-BANDWIDTH'] || '0', 10);
          const res = attrs['RESOLUTION'] || '';
          const name = attrs['NAME'] || '';
          const audioGroup = attrs['AUDIO'] || '';
          const audioUri = audioGroups.get(audioGroup) || null;
          variants.push({ uri, bandwidth: bw, resolution: res, name, audioUri, audioGroup });
        }
      }
    }
    return { variants, audioGroups };
  }

  static async pickVariant(text, baseUrl) {
    // Choose highest BANDWIDTH variant
    const { variants } = HLS.parseMasterForAudioAndVariants(text, baseUrl);
    const best = variants.sort((a,b)=> (b.bandwidth||0)-(a.bandwidth||0))[0];
    if (!best?.uri) throw new Error('Nessuna variante trovata nel master playlist');
    return best.uri;
  }

  static parseVariants(text, baseUrl) {
    const { variants } = HLS.parseMasterForAudioAndVariants(text, baseUrl);
    return variants;
  }

  static async parseMediaPlaylist(url) {
    const text = await HLS.fetchText(url);
    // Some providers chain masters (master -> master). Follow to a media playlist.
    if (HLS.isMasterPlaylist(text)) {
      const next = await HLS.pickVariant(text, url);
      return await HLS.parseMediaPlaylist(next);
    }
    if (/#EXT-X-KEY/i.test(text)) {
      throw new Error('Playlist cifrata (EXT-X-KEY) non supportata al momento.');
    }
    const lines = text.split(/\r?\n/);
    const segments = [];
    let initUrl = null;
    let seq = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line.startsWith('#EXT-X-MAP')) {
        const attrs = HLS.parseAttributes(line);
        if (attrs['URI']) initUrl = HLS.resolve(url, attrs['URI']);
      }
      if (line.startsWith('#EXTINF')) {
        // Next non-tag line is the segment URI (may have tags like BYTERANGE in between)
        let j = i + 1;
        while (j < lines.length && ((lines[j] || '').trim() === '' || (lines[j] || '').trim().startsWith('#'))) j++;
        const uri = (lines[j] || '').trim();
        if (uri && !uri.startsWith('#')) {
          segments.push({ uri: HLS.resolve(url, uri), index: seq++ });
          i = j;
        }
      }
    }
    if (segments.length === 0) {
      // Try Low-Latency HLS partial segments (#EXT-X-PART)
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (line.startsWith('#EXT-X-PART')) {
          const attrs = HLS.parseAttributes(line);
          if (attrs['URI']) {
            segments.push({ uri: HLS.resolve(url, attrs['URI']), index: seq++ });
          }
        }
      }
      if (segments.length === 0) {
        throw new Error('Nessun segmento trovato nella playlist media');
      }
    }
    return { segments, initUrl };
  }

  static async expandToMediaPlaylist(url, variantUrl) {
    const text = await HLS.fetchText(url);
    if (HLS.isMasterPlaylist(text)) {
      const useUri = variantUrl ? variantUrl : await HLS.pickVariant(text, url);
      return await HLS.parseMediaPlaylist(useUri);
    }
    // already media playlist
    if (/#EXT-X-KEY/i.test(text)) {
      throw new Error('Playlist cifrata (EXT-X-KEY) non supportata al momento.');
    }
    // reconstruct from text
    const tmpUrl = url;
    const lines = text.split(/\r?\n/);
    const segments = [];
    let initUrl = null;
    let seq = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line.startsWith('#EXT-X-MAP')) {
        const attrs = HLS.parseAttributes(line);
        if (attrs['URI']) initUrl = HLS.resolve(tmpUrl, attrs['URI']);
      }
      if (line.startsWith('#EXTINF')) {
        let j = i + 1;
        while (j < lines.length && ((lines[j] || '').trim() === '' || (lines[j] || '').trim().startsWith('#'))) j++;
        const uri = (lines[j] || '').trim();
        if (uri && !uri.startsWith('#')) {
          segments.push({ uri: HLS.resolve(tmpUrl, uri), index: seq++ });
          i = j;
        }
      }
    }
    if (segments.length === 0) {
      // Try Low-Latency HLS partial segments (#EXT-X-PART)
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (line.startsWith('#EXT-X-PART')) {
          const attrs = HLS.parseAttributes(line);
          if (attrs['URI']) {
            segments.push({ uri: HLS.resolve(tmpUrl, attrs['URI']), index: seq++ });
          }
        }
      }
    }
    if (segments.length === 0) throw new Error('Nessun segmento trovato');
    return { segments, initUrl };
  }
}

// Build HLS video+audio (if any) from master/media URL
HLS.expandToMediaWithAudio = async function(url, variantUrl) {
  const text = await HLS.fetchText(url);
  if (HLS.isMasterPlaylist(text)) {
    const { variants } = HLS.parseMasterForAudioAndVariants(text, url);
    let chosen = null;
    if (variantUrl) {
      chosen = variants.find(v => v.uri === variantUrl) || null;
    } else {
      chosen = variants.sort((a,b)=> (b.bandwidth||0)-(a.bandwidth||0))[0] || null;
    }
    if (!chosen) throw new Error('Nessuna variante trovata nel master playlist');
    const video = await HLS.parseMediaPlaylist(chosen.uri);
    let audio = null;
    if (chosen.audioUri) {
      try { audio = await HLS.parseMediaPlaylist(chosen.audioUri); } catch (_) { /* ignore */ }
    }
    return { video, audio };
  }
  // Not a master, single media playlist without separate audio
  const video = await HLS.parseMediaPlaylist(url);
  return { video, audio: null };
};

// Basic MPEG-DASH (clear, non-DRM) parser/downloader for common patterns.
const DASH = {
  async fetchText(url) {
    const res = await fetch(url, { credentials: 'include', referrer: CURRENT_REFERRER || undefined });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return await res.text();
  },
  resolve(baseUrl, relative) {
    return new URL(relative, baseUrl).toString();
  },
  baseFrom(node, mpdUrl) {
    // Walk up to find BaseURL, prefer more specific (Representation > AdaptationSet > Period > MPD)
    let base = mpdUrl;
    function getBase(n) {
      const b = n?.getElementsByTagName('BaseURL')[0];
      if (b && b.textContent) return b.textContent.trim();
      return null;
    }
    const repBase = getBase(node);
    if (repBase) return DASH.resolve(base, repBase);
    const as = node.parentElement?.closest('AdaptationSet');
    if (as) {
      const asBase = getBase(as);
      if (asBase) return DASH.resolve(base, asBase);
    }
    const period = node.parentElement?.closest('Period') || node.closest?.('Period');
    if (period) {
      const pBase = getBase(period);
      if (pBase) return DASH.resolve(base, pBase);
    }
    const mpd = node.ownerDocument?.documentElement;
    const mBase = getBase(mpd);
    if (mBase) return DASH.resolve(base, mBase);
    return base;
  },
  ensureNoDRM(doc) {
    const prot = doc.getElementsByTagName('ContentProtection');
    if (prot && prot.length) throw new Error('DASH con DRM non supportato');
  },
  parseVariants: function(text, mpdUrl) {
    const doc = new DOMParser().parseFromString(text, 'application/xml');
    this.ensureNoDRM(doc);
    const out = [];
    const adaps = Array.from(doc.getElementsByTagName('AdaptationSet'));
    for (const as of adaps) {
      const ctype = as.getAttribute('contentType') || as.getAttribute('mimeType') || '';
      const isVideo = /video/.test(ctype);
      if (!isVideo) continue;
      const reps = Array.from(as.getElementsByTagName('Representation'));
      for (const rep of reps) {
        const id = rep.getAttribute('id') || '';
        const bw = parseInt(rep.getAttribute('bandwidth') || '0', 10);
        const width = rep.getAttribute('width');
        const height = rep.getAttribute('height');
        const res = (width && height) ? `${width}x${height}` : '';
        const base = this.baseFrom(rep, mpdUrl);
        out.push({ id, bandwidth: bw, resolution: res, base });
      }
    }
    out.sort((a, b) => (b.bandwidth||0) - (a.bandwidth||0));
    return out;
  },
  buildSegmentList(rep, mpdUrl) {
    // Try SegmentList first (easier)
    const segList = rep.getElementsByTagName('SegmentList')[0] || rep.parentElement?.getElementsByTagName('SegmentList')[0];
    if (!segList) return null;
    const init = segList.getElementsByTagName('Initialization')[0]?.getAttribute('sourceURL');
    const segs = Array.from(segList.getElementsByTagName('SegmentURL')).map(s => s.getAttribute('media')).filter(Boolean);
    const base = this.baseFrom(rep, mpdUrl);
    const initUrl = init ? this.resolve(base, init) : null;
    const urls = segs.map(u => this.resolve(base, u));
    return { type: 'list', initUrl, urls };
  },
  buildSegmentTemplate(rep, mpdUrl) {
    const st = rep.getElementsByTagName('SegmentTemplate')[0] || rep.parentElement?.getElementsByTagName('SegmentTemplate')[0];
    if (!st) return null;
    const media = st.getAttribute('media');
    const init = st.getAttribute('initialization');
    const startNumber = parseInt(st.getAttribute('startNumber') || '1', 10);
    const timeline = st.getElementsByTagName('SegmentTimeline')[0];
    if (!media) return null;
    const repId = rep.getAttribute('id') || '';
    const bw = rep.getAttribute('bandwidth') || '';
    const base = this.baseFrom(rep, mpdUrl);
    function subst(tpl, num) {
      return tpl
        .replace(/\$RepresentationID\$/g, repId)
        .replace(/\$Number\$/g, String(num))
        .replace(/\$Bandwidth\$/g, bw);
    }
    const initUrl = init ? this.resolve(base, subst(init, startNumber)) : null;
    let count = 0;
    const numbers = [];
    if (timeline) {
      const S = Array.from(timeline.getElementsByTagName('S'));
      let n = startNumber;
      for (const s of S) {
        const r = parseInt(s.getAttribute('r') || '0', 10);
        const reps = r >= 0 ? r + 1 : 1; // negative r not handled
        for (let i = 0; i < reps; i++) {
          numbers.push(n++);
        }
      }
    } else {
      // Without SegmentTimeline we don't know the count; skip.
      return null;
    }
    const urls = numbers.map(num => this.resolve(base, subst(media, num)));
    return { type: 'template', initUrl, urls };
  },
  buildSegments: function(text, mpdUrl, repId) {
    const doc = new DOMParser().parseFromString(text, 'application/xml');
    this.ensureNoDRM(doc);
    // choose representation
    let rep = null;
    const reps = Array.from(doc.getElementsByTagName('Representation'));
    if (repId) {
      rep = reps.find(r => (r.getAttribute('id')||'') === repId) || null;
    }
    if (!rep) {
      // pick highest bandwidth video representation
      const adaps = Array.from(doc.getElementsByTagName('AdaptationSet'));
      let best = { bw: -1, rep: null };
      for (const as of adaps) {
        const ctype = as.getAttribute('contentType') || as.getAttribute('mimeType') || '';
        if (!/video/.test(ctype)) continue;
        for (const r of Array.from(as.getElementsByTagName('Representation'))) {
          const bw = parseInt(r.getAttribute('bandwidth') || '0', 10);
          if (bw > best.bw) best = { bw, rep: r };
        }
      }
      rep = best.rep;
    }
    if (!rep) throw new Error('Nessuna Representation video trovata');
    // Try SegmentList
    let built = this.buildSegmentList(rep, mpdUrl);
    if (!built) built = this.buildSegmentTemplate(rep, mpdUrl);
    if (!built) throw new Error('DASH pattern non supportato (manca SegmentList/SegmentTemplate)');
    // Try to also find best audio representation (optional)
    let audio = null;
    const asAudio = rep.parentElement;
    const parentPeriod = asAudio?.parentElement;
    const adaps = parentPeriod ? Array.from(parentPeriod.getElementsByTagName('AdaptationSet')) : [];
    let bestA = { bw: -1, rep: null };
    for (const as of adaps) {
      const ctype = as.getAttribute('contentType') || as.getAttribute('mimeType') || '';
      if (!/audio/.test(ctype)) continue;
      for (const r of Array.from(as.getElementsByTagName('Representation'))) {
        const bw = parseInt(r.getAttribute('bandwidth') || '0', 10);
        if (bw > bestA.bw) bestA = { bw, rep: r };
      }
    }
    if (bestA.rep) {
      let aBuilt = this.buildSegmentList(bestA.rep, mpdUrl);
      if (!aBuilt) aBuilt = this.buildSegmentTemplate(bestA.rep, mpdUrl);
      if (aBuilt) audio = aBuilt;
    }
    return { video: built, audio };
  },
};

async function downloadSegmentsToBlob(playlistUrl, onProgress, variantUrl, progressId) {
  const { segments, initUrl } = await HLS.expandToMediaPlaylist(playlistUrl, variantUrl);
  const bufs = [];
  let done = 0;
  const total = segments.length + (initUrl ? 1 : 0);
  const emit = (phase, value) => {
    if (!progressId) return;
    try { chrome.runtime.sendMessage({ type: 'DOWNLOAD_PROGRESS', id: progressId, phase, value }); } catch {}
  };
  if (initUrl) {
    emit('download', 0);
    const res = await fetch(initUrl, { credentials: 'include', referrer: CURRENT_REFERRER || undefined });
    if (!res.ok) throw new Error(`Init HTTP ${res.status}: ${initUrl}`);
    const buf = await res.arrayBuffer();
    bufs.push(new Uint8Array(buf));
    done += 1;
    onProgress?.(done, total);
    emit('download', done / total);
  }
  for (const seg of segments) {
    const res = await fetch(seg.uri, { credentials: 'include', referrer: CURRENT_REFERRER || undefined });
    if (!res.ok) throw new Error(`Segmento HTTP ${res.status}: ${seg.uri}`);
    const buf = await res.arrayBuffer();
    bufs.push(new Uint8Array(buf));
    done += 1;
    onProgress?.(done, total);
    emit('download', done / total);
  }
  // Concatenate
  const totalLen = bufs.reduce((a, b) => a + b.byteLength, 0);
  const out = new Uint8Array(totalLen);
  let offset = 0;
  for (const b of bufs) {
    out.set(b, offset);
    offset += b.byteLength;
  }
  const isFmp4 = Boolean(initUrl) || /\.m4s(\?|$)/i.test(segments[0]?.uri || '');
  return new Blob([out.buffer], { type: isFmp4 ? 'video/mp4' : 'video/MP2T' });
}

async function ensureFfmpeg() {
  if (self.__ffmpeg) return self.__ffmpeg;
  try {
    // ESM API (v0.12+): import FFmpeg class and load with local core URL
    const mod = await import(chrome.runtime.getURL('vendor/ffmpeg/esm/index.js'));
    const FFmpeg = mod.FFmpeg || mod.default?.FFmpeg;
    if (!FFmpeg) throw new Error('FFmpeg ESM non trovato');
    const ffmpeg = new FFmpeg();
    await ffmpeg.load({
      coreURL: chrome.runtime.getURL('vendor/ffmpeg/esm/ffmpeg-core.js'),
    });
    self.__ffmpeg = ffmpeg;
    return ffmpeg;
  } catch (e) {
    throw new Error('ffmpeg.wasm non disponibile. Aggiungi i file in extension/vendor/ffmpeg/esm (vedi README). Dettagli: ' + e);
  }
}

async function convertTsBlobToMp4(tsBlob) {
  const ffmpeg = await ensureFfmpeg();
  const data = new Uint8Array(await tsBlob.arrayBuffer());
  await ffmpeg.writeFile('input.ts', data);
  // Copy codec to mp4 container (fast remux). If fails, fallback to transcode.
  try {
    await ffmpeg.exec(['-i', 'input.ts', '-c', 'copy', 'output.mp4']);
  } catch (e) {
    // Fallback (slow): transcode H.264 + AAC
    await ffmpeg.exec(['-i', 'input.ts', '-c:v', 'libx264', '-c:a', 'aac', '-b:a', '192k', 'output.mp4']);
  }
  const out = await ffmpeg.readFile('output.mp4');
  await ffmpeg.deleteFile('input.ts');
  await ffmpeg.deleteFile('output.mp4');
  return new Blob([out.buffer], { type: 'video/mp4' });
}

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  try {
    chrome.downloads.download({ url, filename, saveAs: true });
  } catch (_) {
    // Fallback via anchor
    const a = document.createElement('a');
    a.href = url; a.download = filename; a.click();
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    if (msg?.type === 'OFFSCREEN_DOWNLOAD_TS') {
      const { playlistUrl, filename, variantUrl, progressId } = msg;
      let keepPort = null;
      try {
        if (progressId) { try { keepPort = chrome.runtime.connect({ name: 'job:' + progressId }); } catch {} }
        const prevRef = CURRENT_REFERRER; CURRENT_REFERRER = msg.referrer || null;
        const blob = await downloadSegmentsToBlob(playlistUrl, (i, n) => {}, variantUrl, progressId);
        triggerDownload(blob, filename || 'video.ts');
        try { if (progressId) chrome.runtime.sendMessage({ type: 'JOB_DONE', id: progressId }); } catch {}
        sendResponse({ ok: true });
      } catch (e) {
        const canceled = progressId && CANCELED_JOBS.has(progressId);
        try { if (progressId) chrome.runtime.sendMessage({ type: 'DOWNLOAD_PROGRESS', id: progressId, phase: canceled ? 'canceled' : 'error', value: 1, message: String(e) }); } catch {}
        try { if (progressId) chrome.runtime.sendMessage({ type: canceled ? 'JOB_CANCELED' : 'JOB_ERROR', id: progressId }); } catch {}
        sendResponse({ ok: false, error: String(e) });
      } finally {
        try { keepPort?.disconnect(); } catch {}
        if (progressId) CANCELED_JOBS.delete(progressId);
        CURRENT_REFERRER = null;
      }
    } else if (msg?.type === 'OFFSCREEN_DOWNLOAD_MP4') {
      const { playlistUrl, filename, variantUrl, progressId, compress } = msg;
      let onProg = null; let keepPort = null;
      try {
        if (progressId) { try { keepPort = chrome.runtime.connect({ name: 'job:' + progressId }); } catch {} }
        const prevRef = CURRENT_REFERRER; CURRENT_REFERRER = msg.referrer || null;
        // Build HLS video (+ optional audio) segment lists
        const built = await HLS.expandToMediaWithAudio(playlistUrl, variantUrl);
        const emit = (phase, value) => {
          if (!progressId) return;
          try { chrome.runtime.sendMessage({ type: 'DOWNLOAD_PROGRESS', id: progressId, phase, value }); } catch {}
        };
        const ff = await ensureFfmpeg();
        onProg = (d) => { if (typeof d?.progress === 'number') emit('convert', d.progress); };
        ff.on?.('progress', onProg);
        const vParts = [];
        const aParts = [];
        let done = 0; const total = (built.video.initUrl ? 1 : 0) + built.video.segments.length + (built.audio ? ((built.audio.initUrl ? 1 : 0) + built.audio.segments.length) : 0);
        if (built.video.initUrl) { const r = await fetch(built.video.initUrl, { credentials: 'include', referrer: CURRENT_REFERRER || undefined }); if (!r.ok) throw new Error('Init video HTTP ' + r.status); vParts.push(new Uint8Array(await r.arrayBuffer())); done++; emit('download', done/total); }
        for (const s of built.video.segments) { const r = await fetch(s.uri, { credentials: 'include', referrer: CURRENT_REFERRER || undefined }); if (!r.ok) throw new Error('Seg video HTTP ' + r.status); vParts.push(new Uint8Array(await r.arrayBuffer())); done++; emit('download', done/total); }
        if (built.audio) {
          if (built.audio.initUrl) { const r = await fetch(built.audio.initUrl, { credentials: 'include', referrer: CURRENT_REFERRER || undefined }); if (!r.ok) throw new Error('Init audio HTTP ' + r.status); aParts.push(new Uint8Array(await r.arrayBuffer())); done++; emit('download', done/total); }
          for (const s of built.audio.segments) { const r = await fetch(s.uri, { credentials: 'include', referrer: CURRENT_REFERRER || undefined }); if (!r.ok) throw new Error('Seg audio HTTP ' + r.status); aParts.push(new Uint8Array(await r.arrayBuffer())); done++; emit('download', done/total); }
        }
        const vLen = vParts.reduce((a,b)=>a+b.byteLength,0); const vBuf = new Uint8Array(vLen); { let o=0; for(const p of vParts){ vBuf.set(p,o); o+=p.byteLength; } }
        let finalBlob;
        if (built.audio) {
          const aLen = aParts.reduce((a,b)=>a+b.byteLength,0); const aBuf = new Uint8Array(aLen); { let o=0; for(const p of aParts){ aBuf.set(p,o); o+=p.byteLength; } }
          emit('convert', 0);
          // ff already ensured
          const vIsMp4 = Boolean(built.video.initUrl) || /\.m4s(\?|$)/i.test(built.video.segments[0]?.uri || '');
          const aIsMp4 = Boolean(built.audio.initUrl) || /\.m4s(\?|$)/i.test(built.audio.segments[0]?.uri || '');
          const vName = vIsMp4 ? 'v.mp4' : 'v.ts';
          let aName;
          if (aIsMp4) aName = 'a.mp4';
          else if (/\.aac(\?|$)/i.test(built.audio.segments[0]?.uri || '')) aName = 'a.aac';
          else aName = 'a.ts';
          await ff.writeFile(vName, vBuf);
          await ff.writeFile(aName, aBuf);
          const anyTs = /\.ts$/i.test(vName) || /\.ts$/i.test(aName) || /\.aac$/i.test(aName);
          const prefix = anyTs ? ['-fflags','+genpts'] : [];
          const baseMap = ['-map','0:v:0','-map','1:a:0'];
          let ok = false;
          if (!compress) {
            try {
              await ff.exec([...prefix, '-i', vName, '-i', aName, ...baseMap, '-c', 'copy', '-movflags', '+faststart', '-shortest', 'out.mp4']);
              ok = true;
            } catch (_) {}
          }
          if (!ok && !compress) {
            try {
              await ff.exec([...prefix, '-i', vName, '-i', aName, ...baseMap, '-c:v', 'copy', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', '-shortest', 'out.mp4']);
              ok = true;
            } catch (_) {}
          }
          if (!ok) {
            await ff.exec([...prefix, '-i', vName, '-i', aName, ...baseMap, '-c:v', 'libx264', '-preset', 'medium', '-crf', compress ? '23' : '20', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', '-shortest', 'out.mp4']);
          }
          const out = await ff.readFile('out.mp4');
          await ff.deleteFile(vName); await ff.deleteFile(aName); await ff.deleteFile('out.mp4');
          finalBlob = new Blob([out.buffer], { type: 'video/mp4' });
          emit('convert', 1);
        } else {
          // Video only: always remux via ffmpeg to set proper metadata/duration
          const ff = await ensureFfmpeg();
          const vIsMp4 = Boolean(built.video.initUrl) || /\.m4s(\?|$)/i.test(built.video.segments[0]?.uri || '');
          const vName = vIsMp4 ? 'v.mp4' : 'v.ts';
          await ff.writeFile(vName, vBuf);
          const anyTs = /\.ts$/i.test(vName);
          const prefix = anyTs ? ['-fflags','+genpts'] : [];
          let ok = false;
          if (!compress) {
            try {
              await ff.exec([...prefix, '-i', vName, '-c', 'copy', '-movflags', '+faststart', 'out.mp4']);
              ok = true;
            } catch (_) {}
          }
          if (!ok) {
            await ff.exec([...prefix, '-i', vName, '-c:v', 'libx264', '-preset', 'medium', '-crf', compress ? '23' : '20', '-an', '-movflags', '+faststart', 'out.mp4']);
          }
          const out = await ff.readFile('out.mp4');
          await ff.deleteFile(vName); await ff.deleteFile('out.mp4');
          finalBlob = new Blob([out.buffer], { type: 'video/mp4' });
        }
        triggerDownload(finalBlob, filename || 'video.mp4');
        try { if (progressId) chrome.runtime.sendMessage({ type: 'JOB_DONE', id: progressId }); } catch {}
        sendResponse({ ok: true });
      } catch (e) {
        const canceled = progressId && CANCELED_JOBS.has(progressId);
        try { if (progressId) chrome.runtime.sendMessage({ type: 'DOWNLOAD_PROGRESS', id: progressId, phase: canceled ? 'canceled' : 'error', value: 1, message: String(e) }); } catch {}
        try { if (progressId) chrome.runtime.sendMessage({ type: canceled ? 'JOB_CANCELED' : 'JOB_ERROR', id: progressId }); } catch {}
        sendResponse({ ok: false, error: String(e) });
      } finally {
        try { if (onProg) { const ff = await ensureFfmpeg(); ff.off?.('progress', onProg); } } catch {}
        try { keepPort?.disconnect(); } catch {}
        if (progressId) CANCELED_JOBS.delete(progressId);
        CURRENT_REFERRER = null;
      }
    } else if (msg?.type === 'OFFSCREEN_GET_VARIANTS') {
      const { playlistUrl } = msg;
      try {
        const prevRef = CURRENT_REFERRER; CURRENT_REFERRER = msg.referrer || null;
        const text = await HLS.fetchText(playlistUrl);
        if (!HLS.isMasterPlaylist(text)) {
          sendResponse({ ok: true, master: false, variants: [] });
          return;
        }
        const variants = HLS.parseVariants(text, playlistUrl);
        // sort by bandwidth desc
        variants.sort((a, b) => (b.bandwidth || 0) - (a.bandwidth || 0));
        sendResponse({ ok: true, master: true, variants });
      } catch (e) {
        sendResponse({ ok: false, error: String(e) });
      } finally {
        CURRENT_REFERRER = null;
      }
    } else if (msg?.type === 'OFFSCREEN_DASH_GET_VARIANTS') {
      const { mpdUrl } = msg;
      try {
        const prevRef = CURRENT_REFERRER; CURRENT_REFERRER = msg.referrer || null;
        const text = await DASH.fetchText(mpdUrl);
        const variants = DASH.parseVariants(text, mpdUrl);
        sendResponse({ ok: true, variants });
      } catch (e) {
        sendResponse({ ok: false, error: String(e) });
      } finally {
        CURRENT_REFERRER = null;
      }
    } else if (msg?.type === 'OFFSCREEN_DASH_DOWNLOAD_MP4') {
      const { mpdUrl, filename, repId, progressId, compress } = msg;
      let onProg = null; let keepPort = null;
      try {
        if (progressId) { try { keepPort = chrome.runtime.connect({ name: 'job:' + progressId }); } catch {} }
        const prevRef = CURRENT_REFERRER; CURRENT_REFERRER = msg.referrer || null;
        const text = await DASH.fetchText(mpdUrl);
        const built = DASH.buildSegments(text, mpdUrl, repId);
        const emit = (phase, value) => {
          if (!progressId) return;
          try { chrome.runtime.sendMessage({ type: 'DOWNLOAD_PROGRESS', id: progressId, phase, value }); } catch {}
        };
        const ff = await ensureFfmpeg();
        onProg = (d) => { if (typeof d?.progress === 'number') emit('convert', d.progress); };
        ff.on?.('progress', onProg);
        // Download video
        const vParts = [];
        let done = 0; const total = (built.video.initUrl ? 1 : 0) + built.video.urls.length + (built.audio ? ((built.audio.initUrl ? 1 : 0) + built.audio.urls.length) : 0);
        if (built.video.initUrl) {
          const r = await fetch(built.video.initUrl, { credentials: 'include', referrer: CURRENT_REFERRER || undefined }); if (!r.ok) throw new Error('Init video HTTP ' + r.status);
          vParts.push(new Uint8Array(await r.arrayBuffer())); done++; emit('download', done/total);
        }
        for (const u of built.video.urls) {
          const r = await fetch(u, { credentials: 'include', referrer: CURRENT_REFERRER || undefined }); if (!r.ok) throw new Error('Seg video HTTP ' + r.status);
          vParts.push(new Uint8Array(await r.arrayBuffer())); done++; emit('download', done/total);
        }
        const vLen = vParts.reduce((a,b)=>a+b.byteLength,0); const vBuf = new Uint8Array(vLen); { let o=0; for(const p of vParts){ vBuf.set(p,o); o+=p.byteLength; } }
        let finalBlob;
        if (built.audio) {
          const aParts = [];
          if (built.audio.initUrl) { const r=await fetch(built.audio.initUrl, { credentials: 'include', referrer: CURRENT_REFERRER || undefined }); if(!r.ok) throw new Error('Init audio HTTP '+r.status); aParts.push(new Uint8Array(await r.arrayBuffer())); done++; emit('download', done/total); }
          for (const u of built.audio.urls) { const r=await fetch(u, { credentials: 'include', referrer: CURRENT_REFERRER || undefined }); if(!r.ok) throw new Error('Seg audio HTTP '+r.status); aParts.push(new Uint8Array(await r.arrayBuffer())); done++; emit('download', done/total); }
          const aLen = aParts.reduce((a,b)=>a+b.byteLength,0); const aBuf = new Uint8Array(aLen); { let o=0; for(const p of aParts){ aBuf.set(p,o); o+=p.byteLength; } }
          emit('convert', 0);
          const ff = await ensureFfmpeg();
          await ff.writeFile('v.mp4', vBuf);
          await ff.writeFile('a.mp4', aBuf);
          let ok=false;
          if (!compress) {
            try { await ff.exec(['-i','v.mp4','-i','a.mp4','-map','0:v:0','-map','1:a:0','-c','copy','-movflags','+faststart','-shortest','out.mp4']); ok=true; } catch(_){}
          }
          if (!ok) {
            await ff.exec(['-i','v.mp4','-i','a.mp4','-map','0:v:0','-map','1:a:0','-c:v', compress ? 'libx264':'copy', ...(compress? ['-preset','medium','-crf','23'] : []), '-c:a','aac','-b:a','128k','-movflags','+faststart','-shortest','out.mp4']);
          }
          const out = await ff.readFile('out.mp4');
          await ff.deleteFile('v.mp4'); await ff.deleteFile('a.mp4'); await ff.deleteFile('out.mp4');
          finalBlob = new Blob([out.buffer], { type: 'video/mp4' });
          emit('convert', 1);
        } else {
          // Only video track: remux via ffmpeg for proper metadata
          const ff = await ensureFfmpeg();
          await ff.writeFile('v.mp4', vBuf);
          let ok=false;
          if (!compress) {
            try { await ff.exec(['-i','v.mp4','-c','copy','-movflags','+faststart','out.mp4']); ok=true; } catch(_){}
          }
          if (!ok) {
            await ff.exec(['-i','v.mp4','-c:v','libx264','-preset','medium','-crf', compress ? '23' : '20','-an','-movflags','+faststart','out.mp4']);
          }
          const out = await ff.readFile('out.mp4');
          await ff.deleteFile('v.mp4'); await ff.deleteFile('out.mp4');
          finalBlob = new Blob([out.buffer], { type: 'video/mp4' });
        }
        triggerDownload(finalBlob, filename || 'video.mp4');
        try { if (progressId) chrome.runtime.sendMessage({ type: 'JOB_DONE', id: progressId }); } catch {}
        sendResponse({ ok: true });
      } catch (e) {
        const canceled = progressId && CANCELED_JOBS.has(progressId);
        try { if (progressId) chrome.runtime.sendMessage({ type: 'DOWNLOAD_PROGRESS', id: progressId, phase: canceled ? 'canceled' : 'error', value: 1, message: String(e) }); } catch {}
        sendResponse({ ok: false, error: String(e) });
      } finally {
        try { if (onProg) { const ff = await ensureFfmpeg(); ff.off?.('progress', onProg); } } catch {}
        try { keepPort?.disconnect(); } catch {}
        if (progressId) CANCELED_JOBS.delete(progressId);
        CURRENT_REFERRER = null;
      }
    }
  })();
  return true; // async
});

// Handle cancel request from background/popup
chrome.runtime.onMessage.addListener((msg) => {
  (async () => {
    if (msg?.type === 'OFFSCREEN_CANCEL_JOB' && msg.id) {
      try { CANCELED_JOBS.add(msg.id); } catch {}
      try { const ff = await ensureFfmpeg(); ff.terminate(); self.__ffmpeg = null; } catch {}
    }
  })();
});
