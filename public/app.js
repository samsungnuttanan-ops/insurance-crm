// SDK_BASE ถูกเปลี่ยนได้เฉพาะตอนทดสอบในเครื่อง (dev/serve.mjs ใช้ Firebase จำลอง)
const SDK_BASE = self.FIREBASE_SDK_BASE || `https://www.gstatic.com/firebasejs/${self.FIREBASE_SDK_VERSION}`;
const [{ initializeApp }, {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut,
}, {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  collection, doc, addDoc, updateDoc, deleteDoc, setDoc, onSnapshot,
  serverTimestamp, arrayUnion, arrayRemove,
}, messagingSdk] = await Promise.all([
  import(`${SDK_BASE}/firebase-app.js`),
  import(`${SDK_BASE}/firebase-auth.js`),
  import(`${SDK_BASE}/firebase-firestore.js`),
  import(`${SDK_BASE}/firebase-messaging.js`),
]);

const fbApp = initializeApp(self.FIREBASE_CONFIG);
const auth = getAuth(fbApp);
const db = initializeFirestore(fbApp, {
  localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
});

/* ====================================================================
 * ค่าคงที่
 * ==================================================================== */
const CUSTOMER_STATUS = {
  prospect: 'มุ่งหวัง',
  contacted: 'นัดคุยแล้ว',
  customer: 'ซื้อแล้ว',
  not_interested: 'ไม่สนใจ',
};
const APPT_STATUS = { pending: 'รอพบ', done: 'เสร็จแล้ว', cancelled: 'ยกเลิก' };
const WALK_IN = 'ลูกค้าวอล์กอินสำนักงาน';
const OTHER_TOPIC = 'อื่นๆ';
const TOPICS = ['เสนอแบบประกัน', 'เซ็นสัญญา', 'เก็บเบี้ย', 'ติดตาม', WALK_IN, OTHER_TOPIC];
const FREQ = {
  monthly: { label: 'รายเดือน', months: 1 },
  quarterly: { label: 'ราย 3 เดือน', months: 3 },
  semiannual: { label: 'ราย 6 เดือน', months: 6 },
  annual: { label: 'รายปี', months: 12 },
};
const TASK_TYPES = {
  general: { label: 'งานทั่วไป', icon: '📌' },
  meeting: { label: 'ประชุม', icon: '👥' },
  errand: { label: 'ไปธุระ / นอกสถานที่', icon: '🚗' },
  document: { label: 'เอกสาร', icon: '📄' },
};
const CONFLICT_MINUTES = 60; // นัด/งานที่ห่างกันน้อยกว่านี้ถือว่าเวลาชน
const UPCOMING_DAYS = 7;
const OVERDUE_LOOKBACK_DAYS = 90;
const DOW = ['อา', 'จ', 'อ', 'พ', 'พฤ', 'ศ', 'ส'];
const DAY_START_HOUR = 7; // ตารางรายชั่วโมง: ช่วงเวลาที่แสดงเสมอ
const DAY_END_HOUR = 20;

/* ====================================================================
 * State
 * ==================================================================== */
const state = {
  customers: new Map(),
  appointments: [],
  tasks: [],
  tab: 'calendar',
  calMode: 'month',
  selected: todayStr(),
  custQuery: '',
  custFilter: 'all',
  taskView: 'open',
  loaded: { customers: false, appointments: false, tasks: false },
};
let unsubscribers = [];

/* ====================================================================
 * วันที่ (เก็บเป็น 'YYYY-MM-DD' ตามเวลาเครื่อง)
 * ==================================================================== */
function pad(n) { return String(n).padStart(2, '0'); }
function ymd(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function parse(s) { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); }
function todayStr() { return ymd(new Date()); }
function addDays(s, n) { const d = parse(s); d.setDate(d.getDate() + n); return ymd(d); }
function addMonthsClamped(s, months) {
  const [y, m, d] = s.split('-').map(Number);
  const target = new Date(y, m - 1 + months, 1);
  const dim = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  target.setDate(Math.min(d, dim));
  return ymd(target);
}
function startOfWeek(s) { const d = parse(s); d.setDate(d.getDate() - d.getDay()); return ymd(d); }
function toMinutes(t) { if (!t) return null; const [h, m] = t.split(':').map(Number); return h * 60 + m; }

const fmtFull = new Intl.DateTimeFormat('th-TH', { weekday: 'short', day: 'numeric', month: 'short', year: '2-digit' });
const fmtShort = new Intl.DateTimeFormat('th-TH', { day: 'numeric', month: 'short' });
const fmtMonth = new Intl.DateTimeFormat('th-TH', { month: 'long', year: 'numeric' });
const fmtDayLong = new Intl.DateTimeFormat('th-TH', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
const dateFull = (s) => (s ? fmtFull.format(parse(s)) : '-');
const dateShort = (s) => (s ? fmtShort.format(parse(s)) : '-');

function relDay(s) {
  const diff = Math.round((parse(s) - parse(todayStr())) / 86400000);
  if (diff === 0) return 'วันนี้';
  if (diff === 1) return 'พรุ่งนี้';
  if (diff === -1) return 'เมื่อวาน';
  return diff > 0 ? `อีก ${diff} วัน` : `เลยมา ${-diff} วัน`;
}

/* ====================================================================
 * เบี้ยประกัน: คำนวณงวดที่วนซ้ำ
 * ==================================================================== */
function premiumDuesInRange(c, from, to) {
  const f = FREQ[c.premiumFrequency];
  if (!c.premiumStartDate || !f) return [];
  const [sy, sm] = c.premiumStartDate.split('-').map(Number);
  const [fy, fm] = from.split('-').map(Number);
  const monthsFromStart = (fy - sy) * 12 + (fm - sm);
  let i = Math.max(0, Math.floor(monthsFromStart / f.months) - 1);
  const out = [];
  for (;;) {
    const due = addMonthsClamped(c.premiumStartDate, i * f.months);
    if (due > to) break;
    if (due >= from) out.push(due);
    i++;
  }
  return out;
}
function nextPremiumDue(c) {
  if (!c.premiumStartDate || !FREQ[c.premiumFrequency]) return null;
  const t = todayStr();
  return premiumDuesInRange(c, t, addDays(t, 400))[0] || null;
}
function isPaid(c, due) { return (c.paidDues || []).includes(due); }

// งวดที่ครบก่อนวันที่เพิ่มลูกค้าเข้าระบบ ไม่นับว่า "เลยกำหนด" (ถือว่าจ่ายไปก่อนแล้ว)
function overdueFrom(c) {
  const lookback = addDays(todayStr(), -OVERDUE_LOOKBACK_DAYS);
  const ts = c.createdAt;
  const created = ts?.toDate ? ymd(ts.toDate()) : typeof ts === 'string' ? ts.slice(0, 10) : '';
  return created > lookback ? created : lookback;
}

/* ====================================================================
 * รวมรายการสำหรับช่วงวันที่
 * ==================================================================== */
function customerName(a) {
  const c = a.customerId && state.customers.get(a.customerId);
  return c ? c.name : (a.customerName || 'ไม่ระบุลูกค้า');
}

function eventsInRange(from, to) {
  const events = [];
  for (const a of state.appointments) {
    if (a.date >= from && a.date <= to) {
      events.push({ kind: 'appt', date: a.date, time: a.time || '', appt: a });
    }
  }
  for (const c of state.customers.values()) {
    for (const due of premiumDuesInRange(c, from, to)) {
      events.push({ kind: 'premium', date: due, time: '', customer: c, paid: isPaid(c, due) });
    }
    if (c.nextContactDate && c.nextContactDate >= from && c.nextContactDate <= to) {
      events.push({ kind: 'contact', date: c.nextContactDate, time: '', customer: c });
    }
  }
  for (const t of state.tasks) {
    if (t.dueDate && t.dueDate >= from && t.dueDate <= to) {
      events.push({ kind: 'task', date: t.dueDate, time: t.dueTime || '', task: t });
    }
  }
  const order = { appt: 0, task: 1, contact: 2, premium: 3 };
  events.sort((x, y) => x.date.localeCompare(y.date)
    || (x.time || '99').localeCompare(y.time || '99')
    || order[x.kind] - order[y.kind]);
  return events;
}

// รายการที่ใช้เวลา: นัดที่ยังรอพบ + งานที่ยังไม่เสร็จและระบุเวลา
function busyItems(events) {
  return events
    .filter((e) => e.time && ((e.kind === 'appt' && e.appt.status === 'pending') || (e.kind === 'task' && !e.task.done)))
    .map((e) => (e.kind === 'appt'
      ? { id: e.appt.id, time: e.time, label: `นัด ${customerName(e.appt)}` }
      : { id: e.task.id, time: e.time, label: `${TASK_TYPES[e.task.type]?.icon || '📌'} ${e.task.title}` }))
    .sort((a, b) => a.time.localeCompare(b.time));
}

function conflictIds(events) {
  const busy = busyItems(events);
  const ids = new Set();
  for (let i = 0; i < busy.length; i++) {
    for (let j = i + 1; j < busy.length; j++) {
      if (toMinutes(busy[j].time) - toMinutes(busy[i].time) < CONFLICT_MINUTES) {
        ids.add(busy[i].id); ids.add(busy[j].id);
      } else break;
    }
  }
  return ids;
}

// ถามยืนยันถ้าเวลาใกล้กับนัด/งานอื่นในวันเดียวกัน — คืน false ถ้าผู้ใช้กดยกเลิก
function confirmNoClash(date, time, excludeId) {
  const mins = toMinutes(time);
  const clash = busyItems(eventsInRange(date, date))
    .filter((b) => b.id !== excludeId && Math.abs(toMinutes(b.time) - mins) < CONFLICT_MINUTES);
  if (!clash.length) return true;
  const list = clash.map((b) => `• ${b.time} ${b.label}`).join('\n');
  return confirm(`เวลานี้ใกล้กับรายการอื่น:\n${list}\n\nต้องการบันทึกต่อหรือไม่?`);
}

/* ====================================================================
 * สรุปแจ้งเตือน (วันนี้ / ใกล้ถึง / เลยกำหนด)
 * ==================================================================== */
function buildSummary() {
  const t = todayStr();
  const today = eventsInRange(t, t).filter((e) => !(e.kind === 'appt' && e.appt.status === 'cancelled')
    && !(e.kind === 'premium' && e.paid) && !(e.kind === 'task' && e.task.done));
  const upcoming = eventsInRange(addDays(t, 1), addDays(t, UPCOMING_DAYS))
    .filter((e) => !(e.kind === 'appt' && e.appt.status !== 'pending') && !(e.kind === 'premium' && e.paid) && !(e.kind === 'task' && e.task.done));

  const overdue = [];
  for (const a of state.appointments) {
    if (a.status === 'pending' && a.date < t) overdue.push({ kind: 'appt', date: a.date, time: a.time, appt: a });
  }
  for (const c of state.customers.values()) {
    for (const due of premiumDuesInRange(c, overdueFrom(c), addDays(t, -1))) {
      if (!isPaid(c, due)) overdue.push({ kind: 'premium', date: due, time: '', customer: c, paid: false });
    }
    if (c.nextContactDate && c.nextContactDate < t) overdue.push({ kind: 'contact', date: c.nextContactDate, time: '', customer: c });
  }
  for (const task of state.tasks) {
    if (!task.done && task.dueDate && task.dueDate < t) overdue.push({ kind: 'task', date: task.dueDate, time: task.dueTime || '', task });
  }
  overdue.sort((x, y) => y.date.localeCompare(x.date));
  return { today, upcoming, overdue };
}

/* ====================================================================
 * Helpers
 * ==================================================================== */
const $ = (sel, root = document) => root.querySelector(sel);
function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}
function telHref(phone) { return `tel:${String(phone || '').replace(/[^\d+]/g, '')}`; }
function initials(name) { return esc((name || '?').trim().charAt(0)); }

