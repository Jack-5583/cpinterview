'use strict';

/**
 * 면접 대기 관리 시스템 서버
 * - Express 로 정적 페이지(키오스크/관리자) 제공
 * - Socket.IO 로 두 대의 컴퓨터(관리자 PC, 키오스크 PC) 실시간 동기화
 * - 상태는 메모리에 유지하며 data/state.json 에 저장(재시작 시 복구)
 */

const path = require('path');
const fs = require('fs');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'state.json');

// ---------------------------------------------------------------------------
// 상태
// ---------------------------------------------------------------------------
/**
 * @typedef {Object} Applicant
 * @property {string} studentId  5자리 학번
 * @property {string} name       이름
 * @property {'male'|'female'|'unknown'} gender
 * @property {boolean} seated    착석 완료 여부
 * @property {number|null} seatedAt  착석 시각(ms epoch)
 */

/** @type {{applicants: Applicant[], groups: {id:string, memberIds:string[], calledAt:number|null}[]}} */
let state = { applicants: [], groups: [] };

/**
 * 학번으로 성별 판별.
 * 5자리 중 두번째·세번째 자리(NN)가
 *   01~04, 09~12 => 남자
 *   05~08        => 여자
 * 그 외        => unknown
 */
function deriveGender(studentId) {
  const s = String(studentId || '').trim();
  if (!/^\d{5}$/.test(s)) return 'unknown';
  const nn = parseInt(s.slice(1, 3), 10);
  if (nn >= 5 && nn <= 8) return 'female';
  if ((nn >= 1 && nn <= 4) || (nn >= 9 && nn <= 12)) return 'male';
  return 'unknown';
}

// ---------------------------------------------------------------------------
// 영속화
// ---------------------------------------------------------------------------
function loadState() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      state.applicants = Array.isArray(raw.applicants) ? raw.applicants : [];
      state.groups = Array.isArray(raw.groups) ? raw.groups : [];
      // 성별은 항상 학번에서 재계산(규칙 변경/누락 대비)
      state.applicants.forEach((a) => { a.gender = deriveGender(a.studentId); });
      console.log(`[data] 상태 복구: 대기자 ${state.applicants.length}명, 조 ${state.groups.length}개`);
    }
  } catch (err) {
    console.error('[data] 상태 파일 읽기 실패, 빈 상태로 시작합니다:', err.message);
    state = { applicants: [], groups: [] };
  }
}

let saveTimer = null;
function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(DATA_FILE, JSON.stringify(state, null, 2), 'utf8');
    } catch (err) {
      console.error('[data] 상태 저장 실패:', err.message);
    }
  }, 150);
}

// ---------------------------------------------------------------------------
// 헬퍼
// ---------------------------------------------------------------------------
function findApplicant(studentId) {
  return state.applicants.find((a) => a.studentId === String(studentId));
}

function broadcastState() {
  io.emit('state', state);
  persist();
}

let groupSeq = 1;
function nextGroupId() {
  // 기존 id 와 충돌하지 않는 새 id 발급
  while (state.groups.some((g) => g.id === `g${groupSeq}`)) groupSeq++;
  return `g${groupSeq++}`;
}

/** "학번 이름" 형식 텍스트(여러 줄)를 파싱 */
function parseApplicantLines(text) {
  const out = [];
  String(text || '')
    .split(/\r?\n/)
    .forEach((line) => {
      const t = line.trim();
      if (!t) return;
      const m = t.match(/^(\d{5})[\s,\t]+(.+)$/);
      if (m) out.push({ studentId: m[1], name: m[2].trim() });
    });
  return out;
}

function addApplicant(studentId, name) {
  const sid = String(studentId || '').trim();
  const nm = String(name || '').trim();
  if (!/^\d{5}$/.test(sid) || !nm) return { ok: false, reason: '학번(5자리)과 이름을 확인하세요.' };
  if (findApplicant(sid)) return { ok: false, reason: `이미 등록된 학번입니다: ${sid}` };
  state.applicants.push({
    studentId: sid,
    name: nm,
    gender: deriveGender(sid),
    seated: false,
    seatedAt: null,
  });
  return { ok: true };
}

