// Auth จำลอง: กดเข้าสู่ระบบด้วยค่าอะไรก็ได้ (ใช้ทดสอบหน้าจอเท่านั้น)
const listeners = new Set();
let current = sessionStorage.getItem('mockUser') ? { uid: 'mock', email: sessionStorage.getItem('mockUser') } : null;
const emit = () => listeners.forEach((cb) => cb(current));

export function getAuth() { return {}; }
export function onAuthStateChanged(_auth, cb) { listeners.add(cb); setTimeout(() => cb(current), 50); return () => listeners.delete(cb); }
export async function signInWithEmailAndPassword(_auth, email) {
  current = { uid: 'mock', email };
  sessionStorage.setItem('mockUser', email);
  emit();
}
export async function signOut() { current = null; sessionStorage.removeItem('mockUser'); emit(); }