let toastTimer;
function toast(msg) {
  const el = $('#toast');
  const sheet = $('#sheet');
  (sheet.open ? sheet : document.body).appendChild(el);
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2600);
}

function friendlyError(err) {
  console.error(err);
  const code = err?.code || '';
  if (code.includes('permission-denied')) return 'ไม่มีสิทธิ์เข้าถึงข้อมูล';
  if (code.includes('unavailable') || code.includes('network')) return 'เชื่อมต่ออินเทอร์เน็ตไม่ได้';
  return 'เกิดข้อผิดพลาด ลองใหม่อีกครั้ง';
}

// Firestore เก็บการเขียนไว้ในเครื่องก่อนแล้วค่อยส่งขึ้นเซิร์ฟเวอร์
// จึงไม่ต้องรอ (ถ้ารอ ตอนไม่มีเน็ตจะค้าง) — ถ้าเซิร์ฟเวอร์ปฏิเสธค่อยแจ้ง
function write(promise) {
  promise.catch((err) => toast(`บันทึกไม่สำเร็จ: ${friendlyError(err)}`));
}

/* ====================================================================
 * Auth
 * ==================================================================== */
$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.currentTarget;
  const btn = form.querySelector('button');
  const errEl = $('#login-error');
  const username = form.username.value.trim().toLowerCase();
  const email = username.includes('@') ? username : `${username}@${self.LOGIN_EMAIL_DOMAIN}`;
  errEl.hidden = true;
  btn.disabled = true;
  try {
    await signInWithEmailAndPassword(auth, email, form.password.value);
    form.reset();
  } catch (err) {
    const code = err?.code || '';
    errEl.textContent = code.includes('network')
      ? 'เชื่อมต่ออินเทอร์เน็ตไม่ได้'
      : code.includes('too-many-requests')
        ? 'ลองผิดหลายครั้งเกินไป กรุณารอสักครู่'
        : 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง';
    errEl.hidden = false;
  } finally {
    btn.disabled = false;
  }
});

onAuthStateChanged(auth, (user) => {
  $('#splash').hidden = true;
  unsubscribers.forEach((u) => u());
  unsubscribers = [];
  if (!user) {
    $('#app').hidden = true;
    $('#login').hidden = false;
    return;
  }
  $('#login').hidden = true;
  $('#app').hidden = false;
  subscribeData();
  applyUrlParams();
  render();
  refreshPushToken();
});

function subscribeData(retried = false) {
  state.loadError = '';
  const onError = async (err) => {
    unsubscribers.forEach((u) => u());
    unsubscribers = [];
    // สิทธิ์อาจเพิ่งถูกแก้ใน Console (เช่นเปลี่ยนอีเมล) → ขอ token ใหม่แล้วลองอีกครั้ง
    if (!retried && err?.code === 'permission-denied' && auth.currentUser) {
      try {
        await auth.currentUser.getIdToken(true);
        subscribeData(true);
        return;
      } catch { /* แสดง error ด้านล่าง */ }
    }
    state.loadError = err?.code === 'permission-denied'
      ? 'บัญชีนี้ไม่มีสิทธิ์เข้าถึงข้อมูล (บัญชีต้องเป็น ชื่อผู้ใช้@crm.local)'
      : friendlyError(err);
    render();
  };
  unsubscribers.push(onSnapshot(collection(db, 'customers'), (snap) => {
    state.customers = new Map(snap.docs.map((d) => [d.id, { id: d.id, ...d.data() }]));
    state.loaded.customers = true;
    render();
    refreshOpenDetail();
  }, onError));
  unsubscribers.push(onSnapshot(collection(db, 'appointments'), (snap) => {
    state.appointments = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    state.loaded.appointments = true;
    render();
    refreshOpenDetail();
  }, onError));
  unsubscribers.push(onSnapshot(collection(db, 'tasks'), (snap) => {
    state.tasks = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    state.loaded.tasks = true;
    render();
    refreshOpenDetail();
  }, onError));
}

function applyUrlParams() {
  const p = new URLSearchParams(location.search);
  if (p.get('date') && /^\d{4}-\d{2}-\d{2}$/.test(p.get('date'))) {
    state.selected = p.get('date');
    state.tab = 'calendar';
    state.calMode = 'day';
  }
  if (p.has('date') || p.has('view')) history.replaceState(null, '', '/');
}

/* ====================================================================
 * Render หลัก
 * ==================================================================== */
const TITLES = { calendar: 'ปฏิทิน', tasks: 'งานที่ต้องทำ', customers: 'ลูกค้า', summary: 'แจ้งเตือน' };
const FAB_LABELS = { calendar: 'เพิ่มนัดหมาย', tasks: 'เพิ่มงาน', customers: 'เพิ่มลูกค้า', summary: 'เพิ่มนัดหมาย' };

function render() {
  document.querySelectorAll('.tabbar button').forEach((b) => b.classList.toggle('active', b.dataset.tab === state.tab));
  $('#page-title').textContent = TITLES[state.tab];
  $('#page-sub').textContent = fmtDayLong.format(new Date());
  $('#fab').setAttribute('aria-label', FAB_LABELS[state.tab]);
  $('#fab').hidden = state.tab === 'calendar'; // ในปฏิทินให้แตะวันที่แทน

  const s = buildSummary();
  const count = s.today.length + s.overdue.length;
  $('#badge').hidden = count === 0;
  $('#badge').textContent = count > 99 ? '99+' : count;

  const ready = state.loaded.customers && state.loaded.appointments && state.loaded.tasks;
  const view = $('#view');
  if (state.loadError) {
    view.innerHTML = `
      <div class="empty">
        <p class="error">${esc(state.loadError)}</p>
        <button class="btn primary" data-action="retry-load">ลองใหม่</button>
        <button class="btn" data-action="logout-now" style="margin-left:8px">ออกจากระบบ</button>
      </div>`;
    return;
  }
  if (!ready) { view.innerHTML = '<p class="empty">กำลังโหลดข้อมูล…</p>'; return; }
  if (state.tab === 'calendar') view.innerHTML = renderCalendar();
  else if (state.tab === 'customers') {
    // อย่าสร้างช่องค้นหาใหม่ขณะพิมพ์ (คีย์บอร์ดมือถือจะหลุด)
    if ($('#cust-search')) $('#cust-results').innerHTML = renderCustomerList();
    else view.innerHTML = renderCustomers();
  } else if (state.tab === 'tasks') {
    if ($('#task-quick')) $('#task-results').innerHTML = renderTaskList();
    else view.innerHTML = renderTasks();
  } else view.innerHTML = renderSummary(s);

  $('#topbar-actions').innerHTML = state.tab === 'calendar'
    ? '<button class="btn small" data-action="go-today">วันนี้</button>'
    : '';
}

