// ส่ง Push แจ้งเตือนนัดหมาย "พรุ่งนี้" ไปยังมือถือทุกเครื่องที่เปิดแจ้งเตือนไว้
// รันโดย GitHub Actions ทุกวันราว 18:00 (เวลาไทย)
//
// env:
//   FIREBASE_SERVICE_ACCOUNT  JSON ของ service account (จำเป็น)
//   REMIND_DATE               YYYY-MM-DD ถ้าต้องการทดสอบวันอื่น (ไม่บังคับ)
//   DRY_RUN=1                 แสดงข้อความแต่ไม่ส่งจริง
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { getMessaging } from 'firebase-admin/messaging';

const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
if (!raw) {
  console.error('Missing FIREBASE_SERVICE_ACCOUNT');
  process.exit(1);
}
const serviceAccount = JSON.parse(raw);
initializeApp({ credential: cert(serviceAccount) });
const db = getFirestore();
const projectId = serviceAccount.project_id;

function tomorrowInBangkok() {
  const bangkokNow = new Date(Date.now() + 7 * 3600 * 1000);
  bangkokNow.setUTCDate(bangkokNow.getUTCDate() + 1);
  return bangkokNow.toISOString().slice(0, 10);
}

const date = (process.env.REMIND_DATE || '').trim() || tomorrowInBangkok();
if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
  console.error(`Invalid REMIND_DATE: ${date}`);
  process.exit(1);
}

const apptSnap = await db.collection('appointments').where('date', '==', date).get();
const appts = apptSnap.docs
  .map((d) => ({ id: d.id, ...d.data() }))
  .filter((a) => (a.status || 'pending') === 'pending')
  .sort((a, b) => (a.time || '').localeCompare(b.time || ''));

const TASK_ICONS = { general: '📌', meeting: '👥', errand: '🚗', document: '📄' };
const taskSnap = await db.collection('tasks').where('dueDate', '==', date).get();
const tasks = taskSnap.docs
  .map((d) => ({ id: d.id, ...d.data() }))
  .filter((t) => !t.done);

console.log(`Date ${date}: ${appts.length} pending appointment(s), ${tasks.length} task(s)`);
if (appts.length === 0 && tasks.length === 0) process.exit(0);

const customerIds = [...new Set(appts.map((a) => a.customerId).filter(Boolean))];
const customerDocs = customerIds.length
  ? await db.getAll(...customerIds.map((id) => db.collection('customers').doc(id)))
  : [];
const names = new Map(customerDocs.filter((d) => d.exists).map((d) => [d.id, d.data().name]));

const entries = [
  ...appts.map((a) => {
    const who = names.get(a.customerId) || a.customerName || 'ลูกค้า';
    const where = a.location ? ` @ ${a.location}` : '';
    return { time: a.time || '', text: `${a.time || '--:--'} 👤 ${who} – ${a.topic || 'นัดหมาย'}${where}` };
  }),
  ...tasks.map((t) => {
    const where = t.location ? ` @ ${t.location}` : '';
    return { time: t.dueTime || '', text: `${t.dueTime || 'ทั้งวัน'} ${TASK_ICONS[t.type] || '📌'} ${t.title}${where}` };
  }),
].sort((a, b) => (a.time || '99').localeCompare(b.time || '99'));
const lines = entries.map((e) => e.text);
const title = `พรุ่งนี้มี ${[appts.length ? `นัดลูกค้า ${appts.length}` : '', tasks.length ? `งาน ${tasks.length}` : ''].filter(Boolean).join(' · ')} รายการ`;
const body = lines.slice(0, 6).join('\n') + (lines.length > 6 ? `\n…และอีก ${lines.length - 6} รายการ` : '');
console.log(`${title}\n${body}`);

const tokenSnap = await db.collection('fcmTokens').get();
const tokens = tokenSnap.docs.map((d) => d.id);
console.log(`Devices: ${tokens.length}`);
if (tokens.length === 0 || process.env.DRY_RUN === '1') process.exit(0);

const res = await getMessaging().sendEachForMulticast({
  tokens,
  webpush: {
    notification: {
      title,
      body,
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      tag: `reminder-${date}`,
      renotify: true,
    },
    fcmOptions: { link: `https://${projectId}.web.app/?date=${date}` },
  },
});
console.log(`Sent: ${res.successCount} ok, ${res.failureCount} failed`);

// ลบ token ของเครื่องที่ถอนแอป/ปิดแจ้งเตือนไปแล้ว
const stale = [];
res.responses.forEach((r, i) => {
  if (r.success) return;
  const code = r.error?.code || '';
  console.warn(`  token ${i}: ${code} ${r.error?.message || ''}`);
  if (code === 'messaging/registration-token-not-registered' || code === 'messaging/invalid-registration-token') {
    stale.push(tokens[i]);
  }
});
await Promise.all(stale.map((t) => db.collection('fcmTokens').doc(t).delete()));
if (stale.length) console.log(`Removed ${stale.length} stale token(s)`);
