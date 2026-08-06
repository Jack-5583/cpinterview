/* ===== 관리자 클라이언트 (엑셀 스타일) ===== */
(function () {
  'use strict';
  const socket = io();
  const $ = (id) => document.getElementById(id);

  const selected = new Set();
  let applicants = [];
  let groups = [];
  let currentGroupId = null;

  // 시계
  function fmtTime(ts) {
    const d = new Date(ts);
    let h = d.getHours(); const m = d.getMinutes();
    const ap = h < 12 ? '오전' : '오후'; let hh = h % 12; if (hh === 0) hh = 12;
    return `${ap} ${hh}:${String(m).padStart(2, '0')}`;
  }
  function fmtSec(ts) { const d = new Date(ts); return `${fmtTime(ts)}:${String(d.getSeconds()).padStart(2, '0')}`; }
  setInterval(() => { $('clock').textContent = fmtTime(Date.now()); }, 1000);
  $('clock').textContent = fmtTime(Date.now());

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
  let toastT = null;
  function toast(msg, kind) { const t = $('toast'); t.textContent = msg; t.className = 'toast show' + (kind ? ' ' + kind : ''); clearTimeout(toastT); toastT = setTimeout(() => { t.className = 'toast'; }, 2400); }

  function groupNoOf(studentId) {
    for (let i = 0; i < groups.length; i++) if (groups[i].memberIds.includes(studentId)) return i + 1;
    return null;
  }

  // ---- 대기자 표 ----
  function renderApplicants() {
    const body = $('app-body');
    body.innerHTML = '';
    const ids = new Set(applicants.map((a) => a.studentId));
    [...selected].forEach((id) => { if (!ids.has(id)) selected.delete(id); });

    $('app-empty').style.display = applicants.length ? 'none' : 'block';

    applicants.forEach((a, i) => {
      const gno = groupNoOf(a.studentId);
      const tr = document.createElement('tr');
      if (selected.has(a.studentId)) tr.className = 'sel';
      const gender = a.gender === 'male' ? '<span class="g g-m">남</span>' : a.gender === 'female' ? '<span class="g g-f">여</span>' : '<span class="g">–</span>';
      tr.innerHTML = `
        <td><input type="checkbox" class="pick" ${selected.has(a.studentId) ? 'checked' : ''} /></td>
        <td class="num">${i + 1}</td>
        <td class="sid">${a.studentId}</td>
        <td class="name">${esc(a.name)}</td>
        <td>${gender}</td>
        <td class="num">${gno ? gno + '조' : '<span class="g">–</span>'}</td>
        <td>${a.seated ? '<span class="seat-y">완료</span>' : '<span class="seat-n">대기</span>'}</td>
        <td class="num">${a.seated && a.seatedAt ? fmtSec(a.seatedAt) : '<span class="g">–</span>'}</td>
        <td><button class="row-del">삭제</button></td>`;
      tr.querySelector('.pick').addEventListener('change', (e) => {
        if (e.target.checked) selected.add(a.studentId); else selected.delete(a.studentId);
        tr.classList.toggle('sel', e.target.checked);
        updatePick();
      });
      tr.querySelector('.row-del').addEventListener('click', () => {
        if (confirm(`${a.studentId} ${a.name} 삭제할까요?`)) socket.emit('applicant:remove', { studentId: a.studentId });
      });
      body.appendChild(tr);
    });

    const seated = applicants.filter((a) => a.seated).length;
    $('stat').textContent = `전체 ${applicants.length} · 착석 ${seated}`;
    $('chk-all').checked = applicants.length > 0 && selected.size === applicants.length;
    updatePick();
  }

  function updatePick() {
    $('pickN').textContent = selected.size;
    $('btn-make').disabled = !(selected.size === 2 || selected.size === 3);
  }

  // ---- 조 표 ----
  function renderGroups() {
    const body = $('grp-body');
    body.innerHTML = '';
    $('grp-empty').style.display = groups.length ? 'none' : 'block';
    const byId = Object.fromEntries(applicants.map((a) => [a.studentId, a]));
    const curIdx = groups.findIndex((g) => g.id === currentGroupId);
    $('cur-group').textContent = curIdx >= 0 ? `${curIdx + 1}조` : '—';

    groups.forEach((g, i) => {
      const tr = document.createElement('tr');
      const isCur = g.id === currentGroupId;
      if (isCur) tr.className = 'wait';
      const mem = g.memberIds.map((id) => { const a = byId[id]; return a ? `${id} ${esc(a.name)}` : `${id} (삭제됨)`; }).join(' · ');
      const status = g.calledAt ? `<span class="chip chip-called">호출됨 ${fmtTime(g.calledAt)}</span>`
                    : isCur ? '<span class="chip chip-wait">대기 중</span>' : '<span class="chip">대기</span>';
      tr.innerHTML = `
        <td class="num"><b>${i + 1}조</b></td>
        <td>${mem}</td>
        <td>${status}</td>
        <td><div class="act">
          <button class="btn btn-xs btn-set" ${isCur ? 'disabled' : ''}>대기지정</button>
          <button class="btn btn-xs btn-call">호출</button>
          <button class="btn btn-xs btn-mini del">삭제</button>
        </div></td>`;
      tr.querySelector('.btn-set').addEventListener('click', () => socket.emit('group:setCurrent', { id: g.id }));
      tr.querySelector('.btn-call').addEventListener('click', () => {
        socket.emit('group:call', { id: g.id }, (res) => {
          if (res && res.ok) toast(`${i + 1}조 호출 · 키오스크 팝업 표시`, 'ok');
          else toast((res && res.reason) || '호출 실패', 'err');
        });
      });
      tr.querySelector('.del').addEventListener('click', () => socket.emit('group:delete', { id: g.id }));
      body.appendChild(tr);
    });
  }

  // ---- 입력 ----
  function addOne() {
    const sid = $('in-sid').value.trim(); const name = $('in-name').value.trim();
    if (!/^\d{5}$/.test(sid)) return toast('학번은 숫자 5자리', 'err');
    if (!name) return toast('이름을 입력하세요', 'err');
    socket.emit('applicant:add', { studentId: sid, name }, (res) => {
      if (res && res.ok) { $('in-sid').value = ''; $('in-name').value = ''; $('in-sid').focus(); }
      else toast((res && res.reason) || '등록 실패', 'err');
    });
  }
  $('btn-add').addEventListener('click', addOne);
  $('in-sid').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('in-name').focus(); });
  $('in-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') addOne(); });

  $('btn-bulk').addEventListener('click', () => {
    const raw = $('in-bulk').value;
    if (!raw.trim()) return;
    // 콤마/줄바꿈 모두 구분자로 처리
    const text = raw.split(/[\n,]/).map((s) => s.trim()).filter(Boolean).join('\n');
    socket.emit('applicant:addBulk', { text }, (res) => {
      if (res && res.added) { toast(`${res.added}명 등록`, 'ok'); $('in-bulk').value = ''; }
      else toast('등록할 항목이 없습니다. "학번 이름" 형식 확인', 'err');
    });
  });

  $('chk-all').addEventListener('change', (e) => {
    if (e.target.checked) applicants.forEach((a) => selected.add(a.studentId));
    else selected.clear();
    renderApplicants();
  });

  $('btn-make').addEventListener('click', () => {
    socket.emit('group:create', { memberIds: [...selected] }, (res) => {
      if (res && res.ok) { toast('조 편성 완료', 'ok'); selected.clear(); renderApplicants(); }
      else toast((res && res.reason) || '조 편성 실패', 'err');
    });
  });

  $('btn-clear-app').addEventListener('click', () => { if (applicants.length && confirm('모든 대기자와 조를 삭제할까요?')) socket.emit('applicant:clear'); });
  $('btn-clear-grp').addEventListener('click', () => { if (groups.length && confirm('편성된 모든 조를 삭제할까요?')) socket.emit('group:clear'); });

  // ---- 소켓 ----
  const conn = $('conn');
  socket.on('connect', () => { conn.textContent = '연결됨'; conn.className = 'conn ok'; });
  socket.on('disconnect', () => { conn.textContent = '연결 끊김'; conn.className = 'conn off'; });
  socket.on('state', (st) => {
    applicants = st.applicants || [];
    groups = st.groups || [];
    currentGroupId = st.currentGroupId || null;
    renderApplicants();
    renderGroups();
  });
})();
