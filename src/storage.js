import { emptyState, normalize } from './core.js';
const DB = 'reading-notebook-v2';
export async function openStore() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore('records');
    r.onerror = () => reject(r.error);
    r.onsuccess = () => { r.result.onversionchange = () => r.result.close(); resolve(r.result); };
    r.onblocked = () => reject(new Error('다른 창의 기록장을 닫고 다시 열어주세요.'));
  });
}
function get(db, key) {
  return new Promise((resolve, reject) => {
    const r = db.transaction('records').objectStore('records').get(key);
    r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error);
  });
}
export async function load(db) {
  const current = await get(db, 'current');
  if (current) return { state: normalize(current.data), revision: current.revision, migrated: false };
  const raw = localStorage.getItem('onemonth_v1');
  const state = raw ? normalize(JSON.parse(raw)) : emptyState();
  // Preserve the untouched original in BOTH localStorage and the new database.
  const revision = await commit(db, state, 0, raw);
  return { state, revision, migrated: !!raw };
}
export async function commit(db, state, expectedRevision, legacy) {
  const clean = normalize(state);
  return new Promise((resolve, reject) => {
    const tx = db.transaction('records', 'readwrite');
    const store = tx.objectStore('records'); let conflict = false;
    const r = store.get('current');
    r.onsuccess = () => {
      const current = r.result;
      if ((current?.revision || 0) !== expectedRevision) { conflict = true; tx.abort(); return; }
      if (current) store.put(current, 'previous');
      if (legacy) store.put(legacy, 'legacy-original');
      store.put({ data: clean, revision: expectedRevision + 1 }, 'current');
    };
    tx.oncomplete = () => resolve(expectedRevision + 1);
    tx.onabort = () => reject(new Error(conflict ? '다른 창에서 기록이 바뀌었습니다. 작성 내용을 복사한 뒤 새로고침해주세요.' : '저장하지 못했습니다. 저장 공간과 브라우저 설정을 확인해주세요.'));
    tx.onerror = () => {};
  });
}
export async function previous(db) { const v = await get(db, 'previous'); return v ? normalize(v.data) : null; }
