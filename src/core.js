export const VERSION = 3;
export const uid = () => crypto.randomUUID();
export const now = () => new Date().toISOString();
export const emptyProfile = () => ({ catName: '', tone: 'we', schedule: { wake: '07:00', leave: '08:00', back: '18:30', bed: '23:30' }, workdays: [1, 2, 3, 4, 5], aiConsentAt: '' });
export const emptyState = () => ({ version: VERSION, profile: emptyProfile(), books: [], thoughts: [], days: [], moments: [], readings: {}, extraScales: [] });
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
  const dates = new Set();
  const days = !v3 ? [] : list(p.days, '하루').map(d => {
    row(d);
    if (typeof d.date !== 'string' || !/^\d{4}-\d\d-\d\d$/.test(d.date) || dates.has(d.date)) throw new Error('하루 기록의 날짜가 올바르지 않습니다.');
    dates.add(d.date);
    const day = emptyDay(d.date);
    for (const f of FIELDS) {
      const v = getField(d, f.key);
      if (f.type === 'time') { if (v != null && v !== '' && !TIME.test(v)) throw new Error('시각 형식이 올바르지 않습니다.'); setField(day, f.key, v || ''); }
      else if (f.type === 'scale') { if (v != null && ![0, 1, 2, 3, 4, 5].includes(v)) throw new Error('만족도 값이 올바르지 않습니다.'); setField(day, f.key, v || 0); }
      else if (f.type === 'text') setField(day, f.key, text(v, '한 줄', 2000, true));
      else setField(day, f.key, pick(v, f.options.map(o => o[0]), f.label));
    }
    day.skipped = list(d.skipped, '넘어간 질문', true).slice(0, 20).map(x => text(x, '넘어간 질문', 30));
    return day;
  });
  let profile = emptyProfile();
  if (v3) {
    const q = row(p.profile), sch = row(q.schedule);
    for (const k of Object.keys(profile.schedule)) { if (!TIME.test(sch[k])) throw new Error('평소 시각이 올바르지 않습니다.'); profile.schedule[k] = sch[k]; }
    profile = { ...profile, catName: text(q.catName, '고양이 이름', 30, true), tone: q.tone === 'you' ? 'you' : 'we', workdays: list(q.workdays, '출근 요일').filter(n => Number.isInteger(n) && n >= 0 && n <= 6), aiConsentAt: text(q.aiConsentAt, '동의 시각', 100, true) };
  }
  const readings = v3 && object(p.readings) ? structuredClone(p.readings) : {};
  const extraScales = v3 && Array.isArray(p.extraScales) ? structuredClone(p.extraScales) : [];
  return { version: VERSION, profile, books, thoughts, days, moments, readings, extraScales };
}
export function backup(state) { return JSON.stringify({ format: 'reading-notebook', exportedAt: now(), data: normalize(state) }, null, 2); }
export function stats(s) { return { books: s.books.length, entries: s.books.reduce((n, b) => n + b.entries.length, 0), questions: s.books.reduce((n, b) => n + b.questions.length, 0), thoughts: s.thoughts.length, days: s.days.filter(d => FIELDS.some(f => getField(d, f.key))).length, moments: s.moments.length }; }
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

