import { uid, now, emptyState, normalize, backup, stats, matchesBook, dateLabel, safeCover, dayOf, nextQuestion, isIso } from './core.js';
import { mountSlime } from './slime.js';
import { openStore, load, commit, previous } from './storage.js';
import { BOOK_SEARCH_ENDPOINT, AI_ENDPOINT, AI_REFLECT_ENDPOINT } from './config.js';

const BUILD = '1011c';   // 폰에서 어떤 판을 보고 있는지 확인용
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
let state = emptyState(), db, revision = 0, busy = false, ready = false;
let filter = 'all', query = '', entryTab = 'entries', questionFilter = 'open';
let toastTimer, undoAction, modalCleanup = () => {}, draftKey = '', modalDirty = false, modalFocus;
const dialog = $('#editor');
const channel = 'BroadcastChannel' in window ? new BroadcastChannel('reading-notebook') : null;
function notice(message, undo) {
  clearTimeout(toastTimer); undoAction = undo;
  $('#toast').innerHTML = esc(message) + (undo ? '<button id="undo-action">되돌리기</button>' : '');
  $('#toast').hidden = false;
  if (undo) $('#undo-action').onclick = async () => { if (!busy) { $('#undo-action').disabled = true; await undoAction(); } };
  toastTimer = setTimeout(() => { $('#toast').hidden = true; }, undo ? 20000 : 6500);
}
function status(message, error = false) { $('#save-status').textContent = message + ' · ' + BUILD; $('#save-status').classList.toggle('error', error); }
async function change(edit, message = '기록을 보관했습니다.') {
  if (!ready || busy) return false;
  busy = true; status('저장 중…');
  const next = structuredClone(state);
  try {
    edit(next);
    revision = await commit(db, next, revision);
    state = next; channel?.postMessage(revision); status('이 브라우저에 저장됨');
    setTimeout(readRecords, 600);   // 새 기록이 있으면 슬라임이 읽어 둡니다
    render(); if (message) notice(message); return true;
  } catch (e) { status('저장 실패 · 작성 내용을 보관해주세요', true); showError(e.message); return false; }
  finally { busy = false; }
}
function showError(message) {
  const el = dialog.open && $('#form-error');
  if (el) { el.textContent = message; el.scrollIntoView({ block:'nearest' }); }
  else notice(message);
}
function cover(b) {
  return `<div class="cover ${esc(b.color || 'forest')}"><div class="cover-fallback" ${b.cover ? 'aria-hidden="true"' : ''}><b>${esc(b.title || '나의 책')}</b></div>${b.cover ? `<img src="${esc(b.cover)}" alt="${esc(b.title)} 표지" loading="lazy" referrerpolicy="no-referrer">` : ''}</div>`;
}
document.addEventListener('error', e => { if (e.target instanceof HTMLImageElement) { e.target.hidden = true; e.target.parentElement.querySelector('.cover-fallback')?.removeAttribute('aria-hidden'); } }, true);
const empty = (title, message, action = '') => `<div class="empty"><div class="empty-illustration" aria-hidden="true"><i></i><i></i><i></i></div><h2>${title}</h2><p>${message}</p>${action}</div>`;
function route() { const [page, id] = location.hash.slice(1).split('/'); return { page: page || 'home', id }; }
const currentBook = () => state.books.find(b => b.id === route().id);
function render() {
  if (!ready) return;
  const raw = route().page, page = ['cat', 'room', 'moments', 'trips', 'day'].includes(raw) ? 'home' : raw;   // 옛 주소는 첫 화면으로
  if (slime && page !== 'home') { slime.destroy(); slime = null; }
  if (page !== 'home') document.body.classList.remove('night');
  const tab = { book:'shelf', questions:'shelf', shelf:'shelf', thoughts:'thoughts' }[page] || 'home';
  document.querySelectorAll('[data-nav]').forEach(a => { if (a.dataset.nav === tab) a.setAttribute('aria-current','page'); else a.removeAttribute('aria-current'); });
  document.body.dataset.page = page;
  if (page === 'book') renderBook();
  else if (page === 'questions') renderQuestions();
  else if (page === 'thoughts') renderThoughts();
  else if (page === 'answers') renderAnswers();
  else if (page === 'shelf') renderShelf();
  else renderHome();
}