/* ---------- รายการ (ใช้ร่วมกันทุกหน้า) ---------- */
// เบอร์โทรที่แตะแล้วโทรออก (data-stop = ไม่ให้เปิดรายการที่ครอบอยู่)
function telLink(phone) {
  return phone ? `<a class="tel" href="${telHref(phone)}" data-stop>📞 ${esc(phone)}</a>` : '';
}
function callButton(phone, name) {
  return phone ? `<a class="call" href="${telHref(phone)}" aria-label="โทรหา ${esc(name)}" data-stop>📞</a>` : '';
}

function renderEvent(e, { conflicts = new Set(), showDate = false } = {}) {
  const dateLabel = showDate ? `${dateShort(e.date)} · ${relDay(e.date)}` : '';
  if (e.kind === 'appt') {
    const a = e.appt;
    const c = a.customerId && state.customers.get(a.customerId);
    const sub = [a.topic, showDate ? dateLabel : '', a.location].filter(Boolean).join(' · ');
    return `
      <div class="item ${a.status} ${conflicts.has(a.id) ? 'conflict' : ''}" data-action="edit-appt" data-id="${a.id}" role="button" tabindex="0">
        <span class="time">${esc(a.time || '--:--')}</span>
        <span class="body">
          <span class="title">${esc(customerName(a))}</span>
          ${a.status !== 'pending' ? `<span class="tag a-${a.status}">${APPT_STATUS[a.status]}</span>` : ''}
          ${conflicts.has(a.id) ? '<span class="tag warn">เวลาชน</span>' : ''}
          <div class="sub">${esc(sub)}</div>
          ${c?.phone ? `<div class="sub">${telLink(c.phone)}</div>` : ''}
        </span>
      </div>`;
  }
  if (e.kind === 'task') {
    return renderTaskItem(e.task, { showDate, conflict: conflicts.has(e.task.id) });
  }
  const c = e.customer;
  if (e.kind === 'premium') {
    return `
      <div class="item premium ${e.paid ? 'done' : ''}" data-action="view-customer" data-id="${c.id}" role="button" tabindex="0">
        <span class="time">เบี้ย</span>
        <span class="body">
          <span class="title">${esc(c.name)}</span>
          ${e.paid ? '<span class="tag a-done">ชำระแล้ว</span>' : ''}
          <div class="sub">ครบกำหนดชำระ (${esc(FREQ[c.premiumFrequency]?.label || '')})${showDate ? ` · ${esc(dateLabel)}` : ''}</div>
          ${c.phone ? `<div class="sub">${telLink(c.phone)}</div>` : ''}
        </span>
      </div>`;
  }
  return `
    <div class="item contact" data-action="view-customer" data-id="${c.id}" role="button" tabindex="0">
      <span class="time">โทร</span>
      <span class="body">
        <span class="title">${esc(c.name)}</span>
        <div class="sub">ถึงวันติดต่อลูกค้า${showDate ? ` · ${esc(dateLabel)}` : ''}</div>
        ${c.phone ? `<div class="sub">${telLink(c.phone)}</div>` : ''}
      </span>
    </div>`;
}

function renderTaskItem(t, { showDate = true, conflict = false } = {}) {
  const type = TASK_TYPES[t.type] || TASK_TYPES.general;
  const c = t.customerId && state.customers.get(t.customerId);
  const due = t.dueDate
    ? [showDate ? dateShort(t.dueDate) : '', t.dueTime, t.done ? '' : relDay(t.dueDate)].filter(Boolean).join(' · ')
    : '';
  const overdue = !t.done && t.dueDate && t.dueDate < todayStr();
  return `
    <div class="item task ${t.done ? 'task-done' : ''} ${conflict ? 'conflict' : ''}" data-action="edit-task" data-id="${t.id}" role="button" tabindex="0">
      <button type="button" class="check ${t.done ? 'on' : ''}" data-action="toggle-task" data-id="${t.id}" aria-label="${t.done ? 'ยกเลิกทำเสร็จ' : 'ทำเสร็จแล้ว'}">✓</button>
      <span class="body">
        <span class="title">${type.icon} ${esc(t.title)}</span>
        ${overdue ? '<span class="tag warn">เลยกำหนด</span>' : ''}
        ${conflict ? '<span class="tag warn">เวลาชน</span>' : ''}
        ${t.location ? `<div class="sub">📍 ${esc(t.location)}</div>` : ''}
        ${t.notes ? `<div class="sub note">${esc(t.notes)}</div>` : ''}
        ${due || c ? `<div class="sub">${due ? `🗓 ${esc(due)}` : ''}${due && c ? ' · ' : ''}${c ? `👤 ${esc(c.name)}` : ''}</div>` : ''}
        ${c?.phone ? `<div class="sub">${telLink(c.phone)}</div>` : ''}
      </span>
    </div>`;
}

/* ---------- ปฏิทิน ---------- */
function renderCalendar() {
  const mode = state.calMode;
  const seg = ['month', 'week', 'day'].map((m) => `<button data-action="cal-mode" data-mode="${m}" class="${mode === m ? 'active' : ''}">${{ month: 'เดือน', week: 'สัปดาห์', day: 'วัน' }[m]}</button>`).join('');
  const toolbar = `
    <div class="cal-toolbar">
      <div class="segmented">${seg}</div>
      <div class="cal-nav">
        <button class="btn" data-action="cal-prev" aria-label="ก่อนหน้า">‹</button>
        <button class="btn" data-action="cal-next" aria-label="ถัดไป">›</button>
      </div>
    </div>
    <div class="legend">
      <span><i style="background:var(--appt)"></i>นัดหมาย</span>
      <span><i style="background:var(--done)"></i>เสร็จแล้ว</span>
      <span><i style="background:var(--premium)"></i>ครบกำหนดเบี้ย</span>
      <span><i style="background:var(--contact)"></i>วันติดต่อลูกค้า</span>
      <span><i style="background:var(--task)"></i>กิจกรรม</span>
    </div>
    <p class="cal-hint">${mode === 'day' ? 'แตะช่องเวลาเพื่อเพิ่มนัดหมายหรือกิจกรรม' : 'แตะวันที่เพื่อเพิ่มนัดหมายหรือกิจกรรม'}</p>`;
  if (mode === 'month') return toolbar + renderMonth();
  if (mode === 'week') return toolbar + renderWeek();
  return toolbar + renderTimeline(state.selected);
}

function renderMonth() {
  const sel = parse(state.selected);
  const first = ymd(new Date(sel.getFullYear(), sel.getMonth(), 1));
  const gridStart = startOfWeek(first);
  const gridEnd = addDays(gridStart, 41);
  const byDate = new Map();
  for (const e of eventsInRange(gridStart, gridEnd)) {
    if (e.kind === 'appt' && e.appt.status === 'cancelled') continue;
    if (e.kind === 'task' && e.task.done) continue;
    if (!byDate.has(e.date)) byDate.set(e.date, []);
    byDate.get(e.date).push(e);
  }
  const t = todayStr();
  let cells = DOW.map((d) => `<div class="dow">${d}</div>`).join('');
  for (let i = 0; i < 42; i++) {
    const s = addDays(gridStart, i);
    const d = parse(s);
    const evs = byDate.get(s) || [];
    const dots = evs.slice(0, 4).map((e) => {
      const cls = e.kind === 'appt' ? (e.appt.status === 'done' ? 'done' : '') : e.kind;
      return `<i class="${cls}"></i>`;
    }).join('') + (evs.length > 4 ? `<span class="more">+${evs.length - 4}</span>` : '');
    cells += `
      <button class="day ${d.getMonth() !== sel.getMonth() ? 'other' : ''} ${s === t ? 'today' : ''} ${s === state.selected ? 'selected' : ''}"
        data-action="select-day" data-date="${s}" aria-label="${dateFull(s)} ${evs.length} รายการ">
        <span class="n">${d.getDate()}</span>
        <span class="dots">${dots}</span>
      </button>`;
  }
  return `
    <h2 class="cal-title">${fmtMonth.format(sel)}</h2>
    <div class="month">${cells}</div>
    <h3 class="section-title">${fmtDayLong.format(sel)}</h3>
    ${renderDay(state.selected)}`;
}

