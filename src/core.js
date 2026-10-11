export const VERSION = 3;
export const uid = () => crypto.randomUUID();
export const now = () => new Date().toISOString();
export const emptyProfile = () => ({ catName: '', tone: 'we', aiConsentAt: '' });
// AI 사용량 — 요청 종류별 호출 수와 토큰
export const emptyUsage = () => ({ since: '', calls: 0, input: 0, output: 0, byKind: {} });
export const emptyState = () => ({ version: VERSION, profile: emptyProfile(), books: [], thoughts: [], answers: [], moments: [], readings: {}, insights: null, chats: [], usage: emptyUsage(), extraScales: [] });
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
  // 이야기 끝에 기록 아래 덧붙인 말 (문장·생각)
  const more = v => list(v, '덧붙인 말', true).slice(-500).map(m => { row(m); return { id: id(m.id), text: text(m.text, '덧붙인 말'), createdAt: text(m.createdAt, '날짜', 100, true), chat: text(m.chat, '이야기', 100, true) }; });
  // 책 정리 — AI가 내 말로 만든 정리. 형식이 어긋나면 버립니다(다시 정리하면 됨)
  const summaryOf = v => {
    if (!object(v)) return null;
    const str = (x, n) => typeof x === 'string' ? x.slice(0, n) : '', arr = (x, f) => Array.isArray(x) ? x.slice(0, 8).map(f).filter(Boolean) : [];
    const pin = h => object(h) && typeof h.id === 'string' ? { id: h.id.slice(0, 100), why: str(h.why, 200) } : null;
    return { at: str(v.at, 40), n: Number.isFinite(v.n) && v.n >= 0 ? Math.round(v.n) : 0, line: str(v.line, 200), held: arr(v.held, pin), open: arr(v.open, pin), changed: arr(v.changed, c => object(c) && typeof c.then === 'string' && typeof c.now === 'string' ? { then: c.then.slice(0, 200), now: c.now.slice(0, 200) } : null) };
  };
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
      createdAt: text(modern ? b.createdAt : b.s || b.d, '날짜', 100, true), finishedAt: text(b.finishedAt, '완독일', 100, true), summary: summaryOf(b.summary),
      entries: entries.map(e => { row(e); return { id: id(e.id), text: text(modern ? e.text : e.l, '문장'), page: text(e.page, '페이지', 50, true), note: text(e.note, '메모', 100000, true), more: more(e.more), createdAt: text(modern ? e.createdAt : e.d, '날짜', 100, true) }; }),
      questions: list(b.questions, '질문', !modern).map(q => { row(q); return { id: id(q.id), text: text(q.text, '질문'), answer: text(q.answer, '답변', 100000, true), createdAt: text(q.createdAt, '날짜', 100, true), answeredAt: text(q.answeredAt, '답변일', 100, true), from: text(q.from, '문장', 100, true), history: list(q.history, '예전 답', true).slice(-100).map(h => { row(h); return { text: text(h.text, '예전 답'), at: text(h.at, '날짜', 100, true) }; }) }; })
    };
  });
  const thoughts = list(p.thoughts, '생각', !modern).map(t => { row(t); return { id: id(t.id), text: text(modern ? t.text : t.t, '생각'), more: more(t.more), createdAt: text(modern ? t.createdAt : t.d, '날짜', 100, true) }; });
  // 버전 2까지의 '다녀온 자리'는 장소가 붙은 순간으로 옮깁니다.
  const trips = v3 ? [] : list(p.trips, '여행', true).map(t => { row(t); return { id: id(t.id), createdAt: text(t.createdAt, '날짜', 100, true), text: text(modern ? t.text : t.n, '여행 기록'), energy: '', with: '', chosen: '', place: text(modern ? t.place : t.p, '장소', 500), from: 'self' }; });
  const pick = (v, allowed, label) => { if (v == null || v === '') return ''; if (!allowed.includes(v)) throw new Error(`${label} 값이 올바르지 않습니다.`); return v; };
  const moments = !v3 ? trips : list(p.moments, '순간').map(m => { row(m); return { id: id(m.id), createdAt: text(m.createdAt, '날짜', 100, true), text: text(m.text, '순간'), energy: pick(m.energy, ENERGY.map(o => o[0]), '기운'), with: pick(m.with, WITH.map(o => o[0]), '누구와'), chosen: pick(m.chosen, CHOSEN.map(o => o[0]), '골랐나'), place: text(m.place, '장소', 500, true), from: m.from === 'cat' ? 'cat' : 'self' }; });
  let profile = emptyProfile();
  if (v3) { const q = row(p.profile); profile = { catName: text(q.catName, '고양이 이름', 30, true), tone: q.tone === 'you' ? 'you' : 'we', aiConsentAt: text(q.aiConsentAt, '동의 시각', 100, true) }; }
  // 슬라임의 질문에 한 답 — 생각(스스로 떠오른 것)과는 다른 갈래
  const answers = !v3 ? [] : list(p.answers, '답', true).map(a => { row(a); return { id: id(a.id), createdAt: text(a.createdAt, '날짜', 100, true), prompt: text(a.prompt, '질문', 500, true), text: text(a.text, '답'), more: more(a.more) }; });
  const readings = v3 && object(p.readings) ? structuredClone(p.readings) : {};
  // 슬라임의 하루 말 — AI가 만든 '그땐/지금은' 몇 줄과 오늘의 질문. 형식이 어긋나면 버립니다(다시 만들면 됨).
  const ins = v3 && object(p.insights) ? p.insights : null;
  const insights = ins && typeof ins.date === 'string' && Array.isArray(ins.lines) && typeof ins.question === 'string'
    ? { date: ins.date.slice(0, 10), at: text(ins.at, '날짜', 100, true), question: ins.question.slice(0, 120), lines: ins.lines.filter(l => object(l) && typeof l.text === 'string').slice(0, 6).map(l => ({ text: l.text.slice(0, 200), ids: Array.isArray(l.ids) ? l.ids.filter(x => typeof x === 'string').slice(0, 5) : [] })) }
    : null;
  const extraScales = v3 && Array.isArray(p.extraScales) ? structuredClone(p.extraScales) : [];
  // 슬라임과 나눈 이야기
  const chats = !v3 ? [] : list(p.chats, '이야기', true).map(c => {
    row(c); const t = object(c.topic) ? c.topic : {};
    return { id: id(c.id), createdAt: text(c.createdAt, '날짜', 100, true),
      topic: { kind: ['book', 'entry', 'question', 'thought', 'answer', 'free'].includes(t.kind) ? t.kind : 'free', ref: text(t.ref, '주제', 100, true), book: text(t.book, '주제', 100, true), title: text(t.title, '주제', 500, true) },
      usage: { input: object(c.usage) && Number.isFinite(c.usage.input) && c.usage.input >= 0 ? Math.round(c.usage.input) : 0, output: object(c.usage) && Number.isFinite(c.usage.output) && c.usage.output >= 0 ? Math.round(c.usage.output) : 0 },
      messages: list(c.messages, '대화', true).slice(-500).map(m => { row(m); if (!['user', 'assistant'].includes(m.role)) throw new Error('대화 형식이 올바르지 않습니다.'); return { role: m.role, text: text(m.text, '대화', 5000), at: text(m.at, '날짜', 100, true) }; }) };
  });
  const num = v => Number.isFinite(v) && v >= 0 ? Math.round(v) : 0;
  const u = v3 && object(p.usage) ? p.usage : {}, usage = { since: typeof u.since === 'string' ? u.since.slice(0, 40) : '', calls: num(u.calls), input: num(u.input), output: num(u.output), byKind: {} };
  if (object(u.byKind)) for (const [k, v] of Object.entries(u.byKind).slice(0, 10)) if (object(v)) usage.byKind[k.slice(0, 20)] = { calls: num(v.calls), input: num(v.input), output: num(v.output) };
  return { version: VERSION, profile, books, thoughts, answers, moments, readings, insights, chats, usage, extraScales };
}
export function backup(state) { return JSON.stringify({ format: 'reading-notebook', exportedAt: now(), data: normalize(state) }, null, 2); }
export function stats(s) { return { books: s.books.length, entries: s.books.reduce((n, b) => n + b.entries.length, 0), questions: s.books.reduce((n, b) => n + b.questions.length, 0), thoughts: s.thoughts.length, answers: s.answers.length, chats: (s.chats || []).length, moments: s.moments.length }; }
export function matchesBook(b, query) {
  const q = query.trim().toLocaleLowerCase();
  return !q || [b.title, b.author, b.publisher, b.isbn, ...b.entries.flatMap(e => [e.text, e.note, e.page, ...(e.more || []).map(m => m.text)]), ...b.questions.flatMap(e => [e.text, e.answer, ...(e.history || []).map(h => h.text)])].some(t => t.toLocaleLowerCase().includes(q));
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
  // 오늘 슬라임이 기록을 읽고 만든 질문이 있으면 그걸, 없으면 미리 써 둔 질문을
  const custom = state.insights?.date === date && state.insights.question;
  if (!skipped.includes('prompt') && !state.answers.some(a => today(a.createdAt)))
    return { slot: 'prompt', title: '오늘의 물음', type: 'moment', text: custom || PROMPTS[Number(date.replaceAll('-', '')) % PROMPTS.length][tone] };
  return null;
}

