/* 다중 영상 컷 편집기
   - PC 서버(studio-launcher tools/video-cutter, 127.0.0.1:8768)가 켜져 있으면 ffmpeg 로 정확 컷/합치기
   - 서버가 없으면 브라우저 안에서(MediaRecorder) 구간 녹화 저장
*/
(() => {
  'use strict';

  const MAX_CLIPS = 5;
  const MIN_LEN = 0.1;
  const HUB_PORT = 8770;
  const SRV_PORT = 8768;

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  const state = {
    base: null,      // '' (같은 서버에서 열림) 또는 'http://127.0.0.1:8768'
    health: null,    // /health 응답
    clips: [],
    seq: 0,
    busy: false,
    lastResult: null,
  };

  /* ───────────── 공용 유틸 ───────────── */
  function esc(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function clamp(v, a, b) { return Math.min(b, Math.max(a, v)); }
  function even(n) { return Math.max(2, Math.round(n / 2) * 2); }

  function fmt(t) {
    t = Math.max(0, Number(t) || 0);
    const m = Math.floor(t / 60);
    const s = t - m * 60;
    return `${m}:${s.toFixed(1).padStart(4, '0')}`;
  }
  function fmtShort(t) {
    t = Math.max(0, Number(t) || 0);
    const m = Math.floor(t / 60);
    if (m > 0) return `${m}분 ${String(Math.round(t - m * 60)).padStart(2, '0')}초`;
    const s = Math.round(t * 10) / 10;
    return `${Number.isInteger(s) ? s : s.toFixed(1)}초`;
  }
  function parseTime(text) {
    const s = String(text).trim().replace(/,/g, '.');
    if (!s) return NaN;
    if (s.includes(':')) {
      const parts = s.split(':');
      if (parts.length > 2) return NaN;
      const m = Number(parts[0]);
      const sec = Number(parts[1]);
      if (!isFinite(m) || !isFinite(sec)) return NaN;
      return m * 60 + sec;
    }
    const v = Number(s.replace(/[^\d.]/g, ''));
    return isFinite(v) ? v : NaN;
  }
  function fmtBytes(n) {
    if (!n) return '';
    if (n > 1024 * 1024 * 1024) return (n / 1073741824).toFixed(1) + 'GB';
    if (n > 1024 * 1024) return (n / 1048576).toFixed(1) + 'MB';
    return Math.round(n / 1024) + 'KB';
  }

  let toastT = 0;
  function toast(msg, ms = 2600) {
    const el = $('#toast');
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toastT);
    toastT = setTimeout(() => { el.hidden = true; }, ms);
  }

  async function fetchJSON(url, timeout = 1800) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeout);
    try {
      const res = await fetch(url, { cache: 'no-store', signal: ctl.signal, mode: 'cors' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return await res.json();
    } finally {
      clearTimeout(t);
    }
  }

  /* ───────────── PC 서버 연결 ───────────── */
  const localHost = /^(127\.0\.0\.1|localhost)$/.test(location.hostname);

  async function detectServer() {
    // 1) 서버가 직접 서빙한 페이지면 같은 주소로
    if (localHost && location.port === String(SRV_PORT)) {
      try {
        const h = await fetchJSON('/health', 1500);
        if (h && h.app === 'video-cutter') return { base: '', health: h };
      } catch (e) { /* 아래 후보로 */ }
    }
    // 2) 로컬 허브(8770)가 도구 포트를 알려 줌
    const candidates = [];
    try {
      const hub = await fetchJSON(`http://127.0.0.1:${HUB_PORT}/api/status`, 1200);
      const t = (hub && hub.tools || []).find(x => x.id === 'video-cutter');
      if (t && t.port) candidates.push(`http://127.0.0.1:${t.port}`);
    } catch (e) { /* 허브 없음 */ }
    // 3) 기본 포트
    candidates.push(`http://127.0.0.1:${SRV_PORT}`);

    for (const base of [...new Set(candidates)]) {
      try {
        const h = await fetchJSON(base + '/health', 1600);
        if (h && h.app === 'video-cutter') return { base, health: h };
      } catch (e) { /* 다음 후보 */ }
    }
    return { base: null, health: null };
  }

  async function connect(manual = false) {
    const pill = $('#connPill');
    pill.className = 'pill wait';
    $('span', pill).textContent = '연결 확인 중';

    const found = await detectServer();
    const wasServer = state.base !== null;
    state.base = found.base;
    state.health = found.health;

    if (found.base !== null) {
      pill.className = 'pill on';
      $('span', pill).textContent = 'PC 서버 연결됨';
      $('#modeNotice').hidden = true;
      $('#modeFine').innerHTML = 'PC 서버 모드 — <b>ffmpeg</b>로 프레임 단위 정확하게 잘라 <b>MP4</b>로 저장해요. 파일은 이 PC 안에서만 처리됩니다.';
      // 서버가 늦게 붙었으면 아직 안 올린 영상 업로드
      state.clips.forEach(c => { if (!c.serverId && !c.uploading && !c.removed) uploadClip(c); });
    } else {
      pill.className = 'pill off';
      $('span', pill).textContent = '브라우저 모드';
      $('#modeNotice').hidden = false;
      $('#modeFine').innerHTML = '브라우저 모드 — 서버가 없어서 <b>브라우저 녹화(WebM)</b>로 저장해요. 실제 재생 시간만큼 걸리고, MP4가 필요하면 집 PC 런처의 <b>영상 컷 편집기</b>로 열어 주세요.';
      if (manual) toast('PC 서버를 찾지 못했어요. 집 PC에서 실행하기.bat 을 켠 뒤 다시 확인해 주세요.');
    }
    if (manual && found.base !== null && !wasServer) toast('PC 서버에 연결됐어요. ffmpeg로 잘라요.');
    renderAll();
  }

  /* ───────────── 클립 만들기 ───────────── */
  function addFiles(fileList) {
    const files = Array.from(fileList || []).filter(f =>
      (f.type && f.type.startsWith('video/')) || /\.(mp4|m4v|mov|webm|mkv|avi|3gp|mpg|mpeg)$/i.test(f.name));
    if (!files.length) { toast('영상 파일만 넣을 수 있어요.'); return; }

    const room = MAX_CLIPS - state.clips.length;
    if (room <= 0) { toast('영상은 최대 5개까지예요. 하나 빼고 넣어 주세요.'); return; }
    if (files.length > room) toast(`최대 5개라서 ${room}개만 넣었어요.`);

    files.slice(0, room).forEach(createClip);
    renderAll();
  }

  const CLIP_HTML = `
    <div class="clip-head">
      <span class="clip-no">1</span>
      <span class="clip-name" title=""></span>
      <span class="clip-meta">불러오는 중…</span>
      <div class="clip-tools">
        <button class="mini up" type="button" title="위로 (순서 바꾸기)" aria-label="위로">↑</button>
        <button class="mini down" type="button" title="아래로 (순서 바꾸기)" aria-label="아래로">↓</button>
        <button class="mini rm" type="button" title="이 영상 빼기" aria-label="빼기">✕</button>
      </div>
    </div>
    <div class="clip-body">
      <div class="stage">
        <video playsinline preload="metadata" controls></video>
        <span class="badge">구간 —</span>
      </div>
      <div class="ctrl">
        <div class="tl"><div class="tl-fill"></div><div class="tl-sel"></div></div>
        <label class="field"><span class="k">시작</span>
          <input type="range" class="srange" min="0" max="1" step="0.05" value="0">
          <input class="tinput tstart" type="text" inputmode="decimal" value="0:00.0" aria-label="시작 시간">
        </label>
        <label class="field"><span class="k">끝</span>
          <input type="range" class="rrange" min="0" max="1" step="0.05" value="1">
          <input class="tinput tend" type="text" inputmode="decimal" value="0:00.0" aria-label="끝 시간">
        </label>
        <div class="set-row">
          <button class="btn sm" type="button" data-set="start">현재 위치 → 시작점</button>
          <button class="btn sm" type="button" data-set="end">현재 위치 → 끝점</button>
          <button class="btn sm ghost" type="button" data-play>▶ 구간 재생</button>
        </div>
        <div class="clip-actions">
          <button class="btn sm primary" type="button" data-cut>이 구간 자르기</button>
          <label class="chk"><input type="checkbox" class="inc" checked> 합치기에 포함</label>
          <span class="dur"></span>
        </div>
      </div>
    </div>`;

  function createClip(file) {
    const root = document.createElement('article');
    root.className = 'clip';
    root.innerHTML = CLIP_HTML;

    const clip = {
      key: ++state.seq,
      file,
      name: file.name || ('영상' + state.seq),
      size: file.size,
      url: URL.createObjectURL(file),
      duration: 0, width: 0, height: 0,
      start: 0, end: 0,
      include: true,
      serverId: null, uploading: false, progress: 0, error: '',
      segPlay: false,
      root,
      els: {
        no: $('.clip-no', root),
        name: $('.clip-name', root),
        meta: $('.clip-meta', root),
        stage: $('.stage', root),
        video: $('video', root),
        badge: $('.badge', root),
        tlFill: $('.tl-fill', root),
        tlSel: $('.tl-sel', root),
        srange: $('.srange', root),
        rrange: $('.rrange', root),
        tstart: $('.tstart', root),
        tend: $('.tend', root),
        play: $('[data-play]', root),
        cut: $('[data-cut]', root),
        inc: $('.inc', root),
        dur: $('.dur', root),
      },
    };
    clip.video = clip.els.video;
    clip.video.src = clip.url;

    state.clips.push(clip);
    wireClip(clip);

    clip.video.addEventListener('loadedmetadata', () => {
      const d = clip.video.duration;
      if (isFinite(d) && d > 0) {
        clip.duration = d;
        clip.start = 0;
        clip.end = d;
      } else if (!clip._probedInfinity) {
        // 녹화(MediaRecorder) webm 은 길이가 Infinity 로 오기도 함 — 크게 시크해 길이를 받아옵니다
        clip._probedInfinity = true;
        const onSeek = () => {
          clip.video.removeEventListener('timeupdate', onSeek);
          const real = clip.video.duration;
          if (isFinite(real) && real > 0) {
            clip.duration = real;
            clip.start = 0;
            clip.end = real;
            clip.video.currentTime = 0;
            syncClip(clip);
            updateSummary();
          }
        };
        clip.video.addEventListener('timeupdate', onSeek);
        try { clip.video.currentTime = 1e6; } catch (e) { /* noop */ }
        setTimeout(() => clip.video.removeEventListener('timeupdate', onSeek), 2500);
      }
      clip.width = clip.video.videoWidth || clip.width;
      clip.height = clip.video.videoHeight || clip.height;
      syncClip(clip);
      updateSummary();
    });
    clip.video.addEventListener('error', () => {
      clip.els.meta.textContent = '이 브라우저에서 못 여는 형식이에요';
    });

    return clip;
  }

  function wireClip(clip) {
    const { els } = clip;
    const v = clip.video;

    v.addEventListener('timeupdate', () => {
      if (!clip.duration) return;
      clip.els.tlFill.style.width = (v.currentTime / clip.duration * 100) + '%';
      if (clip.segPlay && v.currentTime >= clip.end - 0.02) {
        v.pause();
        clip.segPlay = false;
        els.play.textContent = '▶ 구간 재생';
      }
    });

    const applyRange = (which, val) => {
      if (!clip.duration) return;
      val = clamp(val, 0, clip.duration);
      if (which === 'start') {
        clip.start = Math.min(val, Math.max(0, clip.end - MIN_LEN));
      } else {
        clip.end = Math.max(val, clip.start + MIN_LEN);
      }
      syncClip(clip);
      updateSummary();
    };

    els.srange.addEventListener('input', () => applyRange('start', Number(els.srange.value)));
    els.rrange.addEventListener('input', () => applyRange('end', Number(els.rrange.value)));

    const commitText = (which) => {
      const input = which === 'start' ? els.tstart : els.tend;
      const val = parseTime(input.value);
      if (!isFinite(val)) {
        input.classList.add('bad');
        syncClip(clip);
        return;
      }
      input.classList.remove('bad');
      applyRange(which, val);
      // 슬라이더/입력 동기화
      if (which === 'start') {
        if (val > clip.end - MIN_LEN) v.currentTime = clip.start;
      } else if (val >= clip.duration) v.currentTime = clip.end;
    };
    els.tstart.addEventListener('change', () => commitText('start'));
    els.tend.addEventListener('change', () => commitText('end'));
    els.tstart.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); commitText('start'); } });
    els.tend.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); commitText('end'); } });

    $$('[data-set]', clip.root).forEach(btn => {
      btn.addEventListener('click', () => {
        const which = btn.dataset.set;
        const t = v.currentTime || 0;
        if (which === 'start') {
          clip.start = Math.min(t, Math.max(0, clip.end - MIN_LEN));
          if (v.currentTime < clip.start) v.currentTime = clip.start;
        } else {
          clip.end = Math.max(t, clip.start + MIN_LEN);
        }
        syncClip(clip);
        updateSummary();
        toast(which === 'start' ? `시작점을 ${fmt(clip.start)}로 잡았어요` : `끝점을 ${fmt(clip.end)}로 잡았어요`, 1600);
      });
    });

    els.play.addEventListener('click', async () => {
      if (clip.segPlay) {
        v.pause();
        clip.segPlay = false;
        els.play.textContent = '▶ 구간 재생';
        return;
      }
      if (!clip.duration) return;
      clip.segPlay = true;
      els.play.textContent = '■ 멈춤';
      try {
        v.currentTime = clip.start;
        await v.play();
      } catch (e) {
        clip.segPlay = false;
        els.play.textContent = '▶ 구간 재생';
        toast('재생을 시작하지 못했어요. 플레이어를 직접 눌러 주세요.');
      }
    });

    els.inc.addEventListener('change', () => { clip.include = els.inc.checked; updateSummary(); });

    els.cut.addEventListener('click', () => cutOne(clip));

    $('.up', clip.root).addEventListener('click', () => moveClip(clip, -1));
    $('.down', clip.root).addEventListener('click', () => moveClip(clip, +1));
    $('.rm', clip.root).addEventListener('click', () => removeClip(clip));
  }

  function syncClip(clip) {
    const { els } = clip;
    els.name.textContent = clip.name;
    els.name.title = clip.name;

    let meta = '';
    if (clip.uploading) meta = `업로드 ${Math.round(clip.progress * 100)}%`;
    else if (clip.duration) meta = `${fmt(clip.duration)} · ${clip.width || '?'}×${clip.height || '?'}`;
    else if (clip.error) meta = clip.error;
    else meta = '불러오는 중…';
    if (clip.serverId && !clip.uploading) meta = 'PC 서버 준비됨 · ' + meta;
    els.meta.textContent = meta;

    const d = clip.duration || 1;
    els.srange.max = String(clip.duration || 1);
    els.rrange.max = String(clip.duration || 1);
    els.srange.value = String(clip.start);
    els.rrange.value = String(clip.end);
    if (document.activeElement !== els.tstart) els.tstart.value = fmt(clip.start);
    if (document.activeElement !== els.tend) els.tend.value = fmt(clip.end);
    els.tstart.classList.remove('bad');
    els.tend.classList.remove('bad');

    const left = clip.start / d * 100;
    const width = Math.max(0, (clip.end - clip.start) / d * 100);
    els.tlSel.style.left = left + '%';
    els.tlSel.style.width = width + '%';

    els.badge.textContent = clip.duration ? `${fmt(clip.start)} ~ ${fmt(clip.end)}` : '구간 —';
    els.dur.innerHTML = clip.duration
      ? `<b>${fmtShort(clip.end - clip.start)}</b> 구간`
      : '';
    els.cut.disabled = !clip.duration || clip.end - clip.start < MIN_LEN;
  }

  function moveClip(clip, dir) {
    const i = state.clips.indexOf(clip);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= state.clips.length) return;
    state.clips.splice(i, 1);
    state.clips.splice(j, 0, clip);
    const parent = clip.root.parentNode;
    parent.removeChild(clip.root);
    parent.insertBefore(clip.root, state.clips[j + 1] ? state.clips[j + 1].root : null);
    renumber();
    updateSummary();
  }

  function removeClip(clip) {
    clip.removed = true;
    const i = state.clips.indexOf(clip);
    if (i >= 0) state.clips.splice(i, 1);
    try { clip.video.pause(); } catch (e) { /* noop */ }
    cleanupAudio(clip);
    URL.revokeObjectURL(clip.url);
    if (clip.root.parentNode) clip.root.parentNode.removeChild(clip.root);
    renderAll();
    if (state.base !== null && clip.serverId) {
      fetch(state.base + '/api/forget?id=' + encodeURIComponent(clip.serverId), { method: 'POST' }).catch(() => {});
    }
  }

  function renumber() {
    state.clips.forEach((c, i) => { c.els.no.textContent = String(i + 1); });
  }

  function renderAll() {
    const box = $('#clips');
    state.clips.forEach(c => { if (c.root.parentNode !== box) box.appendChild(c.root); });
    renumber();
    $('#emptyHint').hidden = state.clips.length > 0;
    $('#slotCount').textContent = `${state.clips.length} / ${MAX_CLIPS}`;
    $('#drop').classList.toggle('full', state.clips.length >= MAX_CLIPS);
    $('#actionBlock').hidden = state.clips.length === 0;
    state.clips.forEach(syncClip);
    updateSummary();
  }

  function updateSummary() {
    const parts = state.clips.filter(c => c.include && c.duration && c.end - c.start >= MIN_LEN);
    const total = parts.reduce((a, c) => a + (c.end - c.start), 0);
    $('#sumText').textContent = parts.length
      ? `${parts.length}개 · 총 ${fmtShort(total)}`
      : '포함된 구간이 없어요';
    const serverReady = state.base !== null && parts.length > 0 && parts.every(p => p.serverId);
    const label = state.base !== null && !serverReady && parts.length
      ? 'PC 서버로 업로드하는 중…'
      : (state.base !== null ? '여백은 검은 띠로 채워 이어 붙여요' : '브라우저 녹화로 이어 붙여요 (재생 시간만큼)');
    $('#sumSub').textContent = label;
    $('#concatBtn').disabled = state.busy || parts.length === 0;
  }

  /* ───────────── 업로드 ───────────── */
  function uploadClip(clip) {
    if (!state.base && state.base !== '') return;
    clip.uploading = true;
    clip.progress = 0;
    clip.error = '';
    syncClip(clip);

    const xhr = new XMLHttpRequest();
    xhr.open('POST', state.base + '/api/upload?name=' + encodeURIComponent(clip.name), true);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.upload.onprogress = e => {
      if (!e.lengthComputable) return;
      clip.progress = e.loaded / e.total;
      syncClip(clip);
    };
    xhr.onload = () => {
      clip.uploading = false;
      let d = {};
      try { d = JSON.parse(xhr.responseText || '{}'); } catch (e) { d = {}; }
      if (d.ok) {
        clip.serverId = d.id;
        if (d.duration) {
          if (!clip.duration) { clip.duration = d.duration; clip.start = 0; clip.end = d.duration; }
        }
        if (d.width) clip.width = d.width;
        if (d.height) clip.height = d.height;
      } else {
        clip.error = d.error || '업로드 실패';
      }
      syncClip(clip);
      updateSummary();
    };
    xhr.onerror = () => {
      clip.uploading = false;
      clip.error = 'PC 서버에 못 올렸어요';
      syncClip(clip);
      updateSummary();
    };
    xhr.send(clip.file);
  }

  /* ───────────── 서버 작업 ───────────── */
  async function api(path, payload) {
    const res = await fetch(state.base + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload || {}),
    });
    let data = {};
    try { data = await res.json(); } catch (e) { data = {}; }
    if (!res.ok || !data.ok) throw new Error(data.error || ('서버 오류 (HTTP ' + res.status + ')'));
    return data;
  }

  function showJob(pct, text) {
    $('#job').hidden = false;
    $('#jobFill').style.width = clamp(pct, 0, 100) + '%';
    $('#jobText').textContent = text;
  }
  function hideJob() {
    $('#job').hidden = true;
    $('#jobFill').style.width = '0%';
  }

  function addResult(file, note) {
    const ul = $('#resultList');
    $('#results').hidden = false;
    const li = document.createElement('li');
    const url = file.url.startsWith('http') ? file.url : state.base + file.url;
    li.innerHTML = `<span class="rgrow"><i class="dot"></i><span class="rname" title="${esc(file.name)}">${esc(file.name)}</span>
      <span class="rsize">${esc(fmtBytes(file.size))}${note ? ' · ' + esc(note) : ''}</span></span>`;
    const a = document.createElement('a');
    a.className = 'btn sm';
    a.href = url;
    a.download = file.name;
    a.textContent = '다시 저장';
    li.appendChild(a);
    ul.insertBefore(li, ul.firstChild);
    return a;
  }

  function autoDownload(url, name) {
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  function outName(clip, idx) {
    const base = (clip.name || 'clip').replace(/\.[^.]+$/, '').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 40);
    const len = Math.round((clip.end - clip.start) * 10) / 10;
    return `${String(idx + 1).padStart(2, '0')}_${base}_${len}s`;
  }

  async function cutOne(clip) {
    if (state.busy) return;
    if (!clip.duration || clip.end - clip.start < MIN_LEN) {
      toast('구간을 먼저 잡아 주세요.');
      return;
    }
    const idx = state.clips.indexOf(clip);

    if (state.base !== null && clip.serverId) {
      setBusy(true);
      showJob(15, 'ffmpeg로 자르는 중…');
      try {
        const name = outName(clip, idx) + '.mp4';
        const data = await api('/api/cut', {
          id: clip.serverId, start: clip.start, end: clip.end, name,
        });
        showJob(100, '완료');
        const a = addResult(data.file, 'MP4');
        autoDownload((data.file.url.startsWith('http') ? '' : state.base) + data.file.url, data.file.name);
        toast(`${data.file.name} 저장했어요`);
        setTimeout(hideJob, 900);
      } catch (err) {
        hideJob();
        toast('자르기 실패: ' + err.message, 4000);
      } finally {
        setBusy(false);
      }
      return;
    }

    // 브라우저 모드
    setBusy(true);
    try {
      const res = await recordParts([{ clip, start: clip.start, end: clip.end }], (p, txt) => showJob(p * 100, txt));
      const name = outName(clip, idx) + res.ext;
      const blobUrl = URL.createObjectURL(res.blob);
      addResult({ name, size: res.blob.size, url: blobUrl }, '브라우저');
      autoDownload(blobUrl, name);
      showJob(100, '완료');
      toast(`${name} 저장했어요`);
      setTimeout(hideJob, 900);
    } catch (err) {
      hideJob();
      toast('자르기 실패: ' + err.message, 4500);
    } finally {
      setBusy(false);
    }
  }

  async function concatAll() {
    const parts = state.clips.filter(c => c.include && c.duration && c.end - c.start >= MIN_LEN)
      .map(c => ({ clip: c, start: c.start, end: c.end }));
    if (!parts.length) { toast('합칠 구간이 없어요.'); return; }
    if (state.busy) return;

    const stamp = new Date();
    const name = `cut_${String(stamp.getMonth() + 1).padStart(2, '0')}${String(stamp.getDate()).padStart(2, '0')}_` +
      `${String(stamp.getHours()).padStart(2, '0')}${String(stamp.getMinutes()).padStart(2, '0')}`;

    if (state.base !== null) {
      if (!parts.every(p => p.clip.serverId)) {
        toast('아직 PC 서버로 업로드 중인 영상이 있어요. 잠시 뒤 다시 눌러 주세요.', 3500);
        return;
      }
      setBusy(true);
      showJob(10, `${parts.length}개 구간을 이어 붙이는 중…`);
      try {
        const data = await api('/api/concat', {
          parts: parts.map(p => ({ id: p.clip.serverId, start: p.start, end: p.end })),
          name: name + '.mp4',
        });
        showJob(100, '완료');
        addResult(data.file, 'MP4 · 합치기');
        autoDownload((data.file.url.startsWith('http') ? '' : state.base) + data.file.url, data.file.name);
        toast(`${data.file.name} 저장했어요`);
        setTimeout(hideJob, 900);
      } catch (err) {
        hideJob();
        toast('합치기 실패: ' + err.message, 4500);
      } finally {
        setBusy(false);
      }
      return;
    }

    setBusy(true);
    try {
      const res = await recordParts(parts, (p, txt) => showJob(p * 100, txt));
      const fname = name + res.ext;
      const url = URL.createObjectURL(res.blob);
      addResult({ name: fname, size: res.blob.size, url }, '브라우저 · 합치기');
      autoDownload(url, fname);
      showJob(100, '완료');
      toast(`${fname} 저장했어요`);
      setTimeout(hideJob, 900);
    } catch (err) {
      hideJob();
      toast('합치기 실패: ' + err.message, 4500);
    } finally {
      setBusy(false);
    }
  }

  function setBusy(on) {
    state.busy = on;
    const parts = state.clips.filter(c => c.include && c.duration && c.end - c.start >= MIN_LEN);
    $('#concatBtn').disabled = on || parts.length === 0;
    state.clips.forEach(c => { c.els.cut.disabled = on || !c.duration || c.end - c.start < MIN_LEN; });
    $$('.mini', $('#clips')).forEach(b => { if (!b.classList.contains('rm')) b.disabled = false; });
    if (on) $$('.clip [data-set], .clip [data-play]').forEach(b => { b.disabled = true; });
    else $$('.clip [data-set], .clip [data-play]').forEach(b => { b.disabled = false; });
  }

  /* ───────────── 브라우저 녹화 컷 ───────────── */
  let audioCtx = null;
  function getAudioCtx() {
    if (!audioCtx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      audioCtx = new AC();
    }
    return audioCtx;
  }

  function pickMime() {
    const cands = [
      ['video/webm;codecs=vp9,opus', '.webm'],
      ['video/webm;codecs=vp8,opus', '.webm'],
      ['video/webm', '.webm'],
      ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', '.mp4'],
      ['video/mp4', '.mp4'],
    ];
    if (!window.MediaRecorder) return { mime: '', ext: '.webm' };
    for (const [m, ext] of cands) {
      try { if (MediaRecorder.isTypeSupported(m)) return { mime: m, ext }; } catch (e) { /* noop */ }
    }
    return { mime: '', ext: '.webm' };
  }

  function targetSize(parts) {
    const c = parts[0].clip;
    let w = c.width || 1280;
    let h = c.height || 720;
    const long = Math.max(w, h);
    if (long > 1920) {
      const k = 1920 / long;
      w *= k; h *= k;
    }
    return { w: even(w), h: even(h) };
  }

  function drawCover(ctx, video, W, H) {
    const vw = video.videoWidth || W;
    const vh = video.videoHeight || H;
    const k = Math.min(W / vw, H / vh);
    const dw = vw * k, dh = vh * k;
    const dx = (W - dw) / 2, dy = (H - dh) / 2;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
    try { ctx.drawImage(video, dx, dy, dw, dh); } catch (e) { /* 아직 프레임 없음 */ }
  }

  function waitEvent(el, name, timeout = 4000) {
    return new Promise((resolve, reject) => {
      let done = false;
      const t = setTimeout(() => { if (!done) { done = true; cleanup(); resolve(false); } }, timeout);
      function on() { if (done) return; done = true; cleanup(); resolve(true); }
      function cleanup() { clearTimeout(t); el.removeEventListener(name, on); }
      el.addEventListener(name, on);
    });
  }

  function cleanupAudio(clip) {
    if (clip._src) {
      try { clip._src.disconnect(); } catch (e) { /* noop */ }
    }
  }

  async function recordParts(parts, onProgress) {
    if (!window.MediaRecorder) {
      throw new Error('이 브라우저는 녹화 저장(MediaRecorder)을 지원하지 않아요. 집 PC 런처로 열어 주세요.');
    }
    const { mime, ext } = pickMime();
    const { w, h } = targetSize(parts);
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d', { alpha: false });
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, w, h);

    const stream = canvas.captureStream(30);
    const ac = getAudioCtx();
    if (ac && ac.state === 'suspended') { try { await ac.resume(); } catch (e) { /* noop */ } }
    const dest = ac ? ac.createMediaStreamDestination() : null;
    const audioTrack = dest ? dest.stream.getAudioTracks()[0] : null;
    if (audioTrack) stream.addTrack(audioTrack);

    const connected = [];
    parts.forEach(p => {
      const v = p.clip.video;
      try { v.muted = false; v.volume = 1; } catch (e) { /* noop */ }
      if (!ac || !dest) return;
      if (!p.clip._src) {
        try { p.clip._src = ac.createMediaElementSource(v); } catch (e) { p.clip._src = null; }
      }
      if (p.clip._src) {
        try { p.clip._src.connect(dest); connected.push(p.clip._src); } catch (e) { /* noop */ }
        try { p.clip._src.connect(ac.destination); } catch (e) { /* noop */ }
      }
    });

    const rec = new MediaRecorder(stream, mime ? { mimeType: mime, videoBitsPerSecond: 6000000 } : undefined);
    const chunks = [];
    rec.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
    const stopped = new Promise(res => { rec.onstop = () => res(); });
    rec.start(250);

    let raf = 0;
    const totalDur = parts.reduce((a, p) => a + (p.end - p.start), 0);
    let doneDur = 0;

    try {
      for (const p of parts) {
        const v = p.clip.video;
        // 다른 영상은 멈춰 두기
        state.clips.forEach(c => { if (c !== p.clip) { try { c.video.pause(); } catch (e) { /* noop */ } } });

        const ready = await new Promise(resolve => {
          if (v.readyState >= 1) return resolve(true);
          const on = () => { v.removeEventListener('loadedmetadata', on); resolve(true); };
          v.addEventListener('loadedmetadata', on);
          setTimeout(() => { v.removeEventListener('loadedmetadata', on); resolve(false); }, 3000);
        });
        if (!ready) throw new Error('영상을 불러오지 못했어요: ' + p.clip.name);

        try {
          v.currentTime = Math.max(0, p.start);
          await waitEvent(v, 'seeked', 3000);
          await v.play();
        } catch (e) {
          try { v.muted = true; await v.play(); } catch (e2) {
            throw new Error('재생을 시작할 수 없어요. 플레이어를 한 번 눌러 주세요.');
          }
        }

        await new Promise(resolve => {
          function tick() {
            const t = v.currentTime;
            const local = clamp((t - p.start) / Math.max(0.01, p.end - p.start), 0, 1);
            drawCover(ctx, v, w, h);
            onProgress(Math.min(0.99, (doneDur + local * (p.end - p.start)) / Math.max(0.01, totalDur)),
              `${parts.indexOf(p) + 1}/${parts.length}번째 구간 녹화 중… ${fmt(t - p.start)} / ${fmt(p.end - p.start)}`);
            if (t >= p.end - 0.02 || v.ended) { resolve(); return; }
            raf = requestAnimationFrame(tick);
          }
          tick();
        });
        cancelAnimationFrame(raf);
        try { v.pause(); } catch (e) { /* noop */ }
        doneDur += p.end - p.start;
      }

      // 마지막 프레임이 확실히 들어가도록 잠깐 더 그림
      const last = parts[parts.length - 1].clip.video;
      const t0 = performance.now();
      await new Promise(res => {
        function more() {
          drawCover(ctx, last, w, h);
          if (performance.now() - t0 > 260) { res(); return; }
          requestAnimationFrame(more);
        }
        more();
      });

      rec.stop();
      await stopped;
    } finally {
      cancelAnimationFrame(raf);
      connected.forEach(src => { try { src.disconnect(dest); } catch (e) { /* noop */ } });
      try { stream.getTracks().forEach(t => t.stop()); } catch (e) { /* noop */ }
      parts.forEach(p => { try { p.clip.video.pause(); } catch (e) { /* noop */ } });
    }

    return { blob: new Blob(chunks, { type: mime ? mime.split(';')[0] : 'video/webm' }), ext };
  }

  /* ───────────── 이벤트 연결 ───────────── */
  function init() {
    const drop = $('#drop');
    const input = $('#fileInput');

    drop.addEventListener('click', () => {
      if (state.clips.length >= MAX_CLIPS) { toast('영상은 최대 5개까지예요.'); return; }
      input.click();
    });
    drop.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); drop.click(); }
    });
    input.addEventListener('change', () => {
      addFiles(input.files);
      input.value = '';
    });

    ['dragenter', 'dragover'].forEach(ev => drop.addEventListener(ev, e => {
      e.preventDefault();
      e.stopPropagation();
      drop.classList.add('over');
    }));
    ['dragleave', 'dragend'].forEach(ev => drop.addEventListener(ev, e => {
      e.preventDefault();
      drop.classList.remove('over');
    }));
    drop.addEventListener('drop', e => {
      e.preventDefault();
      e.stopPropagation();
      drop.classList.remove('over');
      if (e.dataTransfer && e.dataTransfer.files) addFiles(e.dataTransfer.files);
    });
    // 페이지 다른 곳에 떨궈도 브라우저가 파일을 열지 않게
    window.addEventListener('dragover', e => e.preventDefault());
    window.addEventListener('drop', e => e.preventDefault());

    $('#concatBtn').addEventListener('click', concatAll);
    $('#reconnect').addEventListener('click', () => connect(true));
    $('#reconnect2').addEventListener('click', () => connect(true));

    renderAll();
    connect(false);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