// ---------------------------------------------------------------------------
// 정적 라우트
// ---------------------------------------------------------------------------
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/kiosk', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'kiosk.html')));
app.get('/admin', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

// ---------------------------------------------------------------------------
// Socket.IO
// ---------------------------------------------------------------------------
io.on('connection', (socket) => {
  socket.emit('state', state);

  // ----- 대기자 관리 -----
  socket.on('applicant:add', ({ studentId, name } = {}, ack) => {
    const r = addApplicant(studentId, name);
    if (r.ok) broadcastState();
    if (typeof ack === 'function') ack(r);
  });

  socket.on('applicant:addBulk', ({ text } = {}, ack) => {
    const rows = parseApplicantLines(text);
    let added = 0;
    const errors = [];
    rows.forEach((r) => {
      const res = addApplicant(r.studentId, r.name);
      if (res.ok) added++;
      else errors.push(`${r.studentId}: ${res.reason}`);
    });
    if (added > 0) broadcastState();
    if (typeof ack === 'function') ack({ ok: added > 0, added, errors });
  });

  socket.on('applicant:remove', ({ studentId } = {}) => {
    const before = state.applicants.length;
    state.applicants = state.applicants.filter((a) => a.studentId !== String(studentId));
    // 삭제된 대기자가 포함된 조에서도 제거
    state.groups.forEach((g) => {
      g.memberIds = g.memberIds.filter((id) => id !== String(studentId));
    });
    state.groups = state.groups.filter((g) => g.memberIds.length > 0);
    if (state.applicants.length !== before) broadcastState();
  });

  socket.on('applicant:clear', () => {
    state.applicants = [];
    state.groups = [];
    broadcastState();
  });

  // ----- 착석 -----
  socket.on('seat:complete', ({ studentId } = {}) => {
    const a = findApplicant(studentId);
    if (a && !a.seated) {
      a.seated = true;
      a.seatedAt = Date.now();
      broadcastState();
    }
  });

  socket.on('seat:cancel', ({ studentId } = {}) => {
    const a = findApplicant(studentId);
    if (a && a.seated) {
      a.seated = false;
      a.seatedAt = null;
      broadcastState();
    }
  });

  // ----- 조 관리 -----
  socket.on('group:create', ({ memberIds } = {}, ack) => {
    const ids = Array.isArray(memberIds) ? memberIds.map(String) : [];
    const uniq = [...new Set(ids)].filter((id) => findApplicant(id));
    if (uniq.length < 2 || uniq.length > 3) {
      if (typeof ack === 'function') ack({ ok: false, reason: '조는 2명 또는 3명으로 구성해야 합니다.' });
      return;
    }
    const group = { id: nextGroupId(), memberIds: uniq, calledAt: null };
    state.groups.push(group);
    broadcastState();
    if (typeof ack === 'function') ack({ ok: true, id: group.id });
  });

  socket.on('group:delete', ({ id } = {}) => {
    const before = state.groups.length;
    state.groups = state.groups.filter((g) => g.id !== id);
    if (state.groups.length !== before) broadcastState();
  });

  socket.on('group:clear', () => {
    state.groups = [];
    broadcastState();
  });

  // 조 호출 -> 키오스크에 팝업 + 소리
  socket.on('group:call', ({ id } = {}, ack) => {
    const group = state.groups.find((g) => g.id === id);
    if (!group) {
      if (typeof ack === 'function') ack({ ok: false, reason: '조를 찾을 수 없습니다.' });
      return;
    }
    const members = group.memberIds
      .map((mid) => findApplicant(mid))
      .filter(Boolean)
      .map((a) => ({ studentId: a.studentId, name: a.name, gender: a.gender }));
    group.calledAt = Date.now();
    io.emit('group:called', { groupId: group.id, members });
    broadcastState();
    if (typeof ack === 'function') ack({ ok: true });
  });
});

// ---------------------------------------------------------------------------
loadState();
server.listen(PORT, '0.0.0.0', () => {
  console.log('===============================================');
  console.log(' 면접 대기 관리 시스템 서버 실행 중');
  console.log(`  - 관리자 페이지 :  http://localhost:${PORT}/admin`);
  console.log(`  - 키오스크 페이지:  http://localhost:${PORT}/kiosk`);
  console.log('  같은 네트워크의 다른 PC 에서는 이 PC 의 IP 주소로 접속하세요.');
  console.log('===============================================');
});