function renderWeek() {
  const start = startOfWeek(state.selected);
  const end = addDays(start, 6);
  const t = todayStr();
  const events = eventsInRange(start, end);
  let html = `<h2 class="cal-title">${dateShort(start)} – ${dateFull(end)}</h2>`;
  for (let i = 0; i < 7; i++) {
    const s = addDays(start, i);
    const dayEvents = events.filter((e) => e.date === s);
    const conflicts = conflictIds(dayEvents);
    html += `
      <div class="week-day">
        <button type="button" class="week-head ${s === t ? 'today' : ''}" data-action="add-at" data-date="${s}">
          <span>${fmtDayLong.format(parse(s))}</span><span class="plus" aria-hidden="true">＋</span>
        </button>
        ${dayEvents.length ? dayEvents.map((e) => renderEvent(e, { conflicts })).join('') : '<div class="sub" style="color:var(--muted);font-size:13px;padding:0 0 4px">ว่าง</div>'}
      </div>`;
  }
  return html;
}

function renderDay(s) {
  const events = eventsInRange(s, s);
  const conflicts = conflictIds(events);
  let html = '';
  if (conflicts.size) html += `<div class="conflict-note">⚠️ มีรายการที่เวลาใกล้กันไม่ถึง ${CONFLICT_MINUTES} นาที ลองเลื่อนนัดดูครับ</div>`;
  html += events.length
    ? events.map((e) => renderEvent(e, { conflicts })).join('')
    : '<div class="empty">ยังไม่มีนัดหมายหรือกิจกรรม</div>';
  return html;
}

// มุมมอง "วัน": ตารางรายชั่วโมง แตะช่องว่างเพื่อเพิ่มนัดเวลานั้น
function renderTimeline(s) {
  const events = eventsInRange(s, s);
  const conflicts = conflictIds(events);
  const allDay = events.filter((e) => !e.time);
  const timed = events.filter((e) => e.time);
  const hours = timed.map((e) => Number(e.time.slice(0, 2)));
  const from = Math.min(DAY_START_HOUR, ...hours);
  const to = Math.max(DAY_END_HOUR, ...hours);
  const isToday = s === todayStr();
  const nowHour = new Date().getHours();

  let html = `<h2 class="cal-title">${fmtDayLong.format(parse(s))} <span class="tag">${relDay(s)}</span></h2>`;
  if (conflicts.size) html += `<div class="conflict-note">⚠️ มีรายการที่เวลาใกล้กันไม่ถึง ${CONFLICT_MINUTES} นาที ลองเลื่อนนัดดูครับ</div>`;
  if (allDay.length) {
    html += `<div class="allday"><div class="allday-label">ทั้งวัน</div>${allDay.map((e) => renderEvent(e, { conflicts })).join('')}</div>`;
  }
  html += '<div class="timeline">';
  for (let h = from; h <= to; h++) {
    const hh = pad(h);
    const inHour = timed.filter((e) => Number(e.time.slice(0, 2)) === h);
    const now = isToday && h === nowHour ? 'now' : '';
    html += `
      <div class="slot ${now}">
        <div class="slot-time">${hh}:00</div>
        <div class="slot-body">
          ${inHour.map((e) => renderEvent(e, { conflicts })).join('')}
          <button type="button" class="slot-add ${inHour.length ? 'compact' : ''}" data-action="add-at" data-date="${s}" data-time="${hh}:00"
            aria-label="เพิ่มนัดหมายหรือกิจกรรม ${hh}:00"></button>
        </div>
      </div>`;
  }
  return `${html}</div>`;
}

/* ---------- ลูกค้า ---------- */
function renderCustomers() {
  return `
    <div class="search">
      <input id="cust-search" type="search" placeholder="ค้นหาชื่อหรือเบอร์โทร" value="${esc(state.custQuery)}" autocomplete="off">
    </div>
    <div id="cust-results">${renderCustomerList()}</div>`;
}

function renderCustomerList() {
  const q = state.custQuery.trim().toLowerCase();
  const digits = q.replace(/\D/g, '');
  let list = [...state.customers.values()];
  if (state.custFilter !== 'all') list = list.filter((c) => (c.status || 'prospect') === state.custFilter);
  if (q) {
    list = list.filter((c) => (c.name || '').toLowerCase().includes(q)
      || (digits && (c.phone || '').replace(/\D/g, '').includes(digits)));
  }
  list.sort((a, b) => (a.name || '').localeCompare(b.name || '', 'th'));

  const chips = [['all', 'ทั้งหมด'], ...Object.entries(CUSTOMER_STATUS)]
    .map(([k, v]) => `<button data-action="cust-filter" data-v="${k}" class="${state.custFilter === k ? 'active' : ''}">${v}</button>`).join('');

  const items = list.map((c) => {
    const next = nextPremiumDue(c);
    const extra = [
      next ? `เบี้ยงวดถัดไป ${dateShort(next)}` : '',
      c.nextContactDate ? `ติดต่อ ${dateShort(c.nextContactDate)}` : '',
    ].filter(Boolean).join(' · ');
    return `
      <div class="item cust" data-action="view-customer" data-id="${c.id}" role="button" tabindex="0">
        <span class="avatar">${initials(c.name)}</span>
        <span class="body">
          <span class="title">${esc(c.name)}</span>
          <span class="tag s-${c.status || 'prospect'}">${CUSTOMER_STATUS[c.status || 'prospect']}</span>
          ${c.phone ? `<div class="sub">${telLink(c.phone)}</div>` : ''}
          ${extra ? `<div class="sub">${esc(extra)}</div>` : ''}
        </span>
        ${callButton(c.phone, c.name)}
      </div>`;
  }).join('');

  return `
    <div class="chips">${chips}</div>
    <p class="hint">ทั้งหมด ${list.length} คน</p>
    ${items || `<div class="empty">${state.customers.size ? 'ไม่พบลูกค้าที่ค้นหา' : 'ยังไม่มีลูกค้า กดปุ่ม ＋ เพื่อเพิ่ม'}</div>`}`;
}

/* ---------- งานที่ต้องทำ ---------- */
function millis(ts) {
  if (!ts) return Date.now(); // ยังรอเซิร์ฟเวอร์ใส่เวลา = เพิ่งสร้าง
  if (ts.toMillis) return ts.toMillis();
  return new Date(ts).getTime() || 0;
}

function renderTasks() {
  return `
    <form id="task-quick" class="quick-add" autocomplete="off">
      <input name="title" placeholder="จดงานด่วน… แล้วกด ＋" enterkeyhint="done">
      <button class="btn primary" type="submit" aria-label="เพิ่มงาน">＋</button>
    </form>
    <div id="task-results">${renderTaskList()}</div>`;
}

function renderTaskList() {
  const t = todayStr();
  const open = state.tasks.filter((x) => !x.done);
  const done = state.tasks.filter((x) => x.done);
  const seg = `
    <div class="segmented task-seg">
      <button data-action="task-view" data-v="open" class="${state.taskView === 'open' ? 'active' : ''}">ยังไม่เสร็จ ${open.length}</button>
      <button data-action="task-view" data-v="done" class="${state.taskView === 'done' ? 'active' : ''}">เสร็จแล้ว ${done.length}</button>
    </div>`;

  if (state.taskView === 'done') {
    const list = done.sort((a, b) => millis(b.doneAt) - millis(a.doneAt)).slice(0, 100);
    return seg + (list.length ? list.map((x) => renderTaskItem(x)).join('') : '<div class="empty">ยังไม่มีงานที่ทำเสร็จ</div>');
  }

  const byDue = (a, b) => (a.dueDate + (a.dueTime || '99')).localeCompare(b.dueDate + (b.dueTime || '99'));
  const groups = [
    ['เลยกำหนด', open.filter((x) => x.dueDate && x.dueDate < t).sort(byDue)],
    ['วันนี้', open.filter((x) => x.dueDate === t).sort(byDue)],
    ['กำลังจะถึง', open.filter((x) => x.dueDate && x.dueDate > t).sort(byDue)],
    ['ไม่ระบุวัน', open.filter((x) => !x.dueDate).sort((a, b) => millis(b.createdAt) - millis(a.createdAt))],
  ];
  const body = groups.filter(([, list]) => list.length).map(([title, list]) => `
    <h3 class="section-title">${title} <span class="count">${list.length}</span></h3>
    ${list.map((x) => renderTaskItem(x)).join('')}`).join('');
  return seg + (body || '<div class="empty">ไม่มีงานค้าง 🎉<br>พิมพ์งานในช่องด้านบน หรือกดปุ่ม ＋ เพื่อใส่รายละเอียด</div>');
}

