/* ===== 키오스크 클라이언트 ===== */
(function () {
  'use strict';

  const socket = io();
  const $ = (id) => document.getElementById(id);

  const seatsEl = $('seats');
  const emptyEl = $('empty');
  const emptyMsg = $('empty-msg');
  const clockEl = $('clock');
  const connEl = $('conn');
  const groupBadge = $('groupBadge');

  // ---- 시계 ----
  function fmtTime(ts) {
    const d = new Date(ts);
    let h = d.getHours();
    const m = d.getMinutes();
    const ampm = h < 12 ? '오전' : '오후';
    let hh = h % 12; if (hh === 0) hh = 12;
    return `${ampm} ${hh}:${String(m).padStart(2, '0')}`;
  }
  function tick() { clockEl.textContent = fmtTime(Date.now()); }
  tick(); setInterval(tick, 1000);

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
  }
  function illustFor(a) {
    if (!a.seated) return '/assets/chair.svg';
    if (a.gender === 'female') return '/assets/mascot-female.svg';
    return '/assets/mascot-male.svg';
  }

  // ---- 렌더링: 현재 대기 조의 조원만 표시 ----
  function render(st) {
    const applicants = st.applicants || [];
    const groups = st.groups || [];
    const byId = Object.fromEntries(applicants.map((a) => [a.studentId, a]));
    const idx = groups.findIndex((g) => g.id === st.currentGroupId);
    const cur = idx >= 0 ? groups[idx] : null;

    // 대기 조 배지
    if (cur) {
      groupBadge.textContent = `${idx + 1}조 대기`;
      groupBadge.classList.remove('none');
    } else {
      groupBadge.textContent = '대기 조 없음';
      groupBadge.classList.add('none');
    }

    seatsEl.innerHTML = '';
    if (!cur) {
      emptyMsg.innerHTML = groups.length
        ? '현재 대기 중인 조가 없습니다.<br />모든 조 호출이 완료되었거나, 관리자 화면에서 대기 조를 지정해 주세요.'
        : '아직 편성된 조가 없습니다.<br />관리자 화면에서 대기자를 등록하고 조를 편성해 주세요.';
      emptyEl.classList.add('show');
      return;
    }
    emptyEl.classList.remove('show');

    const members = cur.memberIds.map((id) => byId[id]).filter(Boolean);
    seatsEl.className = 'k-seats cols-' + Math.min(3, Math.max(1, members.length));

    members.forEach((a) => {
      const card = document.createElement('div');
      card.className = 'seat' + (a.seated ? ' is-seated' : '');
      card.dataset.id = a.studentId;
      const foot = a.seated
        ? `<div class="seat-time"><span class="dot"></span>착석 완료 · ${fmtTime(a.seatedAt)}</div>
           <button class="btn btn-danger btn-cancel">착석 취소</button>`
        : `<button class="btn btn-primary btn-seat">착석 완료</button>`;
      card.innerHTML = `
        <div class="seat-head">
          <div class="seat-sid">${a.studentId}</div>
          <div class="seat-name">${escapeHtml(a.name)}</div>
        </div>
        <div class="seat-illust"><img src="${illustFor(a)}" alt="" draggable="false" /></div>
        <div class="seat-foot">${foot}</div>`;
      if (!a.seated) {
        card.querySelector('.btn-seat').addEventListener('click', () => openConfirm(a));
      } else {
        card.querySelector('.btn-cancel').addEventListener('click', () => {
          if (confirm(`${a.studentId} ${a.name} 님의 착석을 취소할까요?`)) socket.emit('seat:cancel', { studentId: a.studentId });
        });
      }
      seatsEl.appendChild(card);
    });
  }

  // ---- 착석 확인 모달 ----
  const modal = $('confirm-modal');
  const agree = $('confirm-agree');
  const okBtn = $('confirm-ok');
  let pending = null;
  function openConfirm(a) {
    pending = a;
    $('confirm-who').textContent = `${a.studentId} ${a.name}`;
    agree.checked = false; okBtn.disabled = true;
    modal.classList.remove('hidden'); modal.setAttribute('aria-hidden', 'false');
  }
  function closeConfirm() { modal.classList.add('hidden'); modal.setAttribute('aria-hidden', 'true'); pending = null; }
  agree.addEventListener('change', () => { okBtn.disabled = !agree.checked; });
  okBtn.addEventListener('click', () => {
    if (pending && agree.checked) { socket.emit('seat:complete', { studentId: pending.studentId }); unlockAudio(); }
    closeConfirm();
  });
  $('confirm-cancel').addEventListener('click', closeConfirm);
  $('confirm-x').addEventListener('click', closeConfirm);
  modal.addEventListener('click', (e) => { if (e.target === modal) closeConfirm(); });

  // ---- 조 호출 팝업 + 소리 ----
  const callPopup = $('call-popup');
  const callNames = $('call-names');
  const callGroup = $('call-group');
  let callTimer = null;
  function showCall({ groupNo, members }) {
    if (!members || !members.length) return;
    callGroup.textContent = groupNo ? `${groupNo}조` : '';
    callNames.innerHTML = members.map((m) => `<span class="sid">${m.studentId}</span> ${escapeHtml(m.name)}`).join(',&nbsp;&nbsp;');
    document.querySelectorAll('.seat.is-called').forEach((el) => el.classList.remove('is-called'));
    members.forEach((m) => { const el = seatsEl.querySelector(`.seat[data-id="${m.studentId}"]`); if (el) el.classList.add('is-called'); });
    callPopup.classList.remove('hidden'); callPopup.setAttribute('aria-hidden', 'false');
    playDingDong();
    clearTimeout(callTimer);
    callTimer = setTimeout(() => {
      callPopup.classList.add('hidden'); callPopup.setAttribute('aria-hidden', 'true');
      document.querySelectorAll('.seat.is-called').forEach((el) => el.classList.remove('is-called'));
    }, 5000);
  }

  // ---- 오디오 (띵동) ----
  let audioCtx = null;
  function unlockAudio() {
    try {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === 'suspended') audioCtx.resume();
      hideAudioHint();
    } catch (_) {}
  }
  function beep(freq, start, dur) {
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'sine'; osc.frequency.value = freq;
    osc.connect(gain); gain.connect(audioCtx.destination);
    const t = audioCtx.currentTime + start;
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(0.6, t + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.start(t); osc.stop(t + dur + 0.05);
  }
  function playDingDong() {
    try {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === 'suspended') audioCtx.resume();
      beep(659.25, 0.0, 0.55); beep(523.25, 0.42, 0.75);
    } catch (_) { showAudioHint(); }
  }
  let hintEl = null;
  function showAudioHint() {
    if (hintEl) return;
    hintEl = document.createElement('button');
    hintEl.textContent = '🔔 화면을 한 번 눌러 알림 소리를 켜주세요';
    hintEl.style.cssText = 'position:fixed;left:50%;bottom:22px;transform:translateX(-50%);z-index:80;background:#1d4ed8;color:#fff;font-weight:700;font-size:16px;padding:12px 20px;border-radius:999px;box-shadow:0 10px 24px rgba(0,0,0,.25);cursor:pointer';
    hintEl.addEventListener('click', unlockAudio);
    document.body.appendChild(hintEl);
  }
  function hideAudioHint() { if (hintEl) { hintEl.remove(); hintEl = null; } }
  window.addEventListener('pointerdown', unlockAudio, { once: false });
  setTimeout(() => {
    if (!audioCtx || audioCtx.state !== 'running') {
      try { audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)(); if (audioCtx.state !== 'running') showAudioHint(); } catch (_) {}
    }
  }, 1200);

  // ---- 소켓 ----
  socket.on('connect', () => { connEl.classList.remove('off'); connEl.title = '서버 연결됨'; });
  socket.on('disconnect', () => { connEl.classList.add('off'); connEl.title = '서버 연결 끊김'; });
  socket.on('state', (st) => render(st));
  socket.on('group:called', (payload) => showCall(payload));
  socket.on('sound:play', () => playDingDong()); // 관리자 소리 테스트 (팝업 없이 소리만)
})();