// ── 하루 일과 · 고양이의 질문 ────────────────────────────────
// 질문 문장은 [우리 말투, 너 말투] 한 쌍입니다. 값은 짧은 코드로 저장합니다.
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
export const ENERGY = [['up', '↑ 났다'], ['flat', '→ 그대로'], ['down', '↓ 빠졌다']];
export const WITH = [['alone', '혼자'], ['two', '둘이'], ['many', '여럿']];
export const CHOSEN = [['chose', '골랐다'], ['drift', '어쩌다 보니'], ['must', '해야 해서']];
const SAT = ['아주 별로', '별로', '보통', '괜찮음', '아주 좋음'];
export const SLOTS = [
  { id: 'morning', title: '아침', fields: [
    { key: 'wakeAt', label: '일어난 시각', type: 'time', q: ['우리 오늘 몇 시에 일어났지?', '오늘 몇 시에 일어났어?'] },
    { key: 'wakeHow', label: '어떻게 깼나', type: 'choice', q: ['어떻게 깼더라?', '어떻게 깼어?'], options: [['alarm', '알람에 억지로'], ['early', '알람 전에'], ['natural', '저절로']] },
    { key: 'sleepSat', label: '잠 만족도', type: 'scale', q: ['잠은 어땠지?', '잠은 어땠어?'] } ] },
  { id: 'commute', title: '출근길', workday: true, fields: [
    { key: 'commute.ride', label: '타고 간 것', type: 'choice', q: ['오늘은 뭘 타고 갔지?', '오늘은 뭘 타고 갔어?'], options: [['walk', '걸어서'], ['bike', '자전거'], ['transit', '버스·지하철'], ['car', '차'], ['home', '재택']] },
    { key: 'commute.feel', label: '길의 느낌', type: 'choice', q: ['가는 길은 어땠지?', '가는 길은 어땠어?'], options: [['busy', '북적북적'], ['quiet', '한적'], ['nature', '시골길·자연'], ['own', '나만의 길'], ['same', '늘 같은 길'], ['new', '처음 가 본 길']] },
    { key: 'commute.doing', label: '가는 동안 한 것', type: 'choice', q: ['가는 동안 뭘 했더라?', '가는 동안 뭘 했어?'], options: [['music', '음악'], ['book', '책'], ['feed', '쇼츠·SNS'], ['blank', '멍'], ['think', '생각 정리']] },
    { key: 'commute.energy', label: '도착했을 때 기운', type: 'choice', q: ['도착했을 때 기운은?', '도착했을 때 기운은 어땠어?'], options: ENERGY } ] },
  { id: 'work', title: '일', workday: true, fields: [
    { key: 'work.grain', label: '오늘 일의 결', type: 'choice', q: ['오늘 일은 어떤 결이었지?', '오늘 일은 어떤 결이었어?'], options: [['flow', '몰입'], ['okay', '그럭저럭'], ['endure', '버팀']] },
    { key: 'work.people', label: '사람', type: 'choice', q: ['사람은 얼마나 만났지?', '사람은 얼마나 만났어?'], options: [['alone', '혼자 한 일이 많음'], ['mixed', '반반'], ['many', '사람이 많음']] },
    { key: 'work.chosen', label: '스스로 고른 일', type: 'choice', q: ['스스로 고른 일은 얼마나 됐지?', '스스로 고른 일은 얼마나 됐어?'], options: [['most', '대부분'], ['half', '반반'], ['few', '거의 없음']] },
    { key: 'work.gave', label: '기운을 준 일', type: 'text' },
    { key: 'work.took', label: '기운을 뺀 일', type: 'text' } ] },
  { id: 'rest', title: '쉬는 날', workday: false, fields: [
    { key: 'rest.place', label: '가장 오래 머문 곳', type: 'choice', q: ['오늘 어디에 가장 오래 있었지?', '오늘 어디에 가장 오래 있었어?'], options: [['home', '집'], ['shop', '카페·가게'], ['outside', '바깥·자연'], ['crowd', '사람 많은 곳']] } ] },
  { id: 'evening', title: '저녁', fields: [
    { key: 'evening.main', label: '가장 오래 한 것', type: 'choice', q: ['저녁에 뭘 가장 오래 했지?', '저녁에 뭘 가장 오래 했어?'], options: [['exercise', '운동'], ['game', '게임'], ['coding', '바이브코딩'], ['reading', '독서'], ['shorts', '쇼츠'], ['people', '사람'], ['rest', '쉬기'], ['other', '그 밖에']] },
    { key: 'evening.chosen', label: '골랐나', type: 'choice', q: ['그건 고른 거였나?', '그건 고른 거였어?'], options: CHOSEN },
    { key: 'evening.energy', label: '하고 난 뒤 기운', type: 'choice', q: ['하고 나서 기운은?', '하고 나서 기운은 어땠어?'], options: ENERGY } ] },
  { id: 'night', title: '밤', fields: [
    { key: 'bedAt', label: '눕는 시각', type: 'time', q: ['이제 눕는 건가? 몇 시지?', '이제 누워? 몇 시야?'] },
    { key: 'daySat', label: '하루 만족도', type: 'scale', q: ['오늘 하루는 어땠지?', '오늘 하루는 어땠어?'] },
    { key: 'line', label: '오늘의 고양이 한 줄', type: 'text' } ] }
];
export const FIELDS = SLOTS.flatMap(s => s.fields);
export const scaleLabel = n => SAT[n - 1] || '';
const PROMPTS = [
  ['오늘 시간이 가장 빨리 간 순간은 언제였지?', '오늘 시간이 가장 빨리 간 순간은 언제였어?'],
  ['오늘 가장 미룬 일은 뭐였지? 대신 뭘 했더라?', '오늘 가장 미룬 일은 뭐였어? 대신 뭘 했어?'],
  ['오늘 기운을 가장 많이 빼 간 건 뭐였지?', '오늘 기운을 가장 많이 빼 간 건 뭐였어?'],
  ['오늘 꼬리가 가장 높이 섰던 순간은?', '오늘 꼬리가 가장 높이 섰던 순간은 언제였어?'],
  ['오늘 누가 시키지 않았는데 한 일이 있었나?', '오늘 누가 시키지 않았는데 한 일이 있었어?'],
  ['오늘 쇼츠나 SNS를 켠 건 어떤 때였지?', '오늘 쇼츠나 SNS를 켠 건 어떤 때였어?'],
  ['오늘 한 번 더 하고 싶은 일이 있었나?', '오늘 한 번 더 하고 싶은 일이 있었어?']
];
export function emptyDay(date) {
  return { date, wakeAt: '', wakeHow: '', sleepSat: 0, commute: { ride: '', feel: '', doing: '', energy: '' }, work: { grain: '', people: '', chosen: '', gave: '', took: '' }, rest: { place: '' }, evening: { main: '', chosen: '', energy: '' }, bedAt: '', daySat: 0, line: '', skipped: [] };
}
export function getField(day, key) { const [a, b] = key.split('.'); return b ? day?.[a]?.[b] : day?.[a]; }
export function setField(day, key, value) { const [a, b] = key.split('.'); if (b) day[a][b] = value; else day[a] = value; }
// 새벽 4시까지는 전날로 칩니다 — 자정 넘어 눕는 날도 같은 하루에 적히도록.
export function dayOf(date) { return dayKey(new Date(date.getTime() - 4 * 3600e3).toISOString()); }
const toMin = t => { const [h, m] = t.split(':').map(Number); return (h < 4 ? h + 24 : h) * 60 + m; };
export const isWorkday = (profile, date) => profile.workdays.includes(new Date(`${date}T12:00:00`).getDay());
export function slotsFor(profile, date) {
  const work = isWorkday(profile, date), s = profile.schedule, bed = toMin(s.bed);
  const start = { morning: 240, commute: toMin(s.leave), work: toMin(s.back) - 60, rest: 840, evening: bed - 120, night: bed - 60 };
  return SLOTS.filter(x => x.workday == null || x.workday === work).map(x => ({ ...x, start: start[x.id] }));
}
// 재택이면 출근길의 나머지는 묻지 않습니다.
const asks = (day, f) => f.q && !(f.key.startsWith('commute.') && f.key !== 'commute.ride' && day.commute.ride === 'home');
export const isIso = v => /^\d{4}-\d\d-\d\dT/.test(v || '');
// 고양이는 지금 시간대의 칸만 묻습니다. 지나간 빈칸은 되짚을지 먼저 물어봅니다(all = 되짚기로 함).
export function nextQuestion(state, now = new Date(), all = false) {
  const date = dayOf(now), day = state.days.find(d => d.date === date) || emptyDay(date);
  const tone = state.profile.tone === 'you' ? 1 : 0, minutes = toMin(`${now.getHours()}:${now.getMinutes()}`);
  const started = slotsFor(state.profile, date).filter(s => s.start <= minutes);
  const pending = s => !day.skipped.includes(s.id) && s.fields.find(f => asks(day, f) && !getField(day, f.key));
  for (const slot of all ? [...started].reverse() : started.slice(-1)) {
    const f = pending(slot);
    if (f) return { slot: slot.id, title: slot.title, key: f.key, type: f.type, text: f.q[tone], options: f.options };
  }
  const missed = all || day.skipped.includes('catchup') ? [] : started.slice(0, -1).filter(pending);
  if (missed.length) return { slot: 'catchup', title: '지나간 칸', type: 'catchup', text: `${missed.map(s => s.title).join(', ')} 칸이 비어 있어. ${tone ? '이어서 물어볼까?' : '같이 되짚어 볼까?'}` };
  const today = v => isIso(v) && dayOf(new Date(v)) === date;
  const book = [...state.books].reverse().find(b => b.status === 'reading');
  if (book && day.evening.main && !day.skipped.includes('book') && !book.entries.some(e => today(e.createdAt)))
    return { slot: 'book', title: '책', type: 'book', bookId: book.id, text: `『${book.title}』에서 오늘 머문 문장이 ${tone ? '있어?' : '있었나?'}` };
  if (!day.skipped.includes('prompt') && !state.moments.some(m => m.from === 'cat' && today(m.createdAt)))
    return { slot: 'prompt', title: '순간', type: 'moment', text: PROMPTS[Number(date.replaceAll('-', '')) % PROMPTS.length][tone] };
  return null;
}
// 오늘의 상태 → 고양이의 모습. 자리(성향)와는 따로 봅니다.
export function catMood(day) {
  if (!day) return 'calm';
  if (day.daySat) return day.daySat >= 4 ? 'happy' : day.daySat <= 2 ? 'low' : 'calm';
  if (day.evening.energy === 'up') return 'happy';
  if (day.sleepSat && day.sleepSat <= 2) return 'sleepy';
  return 'calm';
}
export function sleepMinutes(prev, day) {
  if (!prev?.bedAt || !day?.wakeAt) return null;
  const [bh, bm] = prev.bedAt.split(':').map(Number), [wh, wm] = day.wakeAt.split(':').map(Number);
  const bed = bh * 60 + bm, total = wh * 60 + wm + (bed >= 720 ? 1440 - bed : -bed);
  return total > 0 && total < 960 ? total : null;
}