// แตะวันที่ (หรือช่องเวลา) → เลือก "นัดหมายลูกค้า" หรือ "กิจกรรม" + ดูรายการของวันนั้น
function openDaySheet(date, time = '') {
  const events = time ? [] : eventsInRange(date, date);
  const conflicts = conflictIds(events);
  const title = `${fmtDayLong.format(parse(date))}${time ? ` · ${time} น.` : ''}`;
  openSheet(title, `
    <div class="add-two">
      <button type="button" data-action="choose-appt" data-date="${date}" data-time="${time}">
        <span class="add-icon appt">👤</span>นัดหมายลูกค้า
      </button>
      <button type="button" data-action="choose-task" data-date="${date}" data-time="${time}">
        <span class="add-icon task">📝</span>กิจกรรม
      </button>
    </div>
    ${time ? '' : `
      <h3 class="section-title">รายการวันนี้ <span class="count">${events.length}</span></h3>
      ${events.length ? events.map((e) => renderEvent(e, { conflicts })).join('') : '<div class="empty">ยังไม่มีรายการ</div>'}`}`);
  if (!time) daySheetFor = date;
}

function openTaskForm(task = null, preset = {}) {
  const x = task || {
    title: preset.title || '', notes: '', type: preset.type || 'general', location: '',
    dueDate: preset.dueDate || '', dueTime: preset.dueTime || '', customerId: '', done: false,
  };
  const type = TASK_TYPES[x.type] ? x.type : 'general';
  const customers = [...state.customers.values()].sort((a, b) => (a.name || '').localeCompare(b.name || '', 'th'));
  const placeholders = {
    general: 'เช่น โทรตามเอกสารคุณสมชาย', meeting: 'เช่น ประชุมทีมประจำเดือน',
    errand: 'เช่น ไปธนาคาร / ไปสาขา', document: 'เช่น ส่งเอกสารเคลม',
  };
  openSheet(task ? 'แก้ไขกิจกรรม' : 'กิจกรรมใหม่', `
    <form id="task-form" class="form-grid" data-id="${task ? task.id : ''}" novalidate>
      <div>
        <label>ประเภท</label>
        <div class="type-chips">
          ${Object.entries(TASK_TYPES).map(([k, v]) => `<button type="button" data-action="task-type" data-v="${k}" class="${type === k ? 'active' : ''}">${v.icon} ${v.label}</button>`).join('')}
        </div>
        <input type="hidden" name="type" value="${type}">
      </div>
      <label>ต้องทำอะไร <span class="req">*</span><input name="title" value="${esc(x.title)}" placeholder="${placeholders[type]}"></label>
      <div class="field-row">
        <label>วันที่<input name="dueDate" type="date" value="${esc(x.dueDate)}"></label>
        <label>เวลา<input name="dueTime" type="time" value="${esc(x.dueTime)}"></label>
      </div>
      <label>สถานที่<input name="location" value="${esc(x.location)}" placeholder="เช่น สำนักงานสาขา / ธนาคารกรุงเทพ สีลม"></label>
      <label>โน้ต / รายละเอียด<textarea name="notes" rows="3" placeholder="จดรายละเอียดเพิ่มเติม">${esc(x.notes)}</textarea></label>
      <label>ลูกค้าที่เกี่ยวข้อง
        <select name="customerId">
          <option value="">— ไม่ระบุ —</option>
          ${customers.map((c) => `<option value="${c.id}" ${x.customerId === c.id ? 'selected' : ''}>${esc(c.name)}${c.phone ? ` (${esc(c.phone)})` : ''}</option>`).join('')}
        </select>
      </label>
      ${task ? `<label class="checkline"><input type="checkbox" name="done" ${x.done ? 'checked' : ''}> ทำเสร็จแล้ว</label>` : ''}
      <p class="hint">ถ้าใส่วันที่ งานจะขึ้นในปฏิทินและหน้าแจ้งเตือนด้วย</p>
      <p id="form-error" class="error" hidden></p>
      <div class="sheet-foot">
        ${task ? '<button type="button" class="btn danger" data-action="delete-task">ลบ</button>' : ''}
        <button type="submit" class="btn primary">บันทึก</button>
      </div>
    </form>`);
  if (!task) $('#task-form').elements.title.focus();
}

function saveTask(form) {
  const f = form.elements;
  const errEl = $('#form-error');
  const data = {
    title: f.title.value.trim(),
    notes: f.notes.value.trim(),
    type: f.type.value,
    location: f.location.value.trim(),
    dueDate: f.dueDate.value,
    dueTime: f.dueDate.value ? f.dueTime.value : '',
    customerId: f.customerId.value,
  };
  if (!data.title) { errEl.textContent = 'กรุณาพิมพ์ว่าต้องทำอะไร'; errEl.hidden = false; f.title.focus(); return; }
  const id = form.dataset.id;
  const done = id ? f.done.checked : false;
  if (!done && data.dueDate && data.dueTime && !confirmNoClash(data.dueDate, data.dueTime, id)) return;
  if (data.dueDate) state.selected = data.dueDate;
  if (id) {
    const prev = state.tasks.find((x) => x.id === id);
    write(updateDoc(doc(db, 'tasks', id), {
      ...data, done, ...(done !== !!prev?.done ? { doneAt: done ? serverTimestamp() : null } : {}), updatedAt: serverTimestamp(),
    }));
  } else {
    write(addDoc(collection(db, 'tasks'), { ...data, done: false, doneAt: null, createdAt: serverTimestamp(), updatedAt: serverTimestamp() }));
  }
  closeSheet();
  render();
  toast('บันทึกงานแล้ว');
}

/* ---------- สรุปแจ้งเตือน ---------- */
function renderSummary(s) {
  const section = (title, evs, emptyText) => `
    <h3 class="section-title">${title} <span class="count">${evs.length}</span></h3>
    ${evs.length ? evs.map((e) => renderEvent(e, { showDate: true })).join('') : `<div class="empty">${emptyText}</div>`}`;

  const perm = 'Notification' in self ? Notification.permission : 'unsupported';
  const pushOn = perm === 'granted' && localStorage.getItem('pushEnabled') === '1';
  const pushCard = `
    <div class="card">
      <strong>แจ้งเตือนบนมือถือเครื่องนี้</strong>
      <p class="hint">เด้งเตือนเวลา 18:00 ของวันก่อนนัด 1 วัน (อาจช้ากว่าเวลาจริงราว 5–15 นาที)</p>
      ${perm === 'unsupported'
        ? '<p class="error">เบราว์เซอร์นี้ไม่รองรับการแจ้งเตือน</p>'
        : perm === 'denied'
          ? '<p class="error">การแจ้งเตือนถูกปิดไว้ ให้เปิดในการตั้งค่าเบราว์เซอร์/แอป แล้วกลับมากดอีกครั้ง</p>'
          : pushOn
            ? '<p style="margin:8px 0 0;color:var(--done);font-weight:600">✓ เปิดแจ้งเตือนแล้ว</p><button class="btn small" style="margin-top:8px" data-action="test-push">ทดสอบแจ้งเตือนในเครื่อง</button>'
            : '<button class="btn primary" style="margin-top:8px" data-action="enable-push">เปิดแจ้งเตือน</button>'}
    </div>`;

  return `
    ${pushCard}
    ${section('เลยกำหนด', s.overdue, 'ไม่มีรายการค้าง 👍')}
    ${section('วันนี้', s.today, 'วันนี้ไม่มีรายการ')}
    ${section(`ใกล้ถึง (${UPCOMING_DAYS} วัน)`, s.upcoming, 'ไม่มีรายการในสัปดาห์นี้')}
    <div style="margin-top:28px;text-align:center">
      <button class="btn ghost" data-action="logout">ออกจากระบบ</button>
    </div>`;
}

/* ====================================================================
 * Bottom sheet
 * ==================================================================== */
const sheet = $('#sheet');
let detailOpenFor = null; // id ลูกค้าที่เปิดหน้ารายละเอียดอยู่ (ไว้รีเฟรชเมื่อข้อมูลเปลี่ยน)
let daySheetFor = null; // วันที่ที่เปิดหน้า "แตะวันที่" อยู่

function refreshOpenDetail() {
  if (sheet.open && daySheetFor) {
    const top = sheet.scrollTop;
    openDaySheet(daySheetFor);
    sheet.scrollTop = top;
    return;
  }
  if (!sheet.open || !detailOpenFor) return;
  if (!state.customers.has(detailOpenFor)) { closeSheet(); return; }
  const top = sheet.scrollTop;
  openCustomerDetail(detailOpenFor);
  sheet.scrollTop = top;
}

function openSheet(title, bodyHtml) {
  detailOpenFor = null;
  daySheetFor = null;
  sheet.innerHTML = `
    <div class="sheet-head">
      <h2>${title}</h2>
      <button class="btn ghost small" data-action="close-sheet" aria-label="ปิด">✕</button>
    </div>
    <div class="sheet-body">${bodyHtml}</div>`;
  if (!sheet.open) sheet.showModal();
  sheet.scrollTop = 0;
}
function closeSheet() { detailOpenFor = null; daySheetFor = null; if (sheet.open) sheet.close(); }
sheet.addEventListener('close', () => { detailOpenFor = null; daySheetFor = null; });
sheet.addEventListener('click', (e) => { if (e.target === sheet) closeSheet(); });

