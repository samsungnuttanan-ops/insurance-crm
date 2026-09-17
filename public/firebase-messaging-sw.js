/* Service worker: รับ Push จาก Firebase Cloud Messaging + เก็บไฟล์แอปไว้ใช้ตอนเน็ตไม่ดี */
importScripts('/config.js');
importScripts(`https://www.gstatic.com/firebasejs/${self.FIREBASE_SDK_VERSION}/firebase-app-compat.js`);
importScripts(`https://www.gstatic.com/firebasejs/${self.FIREBASE_SDK_VERSION}/firebase-messaging-compat.js`);

firebase.initializeApp(self.FIREBASE_CONFIG);
// ข้อความที่มี notification จะถูกแสดงอัตโนมัติโดย SDK (รวมถึงลิงก์เมื่อกด)
firebase.messaging();

const CACHE = 'insurance-crm-v12';
const APP_SHELL = ['/', '/index.html', '/styles.css', '/app.js', '/config.js', '/manifest.webmanifest', '/icons/icon-192.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(APP_SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // ไฟล์ SDK ของ Firebase (มีเลขเวอร์ชันใน URL ไม่เปลี่ยน) → ใช้ cache ก่อน
  if (url.origin === 'https://www.gstatic.com' && url.pathname.startsWith('/firebasejs/')) {
    event.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
      return res;
    })));
    return;
  }

  if (url.origin !== self.location.origin || url.pathname.startsWith('/__/')) return;

  // ไฟล์ของแอป → ดึงจากเน็ตก่อน (ได้เวอร์ชันล่าสุด) ถ้าไม่มีเน็ตใช้ของใน cache
  event.respondWith(fetch(req).then((res) => {
    if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
    return res;
  }).catch(async () => (await caches.match(req, { ignoreSearch: true }))
    || (req.mode === 'navigate' ? caches.match('/index.html') : Response.error())));
});
