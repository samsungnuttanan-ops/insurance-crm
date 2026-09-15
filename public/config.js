// ค่าเชื่อมต่อ Firebase (ค่านี้เปิดเผยได้ ความปลอดภัยอยู่ที่ firestore.rules + การล็อกอิน)
// ไฟล์นี้ถูกโหลดทั้งจากหน้าเว็บและจาก service worker
self.FIREBASE_CONFIG = {
  apiKey: 'AIzaSyDdehVJT-FAqC83CZpYwylbApxBH-L259M',
  authDomain: 'insurance-crm-8jwsv.firebaseapp.com',
  projectId: 'insurance-crm-8jwsv',
  storageBucket: 'insurance-crm-8jwsv.firebasestorage.app',
  messagingSenderId: '1041583696708',
  appId: '1:1041583696708:web:d06a9216ae785bcaa88511',
};
self.FIREBASE_SDK_VERSION = '12.19.0';
// ชื่อผู้ใช้จะถูกแปลงเป็นอีเมล <ชื่อผู้ใช้>@crm.local สำหรับ Firebase Auth
self.LOGIN_EMAIL_DOMAIN = 'crm.local';
