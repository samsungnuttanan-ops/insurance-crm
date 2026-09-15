// Firestore จำลอง (เก็บใน localStorage ของเบราว์เซอร์) พร้อมข้อมูลตัวอย่าง
const KEY = 'mockFirestore';
const pad = (n) => String(n).padStart(2, '0');
const day = (offset) => { const d = new Date(); d.setDate(d.getDate() + offset); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };

function seed() {
  const customers = {
    c1: { name: 'สมชาย ใจดี', phone: '081-234-5678', age: 42, address: 'บางนา กรุงเทพฯ', status: 'customer', notes: 'สนใจแผนสะสมทรัพย์เพิ่ม', nextContactDate: day(-2), premiumStartDate: day(-365 + 3), premiumFrequency: 'annual', paidDues: [] },
    c2: { name: 'สุดา พรมมา', phone: '089-111-2222', age: 35, address: '', status: 'contacted', notes: '', nextContactDate: day(4), premiumStartDate: day(-60), premiumFrequency: 'monthly', paidDues: [] },
    c3: { name: 'วิชัย ทองดี', phone: '062-333-4444', age: null, address: 'เชียงใหม่', status: 'prospect', notes: 'แนะนำโดยคุณสมชาย', nextContactDate: '', premiumStartDate: '', premiumFrequency: '', paidDues: [] },
  };
  const appointments = {
    a1: { date: day(0), time: '10:00', customerId: 'c1', customerName: 'สมชาย ใจดี', topic: 'เสนอแบบประกัน', location: 'ร้านกาแฟหน้าบริษัท', notes: '', status: 'pending' },
    a2: { date: day(0), time: '10:30', customerId: 'c2', customerName: 'สุดา พรมมา', topic: 'เซ็นสัญญา', location: 'บ้านลูกค้า', notes: '', status: 'pending' },
    a3: { date: day(1), time: '14:00', customerId: 'c3', customerName: 'วิชัย ทองดี', topic: 'ติดตาม', location: '', notes: '', status: 'pending' },
    a4: { date: day(-3), time: '09:00', customerId: 'c2', customerName: 'สุดา พรมมา', topic: 'เก็บเบี้ย', location: '', notes: '', status: 'pending' },
    a5: { date: day(-1), time: '16:00', customerId: 'c1', customerName: 'สมชาย ใจดี', topic: 'ติดตาม', location: '', notes: '', status: 'done' },
  };
  const tasks = {
    t1: { title: 'เตรียมเอกสารเคลม คุณสมชาย', notes: 'ใบรับรองแพทย์ + สำเนาบัตร', dueDate: day(0), dueTime: '15:00', customerId: 'c1', done: false, doneAt: null, createdAt: new Date().toISOString() },
    t2: { title: 'ส่งใบเสนอราคาให้คุณวิชัย', notes: '', dueDate: day(-1), dueTime: '', customerId: 'c3', done: false, doneAt: null, createdAt: new Date().toISOString() },
    t3: { title: 'ซื้อแฟ้มเอกสาร', notes: '', dueDate: '', dueTime: '', customerId: '', done: false, doneAt: null, createdAt: new Date().toISOString() },
    t4: { title: 'อัปเดตรายชื่อลูกค้าเดือนนี้', notes: '', dueDate: day(-2), dueTime: '', customerId: '', done: true, doneAt: new Date().toISOString(), createdAt: new Date().toISOString() },
  };
  return { customers, appointments, tasks, fcmTokens: {} };
}

let store;
try { store = JSON.parse(localStorage.getItem(KEY)) || seed(); } catch { store = seed(); }
const listeners = {};
const save = () => localStorage.setItem(KEY, JSON.stringify(store));
function emit(name) {
  const snap = { docs: Object.entries(store[name] || {}).map(([id, data]) => ({ id, data: () => structuredClone(data) })) };
  (listeners[name] || new Set()).forEach((cb) => setTimeout(() => cb(snap), 0));
}
const newId = () => Math.random().toString(36).slice(2, 12);

export function initializeFirestore() { return {}; }
export function persistentLocalCache() { return {}; }
export function persistentMultipleTabManager() { return {}; }
export function collection(_db, name) { return { kind: 'col', name }; }
export function doc(a, name, id) {
  if (a.kind === 'col') return { kind: 'doc', name: a.name, id: name || newId() };
  return { kind: 'doc', name, id };
}
export function onSnapshot(ref, cb, onError) {
  // ทดสอบกรณีไม่มีสิทธิ์: localStorage.mockDeny = '1'
  if (localStorage.getItem('mockDeny') === '1') {
    setTimeout(() => onError?.(Object.assign(new Error('denied'), { code: 'permission-denied' })), 0);
    return () => {};
  }
  (listeners[ref.name] ||= new Set()).add(cb);
  emit(ref.name);
  return () => listeners[ref.name].delete(cb);
}
export function serverTimestamp() { return new Date().toISOString(); }
export function arrayUnion(...v) { return { __op: 'union', v }; }
export function arrayRemove(...v) { return { __op: 'remove', v }; }

async function commit(name) { save(); emit(name); await new Promise((r) => setTimeout(r, 30)); }
export async function setDoc(ref, data) { (store[ref.name] ||= {})[ref.id] = data; await commit(ref.name); }
export async function addDoc(col, data) { const ref = doc(col); await setDoc(ref, data); return ref; }
export async function deleteDoc(ref) { delete store[ref.name][ref.id]; await commit(ref.name); }
export async function updateDoc(ref, patch) {
  const cur = store[ref.name][ref.id];
  if (!cur) throw Object.assign(new Error('not found'), { code: 'not-found' });
  for (const [k, v] of Object.entries(patch)) {
    if (v && v.__op === 'union') cur[k] = [...new Set([...(cur[k] || []), ...v.v])];
    else if (v && v.__op === 'remove') cur[k] = (cur[k] || []).filter((x) => !v.v.includes(x));
    else cur[k] = v;
  }
  await commit(ref.name);
}
