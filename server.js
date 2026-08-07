'use strict';

/**
 * 면접 대기 관리 시스템 서버
 * - Express 로 정적 페이지(키오스크/관리자) 제공
 * - Socket.IO 로 두 대의 컴퓨터(관리자 PC, 키오스크 PC) 실시간 동기화
 * - 상태는 메모리에 유지하며 data/state.json 에 저장(재시작 시 복구)
 *
 * 조 대기 모델
 * - groups 배열의 순서 = 조 번호(1조, 2조, ...)
 * - currentGroupId = 키오스크에 "대기 중"으로 표시되는 조
 * - 조 호출 시 해당 조 팝업을 띄우고, 대기 조를 자동으로 "다음 조"로 넘긴다
 */

const path = require('path');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
// 접속 비밀번호 (환경변수 APP_PASSWORD 로 덮어쓸 수 있음)
const PASSWORD = process.env.APP_PASSWORD || 'saegyeolcpcpcp';
// 쿠키에 저장할 인증 토큰 (원문 비밀번호는 저장/노출하지 않음)
const AUTH_TOKEN = crypto.createHash('sha256').update('interview-auth::' + PASSWORD).digest('hex');
const VIEWS = path.join(__dirname, 'views');
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'state.json');
// 최초 실행(또는 무료 호스팅에서 재시작) 시 명단을 자동 복구하기 위한 기본 데이터
const SEED_FILE = path.join(__dirname, 'data', 'seed.json');

// ---------------------------------------------------------------------------
// 상태
// ---------------------------------------------------------------------------
/** @type {{applicants: any[], groups: any[], currentGroupId: string|null}} */
let state = { applicants: [], groups: [], currentGroupId: null };

/**
 * 학번으로 성별 판별.
 * 5자리 중 두번째·세번째 자리(NN)가
 *   01~04, 09~12 => 남자 / 05~08 => 여자 / 그 외 => unknown
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
    // 저장된 진행 상태가 있으면 그것을, 없으면 기본 명단(seed)을 불러온다
    const file = fs.existsSync(DATA_FILE) ? DATA_FILE : (fs.existsSync(SEED_FILE) ? SEED_FILE : null);
    if (file) {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      state.applicants = Array.isArray(raw.applicants) ? raw.applicants : [];
      state.groups = Array.isArray(raw.groups) ? raw.groups : [];
      state.currentGroupId = raw.currentGroupId || null;
      state.applicants.forEach((a) => { a.gender = deriveGender(a.studentId); });
      normalizeCurrent();
      const src = file === SEED_FILE ? '기본 명단' : '저장 상태';
      console.log(`[data] ${src} 로드: 대기자 ${state.applicants.length}명, 조 ${state.groups.length}개`);
    }
  } catch (err) {
    console.error('[data] 상태 파일 읽기 실패, 빈 상태로 시작:', err.message);
    state = { applicants: [], groups: [], currentGroupId: null };
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
function groupIndex(id) {
  return state.groups.findIndex((g) => g.id === id);
}
/** currentGroupId 를 유효한 값으로 보정 (없으면 첫 조) */
function normalizeCurrent() {
  if (!state.groups.length) { state.currentGroupId = null; return; }
  if (!state.groups.some((g) => g.id === state.currentGroupId)) {
    state.currentGroupId = state.groups[0].id;
  }
}
function broadcastState() {
  normalizeCurrent();
  io.emit('state', state);
  persist();
}

let groupSeq = 1;
function nextGroupId() {
  while (state.groups.some((g) => g.id === `g${groupSeq}`)) groupSeq++;
  return `g${groupSeq++}`;
}

