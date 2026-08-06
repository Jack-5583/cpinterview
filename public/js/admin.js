/* ===== 관리자 클라이언트 ===== */
(function () {
  'use strict';

  const socket = io();
  const $ = (id) => document.getElementById(id);

  const selected = new Set(); // 조 편성용 선택된 학번
  let applicants = [];
  let groups = [];

  // ---- 시계 ----
  function fmtTime(ts) {
    const d = new Date(ts);
    let h = d.getHours();
    const m = d.getMinutes();
    const ampm = h < 12 ? '오전' : '오후';
    let hh = h % 12; if (hh === 0) hh = 12;
    return `${ampm} ${hh}:${String(m).padStart(2, '0')}`;
  }
  function fmtSec(ts) {
    const d = new Date(ts);
    return `${fmtTime(ts)}:${String(d.getSeconds()).padStart(2, '0')}`;
  }
  const clockEl = $('clock');
  setInterval(() => { clockEl.textContent = fmtTime(Date.now()); }, 1000);
  clockEl.textContent = fmtTime(Date.now());

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }
  function genderBadge(g) {
    if (g === 'male') return '<span class="badge badge-male">남자</span>';
    if (g === 'female') return '<span class="badge badge-female">여자</span>';
    return '<span class="badge badge-unknown">미상</span>';
  }

  let toastTimer = null;
  function toast(msg, isErr) {
    const t = $('toast');
    t.textContent = msg;
    t.className = 'toast show' + (isErr ? ' err' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.className = 'toast'; }, 2600);
  }

  // ---- 대기자 목록 렌더 ----
  function renderApplicants() {
    const tbody = $('tbody');
    const emptyEl = $('tbl-empty');
    tbody.innerHTML = '';

    // 삭제된 대기자는 선택에서 제거
    const ids = new Set(applicants.map((a) => a.studentId));
    [...selected].forEach((id) => { if (!ids.has(id)) selected.delete(id); });

    if (!applicants.length) {
      emptyEl.style.display = 'block';
    } else {
      emptyEl.style.display = 'none';
      applicants.forEach((a) => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td><input type="checkbox" class="pick" ${selected.has(a.studentId) ? 'checked' : ''} /></td>
          <td class="c-sid">${a.studentId}</td>
          <td class="c-name">${escapeHtml(a.name)}</td>
          <td>${genderBadge(a.gender)}</td>
          <td>${a.seated
            ? '<span class="badge badge-seated">착석 완료</span>'
            : '<span class="badge badge-wait">대기 중</span>'}</td>
          <td class="time-cell">${a.seated && a.seatedAt ? fmtSec(a.seatedAt) : '—'}</td>
          <td style="text-align:right"><button class="row-del">삭제</button></td>`;

        tr.querySelector('.pick').addEventListener('change', (e) => {
          if (e.target.checked) selected.add(a.studentId);
          else selected.delete(a.studentId);
          updatePickBar();
        });
        tr.querySelector('.row-del').addEventListener('click', () => {
          if (confirm(`${a.studentId} ${a.name} 님을 삭제할까요?`)) {
            socket.emit('applicant:remove', { studentId: a.studentId });
          }
        });
        tbody.appendChild(tr);
      });
    }

    const seatedCount = applicants.filter((a) => a.seated).length;
    $('stat-total').textContent = `전체 ${applicants.length}`;
    $('stat-seated').textContent = `착석 ${seatedCount}`;
    updatePickBar();
  }

  function updatePickBar() {
    const n = selected.size;
    $('pick-count').textContent = `선택 ${n}명`;
    $('btn-group-create').disabled = !(n === 2 || n === 3);
    const msg = $('group-msg');
    if (n > 3) { msg.textContent = '조는 최대 3명까지 선택할 수 있습니다.'; msg.className = 'hint err'; }
    else if (n === 1) { msg.textContent = '조는 2명 또는 3명이어야 합니다.'; msg.className = 'hint'; }
    else { msg.textContent = ''; msg.className = 'hint'; }
  }

  // ---- 조 목록 렌더 ----
  function renderGroups() {
    const wrap = $('groups');
    const emptyEl = $('groups-empty');
    wrap.innerHTML = '';
    if (!groups.length) { emptyEl.style.display = 'block'; return; }
    emptyEl.style.display = 'none';

    const byId = Object.fromEntries(applicants.map((a) => [a.studentId, a]));
    groups.forEach((g, idx) => {
      const card = document.createElement('div');
      card.className = 'group-card' + (g.calledAt ? ' called' : '');
      const members = g.memberIds.map((id) => {
        const a = byId[id];
        const name = a ? a.name : '(삭제됨)';
        const gd = a ? a.gender : 'unknown';
        return `<div class="group-member">${genderBadge(gd)}
                  <span class="m-sid">${id}</span><span class="m-name">${escapeHtml(name)}</span></div>`;
      }).join('');
      card.innerHTML = `
        <div class="group-head">
          <span class="group-name">${idx + 1}조 · ${g.memberIds.length}명</span>
          ${g.calledAt ? `<span class="group-called">호출됨 ${fmtTime(g.calledAt)}</span>` : ''}
        </div>
        <div class="group-members">${members}</div>
        <div class="group-actions">
          <button class="btn btn-call">📢 호출</button>
          <button class="btn btn-danger sm del">삭제</button>
        </div>`;
      card.querySelector('.btn-call').addEventListener('click', () => {
        socket.emit('group:call', { id: g.id }, (res) => {
          if (res && res.ok) toast(`${idx + 1}조를 호출했습니다. (키오스크 팝업 표시)`);
          else toast((res && res.reason) || '호출 실패', true);
        });
      });
      card.querySelector('.del').addEventListener('click', () => {
        socket.emit('group:delete', { id: g.id });
      });
      wrap.appendChild(card);
    });
  }

  // ---- 입력 핸들러 ----
  $('btn-add').addEventListener('click', addOne);
  $('in-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') addOne(); });
  $('in-sid').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('in-name').focus(); });

  function addOne() {
    const studentId = $('in-sid').value.trim();
    const name = $('in-name').value.trim();
    const msg = $('add-msg');
    if (!/^\d{5}$/.test(studentId)) { msg.textContent = '학번은 숫자 5자리여야 합니다.'; msg.className = 'hint err'; return; }
    if (!name) { msg.textContent = '이름을 입력하세요.'; msg.className = 'hint err'; return; }
    socket.emit('applicant:add', { studentId, name }, (res) => {
      if (res && res.ok) {
        msg.textContent = `등록됨: ${studentId} ${name}`; msg.className = 'hint ok';
        $('in-sid').value = ''; $('in-name').value = ''; $('in-sid').focus();
      } else {
        msg.textContent = (res && res.reason) || '등록 실패'; msg.className = 'hint err';
      }
    });
  }

  $('btn-bulk').addEventListener('click', () => {
    const text = $('in-bulk').value;
    if (!text.trim()) return;
    socket.emit('applicant:addBulk', { text }, (res) => {
      if (res && res.added) {
        toast(`${res.added}명 등록되었습니다.`);
        $('in-bulk').value = '';
        if (res.errors && res.errors.length) toast(`일부 실패: ${res.errors.length}건`, true);
      } else {
        toast('등록할 수 있는 항목이 없습니다. "학번 이름" 형식을 확인하세요.', true);
      }
    });
  });

  $('btn-clear-all').addEventListener('click', () => {
    if (applicants.length && confirm('모든 대기자와 조를 삭제할까요?')) socket.emit('applicant:clear');
  });

  $('btn-pick-clear').addEventListener('click', () => {
    selected.clear();
    document.querySelectorAll('.pick').forEach((c) => { c.checked = false; });
    updatePickBar();
  });

  $('btn-group-create').addEventListener('click', () => {
    const memberIds = [...selected];
    socket.emit('group:create', { memberIds }, (res) => {
      if (res && res.ok) {
        toast('조가 등록되었습니다.');
        selected.clear();
        document.querySelectorAll('.pick').forEach((c) => { c.checked = false; });
        updatePickBar();
      } else {
        toast((res && res.reason) || '조 등록 실패', true);
      }
    });
  });

  $('btn-group-clear').addEventListener('click', () => {
    if (groups.length && confirm('편성된 모든 조를 삭제할까요?')) socket.emit('group:clear');
  });

  // ---- 소켓 ----
  const conn = $('conn');
  socket.on('connect', () => { conn.textContent = '연결됨'; conn.className = 'a-conn ok'; });
  socket.on('disconnect', () => { conn.textContent = '연결 끊김'; conn.className = 'a-conn off'; });
  socket.on('state', (st) => {
    applicants = st.applicants || [];
    groups = st.groups || [];
    renderApplicants();
    renderGroups();
  });
})();