/* ---------- ฟอร์มนัดหมาย ---------- */
function customerFields(c = {}, prefix = '') {
  return `
    <div class="field-row">
      <label>ชื่อ-นามสกุล <span class="req">*</span><input name="${prefix}name" value="${esc(c.name)}" required></label>
      <label>เบอร์โทร <span class="req">*</span><input name="${prefix}phone" type="tel" inputmode="tel" value="${esc(c.phone)}" required></label>
    </div>
    <div class="field-row">
      <label>อายุ<input name="${prefix}age" type="number" inputmode="numeric" min="0" max="120" value="${esc(c.age)}"></label>
      <label>สถานะลูกค้า
        <select name="${prefix}status">
          ${Object.entries(CUSTOMER_STATUS).map(([k, v]) => `<option value="${k}" ${(c.status || 'prospect') === k ? 'selected' : ''}>${v}</option>`).join('')}
        </select>
      </label>
    </div>
    <label>ที่อยู่<textarea name="${prefix}address" rows="2">${esc(c.address)}</textarea></label>`;
}

function openApptForm(appt = null, preset = {}) {
  const a = appt || {
    date: preset.date || state.selected, time: preset.time || '', topic: TOPICS[0], location: '', notes: '', status: 'pending', customerId: preset.customerId || '',
  };
  // เรื่องที่พิมพ์เอง (ไม่อยู่ในรายการ) → เลือก "อื่นๆ" แล้วใส่ข้อความเดิมไว้ในช่องพิมพ์
  const customTopic = a.topic && !TOPICS.includes(a.topic) ? a.topic : '';
  const topicChoice = customTopic ? OTHER_TOPIC : (a.topic || TOPICS[0]);
  const picked = a.customerId && state.customers.get(a.customerId);
  const mode = picked || appt ? 'existing' : (state.customers.size ? 'existing' : 'new');

  openSheet(appt ? 'แก้ไขนัดหมาย' : 'นัดหมายใหม่', `
    <form id="appt-form" class="form-grid" data-id="${appt ? appt.id : ''}" novalidate>
      ${appt ? `
        <div>
          <label>สถานะนัด</label>
          <div class="status-row">
            ${Object.entries(APPT_STATUS).map(([k, v]) => `<button type="button" data-action="appt-status" data-v="${k}" class="${a.status === k ? 'active' : ''}">${v}</button>`).join('')}
          </div>
          <input type="hidden" name="status" value="${a.status}">
        </div>` : '<input type="hidden" name="status" value="pending">'}

      <div>
        <label>ลูกค้า <span class="req">*</span></label>
        <div class="switch2" style="margin-top:4px">
          <button type="button" data-action="cust-mode" data-v="existing" class="${mode === 'existing' ? 'active' : ''}">ลูกค้าในระบบ</button>
          <button type="button" data-action="cust-mode" data-v="new" class="${mode === 'new' ? 'active' : ''}">ลูกค้าใหม่</button>
        </div>
        <input type="hidden" name="custMode" value="${mode}">
        <input type="hidden" name="customerId" value="${esc(a.customerId || '')}">
        <div id="cust-existing" ${mode === 'existing' ? '' : 'hidden'} style="margin-top:8px">
          <div id="picked" class="picked" ${picked ? '' : 'hidden'}>
            <span><strong>${esc(picked?.name)}</strong><br>${telLink(picked?.phone)}</span>
            <button type="button" class="btn small" data-action="unpick">เปลี่ยน</button>
          </div>
          <div id="picker" ${picked ? 'hidden' : ''}>
            <input id="picker-q" type="search" placeholder="พิมพ์ชื่อหรือเบอร์เพื่อค้นหา" autocomplete="off">
            <div id="picker-results" class="picker-results"></div>
          </div>
        </div>
        <div id="cust-new" class="form-grid" ${mode === 'new' ? '' : 'hidden'} style="margin-top:8px">
          ${customerFields({}, 'new_')}
        </div>
      </div>

      <div class="field-row">
        <label>วันที่ <span class="req">*</span><input name="date" type="date" value="${esc(a.date)}" required></label>
        <label>เวลา <span class="req">*</span><input name="time" type="time" value="${esc(a.time)}" required></label>
      </div>
      <label>เรื่อง
        <select name="topic">${TOPICS.map((t) => `<option ${topicChoice === t ? 'selected' : ''}>${t}</option>`).join('')}</select>
      </label>
      <label id="topic-other" ${topicChoice === OTHER_TOPIC ? '' : 'hidden'}>ระบุเรื่อง <span class="req">*</span>
        <input name="topicOther" value="${esc(customTopic)}" placeholder="พิมพ์เรื่องที่นัด">
      </label>
      <label>สถานที่<input name="location" value="${esc(a.location)}" placeholder="เช่น ร้านกาแฟหน้าบริษัท / บ้านลูกค้า"></label>
      <label>หมายเหตุ<textarea name="notes" rows="3">${esc(a.notes)}</textarea></label>
      <p id="form-error" class="error" hidden></p>

      <div class="sheet-foot">
        ${appt ? '<button type="button" class="btn danger" data-action="delete-appt">ลบ</button>' : ''}
        <button type="submit" class="btn primary">บันทึก</button>
      </div>
    </form>`);
  renderPicker('');
}

function renderPicker(q) {
  const box = $('#picker-results');
  if (!box) return;
  const query = q.trim().toLowerCase();
  const digits = query.replace(/\D/g, '');
  let list = [...state.customers.values()];
  if (query) {
    list = list.filter((c) => (c.name || '').toLowerCase().includes(query)
      || (digits && (c.phone || '').replace(/\D/g, '').includes(digits)));
  }
  list.sort((a, b) => (a.name || '').localeCompare(b.name || '', 'th'));
  box.innerHTML = list.slice(0, 30).map((c) => `
    <button type="button" data-action="pick" data-id="${c.id}">
      <strong>${esc(c.name)}</strong> <small style="color:var(--muted)">${esc(c.phone)}</small>
    </button>`).join('') || `<div class="empty">ไม่พบลูกค้า — กด "ลูกค้าใหม่" ด้านบนเพื่อเพิ่ม</div>`;
}

function readCustomerFields(form, prefix = '') {
  const v = (n) => (form.elements[prefix + n]?.value || '').trim();
  const age = v('age');
  return {
    name: v('name'),
    phone: v('phone'),
    age: age ? Number(age) : null,
    status: v('status') || 'prospect',
    address: v('address'),
  };
}

async function saveAppt(form) {
  const errEl = $('#form-error');
  const show = (m) => { errEl.textContent = m; errEl.hidden = false; };
  errEl.hidden = true;
  const f = form.elements;
  const id = form.dataset.id;
  const data = {
    date: f.date.value,
    time: f.time.value,
    topic: f.topic.value === OTHER_TOPIC ? f.topicOther.value.trim() : f.topic.value,
    location: f.location.value.trim(),
    notes: f.notes.value.trim(),
    status: f.status.value,
  };
  let newCustomer = null;
  if (f.custMode.value === 'new') {
    newCustomer = readCustomerFields(form, 'new_');
    if (!newCustomer.name || !newCustomer.phone) return show('กรุณากรอกชื่อและเบอร์โทรของลูกค้าใหม่');
  } else if (!f.customerId.value) {
    return show('กรุณาเลือกลูกค้า');
  }
  if (!data.date || !data.time) return show('กรุณาเลือกวันที่และเวลา');
  if (!data.topic) { f.topicOther.focus(); return show('กรุณาพิมพ์เรื่องที่นัด'); }

  if (data.status === 'pending' && !confirmNoClash(data.date, data.time, id)) return;

  if (newCustomer) {
    const ref = doc(collection(db, 'customers'));
    write(setDoc(ref, {
      ...newCustomer, notes: '', nextContactDate: '', premiumStartDate: '', premiumFrequency: '', paidDues: [],
      createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
    }));
    data.customerId = ref.id;
    data.customerName = newCustomer.name;
  } else {
    data.customerId = f.customerId.value;
    data.customerName = state.customers.get(data.customerId)?.name || '';
  }
  if (id) {
    write(updateDoc(doc(db, 'appointments', id), { ...data, updatedAt: serverTimestamp() }));
  } else {
    write(addDoc(collection(db, 'appointments'), { ...data, createdAt: serverTimestamp(), updatedAt: serverTimestamp() }));
  }
  state.selected = data.date;
  closeSheet();
  render();
  toast(newCustomer ? 'บันทึกนัดหมายและเพิ่มลูกค้าใหม่แล้ว' : 'บันทึกนัดหมายแล้ว');
}

