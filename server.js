// server.js — «Учёт занятий» backend
// Простой Node.js http-сервер без внешних зависимостей.
// Данные хранятся в JSON-файле на диске (data.json). Никаких внешних
// сервисов (Gist/Telegram/БД) не используется — при необходимости
// подключить что-то ещё, это делается отдельно и не мешает текущей схеме.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

// ── Хранилище ────────────────────────────────────────────────────────────
function defaultData() {
  return {
    codes: [
      { code: '6551', role: 'admin', name: 'Админ' }
    ],
    groups: [
      { id: 'g_lepka', name: 'Лепка', abonementPrice: 8800, duration: 60 }
    ],
    students: [],
    days: {},      // { 'YYYY-MM-DD': { sessions: [ {id, groupId, time, title, students:[{studentId,status,priceOverride}] } ] } }
    payments: []   // { id, studentId, amount, date, method, comment, createdAt }
  };
}

let data;
function loadData() {
  try {
    data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (e) {
    data = defaultData();
    saveData();
  }
  // миграция на случай отсутствующих полей
  data.codes = data.codes || defaultData().codes;
  data.groups = data.groups || [];
  data.students = data.students || [];
  data.days = data.days || {};
  data.payments = data.payments || [];

  // миграция групп: старая схема (price/sickPrice за занятие) → абонемент за 4 занятия
  data.groups.forEach(g => {
    if (g.abonementPrice == null) {
      g.abonementPrice = g.price != null ? Math.round(g.price * 4) : 8000;
    }
  });
  // миграция учеников: старое одно поле name/phone → фамилия/имя + данные родителя
  data.students.forEach(s => {
    if (s.firstName == null && s.lastName == null) {
      const parts = (s.name || '').trim().split(/\s+/);
      s.lastName = parts.length > 1 ? parts[0] : '';
      s.firstName = parts.length > 1 ? parts.slice(1).join(' ') : (parts[0] || '');
    }
    if (s.parentName == null) s.parentName = '';
    if (s.parentPhone == null) s.parentPhone = s.phone || '';
  });
}
function fullName(s) {
  if (!s) return '(удалён)';
  const n = [s.lastName, s.firstName].filter(Boolean).join(' ').trim();
  return n || '(без имени)';
}
let saveTimer = null;
function saveData() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2)); } catch (e) { console.error('save error', e); }
  }, 150);
}
loadData();

