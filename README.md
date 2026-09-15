# สมุดลูกค้าประกัน (insurance-crm)

แอป PWA สำหรับบันทึกลูกค้าประกันชีวิต นัดหมาย และวันครบกำหนดชำระเบี้ย ใช้ร่วมกัน 2 คน

- เว็บแอป: https://insurance-crm-8jwsv.web.app
- Firebase Console: https://console.firebase.google.com/project/insurance-crm-8jwsv

## ความสามารถ

| หน้า | รายละเอียด |
|---|---|
| ปฏิทิน | ดูแบบ เดือน / สัปดาห์ / วัน · เพิ่มนัดได้ทั้งลูกค้าในระบบและลูกค้าใหม่ · เตือนเวลาชน (ห่างกันไม่ถึง 60 นาที) · แสดงวันครบกำหนดเบี้ย และวันติดต่อลูกค้า |
| ลูกค้า | ชื่อ\*, เบอร์\*, อายุ, ที่อยู่, สถานะ, วันติดต่อครั้งถัดไป, วันชำระเบี้ยงวดแรก + งวด (วนซ้ำอัตโนมัติ), หมายเหตุ · ค้นหาชื่อ/เบอร์ · กดโทรออก · ติ๊กงวดที่ชำระแล้ว |
| แจ้งเตือน | รายการ เลยกำหนด / วันนี้ / ใกล้ถึง 7 วัน · ปุ่มเปิด Push บนมือถือ |
| Push | GitHub Actions ส่งเตือนนัดของ "พรุ่งนี้" ทุกวันราว 18:00 |

## โครงสร้าง

```
public/                     ← ไฟล์เว็บที่ deploy ขึ้น Firebase Hosting
  index.html, styles.css, app.js
  config.js                 ← ค่าเชื่อมต่อ Firebase
  firebase-messaging-sw.js  ← service worker (Push + ใช้งานตอนเน็ตไม่ดี)
  manifest.webmanifest, icons/
firestore.rules             ← สิทธิ์ข้อมูล (ต้องล็อกอินเท่านั้น)
scripts/send-reminders.mjs  ← ตัวส่ง Push (รันบน GitHub Actions)
.github/workflows/reminders.yml
dev/                        ← ทดสอบหน้าจอในเครื่องด้วย Firebase จำลอง (ไม่ถูก deploy)
tools/make_icons.py         ← สร้างไอคอนแอป
```

ข้อมูลใน Firestore: `customers`, `appointments`, `fcmTokens` (เครื่องที่เปิดแจ้งเตือน)

## ขั้นตอนตั้งค่าที่ต้องทำเอง (ครั้งเดียว)

### 1) สร้างชื่อผู้ใช้ + รหัสผ่าน

1. เปิด https://console.firebase.google.com/project/insurance-crm-8jwsv/authentication/users
2. กด **Add user**
3. Email: `ชื่อผู้ใช้@crm.local` เช่น `baan@crm.local` (ตอนล็อกอินในแอปพิมพ์แค่ `baan`)
4. Password: ตั้งเอง (อย่างน้อย 6 ตัว) → **Add user**

> ระบบปิดการสมัครสมาชิกเองไว้แล้ว เพิ่มผู้ใช้ได้จาก Console เท่านั้น

### 2) ติดตั้งแอปบนมือถือ Android (ทั้ง 2 เครื่อง)

1. เปิด https://insurance-crm-8jwsv.web.app ด้วย Chrome
2. เมนู ⋮ → **ติดตั้งแอป / เพิ่มลงในหน้าจอหลัก**
3. เปิดแอป → ล็อกอิน → แท็บ **แจ้งเตือน** → กด **เปิดแจ้งเตือน** → อนุญาต

### 3) เปิด Push อัตโนมัติ 18:00 (GitHub Actions)

1. สร้าง repo ใหม่แบบ **Private** ชื่อ `insurance-crm` บน GitHub (ไม่ต้องติ๊กสร้าง README)
2. push โค้ดขึ้นไป:
   ```bash
   git remote add origin https://github.com/<ชื่อ GitHub>/insurance-crm.git
   git push -u origin main
   ```
3. สร้างกุญแจ service account:
   Firebase Console → ⚙️ Project settings → **Service accounts** → **Generate new private key** (ได้ไฟล์ .json — ห้ามส่งให้ใคร ห้าม commit)
4. GitHub repo → **Settings → Secrets and variables → Actions → New repository secret**
   - Name: `FIREBASE_SERVICE_ACCOUNT`
   - Secret: เปิดไฟล์ .json แล้วคัดลอกเนื้อหาทั้งหมดมาวาง
5. ลบไฟล์ .json ในเครื่องทิ้งได้เลย
6. ทดสอบ: แท็บ **Actions → แจ้งเตือนนัดพรุ่งนี้ → Run workflow** (ใส่วันที่ที่มีนัด เช่น `2026-09-16`)

## คำสั่งที่ใช้บ่อย

```bash
# deploy เว็บ + กฎ Firestore
firebase deploy --only hosting,firestore

# ทดสอบหน้าจอในเครื่อง (ข้อมูลจำลอง ไม่แตะข้อมูลจริง) → http://localhost:5178
node dev/serve.mjs
```

เมื่อแก้ไฟล์ใน `public/` แล้ว deploy ให้เปลี่ยน `CACHE` ใน `firebase-messaging-sw.js` (เช่น `v2`) เพื่อให้มือถือโหลดไฟล์ใหม่

## ข้อจำกัดของแพ็กเกจฟรี (Spark)

- Firestore: อ่าน 50,000 / เขียน 20,000 ครั้งต่อวัน — ใช้ 2 คนเหลือเฟือ
- Hosting: 10 GB พื้นที่, 360 MB/วัน
- GitHub Actions (private repo): 2,000 นาที/เดือน — งานนี้ใช้ราว 30 นาที/เดือน
- เวลาเตือนอาจช้ากว่า 18:00 ราว 5–15 นาที (บางวันอาจมากกว่านั้นถ้า GitHub คิวแน่น)
