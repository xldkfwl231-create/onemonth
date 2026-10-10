export const VERSION = 3;
export const uid = () => crypto.randomUUID();
export const now = () => new Date().toISOString();
export const emptyProfile = () => ({ catName: '', tone: 'we', aiConsentAt: '' });
export const emptyState = () => ({ version: VERSION, profile: emptyProfile(), books: [], thoughts: [], moments: [], readings: {}, extraScales: [] });
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
  if (p.version != null && ![2, VERSION].includes(p.version)) throw new Error('지원하지 않는 백업 버전입니다.');
  if (!['books', 'thoughts', 'trips'].some(k => Array.isArray(p[k]))) throw new Error('기록 목록을 찾을 수 없습니다.');
  const modern = p.version >= 2, v3 = p.version === VERSION;   // 책·생각 구조는 버전 2부터 같습니다
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
  // 버전 2까지의 '다녀온 자리'는 장소가 붙은 순간으로 옮깁니다.
  const trips = v3 ? [] : list(p.trips, '여행', true).map(t => { row(t); return { id: id(t.id), createdAt: text(t.createdAt, '날짜', 100, true), text: text(modern ? t.text : t.n, '여행 기록'), energy: '', with: '', chosen: '', place: text(modern ? t.place : t.p, '장소', 500), from: 'self' }; });
  const pick = (v, allowed, label) => { if (v == null || v === '') return ''; if (!allowed.includes(v)) throw new Error(`${label} 값이 올바르지 않습니다.`); return v; };
  const moments = !v3 ? trips : list(p.moments, '순간').map(m => { row(m); return { id: id(m.id), createdAt: text(m.createdAt, '날짜', 100, true), text: text(m.text, '순간'), energy: pick(m.energy, ENERGY.map(o => o[0]), '기운'), with: pick(m.with, WITH.map(o => o[0]), '누구와'), chosen: pick(m.chosen, CHOSEN.map(o => o[0]), '골랐나'), place: text(m.place, '장소', 500, true), from: m.from === 'cat' ? 'cat' : 'self' }; });
  let profile = emptyProfile();
  if (v3) { const q = row(p.profile); profile = { catName: text(q.catName, '고양이 이름', 30, true), tone: q.tone === 'you' ? 'you' : 'we', aiConsentAt: text(q.aiConsentAt, '동의 시각', 100, true) }; }
  const readings = v3 && object(p.readings) ? structuredClone(p.readings) : {};
  const extraScales = v3 && Array.isArray(p.extraScales) ? structuredClone(p.extraScales) : [];
  return { version: VERSION, profile, books, thoughts, moments, readings, extraScales };
}
export function backup(state) { return JSON.stringify({ format: 'reading-notebook', exportedAt: now(), data: normalize(state) }, null, 2); }
export function stats(s) { return { books: s.books.length, entries: s.books.reduce((n, b) => n + b.entries.length, 0), questions: s.books.reduce((n, b) => n + b.questions.length, 0), thoughts: s.thoughts.length, moments: s.moments.length }; }
export function matchesBook(b, query) {
  const q = query.trim().toLocaleLowerCase();
  return !q || [b.title, b.author, b.publisher, b.isbn, ...b.entries.flatMap(e => [e.text, e.note, e.page]), ...b.questions.flatMap(e => [e.text, e.answer])].some(t => t.toLocaleLowerCase().includes(q));
}
// 같은 날(이 기기 시간 기준) 남긴 기록을 한 묶음으로. 이전 기록의 '8/1'은 그대로 씁니다.
export function dayKey(value) {
  if (!value || /^\d{1,2}\/\d{1,2}$/.test(value)) return value || '';
  const d = new Date(value);
  if (Number.isNaN(+d)) return value;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
export function dateLabel(value) {
  if (!value) return '날짜 미기록';
  if (/^\d{1,2}\/\d{1,2}$/.test(value)) return `${value} · 이전 기록`;
  const d = new Date(value);
  return Number.isNaN(+d) ? value : d.toLocaleDateString('ko-KR', { year: 'numeric', month: 'long', day: 'numeric' });
}

// ── 순간의 빠른 표시 · 고양이의 질문 ─────────────────────────
export const ENERGY = [['up', '↑ 났다'], ['flat', '→ 그대로'], ['down', '↓ 빠졌다']];
export const WITH = [['alone', '혼자'], ['two', '둘이'], ['many', '여럿']];
export const CHOSEN = [['chose', '골랐다'], ['drift', '어쩌다 보니'], ['must', '해야 해서']];
const PROMPTS = [
  ['오늘 시간이 가장 빨리 간 순간은 언제였지?', '오늘 시간이 가장 빨리 간 순간은 언제였어?'],
  ['오늘 가장 미룬 일은 뭐였지? 대신 뭘 했더라?', '오늘 가장 미룬 일은 뭐였어? 대신 뭘 했어?'],
  ['오늘 기운을 가장 많이 빼 간 건 뭐였지?', '오늘 기운을 가장 많이 빼 간 건 뭐였어?'],
  ['오늘 꼬리가 가장 높이 섰던 순간은?', '오늘 꼬리가 가장 높이 섰던 순간은 언제였어?'],
  ['오늘 누가 시키지 않았는데 한 일이 있었나?', '오늘 누가 시키지 않았는데 한 일이 있었어?'],
  ['오늘 쇼츠나 SNS를 켠 건 어떤 때였지?', '오늘 쇼츠나 SNS를 켠 건 어떤 때였어?'],
  ['오늘 한 번 더 하고 싶은 일이 있었나?', '오늘 한 번 더 하고 싶은 일이 있었어?']
];
// 새벽 4시까지는 전날로 칩니다 — 자정 넘어 눕는 날도 같은 하루에 적히도록.
export function dayOf(date) { return dayKey(new Date(date.getTime() - 4 * 3600e3).toISOString()); }
export const isIso = v => /^\d{4}-\d\d-\d\dT/.test(v || '');

// 고양이가 먼저 건네는 말: 저녁에는 읽는 책의 문장을, 그 밖에는 하루 한 번 관찰 질문을. skipped = 오늘 넘어간 것.
export function nextQuestion(state, now = new Date(), skipped = []) {
  const date = dayOf(now), tone = state.profile.tone === 'you' ? 1 : 0;
  const today = v => isIso(v) && dayOf(new Date(v)) === date, evening = now.getHours() >= 18 || now.getHours() < 4;
  const book = [...state.books].reverse().find(b => b.status === 'reading');
  if (book && evening && !skipped.includes('book') && !book.entries.some(e => today(e.createdAt)))
    return { slot: 'book', title: '책', type: 'book', bookId: book.id, text: `『${book.title}』에서 오늘 머문 문장이 ${tone ? '있어?' : '있었나?'}` };
  if (!skipped.includes('prompt') && !state.moments.some(m => m.from === 'cat' && today(m.createdAt)))
    return { slot: 'prompt', title: '순간', type: 'moment', text: PROMPTS[Number(date.replaceAll('-', '')) % PROMPTS.length][tone] };
  return null;
}
