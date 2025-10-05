async function getCurrentTabId() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.id;
}

function filenameFromUrl(url) {
  try {
    const u = new URL(url);
    const last = u.pathname.split('/').filter(Boolean).pop() || 'video';
    const base = last.replace(/\.[^.]+$/, '');
    return base;
  } catch {
    return 'video';
  }
}

async function refresh() {
  const list = document.getElementById('list');
  const empty = document.getElementById('empty');
  list.innerHTML = '';
  empty.style.display = 'none';
  // Jobs container (for ongoing tasks)
  let jobsBox = document.getElementById('jobs');
  if (!jobsBox) {
    jobsBox = document.createElement('div');
    jobsBox.id = 'jobs';
    const h = document.createElement('div'); h.textContent = 'Attività in corso'; h.style.fontWeight = '600'; h.style.margin = '6px 0';
    const ul = document.createElement('ul'); ul.id = 'jobs-list';
    jobsBox.appendChild(h); jobsBox.appendChild(ul);
    list.parentElement.insertBefore(jobsBox, list);
  }
  const jobsList = document.getElementById('jobs-list');
  jobsList.innerHTML = '';
  const progressEls = new Map(); // id -> {bar, label, btn, kind}
  // Restore active jobs on reopen
  try {
    const jr = await chrome.runtime.sendMessage({ type: 'GET_ACTIVE_JOBS' });
    if (jr?.ok && Array.isArray(jr.jobs) && jr.jobs.length) {
      jobsBox.style.display = '';
      for (const j of jr.jobs) {
        const li = document.createElement('li');
        const p = document.createElement('progress'); p.max = 100; p.value = Math.round((j.value||0)*100);
        const pLabel = document.createElement('span'); pLabel.style.marginLeft = '6px';
        pLabel.textContent = j.phase === 'convert' ? 'Conversione...' : 'Scaricamento...';
        li.appendChild(p); li.appendChild(pLabel);
        if (j.type === 'hls-mp4' || j.type === 'dash-mp4') {
          const cancelBtn = document.createElement('button'); cancelBtn.textContent = 'Annulla'; cancelBtn.style.marginLeft = '6px';
          cancelBtn.onclick = async () => { cancelBtn.disabled = true; cancelBtn.textContent = 'Annullamento...'; await chrome.runtime.sendMessage({ type: 'CANCEL_JOB', id: j.id }); };
          li.appendChild(cancelBtn);
          progressEls.set(j.id, { bar: p, label: pLabel, btn: null, kind: j.type, cancel: cancelBtn });
        } else {
          progressEls.set(j.id, { bar: p, label: pLabel, btn: null, kind: j.type });
        }
        jobsList.appendChild(li);
      }
    } else {
      jobsBox.style.display = 'none';
    }
  } catch {
    jobsBox.style.display = 'none';
  }
  const tabId = await getCurrentTabId();
  if (!tabId) return;
  const res = await chrome.runtime.sendMessage({ type: 'GET_STREAMS_FOR_TAB', tabId });
  const items = res?.items || [];
  if (items.length === 0) {
    empty.style.display = 'block';
  }
  const pref = await chrome.storage.local.get('hls_quality_pref');
  const qualityPref = pref.hls_quality_pref || {};

  // (rimosso duplicato jobsBox)

  // listen to progress events
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === 'DOWNLOAD_PROGRESS' && msg.id) {
      jobsBox.style.display = '';
      const entry = progressEls.get(msg.id);
      if (!entry) return;
      if (msg.phase === 'download') {
        entry.bar.value = Math.round((msg.value || 0) * 100);
        entry.label.textContent = `Scaricamento ${entry.bar.value}%`;
        if (entry.kind === 'ts' && (msg.value || 0) >= 1) { if (entry.btn) { entry.btn.textContent = 'Fatto ✔'; entry.btn.disabled = false; } }
      } else if (msg.phase === 'convert') {
        entry.bar.value = Math.round((msg.value || 0) * 100);
        entry.label.textContent = msg.value >= 1 ? 'Conversione completata' : 'Conversione...';
        if ((entry.kind === 'hls-mp4' || entry.kind === 'dash-mp4') && (msg.value || 0) >= 1) { if (entry.btn) { entry.btn.textContent = 'Fatto ✔'; entry.btn.disabled = false; } }
      } else if (msg.phase === 'canceled') {
        entry.bar.value = 0;
        entry.label.textContent = 'Annullato';
        if (entry.cancel) { entry.cancel.disabled = true; entry.cancel.textContent = 'Annullato'; }
        if (entry.btn) { entry.btn.textContent = 'Annullato'; entry.btn.disabled = false; }
      } else if (msg.phase === 'error') {
        entry.bar.value = 0;
        entry.label.textContent = 'Errore';
        if (entry.btn) { entry.btn.textContent = 'Errore'; entry.btn.disabled = false; }
        if (msg.message) alert(msg.message);
      }
    }
  });
  for (const it of items) {
    const url = it.url;
    const li = document.createElement('li');
    const code = document.createElement('code');
    code.textContent = `${it.type.toUpperCase()} • ${url}`;
    li.appendChild(code);
    const row = document.createElement('div');
    row.className = 'row';

    // Quality selector (solo per HLS)
    let select = null;
    if (it.type === 'hls') {
      select = document.createElement('select');
      select.innerHTML = '<option value="">Auto (max qualità)</option>';
      select.disabled = true;
      row.appendChild(select);
      (async () => {
        try {
          const res = await chrome.runtime.sendMessage({ type: 'GET_VARIANTS', playlistUrl: url });
          if (res?.ok && res.master && Array.isArray(res.variants) && res.variants.length > 0) {
            for (const v of res.variants) {
              const labelRes = v.resolution || '?x?';
              const mbps = v.bandwidth ? (v.bandwidth / 1000000).toFixed(2) + ' Mbps' : '';
              const name = v.name ? ` ${v.name}` : '';
              const opt = document.createElement('option');
              opt.value = v.uri;
              opt.textContent = `${labelRes}${name} ${mbps}`.trim();
              select.appendChild(opt);
            }
            // preselect from preference by origin
            try {
              const origin = new URL(url).origin;
              const want = qualityPref[origin]; // resolution string e.g. 1920x1080
              if (want) {
                for (const o of select.options) {
                  if (o.textContent && o.textContent.startsWith(want)) { o.selected = true; break; }
                }
              }
            } catch {}
          }
        } catch (e) {
          // ignore
        } finally {
          select.disabled = false;
        }
      })();
      select.addEventListener('change', () => {
        try {
          const origin = new URL(url).origin;
          const selText = select.selectedOptions?.[0]?.textContent || '';
          const resMatch = selText.match(/^\d+x\d+/);
          const toSave = resMatch ? resMatch[0] : '';
          const updated = { ...qualityPref, [origin]: toSave };
          chrome.storage.local.set({ hls_quality_pref: updated });
        } catch {}
      });
    }

    const btns = document.createElement('div');
    btns.className = 'buttons';

    if (it.type === 'hls') {
      const tsBtn = document.createElement('button');
      tsBtn.textContent = 'Scarica TS';
      tsBtn.onclick = async () => {
        tsBtn.disabled = true; tsBtn.textContent = 'Scarico...';
        const progressId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const pWrap = document.createElement('div');
        const p = document.createElement('progress'); p.max = 100; p.value = 0;
        const pLabel = document.createElement('span'); pLabel.style.marginLeft = '6px'; pLabel.textContent = 'Preparazione...';
        pWrap.appendChild(p); pWrap.appendChild(pLabel); li.appendChild(pWrap);
        progressEls.set(progressId, { bar: p, label: pLabel, btn: tsBtn, kind: 'ts' });
        const name = filenameFromUrl(url) + '.ts';
        const res = await chrome.runtime.sendMessage({
          type: 'DOWNLOAD_TS',
          playlistUrl: url,
          filename: name,
          variantUrl: select?.value || undefined,
          progressId,
        });
        if (!res?.ok && res?.error) { tsBtn.disabled = false; tsBtn.textContent = 'Errore'; alert('Errore scarico TS: ' + res.error); }
      };
      btns.appendChild(tsBtn);

      // Compress toggle
      const compWrap = document.createElement('label');
      compWrap.style.marginRight = '8px';
      const compChk = document.createElement('input');
      compChk.type = 'checkbox';
      compChk.style.marginRight = '4px';
      compWrap.appendChild(compChk);
      compWrap.appendChild(document.createTextNode('Comprimi'));
      btns.appendChild(compWrap);

      const mp4Btn = document.createElement('button');
      mp4Btn.textContent = 'Scarica MP4 (beta)';
      mp4Btn.title = 'Conversione locale con ffmpeg.wasm. Lenta per video lunghi.';
      mp4Btn.onclick = async () => {
        mp4Btn.disabled = true; mp4Btn.textContent = 'Convertendo...';
        const progressId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const pWrap = document.createElement('div');
        const p = document.createElement('progress'); p.max = 100; p.value = 0;
        const pLabel = document.createElement('span'); pLabel.style.marginLeft = '6px'; pLabel.textContent = 'Scaricamento...';
        const cancelBtn = document.createElement('button'); cancelBtn.textContent = 'Annulla'; cancelBtn.style.marginLeft = '6px';
        cancelBtn.onclick = async () => { cancelBtn.disabled = true; cancelBtn.textContent = 'Annullamento...'; await chrome.runtime.sendMessage({ type: 'CANCEL_JOB', id: progressId }); };
        pWrap.appendChild(p); pWrap.appendChild(pLabel); pWrap.appendChild(cancelBtn); li.appendChild(pWrap);
        progressEls.set(progressId, { bar: p, label: pLabel, btn: mp4Btn, kind: 'hls-mp4', cancel: cancelBtn });
        const name = filenameFromUrl(url) + '.mp4';
        const res = await chrome.runtime.sendMessage({
          type: 'DOWNLOAD_MP4',
          playlistUrl: url,
          filename: name,
          variantUrl: select?.value || undefined,
          progressId,
          compress: compChk.checked || undefined,
        });
        if (!res?.ok && res?.error) { mp4Btn.disabled = false; mp4Btn.textContent = 'Errore'; alert('Errore conversione MP4: ' + res.error); }
      };
      btns.appendChild(mp4Btn);
    } else if (it.type === 'direct') {
      const dlBtn = document.createElement('button');
      dlBtn.textContent = 'Scarica file';
      dlBtn.onclick = async () => {
        dlBtn.disabled = true; dlBtn.textContent = 'Scarico...';
        const name = filenameFromUrl(url) + (url.match(/\.(mp4|m4v|webm|mov)(?=$|\?)/i)?.[0] || '');
        const res = await chrome.runtime.sendMessage({ type: 'DOWNLOAD_DIRECT', url, filename: name });
        dlBtn.disabled = false; dlBtn.textContent = res?.ok ? 'Fatto ✔' : 'Errore';
        if (!res?.ok && res?.error) {
          alert('Errore download: ' + res.error);
        }
        setTimeout(() => (dlBtn.textContent = 'Scarica file'), 1500);
      };
      btns.appendChild(dlBtn);
    } else if (it.type === 'dash') {
      // Quality selector for DASH
      const select = document.createElement('select');
      select.innerHTML = '<option value="">Auto (max qualità)</option>';
      select.disabled = true;
      row.appendChild(select);
      (async () => {
        try {
          const vr = await chrome.runtime.sendMessage({ type: 'DASH_GET_VARIANTS', mpdUrl: url });
          if (vr?.ok && Array.isArray(vr.variants)) {
            for (const v of vr.variants) {
              const opt = document.createElement('option');
              const labelRes = v.resolution || '?x?';
              const mbps = v.bandwidth ? (v.bandwidth / 1e6).toFixed(2) + ' Mbps' : '';
              opt.value = v.id || '';
              opt.textContent = `${labelRes} ${mbps}`.trim();
              select.appendChild(opt);
            }
          }
        } catch {}
        select.disabled = false;
      })();

      // Compress toggle for DASH
      const compWrap = document.createElement('label');
      compWrap.style.marginRight = '8px';
      const compChk = document.createElement('input');
      compChk.type = 'checkbox';
      compChk.style.marginRight = '4px';
      compWrap.appendChild(compChk);
      compWrap.appendChild(document.createTextNode('Comprimi'));
      btns.appendChild(compWrap);

      const mp4Btn = document.createElement('button');
      mp4Btn.textContent = 'Scarica MP4 (DASH beta)';
      mp4Btn.onclick = async () => {
        mp4Btn.disabled = true; mp4Btn.textContent = 'Scaricando...';
        const progressId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const pWrap = document.createElement('div');
        const p = document.createElement('progress'); p.max = 100; p.value = 0;
        const pLabel = document.createElement('span'); pLabel.style.marginLeft = '6px'; pLabel.textContent = 'Scaricamento...';
        const cancelBtn = document.createElement('button'); cancelBtn.textContent = 'Annulla'; cancelBtn.style.marginLeft = '6px';
        cancelBtn.onclick = async () => { cancelBtn.disabled = true; cancelBtn.textContent = 'Annullamento...'; await chrome.runtime.sendMessage({ type: 'CANCEL_JOB', id: progressId }); };
        pWrap.appendChild(p); pWrap.appendChild(pLabel); pWrap.appendChild(cancelBtn); li.appendChild(pWrap);
        progressEls.set(progressId, { bar: p, label: pLabel, btn: mp4Btn, kind: 'dash-mp4', cancel: cancelBtn });
        const name = filenameFromUrl(url) + '.mp4';
        const res = await chrome.runtime.sendMessage({ type: 'DASH_DOWNLOAD_MP4', mpdUrl: url, filename: name, repId: select.value || undefined, progressId, compress: compChk.checked || undefined });
        if (!res?.ok && res?.error) { mp4Btn.disabled = false; mp4Btn.textContent = 'Errore'; alert('Errore DASH: ' + res.error); }
      };
      btns.appendChild(mp4Btn);
      // removed: Copy URL MPD button per richiesta
    }

    row.appendChild(btns);
    li.appendChild(row);
    list.appendChild(li);
  }
}

refresh();