function parseApplicantLines(text) {
  const out = [];
  String(text || '').split(/\r?\n/).forEach((line) => {
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
  state.applicants.push({ studentId: sid, name: nm, gender: deriveGender(sid), seated: false, seatedAt: null });
  return { ok: true };
}

function membersOf(group) {
  return group.memberIds
    .map((mid) => findApplicant(mid))
    .filter(Boolean)
    .map((a) => ({ studentId: a.studentId, name: a.name, gender: a.gender }));
}

// ---------------------------------------------------------------------------
// 인증 (비밀번호 게이트)
// ---------------------------------------------------------------------------
function getCookie(req, name) {
  const raw = req.headers.cookie || '';
  const hit = raw.split(';').map((s) => s.trim()).find((s) => s.startsWith(name + '='));
  return hit ? decodeURIComponent(hit.slice(name.length + 1)) : null;
}
function isAuthed(req) { return getCookie(req, 'auth') === AUTH_TOKEN; }
// 열린 리다이렉트 방지를 위해 허용된 경로만 반환
function safeDest(d) { return ['/', '/kiosk', '/admin'].includes(d) ? d : '/'; }
function requireAuth(req, res, next) {
  if (isAuthed(req)) return next();
  res.redirect('/login?next=' + encodeURIComponent(req.path));
}
function loginPage(nextPath, error) {
  const nx = safeDest(nextPath);
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>로그인 · 면접 대기 관리</title>
<link rel="icon" href="/assets/favicon.svg">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/static/pretendard.css">
<style>
*{box-sizing:border-box} html,body{height:100%}
body{margin:0;font-family:"Pretendard","Pretendard Variable",-apple-system,"Malgun Gothic",sans-serif;
 background:radial-gradient(1000px 500px at 80% -10%,#e3edff,transparent 60%),#eef4ff;
 display:grid;place-items:center;color:#1e293b}
.card{background:#fff;border-radius:24px;box-shadow:0 24px 60px rgba(30,58,138,.18);
 padding:44px 40px;width:min(400px,92vw);text-align:center}
.logo{font-size:46px}
h1{font-size:24px;margin:8px 0 4px;color:#1e40af}
p{margin:0 0 22px;color:#64748b;font-size:15px}
input[type=password]{width:100%;font-size:17px;padding:14px 16px;border:1.5px solid #dbeafe;
 border-radius:12px;outline:none;text-align:center;letter-spacing:2px}
input[type=password]:focus{border-color:#3b82f6;box-shadow:0 0 0 3px rgba(96,165,250,.25)}
.err{color:#e11d48;font-weight:700;font-size:14px;margin-top:12px}
button{margin-top:16px;width:100%;font-size:18px;font-weight:800;color:#fff;border:none;cursor:pointer;
 padding:14px;border-radius:999px;background:linear-gradient(180deg,#3b82f6,#1d4ed8);
 box-shadow:0 8px 18px rgba(37,99,235,.35)}
button:active{transform:translateY(1px)}
</style></head><body>
<form class="card" method="post" action="/login" autocomplete="off">
 <div class="logo">🔒</div>
 <h1>면접 대기 관리 시스템</h1>
 <p>접속하려면 비밀번호를 입력하세요.</p>
 <input type="password" name="password" placeholder="비밀번호" autofocus required>
 <input type="hidden" name="next" value="${nx}">
 ${error ? '<div class="err">비밀번호가 올바르지 않습니다.</div>' : ''}
 <button type="submit">입장</button>
</form></body></html>`;
}

app.use(express.urlencoded({ extended: false }));
// 정적 자원(css/js/assets)은 인증 없이 제공 (민감 정보 없음)
app.use(express.static(path.join(__dirname, 'public')));
app.get('/healthz', (_req, res) => res.json({ ok: true }));

app.get('/login', (req, res) => {
  if (isAuthed(req)) return res.redirect(safeDest(req.query.next));
  res.type('html').send(loginPage(req.query.next, req.query.e === '1'));
});
app.post('/login', (req, res) => {
  const pw = (req.body.password || '').toString();
  const dest = safeDest(req.body.next);
  if (pw === PASSWORD) {
    res.setHeader('Set-Cookie', `auth=${AUTH_TOKEN}; HttpOnly; Path=/; Max-Age=86400; SameSite=Lax`);
    return res.redirect(dest);
  }
  res.redirect('/login?e=1&next=' + encodeURIComponent(dest));
});
app.get('/logout', (_req, res) => {
  res.setHeader('Set-Cookie', 'auth=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax');
  res.redirect('/login');
});

// 페이지는 인증 필요
app.get('/', requireAuth, (_req, res) => res.sendFile(path.join(VIEWS, 'index.html')));
app.get('/kiosk', requireAuth, (_req, res) => res.sendFile(path.join(VIEWS, 'kiosk.html')));
app.get('/admin', requireAuth, (_req, res) => res.sendFile(path.join(VIEWS, 'admin.html')));

// ---------------------------------------------------------------------------
// Socket.IO
// ---------------------------------------------------------------------------
// 소켓도 동일 쿠키로 인증 (비로그인 직접 연결 차단)
io.use((socket, next) => {
  const raw = socket.handshake.headers.cookie || '';
  const ok = raw.split(';').map((s) => s.trim()).some((s) => s === 'auth=' + AUTH_TOKEN);
  if (ok) return next();
  next(new Error('unauthorized'));
});

io.on('connection', (socket) => {
  socket.emit('state', state);

  // ----- 대기자 -----
  socket.on('applicant:add', ({ studentId, name } = {}, ack) => {
    const r = addApplicant(studentId, name);
    if (r.ok) broadcastState();
    if (typeof ack === 'function') ack(r);
  });

  socket.on('applicant:addBulk', ({ text } = {}, ack) => {
    const rows = parseApplicantLines(text);
    let added = 0; const errors = [];
    rows.forEach((r) => {
      const res = addApplicant(r.studentId, r.name);
      if (res.ok) added++; else errors.push(`${r.studentId}: ${res.reason}`);
    });
    if (added > 0) broadcastState();
    if (typeof ack === 'function') ack({ ok: added > 0, added, errors });
  });

  socket.on('applicant:remove', ({ studentId } = {}) => {
    const before = state.applicants.length;
    state.applicants = state.applicants.filter((a) => a.studentId !== String(studentId));
    state.groups.forEach((g) => { g.memberIds = g.memberIds.filter((id) => id !== String(studentId)); });
    state.groups = state.groups.filter((g) => g.memberIds.length > 0);
    if (state.applicants.length !== before) broadcastState();
  });

  socket.on('applicant:clear', () => {
    state.applicants = []; state.groups = []; state.currentGroupId = null;
    broadcastState();
  });

  // ----- 착석 -----
  socket.on('seat:complete', ({ studentId } = {}) => {
    const a = findApplicant(studentId);
    if (a && !a.seated) { a.seated = true; a.seatedAt = Date.now(); broadcastState(); }
  });
  socket.on('seat:cancel', ({ studentId } = {}) => {
    const a = findApplicant(studentId);
    if (a && a.seated) { a.seated = false; a.seatedAt = null; broadcastState(); }
  });

  // ----- 조 -----
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
    state.groups = []; state.currentGroupId = null;
    broadcastState();
  });

  // 키오스크에 표시할 "대기 조" 를 수동 지정
  socket.on('group:setCurrent', ({ id } = {}) => {
    if (id === null || state.groups.some((g) => g.id === id)) {
      state.currentGroupId = id;
      broadcastState();
    }
  });

  // 소리 테스트: 키오스크에 팝업 없이 알림음(띵동)만 재생 (연결/소리 점검용)
  socket.on('sound:test', () => {
    io.emit('sound:play');
  });

  // 조 호출 -> 키오스크 팝업 + 소리, 그리고 대기 조를 자동으로 "다음 조" 로
  socket.on('group:call', ({ id } = {}, ack) => {
    const idx = groupIndex(id);
    if (idx === -1) {
      if (typeof ack === 'function') ack({ ok: false, reason: '조를 찾을 수 없습니다.' });
      return;
    }
    const group = state.groups[idx];
    group.calledAt = Date.now();
    io.emit('group:called', { groupId: group.id, groupNo: idx + 1, members: membersOf(group) });

    // 대기 조 자동 전환: 호출한 조 다음 번호로 (없으면 없음)
    const next = state.groups[idx + 1];
    state.currentGroupId = next ? next.id : null;

    broadcastState();
    if (typeof ack === 'function') ack({ ok: true, nextGroupId: state.currentGroupId });
  });
});

// ---------------------------------------------------------------------------
loadState();
server.listen(PORT, '0.0.0.0', () => {
  console.log('===============================================');
  console.log(' 면접 대기 관리 시스템 서버 실행 중');
  console.log(`  - 관리자 :  http://localhost:${PORT}/admin`);
  console.log(`  - 키오스크:  http://localhost:${PORT}/kiosk`);
  console.log('  같은 네트워크의 다른 PC 에서는 이 PC 의 IP 로 접속하세요.');
  console.log('===============================================');
});