// 책장 그림 안의 칸 좌표 — 빈 방 일러스트(4:3)에서 직접 잰 값입니다.
const SHELVES = [66.9, 47.9, 28.3];      // 칸마다 책이 서는 바닥 높이 (아래에서부터 %)
const SPINE = { forest:'#4A6A4C', clay:'#A9705A', blue:'#6E86A8', sand:'#C2A878' };
function spines(books) {
  return books.slice(0, 15).map((b, i) => {
    const shelf = SHELVES[Math.floor(i / 5)], slot = i % 5;
    const left = 57.3 + slot * 3.35, h = 13.6 + (i % 3) * 0.8;
    return `<a class="spine" href="#book/${esc(b.id)}" title="${esc(b.title)}" aria-label="${esc(b.title)}"
      style="left:${left}%;bottom:${shelf}%;height:${h}%;background:${SPINE[b.color] || SPINE.forest}"></a>`;
  }).join('');
}
// ── 슬라임 · 순간 ──────────────────────────────────────────
const say = pair => pair[state.profile.tone === 'you' ? 1 : 0];
const todayKey = () => dayOf(new Date());
let slime = null, saidToday = new Set(), askOpen = false;   // 질문 상자가 펼쳐져 있는지
// 오늘 넘어간 질문은 이 기기에만 잠깐 기억합니다 — 기록이 아니라서 데이터에 넣지 않습니다.
const skipped = () => { try { return JSON.parse(localStorage.getItem(`cat-skip:${todayKey()}`) || '[]'); } catch { return []; } };
function skip(slot) { try { localStorage.setItem(`cat-skip:${todayKey()}`, JSON.stringify([...skipped(), slot])); } catch {} renderHome(); }
function bubble() {
  if (!state.profile.catName) return `<div class="bubble"><p class="bubble-text">안녕. 나는 아직 이름이 없는 슬라임이야. 이름을 지어 줄래?</p><div class="bubble-actions"><button class="primary" data-action="profile">이름 지어 주기</button></div></div>`;
  const q = nextQuestion(state, new Date(), skipped());
  const past = state.answers.length ? `<a class="text-link past-link" href="#answers">지난 답 ${state.answers.length} ›</a>` : '';
  if (!q) return `<div class="bubble done"><p class="bubble-text">${say(['오늘 물을 건 여기까지. 나머진 네가 적고 싶을 때.', '오늘 물을 건 여기까지야. 나머진 네가 적고 싶을 때.'])}</p>${past}</div>`;
  const body = q.type === 'book'
    ? `<div class="bubble-actions"><button class="primary" data-action="cat-book" data-book="${esc(q.bookId)}">문장 남기기</button></div>`
    : `<div class="bubble-actions"><button class="primary" data-action="cat-answer" data-prompt="${esc(q.text)}">답할게</button>${past}</div>`;
  return `<div class="bubble"><p class="bubble-slot">${esc(q.title)}</p><p class="bubble-text">${esc(q.text)}</p>${body}<button class="quiet skip-q" data-action="cat-skip" data-slot="${q.slot}">오늘은 넘어갈래</button></div>`;
}
// 슬라임이 가지고 놀 때 꺼내는 말. 지금은 지난 기록을 그대로 인용하고, 요약이 생기면 그걸로 바뀝니다.
function sayLines() {
  const quote = (createdAt, text) => `${dateLabel(createdAt)}에 이렇게 적었어. “${text.length > 70 ? text.slice(0, 70) + '…' : text}”`;
  return [
    ...state.thoughts.map(t => quote(t.createdAt, t.text)),
    ...state.answers.map(a => `${dateLabel(a.createdAt)}에 내가 “${a.prompt.length > 30 ? a.prompt.slice(0, 30) + '…' : a.prompt}” 하고 물었더니 이렇게 답했어. “${a.text.length > 60 ? a.text.slice(0, 60) + '…' : a.text}”`),
    ...state.moments.map(m => quote(m.createdAt, m.text)),
    ...state.books.flatMap(b => b.entries.filter(e => e.note).map(e => `『${b.title}』을 읽다가 ${dateLabel(e.createdAt)}에 남긴 생각. “${e.note.length > 60 ? e.note.slice(0, 60) + '…' : e.note}”`))
  ];
}
function maybeSay(pokes) {
  const el = $('#slime-say'); if (!el) return;
  // 오늘 슬라임이 만든 말이 남아 있으면 그걸 먼저 — 만지기 시작하면 바로
  const fresh = state.insights?.date === todayKey() ? state.insights.lines.map(l => l.text).filter(t => !saidToday.has(t)) : [];
  if (fresh.length && (pokes === 1 || Math.random() < 0.6)) { saidToday.add(fresh[0]); showSay(fresh[0]); return; }
  if (pokes < 2 || Math.random() > 0.35) return;
  let dayCount = 0; try { dayCount = Number(localStorage.getItem(`slime-said:${todayKey()}`) || 0); } catch {}
  if (dayCount >= 3) return;
  const lines = sayLines().filter(l => !saidToday.has(l)); if (!lines.length) return;
  const line = lines[Math.floor(Math.random() * lines.length)]; saidToday.add(line);
  try { localStorage.setItem(`slime-said:${todayKey()}`, String(dayCount + 1)); } catch {}
  showSay(line);
}
// 물음표 단추: 물을 게 있으면 점이 켜지고, 누르면 질문 상자가 펼쳐집니다
function syncAsk() {
  const fab = $('#ask-fab'), box = $('#home-bubble'); if (!fab || !box) return;
  const pending = !state.profile.catName || !!nextQuestion(state, new Date(), skipped());
  if (!pending) askOpen = false;
  box.hidden = !askOpen; fab.setAttribute('aria-expanded', String(askOpen)); fab.classList.toggle('open', askOpen);
  fab.querySelector('.ask-dot').hidden = !pending || askOpen;
}
// 슬라임이 먹은 기록 — 생각, 책 문장, 슬라임에게 한 답. 오래된 것부터.
// ── 슬라임이 기록 읽기 (AI) ──────────────────────────────────
// 보내는 것: 생각, 슬라임에게 한 답, 책 문장에 단 '내 생각'. 책에서 옮겨 적은 문장은 보내지 않습니다.
const textHash = t => { let h = 5381; for (let i = 0; i < t.length; i++) h = ((h << 5) + h + t.charCodeAt(i)) | 0; return String(h >>> 0); };
function aiSources() {
  const out = [];
  for (const t of state.thoughts) out.push({ id: t.id, text: t.text });
  for (const a of state.answers) out.push({ id: a.id, text: `질문: ${a.prompt}\n답: ${a.text}` });
  for (const b of state.books) for (const e of b.entries) if (e.note) out.push({ id: e.id, text: `책 『${b.title}』을 읽다가 남긴 내 생각: ${e.note}` });
  return out.map(x => ({ ...x, h: textHash(x.text) }));
}
// 기록의 주제어. 내 생각 없이 문장만 옮겨 둔 책 기록은 '독서'
function tagsOf(id) {
  const r = state.readings[id]; if (r?.tags?.length) return r.tags;
  return state.books.some(b => b.entries.some(e => e.id === id && !e.note)) ? ['독서'] : [];
}
function tagCounts(sinceDays = 0) {
  const since = sinceDays ? Date.now() - sinceDays * 864e5 : 0, n = new Map();
  for (const b of beadList()) { if (b.at < since) continue; for (const t of tagsOf(b.id)) n.set(t, (n.get(t) || 0) + 1); }
  return [...n.entries()].sort((a, b) => b[1] - a[1]);
}
let reading = false, readBackoff = 0;
async function readRecords() {
  if (reading || !ready || busy || !state.profile.aiConsentAt || !AI_ENDPOINT || !navigator.onLine || Date.now() < readBackoff) return;
  const todo = aiSources().filter(x => state.readings[x.id]?.h !== x.h).slice(0, 25);
  if (!todo.length) return reflectToday();
  reading = true;
  try {
    const res = await fetch(AI_ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items: todo.map(({ id, text }) => ({ id, text })), known: tagCounts().slice(0, 80).map(x => x[0]) }), signal: AbortSignal.timeout(30000) });
    if (!res.ok) throw new Error(String(res.status));
    const body = await res.json(); if (!Array.isArray(body?.items)) throw new Error('bad reply');
    const got = new Map(body.items.map(x => [x.id, x.tags]));
    reading = false;
    await change(s => {
      const live = new Set(aiSources().map(x => x.id));
      for (const id of Object.keys(s.readings)) if (!live.has(id)) delete s.readings[id];   // 지운 기록의 주제어도 정리
      for (const x of todo) s.readings[x.id] = { tags: (got.get(x.id) || []).slice(0, 3), h: x.h, at: now() };
    }, '');
  } catch { readBackoff = Date.now() + 5 * 60e3; }
  finally { reading = false; }
}
// 하루 한 번: 슬라임이 기록을 읽고 '그땐/지금은' 몇 줄과 오늘의 질문을 만들어 둡니다
let reflecting = false, reflectBackoff = 0;
async function reflectToday() {
  const date = todayKey();
  if (reflecting || !ready || busy || !state.profile.aiConsentAt || !AI_REFLECT_ENDPOINT || !navigator.onLine || Date.now() < reflectBackoff || (state.insights?.date === date && (state.insights.lines.length || state.insights.question))) return;
  const kindOf = { thought: '생각', answer: '답', entry: '책 메모' }, src = new Map(aiSources().map(x => [x.id, x]));
  const all = beadList().filter(b => src.has(b.id)).reverse();   // 최근 것부터
  if (all.length < 3) return;
  const cut = Date.now() - 21 * 864e5, recent = all.filter(b => b.at >= cut).slice(0, 35), older = all.filter(b => b.at < cut).slice(0, 60 - Math.min(35, recent.length));
  const pick = [...recent, ...older].slice(0, 60).reverse();   // 오래된 것부터 읽게
  if (pick.length < 3) return;
  reflecting = true;
  try {
    const res = await fetch(AI_REFLECT_ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(45000), body: JSON.stringify({
      name: state.profile.catName || '슬라임', tone: state.profile.tone, today: date,
      items: pick.map(b => ({ id: b.id, date: b.at ? new Date(b.at).toISOString().slice(0, 10) : '', kind: kindOf[b.kind], text: src.get(b.id).text.slice(0, 400), tags: state.readings[b.id]?.tags || [] }))
    }) });
    if (!res.ok) throw new Error(String(res.status));
    const out = await res.json();
    if (!Array.isArray(out?.lines) || typeof out.question !== 'string' || (!out.lines.length && !out.question)) throw new Error('bad reply');
    reflecting = false;
    await change(s => { s.insights = { date, at: now(), question: out.question || '', lines: (out.lines || []).map(l => ({ text: l.text, ids: l.ids || [] })) }; }, '');
  } catch { reflectBackoff = Date.now() + 15 * 60e3; }
  finally { reflecting = false; }
}
// 요즘(60일) 가장 많은 주제가 슬라임 겉색에 스밉니다
function slimeLook() {
  const base = [169, 211, 164], top = tagCounts(60), total = top.reduce((n, x) => n + x[1], 0);
  if (!top.length || total < 3 || top[0][0] === '독서' && top.length === 1) return { color: '#a9d3a4' };
  const [tag, count] = top[0], share = count / total;
  let h = 5381; for (const c of tag) h = ((h << 5) + h + c.charCodeAt(0)) | 0;
  const hue = (h >>> 0) % 360, k = Math.min(0.55, share * 1.1);
  const c = 0.55 * (1 - Math.abs(2 * 0.72 - 1)), x = c * (1 - Math.abs((hue / 60) % 2 - 1)), m = 0.72 - c / 2;
  const [r1, g1, b1] = hue < 60 ? [c, x, 0] : hue < 120 ? [x, c, 0] : hue < 180 ? [0, c, x] : hue < 240 ? [0, x, c] : hue < 300 ? [x, 0, c] : [c, 0, x];
  const mix = [r1, g1, b1].map((v, i) => Math.round(base[i] * (1 - k) + (v + m) * 255 * k));
  return { color: '#' + mix.map(v => v.toString(16).padStart(2, '0')).join(''), tag };
}
const tagLine = id => { const t = state.readings[id]?.tags; return t?.length ? `<p class="tag-line">${t.map(x => `<span>#${esc(x)}</span>`).join('')}</p>` : ''; };
function beadList() {
  const t = v => isIso(v) ? Date.parse(v) : 0;
  return [
    ...state.thoughts.map(x => ({ id: x.id, kind: 'thought', at: t(x.createdAt) })),
    ...state.books.flatMap(b => b.entries.map(x => ({ id: x.id, kind: 'entry', at: t(x.createdAt) }))),
    ...state.answers.map(x => ({ id: x.id, kind: 'answer', at: t(x.createdAt) }))
  ].map(b => ({ ...b, tag: state.readings[b.id]?.tags?.[0] })).sort((a, b) => a.at - b.at);
}
// 처음 보는 기록만 위에서 떨어뜨립니다. 본 것은 이 기기에만 기억합니다.
function syncBeads() {
  if (!slime) return;
  const list = beadList(); let seen = null;
  try { seen = JSON.parse(localStorage.getItem('slime-seen') || 'null'); } catch {}
  const drop = seen ? list.filter(b => !seen.includes(b.id)).map(b => b.id) : [];
  slime.setBeads(list, drop);
  slime.setLook({ color: slimeLook().color });
  try { localStorage.setItem('slime-seen', JSON.stringify(list.map(b => b.id))); } catch {}
}
function beadText(id) {
  const tags = state.readings[id]?.tags?.length ? state.readings[id].tags.map(t => '#' + t).join(' ') + ' — ' : '';
  return tags + beadBody(id);
}
function beadBody(id) {
  const th = state.thoughts.find(x => x.id === id); if (th) return `${dateLabel(th.createdAt)}의 생각. “${th.text.length > 70 ? th.text.slice(0, 70) + '…' : th.text}”`;
  const an = state.answers.find(x => x.id === id); if (an) return `${dateLabel(an.createdAt)}의 답. “${an.text.length > 70 ? an.text.slice(0, 70) + '…' : an.text}”`;
  for (const b of state.books) { const e = b.entries.find(x => x.id === id); if (e) return `『${b.title}』 ${e.page ? `p. ${e.page}` : ''} “${e.text.length > 60 ? e.text.slice(0, 60) + '…' : e.text}”`; }
  return '';
}
function showSay(line) {
  const el = $('#slime-say'); if (!el || !line) return;
  el.textContent = line; el.hidden = false; el.classList.add('show');
  clearTimeout(maybeSay.timer); maybeSay.timer = setTimeout(() => { el.classList.remove('show'); setTimeout(() => { el.hidden = true; }, 400); }, 7000);
}
// 밤(21시~6시)에는 어두워지고 슬라임이 졸아요
const isNight = () => { const h = new Date().getHours(); return h >= 21 || h < 6; };
function syncNight() { const n = isNight(); document.body.classList.toggle('night', n && route().page !== 'shelf'); slime?.setNight(n); }
setInterval(() => { if (slime) syncNight(); }, 60000);
function renderHome() {
  // 슬라임이 떠 있는 동안에는 말풍선만 바꿉니다 — 출렁이던 게 멈추지 않도록
  if (slime && $('#slime-stage')) { $('#home-bubble').innerHTML = bubble(); syncAsk(); syncBeads(); return; }
  askOpen = !state.profile.catName;   // 처음 만날 때만 열어 둡니다
  $('#main').innerHTML = `<section class="slime-home" aria-label="슬라임">
    <div class="slime-stage" id="slime-stage"><div class="slime-say" id="slime-say" role="status" hidden></div></div>
    <div class="home-bubble" id="home-bubble" hidden>${bubble()}</div>
    <button class="ask-fab" id="ask-fab" aria-label="슬라임의 질문" aria-expanded="false"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 9.5a3 3 0 1 1 4.6 2.5c-1 .7-1.6 1.3-1.6 2.5" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/><circle cx="12" cy="18" r="1.4" fill="currentColor"/></svg><i class="ask-dot" hidden></i></button>
  </section>`;
  syncAsk();
  try { slime = mountSlime($('#slime-stage'), { onPoke: maybeSay, onBead: id => showSay(beadText(id)), onDoubleTap: () => journalEditor(), reduced: matchMedia('(prefers-reduced-motion: reduce)').matches }); syncBeads(); syncNight(); }
  catch (e) { $('#slime-stage').innerHTML = `<p class="empty">이 브라우저에서는 슬라임을 그릴 수 없습니다.<br><small>${esc(e.message)}</small></p>`; }
}
function renderShelf() {
  $('#main').innerHTML = `<section aria-labelledby="shelf-title"><div class="intro"><div><h1 id="shelf-title">나의 책장</h1><p>읽다가 머문 자리마다, 나만의 기록이 쌓입니다. <a class="text-link" href="#questions">남은 질문 ${state.books.reduce((n, b) => n + b.questions.filter(q => !q.answer).length, 0)} ›</a></p></div><button class="primary intro-actions" data-action="add-book">＋ 책 추가</button></div><div class="toolbar"><div class="filters" aria-label="독서 상태">${[['all','전체'],['reading','읽는 중'],['finished','다 읽음']].map(([v,l]) => `<button data-filter="${v}" aria-pressed="${filter === v}">${l}</button>`).join('')}</div><div class="search-field"><label class="visually-hidden" for="local-search">책과 기록 검색</label><input type="search" id="local-search" placeholder="책 제목, 문장, 질문 찾기" value="${esc(query)}"></div></div><div id="shelf-results"></div></section>`;
  shelfResults();
  $('#local-search').oninput = e => { query = e.target.value; shelfResults(); };
}
function shelfResults() {
  const books = state.books.filter(b => (filter === 'all' || b.status === filter) && matchesBook(b, query));
  $('#shelf-results').innerHTML = books.length ? `${query ? `<p class="search-count" role="status">기록을 포함해 ${books.length}권을 찾았습니다.</p>` : ''}<div class="book-grid">${books.map(b => `<a class="book-tile" href="#book/${esc(b.id)}">${cover(b)}<h3>${esc(b.title)}</h3><p class="author">${esc(b.author || '저자 미기록')}</p><div class="counts"><span class="status-tag">${b.status === 'finished' ? '다 읽음' : '읽는 중'}</span>문장 ${b.entries.length} · 질문 ${b.questions.length}</div></a>`).join('')}</div>` : empty(state.books.length ? '아직 이 칸은 비어 있어요' : '첫 책을 놓아보세요', state.books.length ? '다른 검색어나 독서 상태로 찾아보세요.' : '곁에 두고 읽는 책 한 권이면 충분합니다.', !state.books.length ? '<button class="primary" data-action="add-book">내 책 추가하기</button>' : '');
}
function quoteCard(e, b, type, showBook = false) {
  const question = type === 'questions';
  const meta = [showBook ? `<a href="#book/${esc(b.id)}">${esc(b.title)}</a>` : '', !question && e.page ? `p. ${esc(e.page)}` : '', esc(dateLabel(e.createdAt)), question ? (e.answer ? '답을 남김' : '아직 품는 중') : ''].filter(Boolean).join(' · ');
  return `<article class="q ${question ? 'q-question' : ''} ${question && e.answer ? 'answered' : ''}"><span class="mark" aria-hidden="true">${question ? '?' : '“'}</span><p class="q-text">${esc(e.text)}</p><p class="q-meta">${meta}</p>${e.note ? `<p class="mine">${esc(e.note)}</p>` : ''}${question ? '' : tagLine(e.id)}${question && e.answer ? `<p class="mine answer">${esc(e.answer)}<small>${esc(dateLabel(e.answeredAt))}에 남긴 답</small></p>` : ''}<div class="q-actions">${question ? `<button data-action="answer" data-book="${b.id}" data-id="${e.id}">${e.answer ? '답 수정' : '답 남기기'}</button>` : ''}<button data-action="edit-record" data-type="${type}" data-book="${b.id}" data-id="${e.id}">수정</button><button data-action="delete-record" data-type="${type}" data-book="${b.id}" data-id="${e.id}">삭제</button></div></article>`;
}
// 달마다 작은 제목을 두고 왼쪽에 선을 그린 타임라인
function timeline(items, render) {
  const monthOf = v => isIso(v) ? v.slice(0, 7) : v ? 'legacy' : 'none';
  const thisYear = String(new Date().getFullYear());
  const label = m => m === 'legacy' ? '이전 기록' : m === 'none' ? '날짜 미기록' : `${m.slice(0, 4) === thisYear ? '' : m.slice(0, 4) + '년 '}${Number(m.slice(5))}월`;
  let last = null, html = '<div class="tl">';
  for (const it of items) { const m = monthOf(it.createdAt); if (m !== last) { html += `<p class="tl-month">${label(m)}</p>`; last = m; } html += `<div class="tl-entry">${render(it)}</div>`; }
  return html + '</div>';
}
const dayShort = v => isIso(v) ? new Date(v).toLocaleDateString('ko-KR', { day: 'numeric', weekday: 'short' }) : dateLabel(v);
function renderBook() {
  const b = currentBook();
  if (!b) { $('#main').innerHTML = empty('책을 찾을 수 없어요', '책장에서 다른 책을 골라주세요.', '<a class="back" href="#shelf">← 책장으로</a>'); return; }
  const activeQuery = query.trim();
  const records = b[entryTab].filter(e => !activeQuery || [e.text,e.note || '',e.answer || '',e.page || ''].some(t => t.toLowerCase().includes(activeQuery.toLowerCase())));
  $('#main').innerHTML = `<div class="narrow"><a class="back" href="#shelf">← 책장으로</a><section class="book-hero" aria-labelledby="book-title">${cover(b)}<span class="status-tag">${b.status === 'finished' ? '다 읽음' : '읽는 중'}</span><h1 id="book-title">${esc(b.title)}</h1><p class="book-sub">${esc([b.author,b.publisher].filter(Boolean).join(' · ') || '나만의 독서 기록')}</p><p class="book-sub small">${esc(dateLabel(b.createdAt))}부터${b.finishedAt ? ` · ${esc(dateLabel(b.finishedAt))} 완독` : ''}</p><div class="actions"><button data-action="edit-book">책 정보 수정</button><button data-action="toggle-status">${b.status === 'finished' ? '다시 읽기' : '다 읽었어요'}</button></div></section><div class="kind-cards"><button class="kind entries" data-entry-tab="entries" aria-pressed="${entryTab === 'entries'}"><span class="kind-mark" aria-hidden="true">&ldquo;</span><b>문장</b><span class="kind-count">${b.entries.length}</span><i></i><span class="kind-go" aria-hidden="true">→</span></button><button class="kind questions" data-entry-tab="questions" aria-pressed="${entryTab === 'questions'}"><span class="kind-mark" aria-hidden="true">?</span><b>질문</b><span class="kind-count">${b.questions.length}${b.questions.filter(q => q.answer).length ? ` · 답 ${b.questions.filter(q => q.answer).length}` : ''}</span><i></i><span class="kind-go" aria-hidden="true">→</span></button></div><div class="toolbar record-toolbar"><button class="primary" data-action="add-record">＋ ${entryTab === 'entries' ? '문장' : '질문'} 남기기</button></div>${activeQuery ? `<p class="search-count">“${esc(query)}” 검색 중 <button class="quiet" data-action="clear-query">검색 해제</button></p>` : ''}<div class="quotes">${records.length ? [...records].reverse().map(e => quoteCard(e,b,entryTab)).join('') : empty(activeQuery ? '일치하는 기록이 없어요' : entryTab === 'entries' ? '오래 두고 싶은 문장' : '서둘러 답하지 않아도 괜찮아요', activeQuery ? '검색을 해제하면 모든 기록이 보입니다.' : entryTab === 'entries' ? '읽다가 걸린 문장과 그때의 생각을 남겨보세요.' : '읽다가 생긴 물음을 적어두고, 나중의 나에게 건네보세요.')}</div><p class="section-note"><button class="quiet danger" data-action="delete-book">이 책 삭제</button></p></div>`;
}
function renderQuestions() {
  const qs = state.books.flatMap(b => b.questions.map(q => ({ b, q }))).filter(({q}) => questionFilter === 'all' || (questionFilter === 'open' ? !q.answer : !!q.answer)).reverse();
  $('#main').innerHTML = `<div class="narrow"><a class="back" href="#shelf">← 책장으로</a><div class="intro"><div><h1>남은 질문</h1><p>답을 기다리는 시간도 독서의 일부니까요.</p></div></div><div class="toolbar"><div class="filters" aria-label="답변 상태">${[['open','답을 기다리는'],['answered','답을 남긴'],['all','모든 질문']].map(([v,l]) => `<button data-question-filter="${v}" aria-pressed="${questionFilter === v}">${l}</button>`).join('')}</div></div><div class="quotes">${qs.map(({b,q}) => quoteCard(q,b,'questions',true)).join('') || empty('질문을 위한 빈자리', '책을 열어 떠오른 물음을 남기면 이곳에 모입니다.')}</div></div>`;
}
function renderAnswers() {
  const name = state.profile.catName || '슬라임';
  $('#main').innerHTML = `<div class="narrow"><a class="back" href="#home">← ${esc(name)}에게</a><div class="intro"><div><h1>${esc(name)}에게 한 답</h1><p>하루 한 번 건네는 질문에 본 대로 답한 것들.</p></div></div>${state.answers.length ? timeline([...state.answers].reverse(), a => `<span class="tl-date">${esc(dayShort(a.createdAt))}</span><p class="asked">${esc(a.prompt)}</p><p class="tl-text">${esc(a.text)}</p>${tagLine(a.id)}<div class="q-actions"><button data-action="edit-answer" data-id="${esc(a.id)}">수정</button><button data-action="delete-record" data-type="answers" data-id="${esc(a.id)}">삭제</button></div>`) : empty('아직 답한 게 없어요', '첫 화면의 물음표를 누르면 오늘의 질문이 있습니다.')}</div>`;
}
function renderThoughts() {
  $('#main').innerHTML = `<div class="narrow"><div class="intro"><div><h1>떠오르는 생각</h1><p>책과 상관없이, 스스로 떠오른 것.</p></div><button class="primary intro-actions" data-action="add-journal">＋ 기록</button></div>${state.thoughts.length ? timeline([...state.thoughts].reverse(), t => `<span class="tl-date">${esc(dayShort(t.createdAt))}</span><p class="tl-text">${esc(t.text)}</p>${tagLine(t.id)}<div class="q-actions"><button data-action="edit-journal" data-id="${esc(t.id)}">수정</button><button data-action="delete-record" data-type="thoughts" data-id="${esc(t.id)}">삭제</button></div>`) : empty('아무렇게나, 한 줄부터', '잘 정리하지 않아도 괜찮습니다.')}</div>`;
}

function openModal(title, body, key = '') {
  modalCleanup(); modalCleanup = () => {}; modalFocus = document.activeElement;
  draftKey = key ? `reading-draft:${key}` : ''; modalDirty = false;
  $('#dialog-content').innerHTML = `<div class="dialog-inner"><div class="dialog-head"><h2 id="dialog-title">${title}</h2><button type="button" class="quiet" data-close aria-label="닫기">×</button></div>${body}<p id="form-error" class="form-error" role="alert"></p></div>`;
  if (!dialog.open) dialog.showModal();
  $('[data-close]').onclick = () => closeModal();
  if (draftKey) {
    try { const draft = JSON.parse(sessionStorage.getItem(draftKey) || 'null'); if (draft) { for (const [name,value] of Object.entries(draft)) { const el = dialog.querySelector(`[name="${name}"]`); if (el && !['file','radio','checkbox'].includes(el.type)) el.value = value; } notice('이 창에 남아 있던 초안을 불러왔습니다.'); modalDirty = true; } } catch {}
  }
}
function preserveDraft() {
  if (!draftKey) return;
  const values = {};
  dialog.querySelectorAll('input[name],textarea[name],select[name]').forEach(el => { if (!['file','radio','checkbox'].includes(el.type)) values[el.name] = el.value; });
  try { sessionStorage.setItem(draftKey, JSON.stringify(values)); } catch {}
}
dialog.addEventListener('input', () => { modalDirty = true; preserveDraft(); });
function closeModal(saved = false) {
  if (busy) return;
  if (!saved && modalDirty) preserveDraft();
  if (saved && draftKey) { try { sessionStorage.removeItem(draftKey); } catch {} }
  modalCleanup(); modalCleanup = () => {}; dialog.close();
  if (!saved && modalDirty) notice('글 초안을 이 창에 남겨두었습니다. 사진은 다시 선택해주세요.');
  modalDirty = false; draftKey = ''; modalFocus?.isConnected && modalFocus.focus();
}
dialog.addEventListener('cancel', e => { e.preventDefault(); closeModal(); });
const field = (label, name, value = '', options = '') => `<div class="field"><label for="f-${name}">${label}</label><input id="f-${name}" name="${name}" value="${esc(value)}" ${options}></div>`;
const area = (label, name, value = '', required = false) => `<div class="field"><label for="f-${name}">${label}</label><textarea id="f-${name}" name="${name}" maxlength="100000" ${required ? 'required' : ''}>${esc(value)}</textarea></div>`;
const submit = label => `<div class="form-actions"><button type="button" data-cancel>닫기</button><button type="submit" class="primary">${label}</button></div>`;
function formHandler(fn) {
  $('[data-cancel]').onclick = () => closeModal();
  $('#edit-form').onsubmit = async e => {
    e.preventDefault(); if (busy) return;
    const btn = e.submitter; if (btn) btn.disabled = true;
    try { const ok = await fn(new FormData(e.target)); if (ok) closeModal(true); }
    catch (e) { showError(e.message); }
    finally { if (btn?.isConnected) btn.disabled = false; }
  };
}
function recordEditor(type, bookId, id, answerOnly = false) {
  const b = state.books.find(b => b.id === bookId); if (!b) return;
  const existing = b[type].find(e => e.id === id);
  const question = type === 'questions';
  openModal(answerOnly ? '지금의 답 남기기' : `${question ? '질문' : '문장'} ${existing ? '수정' : '남기기'}`, `<p class="hint">${esc(b.title)}</p><form id="edit-form">${answerOnly ? `<p class="record-text">${esc(existing.text)}</p>${area('지금 떠오른 답', 'answer', existing.answer)}` : `${area(question ? '읽다가 생긴 물음' : '오래 두고 싶은 문장', 'text', existing?.text, true)}${!question ? `${field('페이지 · 선택','page',existing?.page,'maxlength="50" placeholder="예: 42 또는 42–43"')}${area('내 생각 · 선택','note',existing?.note)}` : ''}`}${submit('기록 저장')}</form>`, `${bookId}:${type}:${id || 'new'}:${answerOnly}`);
  formHandler(data => change(s => {
    const target = s.books.find(x => x.id === bookId)[type];
    if (answerOnly) { const q = target.find(x => x.id === id); q.answer = data.get('answer').trim(); q.answeredAt = q.answer ? now() : ''; }
    else {
      const content = data.get('text').trim(); if (!content) throw new Error('기록할 내용을 입력해주세요.');
      const values = question ? {text:content} : {text:content,page:data.get('page').trim(),note:data.get('note').trim()};
      if (existing) Object.assign(target.find(x => x.id === id), values);
      else target.push({ id:uid(),createdAt:now(),...values,...(question ? {answer:'',answeredAt:''} : {}) });
    }
  }));
}
function journalEditor(id) {
  const item = state.thoughts.find(x => x.id === id);
  openModal(`생각 ${item ? '수정' : '남기기'}`, `<form id="edit-form">${area('지금 떠오른 것','text',item?.text,true)}${submit('기록 저장')}</form>`, `thoughts:${id || 'new'}`);
  formHandler(data => change(s => {
    const text = data.get('text').trim();
    if (!text) throw new Error('빈칸을 채워주세요.');
    if (item) s.thoughts.find(x => x.id === id).text = text;
    else s.thoughts.push({id:uid(),createdAt:now(),text});
  }));
}
// 슬라임의 질문에 답하기 — 생각 탭이 아니라 '답'으로 따로 모읍니다
function answerEditor(prompt, id) {
  const item = state.answers.find(x => x.id === id); if (item) prompt = item.prompt;
  openModal(item ? '답 고치기' : `${esc(state.profile.catName || '슬라임')}의 질문`, `<p class="prompt">${esc(prompt)}</p><form id="edit-form">${area('본 대로, 판단 없이','text',item?.text,true)}${submit(item ? '변경 저장' : '답 남기기')}</form>`, `answer:${id || 'new'}`);
  formHandler(data => change(s => {
    const text = data.get('text').trim();
    if (!text) throw new Error('빈칸을 채워주세요.');
    if (item) s.answers.find(x => x.id === id).text = text;
    else s.answers.push({ id: uid(), createdAt: now(), prompt, text });
  }, item ? '답을 고쳤습니다.' : '답을 남겼습니다.'));
}
const radios = (label, name, options, value, optional = true) => `<fieldset class="field pick ${optional ? 'optional' : ''}"><legend>${label}${optional ? ' · 선택' : ''}</legend><div class="chips">${options.map(([v,l]) => `<label class="chip-radio"><input type="radio" name="${name}" value="${v}" ${value === v ? 'checked' : ''}><span>${esc(l)}</span></label>`).join('')}</div></fieldset>`;
function profileEditor() {
  const p = state.profile, first = !p.catName;
  openModal(first ? '슬라임과 처음 만나기' : '슬라임 설정', `<p class="hint">이 슬라임은 나를 닮아 갑니다. 좋은 답도 나쁜 답도 없으니, 본 대로만 알려 주세요.</p><form id="edit-form">${field('슬라임 이름','catName',p.catName,'required maxlength="30" placeholder="예: 보리"')}${radios('슬라임 말투','tone',[['we','“우리 오늘 뭘 봤지?”'],['you','“오늘 뭘 봤어?”']],p.tone,false)}${submit(first ? '만나서 반가워' : '저장')}</form>`);
  formHandler(data => {
    const catName = data.get('catName').trim(); if (!catName) throw new Error('슬라임 이름을 지어 주세요.');
    return change(s => { s.profile = { ...s.profile, catName, tone: data.get('tone') === 'you' ? 'you' : 'we' }; }, first ? `${catName}, 만나서 반가워.` : '슬라임 설정을 저장했습니다.');
  });
}

async function deleteRecord(type, bookId, id) {
  const parent = bookId ? state.books.find(b => b.id === bookId) : state;
  const collection = parent?.[type]; if (!collection) return;
  const index = collection.findIndex(x => x.id === id), item = structuredClone(collection[index]); if (!item) return;
  const ok = await change(s => { const p = bookId ? s.books.find(b => b.id === bookId) : s; p[type] = p[type].filter(x => x.id !== id); },'');
  if (ok) notice('기록을 삭제했습니다.',async () => {
    const success = await change(s => { const p = bookId ? s.books.find(b => b.id === bookId) : s; if (!p) throw new Error('책이 삭제되었습니다. 보관함에서 직전 상태를 확인해주세요.'); if (!p[type].some(x => x.id === id)) p[type].splice(index,0,item); },'기록을 되돌렸습니다.');
    if (success) undoAction = null;
  });
}
function deleteBook() {
  const b = currentBook(); if (!b) return;
  openModal('책을 삭제할까요?',`<p>『${esc(b.title)}』의 문장 ${b.entries.length}개와 질문 ${b.questions.length}개도 함께 삭제됩니다.</p><p class="hint">삭제 직후 되돌리거나, 보관함에서 직전 저장 상태를 복원할 수 있습니다.</p><form id="edit-form">${submit('책 삭제')}</form>`);
  formHandler(async () => {
    const index = state.books.findIndex(x => x.id === b.id), copy = structuredClone(b);
    const ok = await change(s => { s.books = s.books.filter(x => x.id !== b.id); },'');
    if (ok) { location.hash = 'shelf'; notice('책을 삭제했습니다.',() => change(s => { if (!s.books.some(x => x.id === copy.id)) s.books.splice(index,0,copy); },'책을 되돌렸습니다.')); }
    return ok;
  });
}
function download(content, filename) {
  const url = URL.createObjectURL(new Blob([content],{type:'application/json'}));
  const a = document.createElement('a'); a.href = url; a.download = filename; a.click(); setTimeout(() => URL.revokeObjectURL(url),10000);
}
function exportState(data = state, prefix = 'my-slime') { download(backup(data),`${prefix}-${new Date().toISOString().slice(0,10)}.json`); }
function aiStatus() {
  const all = aiSources(), done = all.filter(x => state.readings[x.id]?.h === x.h).length;
  const today = state.insights?.date === todayKey() ? ` 오늘의 말 ${state.insights.lines.length}줄을 만들어 뒀습니다.` : '';
  return state.profile.aiConsentAt ? `${all.length}개 중 ${done}개를 읽었습니다.${today}${readBackoff > Date.now() || reflectBackoff > Date.now() ? ' 지금은 연결이 안 돼서 잠시 뒤 다시 시도합니다.' : ''}` : '꺼져 있습니다. 켜기 전까지는 아무것도 보내지 않습니다.';
}
function settings() {
  const s = stats(state);
  openModal('기록 보관함',`<p class="hint">책 ${s.books}권 · 문장 ${s.entries}개 · 질문 ${s.questions}개<br>생각 ${s.thoughts}개 · 슬라임에게 한 답 ${s.answers}개</p><p>기록은 이 기기의 브라우저에 저장됩니다.<br>휴대폰과 PC 사이에 자동으로 공유되지는 않습니다.</p><div class="storage-block"><h3>슬라임이 기록 읽기</h3><p class="hint">켜면 내가 쓴 <b>생각, 슬라임에게 한 답, 책 문장에 단 내 생각</b>을 AI(Anthropic Claude)에게 보내 주제어를 붙입니다. 책에서 옮겨 적은 문장은 보내지 않습니다. 중계소는 글을 저장하지 않고, 주제어는 이 기기에만 남습니다. 언제든 끌 수 있습니다.</p><button id="ai-toggle" class="${state.profile.aiConsentAt ? '' : 'primary'}">${state.profile.aiConsentAt ? '끄기' : '켜기'}</button><p class="hint" id="ai-status">${aiStatus()}</p></div><div class="storage-block"><h3>슬라임</h3><p class="hint">이름과 말투를 고칩니다.</p><button id="cat-profile">슬라임 설정</button></div><div class="storage-block"><h3>파일로 남겨두기</h3><p class="hint">직접 올린 표지 사진까지 포함해 내려받습니다. 검색으로 연결한 표지는 주소가 저장되어 인터넷 연결이 필요합니다.</p><button class="primary" id="export">전체 기록 내보내기</button></div><div class="storage-block"><h3>백업에서 가져오기</h3><p class="hint">이전 기록장의 JSON 파일도 읽을 수 있습니다. 파일을 고르면 복원할 내용을 먼저 보여드립니다.</p><label class="file-label">백업 파일 선택<input class="visually-hidden" type="file" id="import" accept=".json,application/json"></label><div id="restore-area"></div></div><div class="storage-block"><h3>직전 저장 상태</h3><p class="hint">바로 전 저장으로 돌아갑니다. 복원 시 현재 기록도 파일로 내려받습니다.</p><button id="previous">직전 상태 확인</button></div><div class="storage-block"><h3>오래 보관하기</h3><p class="hint">브라우저 데이터를 지우면 기록도 지워집니다. 중요한 기록은 파일로도 보관해주세요.</p><button id="persistent">브라우저에 보관 요청</button><p class="hint" id="persistent-status"></p></div>`);
  $('#cat-profile').onclick = () => profileEditor();
  $('#ai-toggle').onclick = async () => {
    const on = !state.profile.aiConsentAt;
    if (await change(s => { s.profile.aiConsentAt = on ? now() : ''; }, on ? '슬라임이 기록을 읽기 시작합니다.' : '슬라임이 기록 읽기를 멈췄습니다.')) {
      $('#ai-toggle').textContent = on ? '끄기' : '켜기'; $('#ai-toggle').classList.toggle('primary', !on); $('#ai-status').textContent = aiStatus();
      if (on) { readBackoff = 0; await readRecords(); if ($('#ai-status')) $('#ai-status').textContent = aiStatus(); }
    }
  };
  $('#export').onclick = () => exportState();
  $('#import').onchange = async e => {
    const f = e.target.files[0]; if (!f) return;
    try {
      if (f.size > 80 * 1024 * 1024) throw new Error('80MB 이하의 백업 파일을 선택해주세요.');
      const restored = normalize(JSON.parse(await f.text()));
      if (!dialog.open || !$('#restore-area')) return;
      previewRestore(restored,'파일의 기록');
    } catch(e) { showError(`복원하지 않았습니다. ${e.message}`); }
  };
  $('#previous').onclick = async () => {
    try { const data = await previous(db); if (!data) throw new Error('이전 저장 상태가 없습니다.'); previewRestore(data,'직전 저장 기록'); }
    catch(e) { showError(e.message); }
  };
  $('#persistent').onclick = async () => {
    try { const ok = await navigator.storage?.persist?.(); $('#persistent-status').textContent = ok ? '브라우저가 지속 보관 요청을 승인했습니다. 파일 백업도 함께 보관해주세요.' : '이 브라우저에서는 보관 요청이 승인되지 않았습니다. 파일 백업을 이용해주세요.'; }
    catch { $('#persistent-status').textContent = '보관 요청을 처리하지 못했습니다. 파일 백업을 이용해주세요.'; }
  };
}
function previewRestore(data,label) {
  const s = stats(data);
  $('#form-error').textContent = '';
  $('#restore-area').innerHTML = `<div class="restore-preview"><b>${label}</b><p>책 ${s.books}권 · 문장 ${s.entries}개 · 질문 ${s.questions}개<br>생각 ${s.thoughts}개 · 답 ${s.answers}개</p><p>현재 기록 전체를 이 내용으로 교체합니다.<br>교체 전 현재 기록은 백업 파일로 내려받습니다.</p><button id="confirm-restore" class="primary">현재 기록 백업 후 교체</button></div>`;
  $('#confirm-restore').onclick = async e => {
    e.target.disabled = true; exportState(state,'before-restore');
    const ok = await change(s => Object.assign(s,structuredClone(data)),'기록을 복원했습니다.');
    if (ok) { closeModal(true); query = ''; location.hash = 'shelf'; render(); }
    else if ($('#confirm-restore')) $('#confirm-restore').disabled = false;
  };
}
document.addEventListener('click', e => {
  if (busy || !ready) return;
  const btn = e.target.closest('button'); if (!btn) return;
  if (btn.dataset.filter) { filter = btn.dataset.filter; renderShelf(); }
  if (btn.dataset.entryTab) { entryTab = btn.dataset.entryTab; renderBook(); }
  if (btn.dataset.questionFilter) { questionFilter = btn.dataset.questionFilter; renderQuestions(); }
  const {action,id,book,type} = btn.dataset;
  switch(action) {
    case 'add-book': bookEditor(); break;
    case 'edit-book': bookEditor(currentBook()); break;
    case 'toggle-status': { const b = currentBook(); change(s => { const x = s.books.find(x => x.id === b.id); x.status = b.status === 'reading' ? 'finished' : 'reading'; x.finishedAt = x.status === 'finished' ? now() : ''; }); break; }
    case 'delete-book': deleteBook(); break;
    case 'add-record': recordEditor(entryTab,currentBook().id); break;
    case 'edit-record': recordEditor(type,book,id); break;
    case 'answer': recordEditor('questions',book,id,true); break;
    case 'delete-record': deleteRecord(type,book,id); break;
    case 'add-journal': journalEditor(); break;
    case 'edit-journal': journalEditor(id); break;
    case 'clear-query': query = ''; renderBook(); break;
    case 'profile': profileEditor(); break;
    case 'cat-answer': answerEditor(btn.dataset.prompt); break;
    case 'edit-answer': answerEditor('', id); break;
    case 'cat-book': recordEditor('entries', book); break;
    case 'cat-skip': skip(btn.dataset.slot); break;
  }
  if (btn.id === 'ask-fab') { askOpen = !askOpen; syncAsk(); }
});
$('#settings').onclick = () => { if (ready && !busy) settings(); };
window.addEventListener('hashchange',() => { if (dialog.open) closeModal(); render(); window.scrollTo(0,0); });
window.addEventListener('beforeunload',e => { if (busy) { e.preventDefault(); e.returnValue = ''; } });
channel && (channel.onmessage = async e => {
  if (e.data <= revision) return;
  if (dialog.open || busy) { notice('다른 창에서 기록이 변경됐습니다. 작성 내용을 복사한 뒤 새로고침해주세요.'); return; }
  try { const loaded = await load(db); state = loaded.state; revision = loaded.revision; render(); notice('다른 창의 기록을 불러왔습니다.'); } catch(e) { showError(e.message); }
});
async function init() {
  try {
    db = await openStore(); const loaded = await load(db); state = loaded.state; revision = loaded.revision; ready = true;
    // 2026-10-10 슬라임의 질문에 답한 '쇼츠볼때'가 생각 탭에 잘못 들어갔던 것 한 건만 지웁니다 (사용자 요청)
    const stray = state.thoughts.find(t => t.text.replace(/\s/g, '') === '쇼츠볼때' && (t.createdAt || '').startsWith('2026-10-10'));
    setTimeout(readRecords, 1500); window.addEventListener('online', () => { readBackoff = 0; readRecords(); });
    if (stray) await change(s => { s.thoughts = s.thoughts.filter(t => t.id !== stray.id); }, '');
    render(); status('이 브라우저에 저장됨');
    if (loaded.migrated || loaded.upgraded) notice('이전 기록을 모두 가져왔습니다. 원본 데이터도 그대로 보관했습니다.');
    if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('./sw.js').then(() => { status('이 브라우저에 저장됨'); }).catch(() => { status('저장 가능 · 오프라인 준비 실패'); });
  } catch(e) {
    status('불러오기 실패 · 원본 보존됨',true);
    $('#main').innerHTML = `<div class="empty"><h2>기록을 안전하게 열지 못했습니다</h2><p>${esc(e.message)}</p><p>기존 기록은 덮어쓰지 않았습니다. 원본을 내려받아 보관해주세요.</p><button id="download-original">이전 원본 내려받기</button><p class="hint">파일을 직접 열었다면, 로컬 서버 또는 배포된 주소로 접속해주세요.</p></div>`;
    $('#download-original').onclick = () => { try { const raw = localStorage.getItem('onemonth_v1'); if (raw) download(raw,'original-onemonth.json'); else notice('이 브라우저에 이전 기록이 없습니다.'); } catch(e) { notice(e.message); } };
  }
}
init();