/* ---------- ลูกค้า: รายละเอียด / ฟอร์ม ---------- */
function openCustomerDetail(id) {
  const c = state.customers.get(id);
  if (!c) return;
  const t = todayStr();
  const next = nextPremiumDue(c);
  const recentDues = premiumDuesInRange(c, overdueFrom(c), next || t);
  const appts = state.appointments.filter((a) => a.customerId === id).sort((a, b) => (b.date + b.time).localeCompare(a.date + a.time));

  const dues = recentDues.map((due) => {
    const paid = isPaid(c, due);
    return `
      <div class="item premium ${paid ? 'done' : ''}" style="cursor:default;align-items:center">
        <span class="body">
          <span class="title">${dateFull(due)}</span>
          <div class="sub">${paid ? 'ชำระแล้ว' : relDay(due)}</div>
        </span>
        <button class="btn small ${paid ? '' : 'primary'}" data-action="toggle-paid" data-id="${c.id}" data-due="${due}">${paid ? 'ยกเลิก' : 'ชำระแล้ว'}</button>
      </div>`;
  }).join('');

  openSheet(esc(c.name), `
    <div class="detail">
      <div class="detail-actions">
        ${c.phone ? `<a class="btn primary" href="${telHref(c.phone)}">📞 โทร</a>` : '<span></span>'}
        <button class="btn" data-action="new-appt-for" data-id="${c.id}">＋ นัดหมาย</button>
      </div>
      <div class="card">
        <dl>
          <dt>เบอร์โทร</dt><dd>${telLink(c.phone) || '-'}</dd>
          <dt>อายุ</dt><dd>${c.age ?? '-'}</dd>
          <dt>ที่อยู่</dt><dd>${esc(c.address) || '-'}</dd>
          <dt>สถานะ</dt><dd><span class="tag s-${c.status || 'prospect'}">${CUSTOMER_STATUS[c.status || 'prospect']}</span></dd>
          <dt>ติดต่อครั้งถัดไป</dt><dd>${c.nextContactDate ? `${dateFull(c.nextContactDate)} (${relDay(c.nextContactDate)})` : '-'}</dd>
          <dt>ชำระเบี้ย</dt><dd>${c.premiumStartDate && FREQ[c.premiumFrequency] ? `${FREQ[c.premiumFrequency].label} เริ่ม ${dateFull(c.premiumStartDate)}` : '-'}</dd>
          <dt>หมายเหตุ</dt><dd style="white-space:pre-wrap">${esc(c.notes) || '-'}</dd>
        </dl>
        ${c.nextContactDate ? `<button class="btn small" style="margin-top:12px" data-action="contacted" data-id="${c.id}">✓ ติดต่อแล้ว (ล้างวันติดต่อ)</button>` : ''}
      </div>

      ${dues ? `<h3 class="section-title">งวดเบี้ยประกัน</h3>${dues}` : ''}

      <h3 class="section-title">ประวัตินัดหมาย <span class="count">${appts.length}</span></h3>
      ${appts.length ? appts.map((a) => `
        <button class="item ${a.status}" data-action="edit-appt" data-id="${a.id}">
          <span class="body">
            <span class="title">${dateFull(a.date)} ${esc(a.time)}</span>
            <span class="tag a-${a.status}">${APPT_STATUS[a.status]}</span>
            <div class="sub">${esc(a.topic)}${a.location ? ` · ${esc(a.location)}` : ''}</div>
          </span>
        </button>`).join('') : '<div class="empty">ยังไม่มีนัดหมาย</div>'}

      <div class="sheet-foot">
        <button class="btn danger" data-action="delete-customer" data-id="${c.id}">ลบลูกค้า</button>
        <button class="btn primary" data-action="edit-customer" data-id="${c.id}">แก้ไขข้อมูล</button>
      </div>
    </div>`);
  detailOpenFor = id;
}

function openCustomerForm(c = null) {
  const x = c || {};
  openSheet(c ? 'แก้ไขข้อมูลลูกค้า' : 'ลูกค้าใหม่', `
    <form id="customer-form" class="form-grid" data-id="${c ? c.id : ''}" novalidate>
      ${customerFields(x)}
      <label>วันติดต่อครั้งถัดไป<input name="nextContactDate" type="date" value="${esc(x.nextContactDate)}"></label>
      <div class="card" style="margin:0">
        <strong>การชำระเบี้ยประกัน</strong>
        <p class="hint">ใส่วันชำระงวดแรกและความถี่ ระบบจะสร้างวันครบกำหนดงวดถัดไปบนปฏิทินให้เอง</p>
        <div class="field-row" style="margin-top:10px">
          <label>วันชำระงวดแรก<input name="premiumStartDate" type="date" value="${esc(x.premiumStartDate)}"></label>
          <label>งวดชำระ
            <select name="premiumFrequency">
              <option value="">ไม่ระบุ</option>
              ${Object.entries(FREQ).map(([k, v]) => `<option value="${k}" ${x.premiumFrequency === k ? 'selected' : ''}>${v.label}</option>`).join('')}
            </select>
          </label>
        </div>
      </div>
      <label>หมายเหตุ<textarea name="notes" rows="3">${esc(x.notes)}</textarea></label>
      <p id="form-error" class="error" hidden></p>
      <div class="sheet-foot">
        <button type="button" class="btn" data-action="${c ? 'view-customer' : 'close-sheet'}" data-id="${c ? c.id : ''}">ยกเลิก</button>
        <button type="submit" class="btn primary">บันทึก</button>
      </div>
    </form>`);
}

async function saveCustomer(form) {
  const errEl = $('#form-error');
  const show = (m) => { errEl.textContent = m; errEl.hidden = false; };
  errEl.hidden = true;
  const data = {
    ...readCustomerFields(form),
    nextContactDate: form.elements.nextContactDate.value,
    premiumStartDate: form.elements.premiumStartDate.value,
    premiumFrequency: form.elements.premiumFrequency.value,
    notes: form.elements.notes.value.trim(),
  };
  if (!data.name || !data.phone) return show('กรุณากรอกชื่อและเบอร์โทร');
  if (data.premiumFrequency && !data.premiumStartDate) return show('กรุณาใส่วันชำระงวดแรก');
  if (data.premiumStartDate && !data.premiumFrequency) return show('กรุณาเลือกงวดชำระ');

  const id = form.dataset.id;
  const dup = [...state.customers.values()].find((c) => c.id !== id
    && (c.phone || '').replace(/\D/g, '') === data.phone.replace(/\D/g, ''));
  if (dup && !confirm(`เบอร์นี้มีอยู่แล้ว (${dup.name}) ต้องการบันทึกต่อหรือไม่?`)) return;

  if (id) {
    write(updateDoc(doc(db, 'customers', id), { ...data, updatedAt: serverTimestamp() }));
    state.customers.set(id, { ...state.customers.get(id), ...data });
    openCustomerDetail(id);
    toast('บันทึกแล้ว');
  } else {
    const ref = doc(collection(db, 'customers'));
    write(setDoc(ref, { ...data, paidDues: [], createdAt: serverTimestamp(), updatedAt: serverTimestamp() }));
    state.customers.set(ref.id, { id: ref.id, ...data, paidDues: [] });
    openCustomerDetail(ref.id);
    toast('เพิ่มลูกค้าแล้ว');
  }
  render();
}

/* ====================================================================
 * Push notification (FCM)
 * ==================================================================== */
let foregroundListening = false;

async function getSwRegistration() {
  return navigator.serviceWorker.register('/firebase-messaging-sw.js');
}

async function registerPushToken() {
  if (!(await messagingSdk.isSupported())) throw new Error('unsupported');
  const reg = await getSwRegistration();
  await navigator.serviceWorker.ready;
  const messaging = messagingSdk.getMessaging(fbApp);
  const token = await messagingSdk.getToken(messaging, { serviceWorkerRegistration: reg });
  if (!token) throw new Error('no-token');
  const prev = localStorage.getItem('pushToken');
  if (prev && prev !== token) deleteDoc(doc(db, 'fcmTokens', prev)).catch(() => {});
  await setDoc(doc(db, 'fcmTokens', token), {
    token,
    device: navigator.userAgent.slice(0, 200),
    updatedAt: serverTimestamp(),
  });
  localStorage.setItem('pushToken', token);
  localStorage.setItem('pushEnabled', '1');
  if (foregroundListening) return;
  foregroundListening = true;
  // ตอนเปิดแอปอยู่ FCM จะไม่เด้งเอง ต้องแสดงเอง
  messagingSdk.onMessage(messaging, (payload) => {
    const n = payload.notification || {};
    reg.showNotification(n.title || 'แจ้งเตือน', { body: n.body, icon: '/icons/icon-192.png', data: payload.fcmOptions });
  });
}

