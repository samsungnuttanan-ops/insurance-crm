// เซิร์ฟเวอร์ทดสอบหน้าตาแอปในเครื่อง โดยใช้ Firebase จำลอง (ไม่แตะข้อมูลจริง)
// รัน: node dev/serve.mjs  แล้วเปิด http://localhost:5178
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT || 5178);
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png',
};

http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  let file;
  if (url.pathname.startsWith('/dev-mock/')) file = path.join(root, 'dev', 'mock', url.pathname.slice('/dev-mock/'.length));
  else file = path.join(root, 'public', url.pathname === '/' ? 'index.html' : url.pathname);
  if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); res.end('not found'); return;
  }
  let body = fs.readFileSync(file);
  if (url.pathname === '/config.js') body = `${body}\nself.FIREBASE_SDK_BASE = '/dev-mock';\n`;
  // ไม่ลง service worker ตอนทดสอบ (กัน cache ค้าง)
  if (url.pathname === '/firebase-messaging-sw.js') body = 'self.addEventListener("install", () => self.skipWaiting());';
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  res.end(body);
}).listen(PORT, () => console.log(`dev server http://localhost:${PORT}`));