function uid(prefix) {
  return (prefix || 'id') + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// ── Вспомогательные функции для повторов ────────────────────────────────────
// recur: null | { type:'weekly', weekday:0-6 } | { type:'nth', weekday:0-6, nth:1-5 }
function dateMatchesRecur(dateStr, recur) {
  if (!recur) return false;
  const d = new Date(dateStr + 'T00:00:00');
  const weekday = d.getDay();
  if (recur.weekday !== weekday) return false;
  if (recur.type === 'weekly') return true;
  if (recur.type === 'nth') {
    // считаем, какой это по счёту weekday в месяце
    const day = d.getDate();
    const occurrence = Math.floor((day - 1) / 7) + 1;
    if (recur.nth === -1) {
      // последний такой weekday в месяце
      const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
      return day + 7 > lastDay;
    }
    return occurrence === recur.nth;
  }
  return false;
}

// Автоматически вычисляемые сессии дня (до сохранения override пользователем)
function computeAutoDay(dateStr) {
  const byGroup = new Map();
  for (const s of data.students) {
    if (s.recur && dateMatchesRecur(dateStr, s.recur)) {
      if (!byGroup.has(s.groupId)) byGroup.set(s.groupId, { students: [], time: '' });
      const entry = byGroup.get(s.groupId);
      entry.students.push({ studentId: s.id, status: 'planned' });
      if (!entry.time && s.recur.time) entry.time = s.recur.time;
    }
  }
  const sessions = [];
  for (const [groupId, entry] of byGroup.entries()) {
    const group = data.groups.find(g => g.id === groupId);
    sessions.push({
      id: uid('auto'),
      groupId,
      time: entry.time,
      title: group ? group.name : 'Занятие',
      students: entry.students
    });
  }
  return { sessions, auto: true };
}

function getDay(dateStr) {
  if (data.days[dateStr]) return data.days[dateStr];
  return computeAutoDay(dateStr);
}

// Цена — от абонемента за 4 занятия в месяц. Обычная цена занятия = абонемент / 4.
// Если ученик заболел — вычитается одна четверть от этой суммы (платится 75%).
// При пропуске занятие не засчитывается — 0 ₽.
function priceFor(groupId, status, override) {
  if (typeof override === 'number') return override;
  const group = data.groups.find(g => g.id === groupId);
  if (!group) return 0;
  const perLesson = Math.round((group.abonementPrice || 0) / 4);
  if (status === 'sick') return Math.round(perLesson * 0.75);
  if (status === 'skipped') return 0;
  return perLesson;
}

// ── HTTP helpers ─────────────────────────────────────────────────────────
function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 5e6) req.destroy(); });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}
function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}
function getAuth(req) {
  const code = req.headers['x-auth-code'];
  if (!code) return null;
  const entry = data.codes.find(c => c.code === code);
  return entry || null;
}
function requireAuth(req, res) {
  const auth = getAuth(req);
  if (!auth) { sendJson(res, 401, { ok: false, error: 'Неверный или отсутствующий код доступа' }); return null; }
  return auth;
}
function requireAdmin(req, res) {
  const auth = requireAuth(req, res);
  if (!auth) return null;
  if (auth.role !== 'admin') { sendJson(res, 403, { ok: false, error: 'Требуются права администратора' }); return null; }
  return auth;
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json' };

function serveStatic(req, res, urlPath) {
  let filePath = urlPath === '/' ? '/index.html' : urlPath;
  filePath = path.join(PUBLIC_DIR, filePath);
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); res.end(); return; }
  fs.readFile(filePath, (err, content) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(content);
  });
}