// 기록 지도: 기록은 점, 주제어와 책은 큰 점. 기록은 자기 주제어(슬라임이 붙인 것)와 책에 이어지고,
// 문장에서 생긴 질문은 그 문장에 이어집니다. 이야기를 나눈 기록에는 마디 수가 붙습니다.
export function boardGraph(s) {
  const nodes = [], links = [], tags = new Map(), talk = new Map();
  for (const c of s.chats || []) if (c.messages.length) talk.set(c.topic.ref, (talk.get(c.topic.ref) || 0) + c.messages.length);
  const tagged = id => { for (const t of s.readings?.[id]?.tags || []) { links.push({ s: id, t: 'tag:' + t, kind: 'tag' }); tags.set(t, (tags.get(t) || 0) + 1); } };
  const rec = (kind, x, extra = {}) => nodes.push({ id: x.id, kind, label: x.text, at: x.createdAt || '', talk: talk.get(x.id) || 0, ...extra });
  for (const b of s.books) {
    nodes.push({ id: 'book:' + b.id, kind: 'book', label: b.title, ref: b.id, talk: talk.get(b.id) || 0 });
    for (const e of b.entries) { rec('entry', e, { book: b.id }); links.push({ s: e.id, t: 'book:' + b.id, kind: 'book' }); tagged(e.id); }
    for (const q of b.questions) { const from = q.from && b.entries.some(e => e.id === q.from); rec('question', q, { book: b.id }); links.push({ s: q.id, t: from ? q.from : 'book:' + b.id, kind: from ? 'from' : 'book' }); }
  }
  for (const t of s.thoughts) { rec('thought', t); tagged(t.id); }
  for (const a of s.answers) { rec('answer', a, { prompt: a.prompt }); tagged(a.id); }
  for (const [t, n] of tags) nodes.push({ id: 'tag:' + t, kind: 'tag', label: t, count: n });
  return { nodes, links };
}
