export const VERSION = 2;
export const uid = () => crypto.randomUUID();
export const now = () => new Date().toISOString();
export const emptyState = () => ({ version: VERSION, books: [], thoughts: [], trips: [] });
const object = v => v && typeof v === 'object' && !Array.isArray(v);
function text(v, label, max = 100000, optional = false) {
  if (v == null && optional) return '';
  if (typeof v !== 'string' || v.length > max) throw new Error(`${label} 형식이 맞지 않습니다.`);
  return v;
}
function list(v, label, optional = false) {
  if (v == null && optional) return [];
  if (!Array.isArray(v) || v.length > 50000) throw new Error(`${label} 목록이 올바르지 않습니다.`);
  return v;
}
function row(v) { if (!object(v)) throw new Error('기록 형식이 올바르지 않습니다.'); return v; }
export function safeCover(value) {
  if (!value) return '';
  if (typeof value !== 'string' || value.length > 2000000) throw new Error('표지 파일이 너무 크거나 올바르지 않습니다.');
  if (/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(value)) return value;
  try { const u = new URL(value); if (u.protocol === 'https:' && !u.username && !u.password) return u.href; } catch {}
  throw new Error('표지는 사진 또는 HTTPS 이미지 주소여야 합니다.');
}
// Legacy month/day dates are preserved, never assigned a guessed year.
export function normalize(input) {
  if (!object(input)) throw new Error('백업 파일 형식이 아닙니다.');
  const p = input.format === 'reading-notebook' ? input.data : input;
  if (!object(p)) throw new Error('백업 데이터가 없습니다.');
  if (p.version != null && p.version !== VERSION) throw new Error('지원하지 않는 백업 버전입니다.');
  if (!['books', 'thoughts', 'trips'].some(k => Array.isArray(p[k]))) throw new Error('기록 목록을 찾을 수 없습니다.');
  const modern = p.version === VERSION;
  const seen = new Set();
  function id(v) {
    const value = modern ? text(v, 'ID', 100) : uid();
    if (!value || seen.has(value)) throw new Error('중복되거나 비어 있는 기록 ID입니다.');
    seen.add(value); return value;
  }
  const books = list(p.books, '책', !modern).map(b => {
    row(b);
    const entries = modern ? list(b.entries, '문장') : (b.e != null ? list(b.e, '문장') : b.l ? [{ l: b.l, d: b.d || '' }] : []);
    const title = text(modern ? b.title : b.t, '책 제목', 500);
    if (!title.trim()) throw new Error('책 제목이 비어 있습니다.');
    const status = modern ? b.status : 'reading';
    if (!['reading', 'finished'].includes(status)) throw new Error('독서 상태가 올바르지 않습니다.');
    return {
      id: id(b.id), title, author: text(b.author, '저자', 1000, true), publisher: text(b.publisher, '출판사', 500, true),
      isbn: text(b.isbn, 'ISBN', 100, true), cover: modern ? safeCover(b.cover) : '',
      color: ['forest', 'clay', 'blue', 'sand'].includes(b.color) ? b.color : 'forest', status,
      createdAt: text(modern ? b.createdAt : b.s || b.d, '날짜', 100, true), finishedAt: text(b.finishedAt, '완독일', 100, true),
      entries: entries.map(e => { row(e); return { id: id(e.id), text: text(modern ? e.text : e.l, '문장'), page: text(e.page, '페이지', 50, true), note: text(e.note, '내 생각', 100000, true), createdAt: text(modern ? e.createdAt : e.d, '날짜', 100, true) }; }),
      questions: list(b.questions, '질문', !modern).map(q => { row(q); return { id: id(q.id), text: text(q.text, '질문'), answer: text(q.answer, '답변', 100000, true), createdAt: text(q.createdAt, '날짜', 100, true), answeredAt: text(q.answeredAt, '답변일', 100, true) }; })
    };
  });
  const thoughts = list(p.thoughts, '생각', !modern).map(t => { row(t); return { id: id(t.id), text: text(modern ? t.text : t.t, '생각'), createdAt: text(modern ? t.createdAt : t.d, '날짜', 100, true) }; });
  const trips = list(p.trips, '여행', !modern).map(t => { row(t); return { id: id(t.id), place: text(modern ? t.place : t.p, '장소', 500), text: text(modern ? t.text : t.n, '여행 기록'), createdAt: text(t.createdAt, '날짜', 100, true) }; });
  return { version: VERSION, books, thoughts, trips };
}
export function backup(state) { return JSON.stringify({ format: 'reading-notebook', exportedAt: now(), data: normalize(state) }, null, 2); }
export function stats(s) { return { books: s.books.length, entries: s.books.reduce((n, b) => n + b.entries.length, 0), questions: s.books.reduce((n, b) => n + b.questions.length, 0), thoughts: s.thoughts.length, trips: s.trips.length }; }
export function matchesBook(b, query) {
  const q = query.trim().toLocaleLowerCase();
  return !q || [b.title, b.author, b.publisher, b.isbn, ...b.entries.flatMap(e => [e.text, e.note, e.page]), ...b.questions.flatMap(e => [e.text, e.answer])].some(t => t.toLocaleLowerCase().includes(q));
}
export function dateLabel(value) {
  if (!value) return '날짜 미기록';
  if (/^\d{1,2}\/\d{1,2}$/.test(value)) return `${value} · 이전 기록`;
  const d = new Date(value);
  return Number.isNaN(+d) ? value : d.toLocaleDateString('ko-KR', { year: 'numeric', month: 'long', day: 'numeric' });
}