// ── Сервер ───────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;

  try {
    // ── Авторизация ──
    if (p === '/api/login' && req.method === 'POST') {
      const { code } = JSON.parse(await readBody(req) || '{}');
      const entry = data.codes.find(c => c.code === String(code || '').trim());
      if (!entry) return sendJson(res, 401, { ok: false, error: 'Неверный код' });
      return sendJson(res, 200, { ok: true, role: entry.role, name: entry.name });
    }

    if (!p.startsWith('/api/')) return serveStatic(req, res, p);

    // ── Всё, что ниже — требует авторизации ──
    if (p === '/api/state' && req.method === 'GET') {
      const auth = requireAuth(req, res); if (!auth) return;
      return sendJson(res, 200, {
        ok: true,
        role: auth.role,
        name: auth.name,
        groups: data.groups,
        students: data.students,
        codes: auth.role === 'admin' ? data.codes : undefined
      });
    }

    // ── Группы (типы занятий + цены) ──
    if (p === '/api/groups' && req.method === 'POST') {
      const auth = requireAdmin(req, res); if (!auth) return;
      const b = JSON.parse(await readBody(req) || '{}');
      const g = { id: uid('g'), name: (b.name || 'Занятие').trim(), abonementPrice: Number(b.abonementPrice) || 0, duration: Number(b.duration) || 60 };
      data.groups.push(g); saveData();
      return sendJson(res, 200, { ok: true, group: g });
    }
    if (p.startsWith('/api/groups/') && req.method === 'PUT') {
      const auth = requireAdmin(req, res); if (!auth) return;
      const id = p.split('/')[3];
      const g = data.groups.find(x => x.id === id);
      if (!g) return sendJson(res, 404, { ok: false, error: 'Не найдено' });
      const b = JSON.parse(await readBody(req) || '{}');
      if (b.name != null) g.name = b.name.trim();
      if (b.abonementPrice != null) g.abonementPrice = Number(b.abonementPrice) || 0;
      if (b.duration != null) g.duration = Number(b.duration) || 60;
      saveData();
      return sendJson(res, 200, { ok: true, group: g });
    }
    if (p.startsWith('/api/groups/') && req.method === 'DELETE') {
      const auth = requireAdmin(req, res); if (!auth) return;
      const id = p.split('/')[3];
      data.groups = data.groups.filter(x => x.id !== id);
      saveData();
      return sendJson(res, 200, { ok: true });
    }

    // ── Ученики ──
    if (p === '/api/students' && req.method === 'POST') {
      const auth = requireAdmin(req, res); if (!auth) return;
      const b = JSON.parse(await readBody(req) || '{}');
      const s = {
        id: uid('s'),
        lastName: (b.lastName || '').trim(),
        firstName: (b.firstName || '').trim(),
        parentName: (b.parentName || '').trim(),
        parentPhone: b.parentPhone || '',
        groupId: b.groupId || null,
        recur: b.recur || null
      };
      data.students.push(s); saveData();
      return sendJson(res, 200, { ok: true, student: s });
    }
    if (p.startsWith('/api/students/') && req.method === 'PUT') {
      const auth = requireAdmin(req, res); if (!auth) return;
      const id = p.split('/')[3];
      const s = data.students.find(x => x.id === id);
      if (!s) return sendJson(res, 404, { ok: false, error: 'Не найдено' });
      const b = JSON.parse(await readBody(req) || '{}');
      if (b.lastName != null) s.lastName = b.lastName.trim();
      if (b.firstName != null) s.firstName = b.firstName.trim();
      if (b.parentName != null) s.parentName = b.parentName.trim();
      if (b.parentPhone != null) s.parentPhone = b.parentPhone;
      if (b.groupId !== undefined) s.groupId = b.groupId;
      if (b.recur !== undefined) s.recur = b.recur;
      saveData();
      return sendJson(res, 200, { ok: true, student: s });
    }
    if (p.startsWith('/api/students/') && req.method === 'DELETE') {
      const auth = requireAdmin(req, res); if (!auth) return;
      const id = p.split('/')[3];
      data.students = data.students.filter(x => x.id !== id);
      saveData();
      return sendJson(res, 200, { ok: true });
    }

    // ── День (календарь / занятия) ──
    // GET /api/day/2026-07-21
    if (p.startsWith('/api/day/') && req.method === 'GET') {
      const auth = requireAuth(req, res); if (!auth) return;
      const dateStr = p.split('/')[3];
      const day = getDay(dateStr);
      const enriched = day.sessions.map(sess => ({
        ...sess,
        students: sess.students.map(st => {
          const student = data.students.find(x => x.id === st.studentId);
          return { ...st, name: fullName(student), price: priceFor(sess.groupId, st.status, st.priceOverride) };
        })
      }));
      return sendJson(res, 200, { ok: true, date: dateStr, sessions: enriched, auto: !!day.auto });
    }

    // GET /api/month/2026-07/detail -> полные данные по всем дням месяца (для баланса/просмотра)
    // ВАЖНО: проверяется раньше общей сводки ниже, т.к. иначе более общий startsWith перехватит и этот путь
    if (p.match(/^\/api\/month\/[^/]+\/detail$/) && req.method === 'GET') {
      const auth = requireAuth(req, res); if (!auth) return;
      const ym = p.split('/')[3];
      const [y, m] = ym.split('-').map(Number);
      const daysInMonth = new Date(y, m, 0).getDate();
      const result = {};
      for (let d = 1; d <= daysInMonth; d++) {
        const dateStr = ym + '-' + String(d).padStart(2, '0');
        const day = getDay(dateStr);
        if (!day.sessions.length) continue;
        result[dateStr] = day.sessions.map(sess => ({
          ...sess,
          students: sess.students.map(st => {
            const student = data.students.find(x => x.id === st.studentId);
            return { ...st, name: fullName(student), price: priceFor(sess.groupId, st.status, st.priceOverride) };
          })
        }));
      }
      return sendJson(res, 200, { ok: true, days: result });
    }

    // GET /api/month/2026-07  -> краткая сводка по дням (кол-во учеников/сессий) для календаря
    if (p.startsWith('/api/month/') && req.method === 'GET') {
      const auth = requireAuth(req, res); if (!auth) return;
      const ym = p.split('/')[3]; // '2026-07'
      const [y, m] = ym.split('-').map(Number);
      const daysInMonth = new Date(y, m, 0).getDate();
      const summary = {};
      for (let d = 1; d <= daysInMonth; d++) {
        const dateStr = ym + '-' + String(d).padStart(2, '0');
        const day = getDay(dateStr);
        if (day.sessions.length) {
          const studentCount = new Set(day.sessions.flatMap(s => s.students.map(x => x.studentId))).size;
          summary[dateStr] = { sessions: day.sessions.length, students: studentCount };
        }
      }
      return sendJson(res, 200, { ok: true, summary });
    }

    // POST /api/day/2026-07-21/session — добавить сессию (в т.ч. одноразовую с произвольным названием)
    if (p.match(/^\/api\/day\/[^/]+\/session$/) && req.method === 'POST') {
      const auth = requireAdmin(req, res); if (!auth) return;
      const dateStr = p.split('/')[3];
      if (!data.days[dateStr]) data.days[dateStr] = getDay(dateStr); // материализуем авто-день
      data.days[dateStr].auto = false;
      const b = JSON.parse(await readBody(req) || '{}');
      const sess = { id: uid('sess'), groupId: b.groupId || null, time: b.time || '', title: b.title || 'Занятие', students: [] };
      data.days[dateStr].sessions.push(sess);
      saveData();
      return sendJson(res, 200, { ok: true, session: sess });
    }
    // DELETE /api/day/2026-07-21/session/sess_xxx
    if (p.match(/^\/api\/day\/[^/]+\/session\/[^/]+$/) && req.method === 'DELETE') {
      const auth = requireAdmin(req, res); if (!auth) return;
      const parts = p.split('/'); const dateStr = parts[3]; const sessId = parts[5];
      if (!data.days[dateStr]) data.days[dateStr] = getDay(dateStr);
      data.days[dateStr].auto = false;
      data.days[dateStr].sessions = data.days[dateStr].sessions.filter(s => s.id !== sessId);
      saveData();
      return sendJson(res, 200, { ok: true });
    }
    // POST /api/day/2026-07-21/session/sess_xxx/student — добавить ученика в сессию (разово, без изменения повтора)
    if (p.match(/^\/api\/day\/[^/]+\/session\/[^/]+\/student$/) && req.method === 'POST') {
      const auth = requireAdmin(req, res); if (!auth) return;
      const parts = p.split('/'); const dateStr = parts[3]; const sessId = parts[5];
      if (!data.days[dateStr]) data.days[dateStr] = getDay(dateStr);
      data.days[dateStr].auto = false;
      const sess = data.days[dateStr].sessions.find(s => s.id === sessId);
      if (!sess) return sendJson(res, 404, { ok: false, error: 'Сессия не найдена' });
      const b = JSON.parse(await readBody(req) || '{}');
      if (!sess.students.some(x => x.studentId === b.studentId)) {
        sess.students.push({ studentId: b.studentId, status: 'planned' });
      }
      saveData();
      return sendJson(res, 200, { ok: true });
    }
    // PUT /api/day/2026-07-21/session/sess_xxx/student/s_xxx — статус/цена (пришёл/заболел/пропуск)
    if (p.match(/^\/api\/day\/[^/]+\/session\/[^/]+\/student\/[^/]+$/) && (req.method === 'PUT' || req.method === 'DELETE')) {
      const auth = requireAdmin(req, res); if (!auth) return;
      const parts = p.split('/'); const dateStr = parts[3]; const sessId = parts[5]; const studentId = parts[7];
      if (!data.days[dateStr]) data.days[dateStr] = getDay(dateStr);
      data.days[dateStr].auto = false;
      const sess = data.days[dateStr].sessions.find(s => s.id === sessId);
      if (!sess) return sendJson(res, 404, { ok: false, error: 'Сессия не найдена' });
      if (req.method === 'DELETE') {
        sess.students = sess.students.filter(x => x.studentId !== studentId);
        saveData();
        return sendJson(res, 200, { ok: true });
      }
      const b = JSON.parse(await readBody(req) || '{}');
      let st = sess.students.find(x => x.studentId === studentId);
      if (!st) { st = { studentId, status: 'planned' }; sess.students.push(st); }
      if (b.status) st.status = b.status; // 'planned' | 'came' | 'sick' | 'skipped'
      if (b.priceOverride !== undefined) st.priceOverride = b.priceOverride === null ? undefined : Number(b.priceOverride);
      saveData();
      return sendJson(res, 200, { ok: true, student: st });
    }

    // ── Оплаты ──
    if (p === '/api/payments' && req.method === 'GET') {
      const auth = requireAuth(req, res); if (!auth) return;
      return sendJson(res, 200, { ok: true, payments: data.payments });
    }
    if (p === '/api/payments' && req.method === 'POST') {
      const auth = requireAdmin(req, res); if (!auth) return;
      const b = JSON.parse(await readBody(req) || '{}');
      const pay = { id: uid('p'), studentId: b.studentId, amount: Number(b.amount) || 0, date: b.date || new Date().toISOString().slice(0, 10), method: b.method || 'cash', comment: b.comment || '', createdAt: Date.now() };
      data.payments.push(pay); saveData();
      return sendJson(res, 200, { ok: true, payment: pay });
    }
    if (p.startsWith('/api/payments/') && req.method === 'DELETE') {
      const auth = requireAdmin(req, res); if (!auth) return;
      const id = p.split('/')[3];
      data.payments = data.payments.filter(x => x.id !== id);
      saveData();
      return sendJson(res, 200, { ok: true });
    }

    // ── Коды доступа (только админ) ──
    if (p === '/api/codes' && req.method === 'POST') {
      const auth = requireAdmin(req, res); if (!auth) return;
      const b = JSON.parse(await readBody(req) || '{}');
      const code = String(b.code || '').trim();
      if (!/^\d{4,6}$/.test(code)) return sendJson(res, 400, { ok: false, error: 'Код должен быть числом из 4–6 цифр' });
      if (data.codes.some(c => c.code === code)) return sendJson(res, 400, { ok: false, error: 'Такой код уже существует' });
      const entry = { code, role: b.role === 'admin' ? 'admin' : 'viewer', name: b.name || 'Без имени' };
      data.codes.push(entry); saveData();
      return sendJson(res, 200, { ok: true, codes: data.codes });
    }
    if (p.startsWith('/api/codes/') && req.method === 'PUT') {
      const auth = requireAdmin(req, res); if (!auth) return;
      const code = decodeURIComponent(p.split('/')[3]);
      const entry = data.codes.find(c => c.code === code);
      if (!entry) return sendJson(res, 404, { ok: false, error: 'Код не найден' });
      const b = JSON.parse(await readBody(req) || '{}');
      if (b.name != null) entry.name = b.name.trim() || entry.name;
      if (b.role) entry.role = b.role === 'admin' ? 'admin' : 'viewer';
      saveData();
      return sendJson(res, 200, { ok: true, codes: data.codes });
    }
    if (p.startsWith('/api/codes/') && req.method === 'DELETE') {
      const auth = requireAdmin(req, res); if (!auth) return;
      const code = decodeURIComponent(p.split('/')[3]);
      if (data.codes.length <= 1) return sendJson(res, 400, { ok: false, error: 'Нельзя удалить последний код' });
      data.codes = data.codes.filter(c => c.code !== code);
      saveData();
      return sendJson(res, 200, { ok: true, codes: data.codes });
    }

    sendJson(res, 404, { ok: false, error: 'Неизвестный маршрут' });
  } catch (e) {
    console.error(e);
    sendJson(res, 500, { ok: false, error: 'Ошибка сервера: ' + e.message });
  }
});

server.listen(PORT, () => console.log('Сервер запущен на порту ' + PORT));