async function enablePush() {
  try {
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') { toast('ไม่ได้อนุญาตการแจ้งเตือน'); render(); return; }
    await registerPushToken();
    toast('เปิดแจ้งเตือนแล้ว');
  } catch (err) {
    console.error(err);
    toast(err.message === 'unsupported' ? 'เครื่องนี้ไม่รองรับการแจ้งเตือน' : 'เปิดแจ้งเตือนไม่สำเร็จ ลองใหม่อีกครั้ง');
  }
  render();
}

async function refreshPushToken() {
  if ('serviceWorker' in navigator) getSwRegistration().catch(() => {});
  if (!('Notification' in self) || Notification.permission !== 'granted' || localStorage.getItem('pushEnabled') !== '1') return;
  try { await registerPushToken(); } catch (err) { console.warn('refresh push token failed', err); }
}

/* ====================================================================
 * Event delegation
 * ==================================================================== */
async function handleAction(el, e) {
  const { action, id } = el.dataset;
  switch (action) {
    case 'close-sheet': closeSheet(); break;
    case 'go-today': state.selected = todayStr(); render(); break;
    case 'cal-mode': state.calMode = el.dataset.mode; render(); break;
    case 'cal-prev':
    case 'cal-next': {
      const dir = action === 'cal-next' ? 1 : -1;
      if (state.calMode === 'month') state.selected = addMonthsClamped(state.selected, dir);
      else state.selected = addDays(state.selected, dir * (state.calMode === 'week' ? 7 : 1));
      render();
      break;
    }
    case 'select-day':
      state.selected = el.dataset.date;
      render();
      openDaySheet(el.dataset.date);
      break;
    case 'add-at': openDaySheet(el.dataset.date, el.dataset.time || ''); break;
    case 'choose-appt': openApptForm(null, { date: el.dataset.date, time: el.dataset.time }); break;
    case 'choose-task': openTaskForm(null, { dueDate: el.dataset.date, dueTime: el.dataset.time }); break;
    case 'task-type': {
      const form = $('#task-form');
      form.elements.type.value = el.dataset.v;
      form.querySelectorAll('.type-chips button').forEach((b) => b.classList.toggle('active', b === el));
      break;
    }
    case 'task-view': state.taskView = el.dataset.v; render(); break;
    case 'edit-task': {
      const task = state.tasks.find((x) => x.id === id);
      if (task) openTaskForm(task);
      break;
    }
    case 'toggle-task': {
      const task = state.tasks.find((x) => x.id === id);
      if (!task) break;
      const done = !task.done;
      write(updateDoc(doc(db, 'tasks', id), { done, doneAt: done ? serverTimestamp() : null, updatedAt: serverTimestamp() }));
      toast(done ? 'ทำเสร็จแล้ว ✓' : 'ย้ายกลับไปงานที่ยังไม่เสร็จ');
      break;
    }
    case 'delete-task': {
      if (!confirm('ลบงานนี้?')) return;
      write(deleteDoc(doc(db, 'tasks', $('#task-form').dataset.id)));
      closeSheet();
      toast('ลบงานแล้ว');
      break;
    }
    case 'new-appt-for': openApptForm(null, { customerId: id, date: state.selected >= todayStr() ? state.selected : todayStr() }); break;
    case 'edit-appt': {
      const a = state.appointments.find((x) => x.id === id);
      if (a) openApptForm(a);
      break;
    }
    case 'appt-status': {
      const form = $('#appt-form');
      form.elements.status.value = el.dataset.v;
      form.querySelectorAll('.status-row button').forEach((b) => b.classList.toggle('active', b === el));
      break;
    }
    case 'cust-mode': {
      const form = $('#appt-form');
      const v = el.dataset.v;
      form.elements.custMode.value = v;
      form.querySelectorAll('.switch2 button').forEach((b) => b.classList.toggle('active', b === el));
      $('#cust-existing').hidden = v !== 'existing';
      $('#cust-new').hidden = v !== 'new';
      if (v === 'new') form.elements.new_name.focus();
      break;
    }
    case 'pick': {
      const c = state.customers.get(id);
      const form = $('#appt-form');
      form.elements.customerId.value = id;
      $('#picked').querySelector('span').innerHTML = `<strong>${esc(c.name)}</strong><br>${telLink(c.phone)}`;
      $('#picked').hidden = false;
      $('#picker').hidden = true;
      break;
    }
    case 'unpick':
      $('#appt-form').elements.customerId.value = '';
      $('#picked').hidden = true;
      $('#picker').hidden = false;
      $('#picker-q').focus();
      break;
    case 'delete-appt': {
      const form = $('#appt-form');
      if (!confirm('ลบนัดหมายนี้?')) return;
      write(deleteDoc(doc(db, 'appointments', form.dataset.id)));
      closeSheet();
      toast('ลบแล้ว');
      break;
    }
    case 'view-customer': openCustomerDetail(id); break;
    case 'edit-customer': openCustomerForm(state.customers.get(id)); break;
    case 'delete-customer': {
      const c = state.customers.get(id);
      if (!confirm(`ลบลูกค้า "${c.name}"?\n(นัดหมายเดิมของลูกค้าจะยังอยู่ในปฏิทิน)`)) return;
      write(deleteDoc(doc(db, 'customers', id)));
      closeSheet();
      toast('ลบลูกค้าแล้ว');
      break;
    }
    case 'toggle-paid': {
      const c = state.customers.get(id);
      const due = el.dataset.due;
      const paid = isPaid(c, due);
      write(updateDoc(doc(db, 'customers', id), { paidDues: paid ? arrayRemove(due) : arrayUnion(due) }));
      c.paidDues = paid ? (c.paidDues || []).filter((d) => d !== due) : [...(c.paidDues || []), due];
      refreshOpenDetail();
      render();
      break;
    }
    case 'contacted':
      write(updateDoc(doc(db, 'customers', id), { nextContactDate: '', updatedAt: serverTimestamp() }));
      state.customers.get(id).nextContactDate = '';
      refreshOpenDetail();
      render();
      toast('บันทึกแล้ว');
      break;
    case 'cust-filter': state.custFilter = el.dataset.v; render(); break;
    case 'enable-push': enablePush(); break;
    case 'test-push': {
      const reg = await getSwRegistration();
      reg.showNotification('ทดสอบแจ้งเตือน', { body: 'ถ้าเห็นข้อความนี้ แปลว่าเครื่องนี้แสดงแจ้งเตือนได้', icon: '/icons/icon-192.png' });
      break;
    }
    case 'logout':
      if (confirm('ออกจากระบบ?')) await signOut(auth);
      break;
    case 'logout-now': await signOut(auth); break;
    case 'retry-load':
      state.loadError = '';
      render();
      subscribeData();
      break;
    default:
      return;
  }
  e.preventDefault();
}

document.addEventListener('click', (e) => {
  if (e.target.closest('[data-stop]')) return; // ลิงก์โทรในรายการ
  const el = e.target.closest('[data-action]');
  if (el) handleAction(el, e);
});

document.querySelectorAll('.tabbar button').forEach((b) => b.addEventListener('click', () => {
  state.tab = b.dataset.tab;
  render();
  window.scrollTo(0, 0);
}));

$('#fab').addEventListener('click', () => {
  if (state.tab === 'customers') openCustomerForm();
  else if (state.tab === 'tasks') openTaskForm(null, { title: $('#task-quick')?.elements.title.value.trim() });
  else openDaySheet(todayStr());
});

document.addEventListener('input', (e) => {
  if (e.target.id === 'cust-search') {
    state.custQuery = e.target.value;
    $('#cust-results').innerHTML = renderCustomerList();
  } else if (e.target.id === 'picker-q') {
    renderPicker(e.target.value);
  }
});

document.addEventListener('change', (e) => {
  if (e.target.name !== 'topic' || !e.target.closest('#appt-form')) return;
  const form = e.target.form;
  const isOther = e.target.value === OTHER_TOPIC;
  $('#topic-other').hidden = !isOther;
  if (isOther) form.elements.topicOther.focus();
  if (e.target.value === WALK_IN && !form.elements.location.value.trim()) form.elements.location.value = 'สำนักงาน';
});

document.addEventListener('submit', (e) => {
  if (e.target.id === 'appt-form') { e.preventDefault(); saveAppt(e.target); }
  if (e.target.id === 'customer-form') { e.preventDefault(); saveCustomer(e.target); }
  if (e.target.id === 'task-form') { e.preventDefault(); saveTask(e.target); }
  if (e.target.id === 'task-quick') {
    e.preventDefault();
    const input = e.target.elements.title;
    const title = input.value.trim();
    if (!title) { input.focus(); return; }
    write(addDoc(collection(db, 'tasks'), {
      title, notes: '', type: 'general', location: '', dueDate: '', dueTime: '', customerId: '', done: false, doneAt: null,
      createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
    }));
    input.value = '';
    toast('เพิ่มงานแล้ว');
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.matches('.item[role=button]')) e.target.click();
});

// ตอนเปิดแอปค้างไว้ข้ามวัน ให้ "วันนี้" อัปเดต
document.addEventListener('visibilitychange', () => { if (!document.hidden) render(); });
