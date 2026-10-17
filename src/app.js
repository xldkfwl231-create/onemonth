import { uid, now, emptyState, normalize, backup, stats, matchesBook, dateLabel, safeCover, emptyUsage, dayOf, isIso, boardGraph, seenSelf } from './core.js';
import { mountSlime } from './slime.js';
import { mountBoard, BOARD_COLORS } from './board.js';
import { openStore, load, commit, previous } from './storage.js';
import { BOOK_SEARCH_ENDPOINT, AI_ENDPOINT, AI_SUMMARY_ENDPOINT, AI_CHAT_ENDPOINT, AI_TITLES_ENDPOINT } from './config.js';

const BUILD = '1017h';   // 폰에서 어떤 판을 보고 있는지 확인용
const $ = s => document.querySelector(s), $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
// 이름 뒤 조사 — 받침이 있으면 이/과, 없으면 가/와 (뚱이가, 말랑이)
const batchim = w => { const c = String(w || '').trim().slice(-1).charCodeAt(0); return c >= 0xac00 && c <= 0xd7a3 && (c - 0xac00) % 28 > 0; };
const ig = w => w + (batchim(w) ? '이' : '가'), wa = w => w + (batchim(w) ? '과' : '와');
let state = emptyState(), db, revision = 0, busy = false, ready = false;
let filter = 'all', query = '', entryTab = 'entries', questionFilter = 'open', focusRec = '', talkFilter = 'all';
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
  if (board && page !== 'board') { board.destroy(); board = null; }
  if (page !== 'home') document.body.classList.remove('night');
  const tab = { board:'home', book:'shelf', questions:'shelf', shelf:'shelf', thoughts:'thoughts', me:'me', answers:'talk', talk:'talk' }[page] || 'home';
  document.querySelectorAll('[data-nav]').forEach(a => { if (a.dataset.nav === tab) a.setAttribute('aria-current','page'); else a.removeAttribute('aria-current'); });
  document.body.dataset.page = page;
  const desk = page === 'talk' && !!route().id;
  document.body.classList.toggle('pc', desk && pcMode());
  document.body.classList.toggle('desk-on', desk && (pcMode() || matchMedia('(min-width: 760px)').matches));
  if (!desk) { ctxOpen = false; document.body.classList.remove('ctx-open'); }
  if (page === 'book') renderBook();
  else if (page === 'questions') renderQuestions();
  else if (page === 'thoughts') renderThoughts();
  else if (page === 'answers') { talkFilter = 'ask'; renderTalks(); }   // 예전 '슬라임에게 한 답' 주소
  else if (page === 'me') renderMe();
  else if (page === 'talk') { if (route().id) renderTalk(route().id); else renderTalks(); }
  else if (page === 'shelf') renderShelf();
  else if (page === 'board') renderBoard();
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
let slime = null, saidToday = new Set(), lastFed = '';   // lastFed: 방금 먹인 생각 — 주제어가 붙으면 맛을 말해 줍니다
// 이름이 없으면 이름을 묻고, 처음 한 번은 다루는 법을 알려 줍니다
const guideSeen = () => { try { return localStorage.getItem('guide-seen') === '1'; } catch { return true; } };
const nameBubble = () => state.profile.catName ? (guideSeen() ? '' : `<div class="bubble"><p class="bubble-text">나는 꾹 누르면 터지고, 흔들면 날아가. 다루는 법을 알려 줄까?</p><div class="bubble-actions"><button class="primary" data-action="guide-open">다루는 법 보기</button><button class="quiet" data-action="guide-ok">알겠어</button></div></div>`) : `<div class="bubble"><p class="bubble-text">안녕. 나는 아직 이름이 없는 슬라임이야. 이름을 지어 줄래?</p><div class="bubble-actions"><button class="primary" data-action="profile">이름 지어 주기</button></div></div>`;
// 생각 먹이기 — 주제 없이 떠오른 걸 적으면 생각 탭에 남고, 슬라임 안에 방울로 떨어집니다
const feedDraft = { get: () => { try { return localStorage.getItem('feed-draft') || ''; } catch { return ''; } }, set: v => { try { v ? localStorage.setItem('feed-draft', v) : localStorage.removeItem('feed-draft'); } catch {} } };
function feedHtml() {
  const name = state.profile.catName || '슬라임';
  return `<form class="feed" id="feed-form"><label class="visually-hidden" for="feed-input">${esc(name)}에게 먹일 생각</label><textarea id="feed-input" rows="1" maxlength="5000" placeholder="떠오른 생각을 적으면 ${esc(ig(name))} 먹어요">${esc(feedDraft.get())}</textarea><button class="primary" type="submit" aria-label="먹이기"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V6M6.5 11.5 12 6l5.5 5.5" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg></button></form>`;
}
function wireFeed() {
  const form = $('#feed-form'), input = $('#feed-input'); if (!form) return;
  const grow = () => { input.style.height = 'auto'; input.style.height = Math.min(150, input.scrollHeight) + 'px'; form.classList.toggle('has-text', !!input.value.trim()); };
  input.oninput = () => { feedDraft.set(input.value); grow(); }; grow();
  input.onkeydown = e => { if (e.key === 'Enter' && !e.isComposing && ((enterSendsPref() && !e.shiftKey) || e.ctrlKey || e.metaKey)) { e.preventDefault(); form.requestSubmit(); } };
  form.onsubmit = async e => {
    e.preventDefault(); const text = input.value.trim(); if (!text || busy) return;
    const id = uid();
    if (!await change(s => { s.thoughts.push({ id, createdAt: now(), text, more: [] }); }, '')) return;
    input.value = ''; feedDraft.set(''); grow(); input.blur();   // 키보드를 내려 슬라임이 먹는 걸 보이게
    lastFed = id;
    showSay(say(['냠. 잘 먹었어. 생각 탭에 넣어 둘게.', '냠. 잘 먹었어. 생각 탭에 넣어 둘게.']));
  };
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
  if (pokes < 2 || Math.random() > 0.35) return;
  let dayCount = 0; try { dayCount = Number(localStorage.getItem(`slime-said:${todayKey()}`) || 0); } catch {}
  if (dayCount >= 3) return;
  const lines = sayLines().filter(l => !saidToday.has(l)); if (!lines.length) return;
  const line = lines[Math.floor(Math.random() * lines.length)]; saidToday.add(line);
  try { localStorage.setItem(`slime-said:${todayKey()}`, String(dayCount + 1)); } catch {}
  showSay(line);
}
// 슬라임이 먹은 기록 — 생각, 책 문장, 슬라임에게 한 답. 오래된 것부터.
// ── AI 사용량 ── 요청마다 아래에 잠깐 보여 주고, '나'에 모아 둡니다. 값은 Claude Haiku 5.5 기준 대략치.
const USAGE_LABEL = { tags: '주제어 붙이기', titles: '문장 제목', chat: '이야기', summary: '책 정리', reflect: '오늘의 말(예전)' };
const PRICE = { input: 0.10 / 1e6, output: 0.50 / 1e6 };
const dollars = u => (u.input * PRICE.input + u.output * PRICE.output);
const WON_PER_USD = 1400;   // 대략 환율 — 정확한 값이 필요하면 여기만 고치면 됩니다
const fmtWon = usd => { const w = usd * WON_PER_USD; return w < 1 ? `${w.toFixed(1)}원` : w < 100 ? `${w.toFixed(1).replace(/\.0$/, '')}원` : `${Math.round(w).toLocaleString()}원`; };
function addUsage(s, kind, u) {
  if (!u || !Number.isFinite(u.input)) return;
  s.usage ||= emptyUsage(); if (!s.usage.since) s.usage.since = now();
  s.usage.calls++; s.usage.input += u.input || 0; s.usage.output += u.output || 0;
  const k = (s.usage.byKind[kind] ||= { calls: 0, input: 0, output: 0 }); k.calls++; k.input += u.input || 0; k.output += u.output || 0;
}
function flashUsage(kind, u) {
  const el = $('#usage-pill'); if (!el || !u || !Number.isFinite(u.input)) return;
  el.textContent = `${USAGE_LABEL[kind] || 'AI'} · 입력 ${u.input.toLocaleString()} · 출력 ${(u.output || 0).toLocaleString()} 토큰 · 약 ${fmtWon(dollars({ input: u.input, output: u.output || 0 }))}`;
  el.hidden = false; requestAnimationFrame(() => el.classList.add('show'));
  clearTimeout(flashUsage.t); flashUsage.t = setTimeout(() => { el.classList.remove('show'); setTimeout(() => { el.hidden = true; }, 350); }, 3500);
}
// ── 슬라임이 기록 읽기 (AI) ──────────────────────────────────
// 보내는 것: 생각, 슬라임에게 한 답, 책 문장에 단 '내 생각'. 책에서 옮겨 적은 문장은 보내지 않습니다.
const textHash = t => { let h = 5381; for (let i = 0; i < t.length; i++) h = ((h << 5) + h + t.charCodeAt(i)) | 0; return String(h >>> 0); };
function aiSources() {
  const out = [];
  for (const t of state.thoughts) out.push({ id: t.id, text: [t.text, ...(t.more || []).map(m => m.text)].join('\n') });
  for (const a of state.answers) out.push({ id: a.id, text: `질문: ${a.prompt}\n답: ${[a.text, ...(a.more || []).map(m => m.text)].join('\n')}` });
  for (const b of state.books) for (const e of b.entries) { const mine = [e.note, ...(e.more || []).map(m => m.text)].filter(Boolean).join('\n'); if (mine) out.push({ id: e.id, text: `책 『${b.title}』을 읽다가 남긴 내 생각: ${mine}` }); }
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
  if (!todo.length) return;
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
      addUsage(s, 'tags', body.usage);
    }, '');
    flashUsage('tags', body.usage);
    const tag = lastFed && state.readings[lastFed]?.tags?.[0];
    if (tag && route().page === 'home') { lastFed = ''; setTimeout(() => showSay(`음… #${tag} 맛이 나.`), 1200); }
  } catch { readBackoff = Date.now() + 5 * 60e3; }
  finally { reading = false; }
}
// 문장 제목 — 이야기 목록에서 알아보기 쉽게, 책에서 옮긴 문장마다 슬라임이 짧은 제목을 붙여 둡니다.
// 문장을 고치면 다시 붙입니다. 제목을 못 받은 문장도 빈 제목으로 적어 두어 같은 문장을 되풀이해 보내지 않습니다.
let titling = false, titleBackoff = 0;
async function titleEntries(book) {
  if (titling || !ready || busy || !state.profile.aiConsentAt || !AI_TITLES_ENDPOINT || !navigator.onLine || Date.now() < titleBackoff) return;
  const todo = book.entries.filter(e => state.titles[e.id]?.h !== textHash(e.text)).slice(0, 30);
  if (!todo.length) return;
  titling = true;
  try {
    const res = await fetch(AI_TITLES_ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ book: book.title, items: todo.map(e => ({ id: e.id, text: e.text })) }), signal: AbortSignal.timeout(30000) });
    if (!res.ok) throw new Error(String(res.status));
    const body = await res.json(); if (!Array.isArray(body?.items)) throw new Error('bad reply');
    const got = new Map(body.items.map(x => [x.id, x.title]));
    titling = false;
    await change(s => {
      const live = new Set(s.books.flatMap(b => b.entries.map(e => e.id)));
      for (const id of Object.keys(s.titles)) if (!live.has(id)) delete s.titles[id];   // 지운 문장의 제목도 정리
      for (const e of todo) s.titles[e.id] = { t: typeof got.get(e.id) === 'string' ? got.get(e.id).slice(0, 24) : '', h: textHash(e.text) };
      addUsage(s, 'titles', body.usage);
    }, '');
  } catch { titleBackoff = Date.now() + 10 * 60e3; }
  finally { titling = false; }
}
// 요즘(60일) 가장 많은 주제가 슬라임 겉색에 스밉니다
function slimeLook() {
  const top = tagCounts(60), total = top.reduce((n, x) => n + x[1], 0);
  if (!top.length || total < 3 || top[0][0] === '독서' && top.length === 1) return { color: '#a9d3a4' };
  const [tag, count] = top[0], share = count / total;
  let h = 5381; for (const c of tag) h = ((h << 5) + h + c.charCodeAt(0)) | 0;
  // 색은 색상환을 따라 옮깁니다 — RGB로 섞으면 반대색끼리 흙빛이 됨
  const target = (h >>> 0) % 360, k = Math.min(0.55, share * 1.1), base = 113;
  const diff = ((target - base + 540) % 360) - 180, hue = (base + diff * k + 360) % 360;
  const sat = 0.42, light = 0.73, c = (1 - Math.abs(2 * light - 1)) * sat, x = c * (1 - Math.abs((hue / 60) % 2 - 1)), m = light - c / 2;
  const [r1, g1, b1] = hue < 60 ? [c, x, 0] : hue < 120 ? [x, c, 0] : hue < 180 ? [0, c, x] : hue < 240 ? [0, x, c] : hue < 300 ? [x, 0, c] : [c, 0, x];
  return { color: '#' + [r1, g1, b1].map(v => Math.round((v + m) * 255).toString(16).padStart(2, '0')).join(''), tag };
}
const tagLine = id => { const t = state.readings[id]?.tags; return t?.length ? `<p class="tag-line">${t.map(x => `<span>#${esc(x)}</span>`).join('')}</p>` : ''; };
function beadList() {
  const t = v => isIso(v) ? Date.parse(v) : 0;
  return [
    ...state.thoughts.map(x => ({ id: x.id, kind: 'thought', at: t(x.createdAt) })),
    ...state.books.flatMap(b => b.entries.map(x => ({ id: x.id, kind: 'entry', at: t(x.createdAt) }))),
    ...state.answers.map(x => ({ id: x.id, kind: 'answer', at: t(x.createdAt) })),
    ...state.thoughts.flatMap(x => (x.more || []).map(m => ({ id: m.id, kind: 'thought', at: t(m.createdAt), parent: x.id }))),
    ...state.answers.flatMap(x => (x.more || []).map(m => ({ id: m.id, kind: 'answer', at: t(m.createdAt), parent: x.id }))),
    ...state.books.flatMap(b => b.entries.flatMap(x => (x.more || []).map(m => ({ id: m.id, kind: 'entry', at: t(m.createdAt), parent: x.id }))))
  ].map(b => ({ ...b, tag: state.readings[b.parent || b.id]?.tags?.[0] })).sort((a, b) => a.at - b.at);
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
  for (const x of [...state.thoughts, ...state.answers, ...state.books.flatMap(b => b.entries)]) { const m = (x.more || []).find(y => y.id === id); if (m) return `${dateLabel(m.createdAt)}에 덧붙인 말. “${m.text.length > 70 ? m.text.slice(0, 70) + '…' : m.text}”`; }
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
// 첫 화면 위쪽의 작은 띠: 슬라임 이름표(누르면 '나')와 오늘 날짜(밤엔 달)
function homeTop() {
  const name = state.profile.catName || '나만의 슬라임', look = slimeLook(), n = beadList().length;
  const d = new Date(), day = d.toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric', weekday: 'short' });
  const icon = isNight()
    ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 14.5A7.5 7.5 0 0 1 9.5 5a7.5 7.5 0 1 0 9.5 9.5z" fill="currentColor"/></svg>'
    : '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4.2" fill="currentColor"/><path d="M12 2.5v2.6M12 18.9v2.6M2.5 12h2.6M18.9 12h2.6M5.3 5.3l1.8 1.8M16.9 16.9l1.8 1.8M5.3 18.7l1.8-1.8M16.9 7.1l1.8-1.8" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
  const map = `<button class="home-map" data-action="open-board" aria-label="기록 지도 펼치기" title="기록 지도 — 슬라임을 꾹 눌러도 펼쳐져요"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="6" cy="7" r="2.4" fill="currentColor"/><circle cx="18" cy="6" r="2" fill="currentColor"/><circle cx="12" cy="14" r="3" fill="currentColor"/><circle cx="5.5" cy="19" r="1.8" fill="currentColor"/><circle cx="19" cy="18" r="2.2" fill="currentColor"/><path d="M6 7l6 7 6-8M12 14l-6.5 5M12 14l7 4" stroke="currentColor" stroke-width="1.6" fill="none"/></svg></button>`;
  return `<a class="home-name" href="#me" aria-label="${esc(name)} — 나 화면으로">${miniSlime(look.color)}<b>${esc(name)}</b><span>방울 ${n}${look.tag ? ` · #${esc(look.tag)}` : ''}</span></a><span class="home-right">${map}<span class="home-day">${icon}${esc(day)}</span></span>`;
}
function renderHome() {
  // 슬라임이 떠 있는 동안에는 말풍선만 바꿉니다 — 출렁이던 게 멈추지 않도록
  if (slime && $('#slime-stage')) { $('#home-bubble').innerHTML = nameBubble(); $('#home-bubble').hidden = !nameBubble(); syncBeads(); $('#home-top').innerHTML = homeTop(); syncBackupNudge(); return; }
  $('#main').innerHTML = `<section class="slime-home" aria-label="슬라임">
    <div class="home-top" id="home-top">${homeTop()}</div>
    <div class="backup-slot" id="backup-nudge">${backupNudgeHtml()}</div>
    <div class="slime-stage" id="slime-stage"><div class="slime-say" id="slime-say" role="status" hidden></div></div>
    <div class="home-bubble" id="home-bubble" ${nameBubble() ? '' : 'hidden'}>${nameBubble()}</div>
    ${feedHtml()}
  </section>`;
  wireFeed();
  try { slime = mountSlime($('#slime-stage'), { onPoke: maybeSay, onBead: id => showSay(beadText(id)), onDoubleTap: () => $('#feed-input')?.focus(), onSwell: () => showSay(say(['꾹… 더 누르면 터질 것 같아!', '꾹… 더 누르면 터질 것 같아!'])), onPop: popToBoard, reduced: matchMedia('(prefers-reduced-motion: reduce)').matches }); syncBeads(); syncNight(); }
  catch (e) { $('#slime-stage').innerHTML = `<p class="empty">이 브라우저에서는 슬라임을 그릴 수 없습니다.<br><small>${esc(e.message)}</small></p>`; }
}
// ── 기록 지도 ── 슬라임이 터지면 안에 있던 기록들이 주제어로 이어진 지도로 펼쳐집니다
let board = null;
function popToBoard() {
  const stage = $('#slime-stage'); if (!stage) { location.hash = 'board'; return; }
  const r = stage.getBoundingClientRect(), burst = document.createElement('div');
  burst.className = 'burst'; burst.style.left = r.left + r.width / 2 + 'px'; burst.style.top = r.top + r.height * 0.52 + 'px';
  const colors = Object.values(BOARD_COLORS);
  burst.innerHTML = Array.from({ length: 22 }, (_, i) => { const a = i / 22 * Math.PI * 2 + Math.random() * 0.3, d = 90 + Math.random() * 120; return `<i style="--x:${Math.cos(a) * d}px;--y:${Math.sin(a) * d}px;background:${colors[i % colors.length]};--s:${0.6 + Math.random() * 0.8}"></i>`; }).join('') + '<b></b>';
  document.body.append(burst);
  setTimeout(() => { location.hash = 'board'; }, 420);
  setTimeout(() => burst.remove(), 1000);
}
function boardCardHtml(n) {
  if (!n) return '';
  const name = state.profile.catName || '슬라임', kindName = { entry: '문장', question: '질문', thought: '생각', answer: '물음에 한 답', tag: '주제어', book: '책' }[n.kind];
  const g = boardGraph(state), linked = new Set(g.links.filter(l => l.s === n.id || l.t === n.id).map(l => l.s === n.id ? l.t : l.s));
  const pick = x => `<button class="board-row" data-action="board-pick" data-id="${esc(x.id)}"><i style="background:${BOARD_COLORS[x.kind]}"></i><span>${esc(x.kind === 'tag' ? '#' + x.label : cutN(x.label, 60))}</span></button>`;
  const rel = g.nodes.filter(x => linked.has(x.id));
  if (n.kind === 'tag') return `<p class="board-kind"><i style="background:${BOARD_COLORS.tag}"></i>주제어</p><h2>#${esc(n.label)}</h2><p class="hint">이 주제어가 붙은 기록 ${rel.length}개</p><div class="board-list">${rel.map(pick).join('')}</div>`;
  if (n.kind === 'book') { const b = state.books.find(x => x.id === n.ref); return `<p class="board-kind"><i style="background:${BOARD_COLORS.book}"></i>책</p><h2>『${esc(n.label)}』</h2><p class="hint">문장 ${b?.entries.length || 0} · 질문 ${b?.questions.length || 0}</p><div class="board-actions">${b ? talkButton('book', b.id) : ''}<a class="text-link" href="#book/${esc(n.ref)}">책 열기 ›</a></div><div class="board-list">${rel.map(pick).join('')}</div>`; }
  const b = n.book && state.books.find(x => x.id === n.book), talkKindOf = { entry: 'entry', question: 'question', thought: 'thought', answer: 'answer' }[n.kind];
  return `<p class="board-kind"><i style="background:${BOARD_COLORS[n.kind]}"></i>${kindName}${b ? ` · 『${esc(b.title)}』` : ''} · ${esc(dateLabel(n.at))}</p>${n.prompt ? `<p class="hint">${esc(ig(name))} 물었던 것: ${esc(n.prompt)}</p>` : ''}<p class="board-text">${esc(n.label)}</p>
    <div class="board-actions">${talkButton(talkKindOf, n.id, n.book || '')}<button class="quiet" data-action="board-open" data-kind="${n.kind}" data-id="${esc(n.id)}" data-book="${esc(n.book || '')}">기록 보기</button></div>
    ${rel.length ? `<p class="hint">이어진 것</p><div class="board-list">${rel.map(pick).join('')}</div>` : `<p class="hint">아직 이어진 주제어가 없어요.${state.profile.aiConsentAt ? ' 슬라임이 읽으면 이어집니다.' : ''}</p>`}`;
}
function renderBoard() {
  const g = boardGraph(state), tagged = g.nodes.some(n => n.kind === 'tag');
  const legend = [['entry', '문장'], ['question', '질문'], ['thought', '생각'], ...(state.answers.length ? [['answer', '답']] : []), ['tag', '주제어'], ['book', '책']];
  $('#main').innerHTML = `<section class="board" aria-label="기록 지도">
    <canvas id="board-canvas" role="img" aria-label="기록 ${g.nodes.filter(n => !['tag', 'book'].includes(n.kind)).length}개가 주제어와 책으로 이어진 지도. 점을 누르면 아래에 그 기록이 나옵니다."></canvas>
    <div class="board-top"><a class="back" href="#home">← 슬라임</a><h1>기록 지도</h1><button class="tool" data-action="board-fit" aria-label="전체 보기" title="전체 보기"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg></button></div>
    <p class="board-legend">${legend.map(([k, l]) => `<span><i style="background:${BOARD_COLORS[k]}"></i>${l}</span>`).join('')}<span><i class="ring"></i>이야기함</span></p>
    ${!g.nodes.length ? `<div class="board-empty">${empty('아직 펼칠 기록이 없어요', '생각을 먹이거나 책에 문장을 남기면 여기 점으로 생겨요.')}</div>` : !tagged ? `<p class="board-note">${state.profile.aiConsentAt ? '슬라임이 기록을 읽는 중이에요. 주제어가 붙으면 기록끼리 이어집니다.' : '나 → <b>슬라임이 기록 읽기</b>를 켜면 기록이 주제어로 이어져요. 지금은 책끼리만 이어져 있어요.'}</p>` : ''}
    <aside class="board-card" id="board-card" hidden aria-live="polite"></aside>
  </section>`;
  board = mountBoard($('#board-canvas'), { nodes: g.nodes, links: g.links, reduced: matchMedia('(prefers-reduced-motion: reduce)').matches,
    onSelect: n => { const card = $('#board-card'); if (!card) return; card.hidden = !n; card.innerHTML = n ? `<button class="quiet card-close" data-action="board-close" aria-label="닫기">✕</button>${boardCardHtml(n)}` : ''; } });
  $('#board-canvas').__board = board;   // 확인용
  if (boardFocus) { const f = boardFocus; boardFocus = ''; setTimeout(() => board?.select(f), 900); }
}
function renderShelf() {
  $('#main').innerHTML = `<section aria-labelledby="shelf-title"><div class="intro"><div><h1 id="shelf-title">나의 책장</h1><p>읽다가 머문 자리마다, 나만의 기록이 쌓입니다. <a class="text-link" href="#questions">답을 기다리는 질문 ${state.books.reduce((n, b) => n + b.questions.filter(q => !q.answer).length, 0)} ›</a></p></div><button class="primary intro-actions" data-action="add-book">＋ 책 추가</button></div><div class="toolbar"><div class="filters" aria-label="독서 상태">${[['all','전체'],['reading','읽는 중'],['finished','다 읽음']].map(([v,l]) => `<button data-filter="${v}" aria-pressed="${filter === v}">${l}</button>`).join('')}</div><div class="search-field"><label class="visually-hidden" for="local-search">책과 기록 검색</label><input type="search" id="local-search" placeholder="책 제목, 문장, 질문 찾기" value="${esc(query)}"></div></div><div id="shelf-results"></div></section>`;
  shelfResults();
  $('#local-search').oninput = e => { query = e.target.value; shelfResults(); };
}
function shelfResults() {
  const books = state.books.filter(b => (filter === 'all' || b.status === filter) && matchesBook(b, query));
  $('#shelf-results').innerHTML = books.length ? `${query ? `<p class="search-count" role="status">기록을 포함해 ${books.length}권을 찾았습니다.</p>` : ''}<div class="book-grid">${books.map(b => `<a class="book-tile" href="#book/${esc(b.id)}">${cover(b)}<h3>${esc(b.title)}</h3><p class="author">${esc(b.author || '저자 미기록')}</p><div class="counts"><span class="status-tag">${b.status === 'finished' ? '다 읽음' : '읽는 중'}</span>문장 ${b.entries.length} · 질문 ${b.questions.length}</div></a>`).join('')}</div>` : empty(state.books.length ? '아직 이 칸은 비어 있어요' : '첫 책을 놓아보세요', state.books.length ? '다른 검색어나 독서 상태로 찾아보세요.' : '곁에 두고 읽는 책 한 권이면 충분합니다.', !state.books.length ? '<button class="primary" data-action="add-book">내 책 추가하기</button>' : '');
}
// 기록마다 나눈 이야기 — 이야기를 했으면 단추가 '이야기 이어가기 · N마디'로 바뀝니다
const talkOf = (kind, ref) => [...state.chats].reverse().find(c => c.topic.kind === kind && c.topic.ref === ref);
function talkButton(kind, ref, bookId = '', cls = '') {
  const n = talkOf(kind, ref)?.messages.length || 0;
  return `<button class="talk-btn ${n ? 'talked' : ''} ${cls}" data-action="talk-${kind}" data-id="${esc(ref)}"${bookId ? ` data-book="${esc(bookId)}"` : ''}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6.5C4 5.1 5.1 4 6.5 4h11C18.9 4 20 5.1 20 6.5v7c0 1.4-1.1 2.5-2.5 2.5H11l-4.5 3.8V16C5.1 16 4 14.9 4 13.5z" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round"/></svg>${n ? `이어가기 · ${n}마디` : '이야기하기'}</button>`;
}
// 이야기 끝에 기록 아래 덧붙인 말
const moreHtml = list => (list || []).length ? `<div class="more">${list.map(m => `<p>${esc(m.text)}<small>${esc(dateLabel(m.createdAt))}${m.chat ? ' · 이야기에서' : ''}</small><button class="more-del" data-action="delete-more" data-id="${esc(m.id)}" aria-label="덧붙인 말 지우기">×</button></p>`).join('')}</div>` : '';
// 질문의 답: 예전 답이 있으면 '지금은'과 '그땐'으로 나눠 보여 줍니다
function answerHtml(q) {
  const old = q.history || [];
  return `${q.answer ? `<p class="mine answer">${old.length ? '<span class="when">지금은</span>' : ''}${esc(q.answer)}<small>${esc(dateLabel(q.answeredAt))}에 남긴 답</small></p>` : ''}${old.length ? `<details class="then"><summary>그땐 · ${old.length}</summary>${[...old].reverse().map(h => `<p>${esc(h.text)}<small>${esc(dateLabel(h.at))}</small></p>`).join('')}</details>` : ''}`;
}
// 다른 화면에서 돌아올 때 그 기록으로 스크롤
function focusRecord() {
  if (!focusRec) return; const id = focusRec; focusRec = '';
  setTimeout(() => { const el = document.getElementById('rec-' + id); if (el) { el.scrollIntoView({ block: 'center' }); el.classList.add('flash'); setTimeout(() => el.classList.remove('flash'), 2000); } }, 30);   // 화면을 맨 위로 올린 다음에
}
function quoteCard(e, b, type, showBook = false) {
  const question = type === 'questions';
  const from = question && e.from ? b.entries.find(x => x.id === e.from) : null;
  const meta = [showBook ? `<a href="#book/${esc(b.id)}">${esc(b.title)}</a>` : '', !question && e.page ? `p. ${esc(e.page)}` : '', esc(dateLabel(e.createdAt)), question ? (e.answer ? '답을 남김' : '아직 품는 중') : ''].filter(Boolean).join(' · ');
  return `<article class="q ${question ? 'q-question' : ''} ${question && e.answer ? 'answered' : ''}" id="rec-${esc(e.id)}"><span class="mark" aria-hidden="true">${question ? '?' : '“'}</span>${from ? `<p class="q-from">“${esc(from.text.length > 50 ? from.text.slice(0, 50) + '…' : from.text)}”에서 생긴 질문</p>` : ''}<p class="q-text">${esc(e.text)}</p><p class="q-meta">${meta}</p>${e.note ? `<p class="mine">${esc(e.note)}</p>` : ''}${question ? answerHtml(e) : moreHtml(e.more) + tagLine(e.id)}<div class="q-actions">${talkButton(question ? 'question' : 'entry', e.id, b.id)}${question ? `<button data-action="answer" data-book="${b.id}" data-id="${e.id}">${e.answer ? '답 고치기' : '답 남기기'}</button>` : `<button data-action="ask-from" data-book="${b.id}" data-id="${e.id}">질문 만들기</button>`}<button data-action="edit-record" data-type="${type}" data-book="${b.id}" data-id="${e.id}">수정</button><button data-action="delete-record" data-type="${type}" data-book="${b.id}" data-id="${e.id}">삭제</button></div></article>`;
}
// 달마다 작은 제목을 두고 왼쪽에 선을 그린 타임라인
function timeline(items, render) {
  const monthOf = v => isIso(v) ? v.slice(0, 7) : v ? 'legacy' : 'none';
  const thisYear = String(new Date().getFullYear());
  const label = m => m === 'legacy' ? '이전 기록' : m === 'none' ? '날짜 미기록' : `${m.slice(0, 4) === thisYear ? '' : m.slice(0, 4) + '년 '}${Number(m.slice(5))}월`;
  let last = null, html = '<div class="tl">';
  for (const it of items) { const m = monthOf(it.createdAt); if (m !== last) { html += `<p class="tl-month">${label(m)}</p>`; last = m; } html += `<div class="tl-entry" id="rec-${esc(it.id)}">${render(it)}</div>`; }
  return html + '</div>';
}
const dayShort = v => isIso(v) ? new Date(v).toLocaleDateString('ko-KR', { day: 'numeric', weekday: 'short' }) : dateLabel(v);
// ── 책 정리 ── 붙든 문장 · 아직 답 못 한 질문 · 그사이 바뀐 생각. 내 말(메모 · 덧붙임 · 질문 · 답 · 이야기)만 보냅니다.
let summaryPending = '';
const myLines = ref => state.chats.filter(c => c.topic.ref === ref).flatMap(c => c.messages.filter(m => m.role === 'user').map(m => m.text));
const bookWords = b => b.entries.reduce((n, e) => n + (e.note ? 1 : 0) + (e.more || []).length + myLines(e.id).length, 0) + b.questions.reduce((n, q) => n + 1 + (q.answer ? 1 : 0) + (q.history || []).length + myLines(q.id).length, 0) + myLines(b.id).length;
async function summarizeBook(bookId) {
  const b = state.books.find(x => x.id === bookId); if (!b || summaryPending) return;
  if (!state.profile.aiConsentAt) { notice("책 정리는 '나 → 슬라임이 기록 읽기'를 켜야 할 수 있어요."); return; }
  if (!bookWords(b)) { notice('정리할 내 말이 아직 없어요. 문장에 메모를 달거나 질문을 남겨 보세요.'); return; }
  summaryPending = bookId; renderBook();
  try {
    const res = await fetch(AI_SUMMARY_ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(60000), body: JSON.stringify({
      name: state.profile.catName || '슬라임', tone: state.profile.tone, book: { title: b.title, author: b.author },
      entries: b.entries.slice(-80).map(e => ({ id: e.id, page: e.page, note: e.note, more: (e.more || []).map(m => m.text), talk: myLines(e.id).slice(-10) })),
      questions: b.questions.slice(-60).map(q => ({ id: q.id, text: q.text, answer: q.answer, history: (q.history || []).map(h => h.text), talk: myLines(q.id).slice(-10) })),
      talk: myLines(b.id).slice(-10)
    }) });
    const out = await res.json().catch(() => ({}));
    if (res.status === 404 || res.status === 405) throw new Error('중계소가 아직 예전 코드예요. worker 코드를 새로 붙여 넣어 주세요.');
    if (!res.ok || typeof out.line !== 'string' || !Array.isArray(out.held)) throw new Error(out.error || `연결 실패 (${res.status})`);
    summaryPending = '';
    await change(s => { const x = s.books.find(y => y.id === bookId); if (x) x.summary = { at: now(), n: bookWords(b), line: out.line, held: out.held, open: out.open || [], changed: (out.changed || []).map(c => ({ ...(c.id ? { id: c.id } : {}), then: c.then, now: c.now })) }; addUsage(s, 'summary', out.usage); }, '책을 정리했습니다.');
    flashUsage('summary', out.usage);
  } catch (e) { notice(`정리하지 못했어요. ${e.name === 'TimeoutError' ? '시간이 너무 오래 걸렸습니다.' : e.message}`); }
  finally { summaryPending = ''; if (route().page === 'book' && route().id === bookId) renderBook(); }
}
function summaryHtml(b) {
  if (summaryPending === b.id) return `<section class="book-sum pending"><h2>이 책 정리</h2><p class="hint">${esc(ig(state.profile.catName || '슬라임'))} 내 말을 모아 정리하는 중… <span class="dots"><i></i><i></i><i></i></span></p></section>`;
  const s = b.summary; if (!s) return '';
  const fresh = Math.max(0, bookWords(b) - s.n);
  const held = s.held.map(h => ({ h, e: b.entries.find(e => e.id === h.id) })).filter(x => x.e), open = s.open.map(o => ({ o, q: b.questions.find(q => q.id === o.id) })).filter(x => x.q);
  return `<details class="book-sum" open><summary><h2>이 책 정리</h2><small>${esc(dateLabel(s.at))}${fresh ? ` · 그 뒤로 남긴 말 ${fresh}개` : ''}</small></summary>
    ${s.line ? `<p class="sum-line">${esc(s.line)}</p>` : ''}
    ${held.length ? `<h3>붙든 문장</h3>${held.map(({ h, e }) => `<button class="sum-item" data-action="sum-go" data-tab="entries" data-id="${esc(e.id)}"><span class="q-text">“${esc(e.text)}”</span>${e.page ? `<small>p. ${esc(e.page)}</small>` : ''}${h.why ? `<span class="why">${esc(h.why)}</span>` : ''}</button>`).join('')}` : ''}
    ${open.length ? `<h3>아직 답 못 한 질문</h3>${open.map(({ o, q }) => `<button class="sum-item q" data-action="sum-go" data-tab="questions" data-id="${esc(q.id)}"><span class="q-text">? ${esc(q.text)}</span>${o.why ? `<span class="why">${esc(o.why)}</span>` : ''}</button>`).join('')}` : ''}
    ${s.changed.length ? `<h3>그사이 바뀐 생각</h3>${s.changed.map(c => { const q = c.id && b.questions.find(x => x.id === c.id), e = c.id && b.entries.find(x => x.id === c.id), body = `${q || e ? `<small class="about">${esc(cutN(q ? '? ' + q.text : '“' + e.text + '”', 50))}</small>` : ''}<p><span>그땐</span>${esc(c.then)}</p><p><span>지금은</span>${esc(c.now)}</p>`; return q || e ? `<button class="sum-change" data-action="sum-go" data-tab="${q ? 'questions' : 'entries'}" data-id="${esc(c.id)}">${body}</button>` : `<div class="sum-change">${body}</div>`; }).join('')}` : ''}
    <div class="sum-foot"><button class="quiet" data-action="summarize">${fresh ? '새로 남긴 말까지 다시 정리' : '다시 정리'}</button></div>
  </details>`;
}
function renderBook() {
  const b = currentBook();
  if (!b) { $('#main').innerHTML = empty('책을 찾을 수 없어요', '책장에서 다른 책을 골라주세요.', '<a class="back" href="#shelf">← 책장으로</a>'); return; }
  const activeQuery = query.trim();
  const records = b[entryTab].filter(e => !activeQuery || [e.text,e.note || '',e.answer || '',e.page || ''].some(t => t.toLowerCase().includes(activeQuery.toLowerCase())));
  $('#main').innerHTML = `<div class="narrow"><a class="back" href="#shelf">← 책장으로</a><section class="book-hero" aria-labelledby="book-title">${cover(b)}<span class="status-tag">${b.status === 'finished' ? '다 읽음' : '읽는 중'}</span><h1 id="book-title">${esc(b.title)}</h1><p class="book-sub">${esc([b.author,b.publisher].filter(Boolean).join(' · ') || '나만의 독서 기록')}</p><p class="book-sub small">${esc(dateLabel(b.createdAt))}부터${b.finishedAt ? ` · ${esc(dateLabel(b.finishedAt))} 완독` : ''}</p><div class="actions">${talkButton('book', b.id, '', 'primary')}${b.summary || summaryPending === b.id ? '' : '<button class="sum-btn" data-action="summarize">이 책 정리</button>'}</div><div class="actions small-actions"><button class="quiet" data-action="edit-book">책 정보 수정</button><button class="quiet" data-action="toggle-status">${b.status === 'finished' ? '다시 읽기' : '다 읽었어요'}</button></div></section>${summaryHtml(b)}<div class="book-tabs"><div class="seg" role="group" aria-label="문장과 질문"><button class="entries" data-entry-tab="entries" aria-pressed="${entryTab === 'entries'}"><span aria-hidden="true">“</span> 문장 <small>${b.entries.length}</small></button><button class="questions" data-entry-tab="questions" aria-pressed="${entryTab === 'questions'}"><span aria-hidden="true">?</span> 질문 <small>${b.questions.length}${b.questions.filter(q => q.answer).length ? ` · 답 ${b.questions.filter(q => q.answer).length}` : ''}</small></button></div><button class="primary" data-action="add-record">＋ ${entryTab === 'entries' ? '문장' : '질문'}</button></div>${activeQuery ? `<p class="search-count">“${esc(query)}” 검색 중 <button class="quiet" data-action="clear-query">검색 해제</button></p>` : ''}<div class="quotes">${records.length ? [...records].reverse().map(e => quoteCard(e,b,entryTab)).join('') : empty(activeQuery ? '일치하는 기록이 없어요' : entryTab === 'entries' ? '오래 두고 싶은 문장' : '서둘러 답하지 않아도 괜찮아요', activeQuery ? '검색을 해제하면 모든 기록이 보입니다.' : entryTab === 'entries' ? '읽다가 걸린 문장과 그때의 생각을 남겨보세요.' : '읽다가 생긴 물음을 적어두고, 나중의 나에게 건네보세요.')}</div><p class="section-note"><button class="quiet danger" data-action="delete-book">이 책 삭제</button></p></div>`;
  focusRecord();
}
function renderQuestions() {
  const qs = state.books.flatMap(b => b.questions.map(q => ({ b, q }))).filter(({q}) => questionFilter === 'all' || (questionFilter === 'open' ? !q.answer : !!q.answer)).reverse();
  $('#main').innerHTML = `<div class="narrow"><a class="back" href="#shelf">← 책장으로</a><div class="intro"><div><h1>모든 책의 질문</h1><p>답을 기다리는 시간도 독서의 일부니까요.</p></div></div><div class="toolbar"><div class="filters" aria-label="답변 상태">${[['open','답을 기다리는'],['answered','지금의 답이 있는'],['all','모두']].map(([v,l]) => `<button data-question-filter="${v}" aria-pressed="${questionFilter === v}">${l}</button>`).join('')}</div></div><div class="quotes">${qs.map(({b,q}) => quoteCard(q,b,'questions',true)).join('') || empty('질문을 위한 빈자리', '책을 열어 떠오른 물음을 남기면 이곳에 모입니다.')}</div></div>`;
  focusRecord();
}
let thoughtQuery = '', talkQuery = '';
const hits = (q, ...texts) => { q = q.trim().toLowerCase(); return !q || texts.some(t => String(t || '').toLowerCase().includes(q)); };
const searchBox = (id, label, value, hint) => `<div class="search-field list-search"><label class="visually-hidden" for="${id}">${label}</label><input type="search" id="${id}" placeholder="${hint}" value="${esc(value)}"></div>`;
function thoughtItem(t) { return `<span class="tl-date">${esc(dayShort(t.createdAt))}</span><p class="tl-text">${esc(t.text)}</p>${moreHtml(t.more)}${tagLine(t.id)}<div class="q-actions">${talkButton('thought', t.id)}<button data-action="edit-journal" data-id="${esc(t.id)}">수정</button><button data-action="delete-record" data-type="thoughts" data-id="${esc(t.id)}">삭제</button></div>`; }
function thoughtResults() {
  const el = $('#thought-results'); if (!el) return;
  const list = [...state.thoughts].reverse().filter(t => hits(thoughtQuery, t.text, ...(t.more || []).map(m => m.text), ...(state.readings[t.id]?.tags || []).map(x => '#' + x)));
  el.innerHTML = !state.thoughts.length ? empty('아무렇게나, 한 줄부터', '잘 정리하지 않아도 괜찮습니다.') : list.length ? `${thoughtQuery.trim() ? `<p class="search-count" role="status">생각 ${list.length}개를 찾았습니다.</p>` : ''}${timeline(list, thoughtItem)}` : empty('찾는 생각이 없어요', '다른 말이나 #주제어로 찾아보세요.');
}
function renderThoughts() {
  $('#main').innerHTML = `<div class="narrow"><div class="intro"><div><h1>떠오르는 생각</h1><p>책과 상관없이, 스스로 떠오른 것.</p></div><button class="primary intro-actions" data-action="add-journal">＋ 기록</button></div>${state.thoughts.length > 2 ? searchBox('thought-search', '생각 찾기', thoughtQuery, '생각 찾기 · 글이나 #주제어') : ''}<div id="thought-results"></div></div>`;
  thoughtResults(); $('#thought-search')?.addEventListener('input', e => { thoughtQuery = e.target.value; thoughtResults(); });
  focusRecord();
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
function recordEditor(type, bookId, id, answerOnly = false, fromId = '') {
  const b = state.books.find(b => b.id === bookId); if (!b) return;
  const existing = b[type].find(e => e.id === id);
  const question = type === 'questions';
  const from = question && !existing && fromId ? b.entries.find(e => e.id === fromId) : null;
  openModal(answerOnly ? '지금의 답 남기기' : `${question ? '질문' : '문장'} ${existing ? '수정' : '남기기'}`, `<p class="hint">${esc(b.title)}</p>${from ? `<p class="record-text">“${esc(from.text)}”</p>` : ''}<form id="edit-form">${answerOnly ? `<p class="record-text">${esc(existing.text)}</p>${area('지금의 답', 'answer', existing.answer)}${existing.answer ? '<label class="check"><input type="checkbox" name="keepOld" checked> 예전 답은 “그땐”으로 남기기</label>' : ''}` : `${area(question ? (from ? '이 문장에서 생긴 물음' : '읽다가 생긴 물음') : '오래 두고 싶은 문장', 'text', existing?.text, true)}${!question ? `${field('페이지 · 선택','page',existing?.page,'maxlength="50" placeholder="예: 42 또는 42–43"')}${area('메모 · 선택','note',existing?.note)}` : ''}`}${submit('기록 저장')}</form>`, `${bookId}:${type}:${id || 'new'}:${answerOnly}`);
  formHandler(data => change(s => {
    const target = s.books.find(x => x.id === bookId)[type];
    if (answerOnly) { const q = target.find(x => x.id === id), next = data.get('answer').trim(); if (next === q.answer) return; if (q.answer && data.get('keepOld')) (q.history ||= []).push({ text: q.answer, at: q.answeredAt }); q.answer = next; q.answeredAt = next ? now() : ''; }
    else {
      const content = data.get('text').trim(); if (!content) throw new Error('기록할 내용을 입력해주세요.');
      const values = question ? {text:content} : {text:content,page:data.get('page').trim(),note:data.get('note').trim()};
      if (existing) Object.assign(target.find(x => x.id === id), values);
      else { const nid = uid(); target.push({ id:nid,createdAt:now(),...values,...(question ? {answer:'',answeredAt:'',from:from?.id || '',history:[]} : {more:[]}) }); if (from) { entryTab = 'questions'; focusRec = nid; } }
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
  openModal(item ? '답 고치기' : `${esc(state.profile.catName || '슬라임')}의 물음`, `<p class="prompt">${esc(prompt)}</p><form id="edit-form">${area('본 대로, 판단 없이','text',item?.text,true)}${submit(item ? '변경 저장' : '답 남기기')}</form>`, `answer:${id || 'new'}`);
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
  const talks = state.chats.filter(c => c.topic.book === b.id || (c.topic.kind === 'book' && c.topic.ref === b.id));
  openModal('책을 삭제할까요?',`<p>『${esc(b.title)}』의 문장 ${b.entries.length}개와 질문 ${b.questions.length}개도 함께 삭제됩니다.</p><p class="hint">삭제 직후 되돌리거나, 보관함에서 직전 저장 상태를 복원할 수 있습니다.</p><form id="edit-form">${talks.length ? `<label class="check"><input type="checkbox" name="talks" checked> 이 책으로 나눈 이야기 ${talks.length}개도 지우기</label>` : ''}${submit('책 삭제')}</form>`);
  formHandler(async data => {
    const index = state.books.findIndex(x => x.id === b.id), copy = structuredClone(b), gone = data.get('talks') ? structuredClone(talks) : [], ids = new Set(gone.map(c => c.id));
    const ok = await change(s => { s.books = s.books.filter(x => x.id !== b.id); s.chats = s.chats.filter(c => !ids.has(c.id)); },'');
    if (ok) { location.hash = 'shelf'; notice(`책을 삭제했습니다.${gone.length ? ` 이야기 ${gone.length}개도 지웠습니다.` : ''}`,() => change(s => { if (!s.books.some(x => x.id === copy.id)) s.books.splice(index,0,copy); for (const c of gone) if (!s.chats.some(x => x.id === c.id)) s.chats.push(c); },'책을 되돌렸습니다.')); }
    return ok;
  });
}
function download(content, filename) {
  const url = URL.createObjectURL(new Blob([content],{type:'application/json'}));
  const a = document.createElement('a'); a.href = url; a.download = filename; a.click(); setTimeout(() => URL.revokeObjectURL(url),10000);
}
function exportState(data = state, prefix = 'my-slime') { download(backup(data),`${prefix}-${new Date().toISOString().slice(0,10)}.json`); if (data === state) { try { localStorage.setItem('last-backup', now()); localStorage.removeItem('backup-snooze'); } catch {} syncBackupNudge(); } }
// 백업 챙기기 — 마지막으로 파일을 내려받은 날을 이 기기에 기억하고, 7일이 넘으면 첫 화면에서 알려 줍니다
const lastBackup = () => { try { return localStorage.getItem('last-backup') || ''; } catch { return ''; } };
function backupDue() {
  const recs = beadList(); if (recs.length + state.chats.length < 3) return null;
  try { if (Number(localStorage.getItem('backup-snooze') || 0) > Date.now()) return null; } catch {}
  const last = Date.parse(lastBackup()) || 0, since = last || recs.find(b => b.at)?.at || Date.now(), days = Math.floor((Date.now() - since) / 864e5);
  return days >= 7 ? { days, never: !last } : null;
}
function backupNudgeHtml() {
  const due = backupDue(); if (!due) return '';
  return `<div class="backup-nudge" role="status"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v10M7.5 9.5 12 14l4.5-4.5M5 18.5h14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg><span>${due.never ? `기록을 모은 지 ${due.days}일, 아직 백업한 적이 없어요` : `마지막 백업이 ${due.days}일 전이에요`}</span><button class="primary" data-action="backup-now">백업</button><button class="quiet" data-action="backup-later" aria-label="3일 뒤에 다시 알리기">나중에</button></div>`;
}
function syncBackupNudge() { const el = $('#backup-nudge'); if (el) el.innerHTML = backupNudgeHtml(); }
function aiStatus() {
  const all = aiSources(), done = all.filter(x => state.readings[x.id]?.h === x.h).length;
  return state.profile.aiConsentAt ? `${all.length}개 중 ${done}개를 읽었습니다.${readBackoff > Date.now() ? ' 지금은 연결이 안 돼서 잠시 뒤 다시 시도합니다.' : ''}` : '꺼져 있습니다. 켜기 전까지는 아무것도 보내지 않습니다.';
}
// ── 슬라임과 이야기 (토론) ───────────────────────────────────
let talkPending = '', talkError = '';
const talkKind = { book: '책', entry: '문장', question: '질문', thought: '생각', answer: '물음', free: '이야기' };
const cut60 = t => t.length > 60 ? t.slice(0, 60) + '…' : t;
// 이야기의 주제가 된 기록 (지워졌으면 저장해 둔 제목으로)
function talkSubject(c) {
  const b = state.books.find(x => x.id === (c.topic.kind === 'book' ? c.topic.ref : c.topic.book));
  const item = c.topic.kind === 'entry' ? b?.entries.find(e => e.id === c.topic.ref) : c.topic.kind === 'question' ? b?.questions.find(q => q.id === c.topic.ref) : c.topic.kind === 'thought' ? state.thoughts.find(t => t.id === c.topic.ref) : c.topic.kind === 'answer' ? state.answers.find(a => a.id === c.topic.ref) : null;
  return { book: b, item };
}
function talkName(c) {
  if (c.topic.kind === 'free') return c.messages.find(m => m.role === 'user')?.text.slice(0, 40) || '새 이야기';
  return cut60(talkFull(c));   // 기록을 고쳤으면 고친 글로
}
// 이야기의 주제 글 전체 — 자르지 않습니다 (지워졌으면 저장해 둔 제목)
function talkFull(c) {
  const { book, item } = talkSubject(c);
  if (c.topic.kind === 'book') return book?.title || c.topic.title || '';
  if (c.topic.kind === 'answer') return item?.prompt || c.topic.title || '';
  return item?.text || c.topic.title || '';
}
// 이야기 맨 위 주제 카드 — 무엇에 대해 이야기하는지 전체를 보여 주고, 첫 말은 내가 꺼냅니다
function talkTopicCard(c) {
  const { book, item } = talkSubject(c), k = c.topic.kind, name = state.profile.catName || '슬라임';
  const hint = c.messages.length ? '' : `<p class="topic-hint">먼저 말을 꺼내 보세요. ${esc(ig(name))} 듣고 같이 생각해요.</p>`;
  if (k === 'free') return hint ? `<div class="talk-topic free">${hint}</div>` : '';
  const src = book && k !== 'book' ? `<small class="topic-src">『${esc(book.title)}』${k === 'entry' && item?.page ? ` · p. ${esc(item.page)}` : ''}</small>` : '';
  const body = k === 'book' ? `<p class="topic-text">『${esc(talkFull(c))}』${book?.author ? ` <small>${esc(book.author)}</small>` : ''}</p>`
    : k === 'answer' ? `<small class="topic-src">${esc(ig(name))} 물었던 것</small><p class="topic-text">${esc(talkFull(c))}</p>${item ? `<p class="mine">${esc(item.text)}</p>` : ''}`
    : `${src}<p class="topic-text">${k === 'question' ? '' : k === 'entry' ? '“' : ''}${esc(talkFull(c))}${k === 'entry' ? '”' : ''}</p>${k === 'entry' && item?.note ? `<p class="mine">${esc(item.note)}</p>` : ''}${k === 'question' && item ? answerHtml(item) : ''}`;
  return `<div class="talk-topic ${k}">${k === 'question' ? '<span class="mark" aria-hidden="true">?</span>' : ''}${body}${hint}</div>`;
}
// 슬라임에게 보낼 배경 — 내가 쓴 것. 문장 하나를 골라 이야기할 때만 그 문장을 함께 보냅니다.
function bookNotes(b) { return b ? [...b.entries.filter(e => e.note).map(e => `내 메모: ${e.note}`), ...b.questions.map(q => `내 질문: ${q.text}${q.answer ? ` / 내 답: ${q.answer}` : ''}`)] : []; }
function talkTopic(c) {
  const { book: b, item } = talkSubject(c);
  if (c.topic.kind === 'book') return { kind: 'book', title: b?.title || c.topic.title, author: b?.author || '', notes: bookNotes(b).slice(-20) };
  if (c.topic.kind === 'entry') return { kind: 'book', title: b?.title || '', author: b?.author || '', notes: [`지금 이야기할 문장${item?.page ? ` (p. ${item.page})` : ''}: ${item?.text || c.topic.title}`, ...(item?.note ? [`이 문장에 단 내 메모: ${item.note}`] : []), ...(item?.more || []).slice(-6).map(m => `이 문장에 덧붙인 내 말: ${m.text}`), ...bookNotes(b).filter(n => !item?.note || !n.includes(item.note)).slice(-12)] };
  if (c.topic.kind === 'question') return { kind: 'book', title: b?.title || '', author: b?.author || '', notes: [`지금 이야기할 내 질문: ${item?.text || c.topic.title}`, ...(item?.history || []).slice(-4).map(h => `그땐 내 답: ${h.text}`), ...(item?.answer ? [`지금 내 답: ${item.answer}`] : []), ...bookNotes(b).slice(-12)] };
  if (c.topic.kind === 'answer') return { kind: 'thought', title: '', notes: [`슬라임이 물은 것: ${item?.prompt || c.topic.title}`, ...(item ? [`내 답: ${item.text}`] : []), ...(item?.more || []).slice(-8).map(m => `이 답에 덧붙인 말: ${m.text}`), ...(state.readings[c.topic.ref]?.tags || []).map(x => `주제어: ${x}`)] };
  if (c.topic.kind === 'thought') return { kind: 'thought', title: '', notes: [item?.text || c.topic.title, ...(item?.more || []).slice(-8).map(m => `이 생각에 덧붙인 말: ${m.text}`), ...(state.readings[c.topic.ref]?.tags || []).map(x => `주제어: ${x}`)] };
  return { kind: 'free', title: '', notes: tagCounts(60).slice(0, 6).map(([t]) => `요즘 자주 나온 주제어: ${t}`) };
}
async function startTalk(kind, ref = '', bookId = '') {
  const b = state.books.find(x => x.id === (kind === 'book' ? ref : bookId));
  const title = kind === 'book' ? b?.title : kind === 'entry' ? b?.entries.find(e => e.id === ref)?.text : kind === 'question' ? b?.questions.find(q => q.id === ref)?.text : kind === 'thought' ? state.thoughts.find(t => t.id === ref)?.text : kind === 'answer' ? state.answers.find(a => a.id === ref)?.prompt : '';
  // 같은 기록으로 이미 시작한 이야기가 있으면 거기로 이어 갑니다
  const old = kind !== 'free' && [...state.chats].reverse().find(c => c.topic.kind === kind && c.topic.ref === ref);
  if (old) { location.hash = `talk/${old.id}`; return; }
  const id = uid();
  if (await change(s => { s.chats.push({ id, createdAt: now(), topic: { kind, ref, book: bookId, title: (title || '').slice(0, 500) }, usage: { input: 0, output: 0 }, messages: [] }); }, '')) location.hash = `talk/${id}`;
}
const TRASH = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h14M10 7V4.5h4V7M7 7l1 13h8l1-13M10.5 11v5.5M13.5 11v5.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
// 이야기 지우기 — 이야기만 지우고, 이야기에서 기록에 남긴 말(덧붙임 · 지금의 답)은 그대로 둡니다. 되돌리기 가능
async function deleteTalk(id) {
  const i = state.chats.findIndex(c => c.id === id); if (i < 0) return;
  const item = structuredClone(state.chats[i]), here = route().page === 'talk' && route().id === id, home = here ? talkHome(item) : null;
  if (!await change(s => { s.chats = s.chats.filter(c => c.id !== id); }, '')) return;
  if (here) location.hash = home.href.slice(1);
  notice(`이야기를 지웠습니다.${item.messages.length ? ` (${item.messages.length}마디)` : ''}`, async () => {
    if (await change(s => { if (!s.chats.some(c => c.id === id)) s.chats.splice(Math.min(i, s.chats.length), 0, item); }, '이야기를 되돌렸습니다.')) undoAction = null;
  });
}
function talkListHtml(currentId, only) {
  const list = only || [...state.chats].sort((a, b) => lastAt(b) - lastAt(a));
  return list.length ? list.map(c => { const last = c.messages[c.messages.length - 1]; return `<div class="talk-row"><a class="talk-item ${c.id === currentId ? 'on' : ''}" href="#talk/${esc(c.id)}" ${c.id === currentId ? 'aria-current="page"' : ''}><span class="status-tag">${talkKind[c.topic.kind]}</span><b>${esc(talkName(c))}</b>${['entry', 'question'].includes(c.topic.kind) && talkSubject(c).book ? `<small class="from">『${esc(talkSubject(c).book.title)}』</small>` : ''}<small>${esc(last ? last.text.slice(0, 60) : '아직 아무 말도 안 했어요')}</small><small>${esc(dateLabel(c.createdAt))} · ${c.messages.length}마디</small></a><button class="talk-del" data-action="talk-delete" data-id="${esc(c.id)}" aria-label="이 이야기 지우기" title="이야기 지우기">${TRASH}</button></div>`; }).join('')
    : empty('아직 나눈 이야기가 없어요', '책·문장·질문·생각에서 "이야기하기"를 누르거나, 새 이야기로 시작해 보세요.');
}
// PC 모드 — 폰을 노트북에 연결해 이야기할 때. 이 기기에만 기억합니다. (예전 'Enter로 보내기'를 켜 두었으면 켠 것으로)
function pcMode() {
  try { const v = localStorage.getItem('pc-mode'); if (v === '1' || v === '0') return v === '1'; return localStorage.getItem('enter-sends') === '1'; } catch { return false; }
}
// PC 모드면 폰에서도 이야기 화면만 노트북처럼 보입니다 — 배율은 index.html 머리에서 그리기 전에 정하므로,
// 이야기 화면에 들고 날 때와 PC 모드를 켜고 끌 때는 새로 엽니다. 폰을 돌리면 너비(가로 853 · 세로 760)만 바꿔 줍니다.
// 가로 853은 노트북 너비(1280)를 1.5배 키운 것, 세로 760은 PC 배치가 나오는 가장 좁은 너비입니다.
const pcWidth = () => { const land = matchMedia('(orientation: landscape)').matches, real = land ? Math.max(screen.width, screen.height) : Math.min(screen.width, screen.height); return pcMode() && real < 1100 && /^#talk\/./.test(location.hash) ? (land ? 853 : 760) : 0; };
// 지금 배율이 이 화면에 맞지 않으면 새로 엽니다. 그냥 새로고침하면 예전 배율이 되살아나서, 주소를 살짝 바꿔 엽니다 (열린 뒤 지움)
function syncViewport() {
  const scaled = !$('meta[name=viewport]').content.startsWith('width=device-width');
  if (!!pcWidth() === scaled) return false;
  location.replace(`${location.pathname}?v=${Date.now()}${location.hash}`); return true;
}
// PC 모드에서는 블루투스 키보드를 쓰니 화면 자판을 띄우지 않습니다. 머리줄 '자판' 단추로 다시 띄울 수 있습니다 (이 기기에만 기억)
const softKb = () => { try { return localStorage.getItem('soft-kb') === '1'; } catch { return false; } };
function setPcMode(on) { try { localStorage.setItem('pc-mode', on ? '1' : '0'); localStorage.removeItem('enter-sends'); } catch {} syncViewport(); }
matchMedia('(orientation: landscape)').addEventListener('change', () => { const w = pcWidth(); if (w) $('meta[name=viewport]').content = `width=${w}, viewport-fit=cover`; });
// PC 모드면 Enter로 보냄. 아니면 넓은 화면·마우스일 때만
const enterSendsPref = () => pcMode() || matchMedia('(min-width: 760px), (pointer: fine)').matches;
let ctxOpen = false, talkFocus = false;   // talkFocus: 이야기하기를 눌러 들어오면 입력칸에 바로
// 이야기 탭 — 슬라임과 주고받은 것: 내가 꺼낸 이야기(책 갈래 · 생각 갈래)와 슬라임이 물어 내가 한 답
const LANE = { book: 'book', entry: 'book', question: 'book', thought: 'thought', free: 'thought', answer: 'ask' };
const lastAt = c => Date.parse(c.messages.at(-1)?.at || c.createdAt) || 0;
function askCard(a) {
  return `<article class="talk-item ask-item" id="rec-${esc(a.id)}"><span class="status-tag">물음</span><p class="asked">${esc(a.prompt)}</p><p class="ask-text">${esc(a.text)}</p>${moreHtml(a.more)}${tagLine(a.id)}<small>${esc(dateLabel(a.createdAt))}</small><div class="q-actions">${talkButton('answer', a.id)}<button data-action="edit-answer" data-id="${esc(a.id)}">수정</button><button data-action="delete-record" data-type="answers" data-id="${esc(a.id)}">삭제</button></div></article>`;
}
function renderTalks() {
  const name = state.profile.catName || '슬라임';
  // 답으로 시작한 이야기는 그 답 카드 안의 '이야기 이어가기'로 들어갑니다 (답이 지워졌으면 이야기 카드로)
  const items = [
    ...state.chats.filter(c => c.messages.length && (c.topic.kind !== 'answer' || !state.answers.some(a => a.id === c.topic.ref))).map(c => ({ lane: LANE[c.topic.kind], at: lastAt(c), words: [talkFull(c), ...c.messages.map(m => m.text)], html: () => talkListHtml('', [c]) })),
    ...state.answers.map(a => { const c = talkOf('answer', a.id); return { lane: 'ask', words: [a.prompt, a.text, ...(a.more || []).map(m => m.text), ...(c ? c.messages.map(m => m.text) : [])], at: Math.max(Date.parse(a.createdAt) || 0, c ? lastAt(c) : 0), html: () => askCard(a) }; })
  ].sort((x, y) => y.at - x.at);
  const count = k => items.filter(x => k === 'all' || x.lane === k).length;
  const lanes = [['all', '전체'], ['book', '책'], ['thought', '생각'], ...(state.answers.length ? [['ask', `${name}의 물음`]] : [])];
  if (talkFilter === 'ask' && !state.answers.length) talkFilter = 'all';
  const none = { all: ['아직 주고받은 게 없어요', '책·문장·질문·생각에서 "이야기하기"를 누르거나, ＋ 새 이야기로 시작해 보세요.'], book: ['책 이야기가 아직 없어요', '책장에서 문장이나 질문을 열고 "이야기하기"를 눌러 보세요.'], thought: ['생각 이야기가 아직 없어요', '생각 탭에서 "이야기하기"를 누르거나, 새 이야기로 시작해 보세요.'], ask: ['아직 답한 물음이 없어요', '첫 화면의 물음표를 누르면 오늘의 물음이 있습니다.'] }[talkFilter];
  $('#main').innerHTML = `<div class="narrow"><div class="intro"><div><h1>이야기</h1><p>${esc(wa(name))} 주고받은 것 — 내가 꺼낸 이야기${state.answers.length ? `와, ${esc(ig(name))} 물어 내가 한 답` : ''}.</p></div><button class="primary intro-actions" data-action="talk-free">＋ 새 이야기</button></div><div class="toolbar"><div class="filters" aria-label="이야기 갈래">${lanes.map(([v, l]) => `<button data-talk-filter="${v}" aria-pressed="${talkFilter === v}">${esc(l)} <small>${count(v)}</small></button>`).join('')}</div></div>${items.length > 2 ? searchBox('talk-search', '이야기 찾기', talkQuery, '이야기 찾기 · 주고받은 말에서') : ''}<div class="talk-list" id="talk-results"></div></div>`;
  const draw = () => { const shown = items.filter(x => (talkFilter === 'all' || x.lane === talkFilter) && hits(talkQuery, ...x.words)); $('#talk-results').innerHTML = shown.length ? `${talkQuery.trim() ? `<p class="search-count" role="status">${shown.length}개를 찾았습니다.</p>` : ''}${shown.map(x => x.html()).join('')}` : talkQuery.trim() ? empty('찾는 이야기가 없어요', '다른 말로 찾아보세요.') : empty(...none); };
  draw(); $('#talk-search')?.addEventListener('input', e => { talkQuery = e.target.value; draw(); });
  focusRecord();
}
// 오른쪽 배경 칸 — 무엇에 대해 이야기하는지, 내가 그 주제에 적어 둔 것들. 누르면 입력칸에 인용됩니다.
function talkContextHtml(c) {
  const { book: b, item } = talkSubject(c), quote = (t, label = '') => `<button class="ctx-item" data-action="talk-quote" data-text="${esc(t)}">${label ? `<small>${esc(label)}</small>` : ''}${esc(t)}</button>`;
  let html = '';
  if (b) html += `<div class="ctx-book">${cover(b)}<div><b>${esc(b.title)}</b><small>${esc([b.author, b.publisher].filter(Boolean).join(' · ') || '')}</small><a class="text-link" href="#book/${esc(b.id)}">책 열기 ›</a></div></div>`;
  if (c.topic.kind === 'entry' && item) html += `<div class="ctx-focus"><span class="mark">“</span><p>${esc(item.text)}</p>${item.page ? `<small>p. ${esc(item.page)}</small>` : ''}${item.note ? `<p class="mine">${esc(item.note)}</p>` : ''}${moreHtml(item.more)}</div>`;
  if (c.topic.kind === 'question' && item) html += `<div class="ctx-focus q"><span class="mark">?</span><p>${esc(item.text)}</p>${answerHtml(item)}</div>`;
  if (c.topic.kind === 'answer') html += `<div class="ctx-focus ask"><small>${esc(item?.prompt || c.topic.title)}</small><p>${esc(item?.text || '')}</p>${moreHtml(item?.more)}${tagLine(c.topic.ref)}</div>`;
  if (c.topic.kind === 'thought') html += `<div class="ctx-focus"><p>${esc(item?.text || c.topic.title)}</p>${moreHtml(item?.more)}${tagLine(c.topic.ref)}</div>`;
  if (b) {
    const notes = b.entries.filter(e => e.note && e.id !== item?.id).map(e => quote(e.note, e.page ? `p. ${e.page}에 단 메모` : '내 메모'));
    const qs = b.questions.filter(q => q.id !== item?.id).map(q => quote(q.text, q.answer ? '내 질문 · 답 있음' : '내 질문'));
    if (notes.length || qs.length) html += `<h3>이 책에 적어 둔 것</h3><div class="ctx-list">${[...notes, ...qs].join('')}</div>`;
  }
  if (c.topic.kind === 'thought') {
    const tag = state.readings[c.topic.ref]?.tags?.[0];
    const near = tag ? state.thoughts.filter(t => t.id !== c.topic.ref && state.readings[t.id]?.tags?.includes(tag)).slice(-5).reverse() : [];
    if (near.length) html += `<h3>#${esc(tag)}로 이어진 생각</h3><div class="ctx-list">${near.map(t => quote(t.text, dateLabel(t.createdAt))).join('')}</div>`;
  }
  if (c.topic.kind === 'free') {
    const top = tagCounts(60).slice(0, 8);
    html += top.length ? `<h3>요즘 자주 나온 주제</h3><p class="tag-line">${top.map(([t]) => `<span>#${esc(t)}</span>`).join('')}</p>` : '<p class="hint">책·문장·질문·생각 화면에서 "이야기하기"를 누르면 그 기록을 옆에 두고 이야기할 수 있습니다.</p>';
    const recent = [...state.thoughts].slice(-4).reverse();
    if (recent.length) html += `<h3>최근 생각</h3><div class="ctx-list">${recent.map(t => quote(t.text, dateLabel(t.createdAt))).join('')}</div>`;
  }
  const u = c.usage || { input: 0, output: 0 };
  html += `<p class="ctx-usage">이 이야기에 쓴 토큰 ${(u.input + u.output).toLocaleString()} · 약 ${fmtWon(dollars(u))}</p>`;
  return html;
}
// 이야기에서 돌아갈 자리 — 책 갈래는 그 책, 생각 갈래는 생각
function talkHome(c) {
  const { book } = talkSubject(c);
  if (c.topic.kind !== 'thought' && c.topic.kind !== 'free' && book) return { href: `#book/${book.id}`, label: '← 책', tab: c.topic.kind === 'question' ? 'questions' : 'entries' };
  if (c.topic.kind === 'thought') return { href: '#thoughts', label: '← 생각' };
  if (c.topic.kind === 'answer') return { href: '#talk', label: '← 이야기', filter: 'ask' };
  return { href: '#talk', label: '← 이야기' };
}
// 이야기 끝에 남길 자리 — 처음 시작한 기록으로 돌아갑니다
function keepTargets(c) {
  const { book, item } = talkSubject(c), k = c.topic.kind;
  if (k === 'question' && item) return [['answer', '이 질문의 지금의 답으로', '예전 답은 지우지 않고 “그땐”으로 남깁니다.']];
  if (k === 'entry' && item) return [['memo', '이 문장 아래 덧붙이기', '문장의 메모 밑에 날짜와 함께 붙습니다.'], ['question', '이 문장에서 생긴 질문으로', '책의 질문 칸에 들어갑니다.']];
  if (k !== 'thought' && k !== 'free' && book) return [['question', `『${book.title.length > 30 ? book.title.slice(0, 30) + '…' : book.title}』의 질문으로`, '책의 질문 칸에 들어갑니다.']];
  if (k === 'thought' && item) return [['more', '이 생각 아래 덧붙이기', '생각 밑에 날짜와 함께 붙습니다.']];
  if (k === 'answer' && item) return [['amore', '이 답 아래 덧붙이기', '슬라임의 물음에 한 답 밑에 날짜와 함께 붙습니다.']];
  return [['thought', '새 생각으로', '생각 탭에 들어갑니다.']];
}
const keepLabel = c => ({ answer: '답으로 남기기', memo: '남기기', question: '질문으로 남기기', more: '덧붙이기', amore: '덧붙이기', thought: '생각으로 남기기' })[keepTargets(c)[0][0]];
function renderTalk(id) {
  const c = state.chats.find(x => x.id === id), name = state.profile.catName || '슬라임';
  if (!c) { $('#main').innerHTML = empty('이야기를 찾을 수 없어요', '목록에서 다시 골라 주세요.', '<a class="back" href="#talk">← 이야기</a>'); return; }
  const old = $('#talk-input'), draft = old?.value || '', home = talkHome(c);
  // 다시 그려도 쓰던 칸(이야기 입력칸 · 남길 말)의 초점과 커서를 지킵니다
  const act = document.activeElement, keep = act && act.id === 'talk-input' ? [act.id, act.selectionStart, act.selectionEnd] : null;
  const face = miniSlime(slimeLook().color);
  const bubbleHtml = (role, text) => role === 'assistant' ? `<div class="talk-msg slime">${face}<p><b class="who">${esc(name)}</b>${esc(text)}</p></div>` : `<div class="talk-msg me"><p><b class="who">나</b>${esc(text)}</p></div>`;
  const pending = talkPending === id, on = !!state.profile.aiConsentAt, pc = pcMode(), wide = pc || matchMedia('(min-width: 760px)').matches, enterSends = enterSendsPref();
  document.body.classList.toggle('pc', pc); document.body.classList.toggle('desk-on', wide); document.body.classList.toggle('ctx-open', ctxOpen);
  $('#main').innerHTML = `<div class="talk-desk ${wide ? 'desk' : ''}">
    ${wide ? deskSideHtml(c, home) : ''}
    <section class="talk" aria-label="이야기">
      <div class="talk-head"><a class="back talk-back" href="${home.href}">${home.label}</a><h1 class="talk-title"><span class="status-tag">${talkKind[c.topic.kind]}</span><span class="title-text" title="눌러서 전체 보기">${esc(c.topic.kind === 'free' ? `${wa(name)} 이야기` : talkFull(c))}</span></h1><div class="talk-tools">${c.messages.some(m => m.role === 'user') ? `<button class="quiet" data-action="talk-keep">${keepLabel(c)}</button>` : ''}${c.messages.length ? `<button class="tool talk-del-tool" data-action="talk-delete" data-id="${esc(c.id)}" aria-label="이 이야기 지우기" title="이야기 지우기">${TRASH}</button>` : ''}<button class="tool ctx-toggle" data-action="talk-ctx" aria-pressed="${ctxOpen}" aria-label="이야기의 배경 보기" title="배경 보기"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 4h11l3 3v13H5z M9 10h7 M9 14h7" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/></svg></button>${pc ? `<button class="tool" data-action="soft-kb" aria-pressed="${softKb()}" aria-label="화면 자판 ${softKb() ? '숨기기' : '띄우기'}" title="화면 자판"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7h18v11H3z M7 11h0 M11 11h0 M15 11h0 M8 15h8" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/></svg><span>자판</span></button>` : ''}<button class="tool" data-action="pc-mode" aria-pressed="${pc}" aria-label="PC 모드 ${pc ? '끄기' : '켜기'}" title="PC 모드"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 6h14v9H5z M3 18h18" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/></svg><span>PC</span></button></div></div>
      <div class="talk-log" id="talk-log">
        ${talkTopicCard(c)}
        ${c.messages.map(m => bubbleHtml(m.role, m.text)).join('')}
        ${pending ? `<div class="talk-msg slime typing">${face}<p><i></i><i></i><i></i></p></div>` : ''}
        ${talkError && !pending ? `<div class="talk-error"><p>${esc(talkError)}</p><button data-action="talk-retry">다시 보내기</button></div>` : ''}
        ${!pending && !talkError && on && talkNext[id]?.length && c.messages.at(-1)?.role === 'assistant' ? `<div class="talk-next" aria-label="이어서 꺼낼 말">${talkNext[id].map(t => `<button class="chip" data-action="talk-next" data-text="${esc(t)}">${esc(t)}</button>`).join('')}</div>` : ''}
      </div>
      ${on ? `<form class="talk-form" id="talk-form"><label class="visually-hidden" for="talk-input">${esc(name)}에게 할 말</label><textarea id="talk-input" rows="1" maxlength="1500"${pc && !softKb() ? ' inputmode="none"' : ''} placeholder="${esc(name)}에게 말하기${enterSends ? ' · Enter 보내기, Shift+Enter 줄바꿈' : ''}">${esc(draft)}</textarea><button class="primary" type="submit" ${pending ? 'disabled' : ''} aria-label="보내기"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12l15-7-5 15-2.5-6.5z" fill="currentColor"/></svg></button></form>`
         : `<div class="talk-form off"><p>이야기하려면 '나'에서 <b>슬라임이 기록 읽기</b>를 켜 주세요.</p><a class="text-link" href="#me">켜러 가기 ›</a></div>`}
    </section>
    <aside class="talk-ctx" aria-label="이야기의 배경"><button class="quiet ctx-close" data-action="talk-ctx">닫기 ✕</button><div class="ctx-more">${talkContextHtml(c)}</div></aside>
  </div>`;
  if (wide && laneOf(c) !== 'thought' && talkSubject(c).book) { const b = talkSubject(c).book; setTimeout(() => titleEntries(b), 800); }   // 왼쪽 목록의 문장 제목
  $$('.talk-back').forEach(a => { a.onclick = () => { if (home.tab) entryTab = home.tab; if (home.filter) talkFilter = home.filter; focusRec = c.topic.kind === 'book' || c.topic.kind === 'free' ? '' : c.topic.ref; }; });
  const recs = $('.recs-list'), picked = $('.recs-list .on');   // 고른 기록이 목록에서 보이게 (화면 전체는 움직이지 않게)
  if (recs && picked && (picked.offsetTop < recs.scrollTop || picked.offsetTop + picked.offsetHeight > recs.scrollTop + recs.clientHeight)) recs.scrollTop = picked.offsetTop - recs.clientHeight / 3;
  $('.title-text').onclick = e => e.currentTarget.classList.toggle('open');   // 긴 문장은 두 줄까지, 누르면 전체
  const log = $('#talk-log'); if (log) { log.scrollTop = log.scrollHeight; log.lastElementChild?.scrollIntoView({ block: 'end' }); }
  const input = $('#talk-input');
  if (input) {
    const grow = () => { input.style.height = 'auto'; input.style.height = Math.min(wide ? 220 : 140, input.scrollHeight) + 'px'; };
    input.oninput = grow; grow();
    // PC: Enter로 보내고 Shift+Enter로 줄바꿈. 폰: 보내기 단추 (Ctrl+Enter도 됨)
    input.onkeydown = e => { if (e.key === 'Escape' && ctxOpen) { ctxOpen = false; renderTalk(id); return; } if (e.key === 'Enter' && !e.isComposing && ((enterSends && !e.shiftKey) || e.ctrlKey || e.metaKey)) { e.preventDefault(); $('#talk-form').requestSubmit(); } };
    $('#talk-form').onsubmit = e => { e.preventDefault(); const t = input.value.trim(); if (t) sendTalk(id, t); };
    if (!keep && (wide || talkFocus) && !pending) input.focus({ preventScroll: true });
    talkFocus = false;
  }
  if (keep && $('#' + keep[0])) { const el = $('#' + keep[0]); el.focus({ preventScroll: true }); el.setSelectionRange(keep[1], keep[2]); }
}
// ── 슬라임의 기억 ── 이 앱에 남긴 모든 것(책에서 옮겨 적은 문장은 빼고) 가운데, 지금 이야기와 주제어가 겹치는 것을 먼저,
// 그다음 최근 것을 골라 오래된 순으로 보냅니다. 자주 나온 주제어도 한 줄로.
function memoryFor(c) {
  const { book } = talkSubject(c), skip = new Set([c.topic.ref]);
  const topicTags = new Set([...(state.readings[c.topic.ref]?.tags || []), ...(c.topic.kind === 'book' && book ? book.entries.flatMap(e => state.readings[e.id]?.tags || []) : [])]);
  const items = [], add = (id, kind, text, at) => {
    if (!text || !text.trim() || skip.has(id)) return;
    const score = (state.readings[id]?.tags || []).filter(t => topicTags.has(t)).length;
    items.push({ kind, text: text.slice(0, 380), at: isIso(at) ? Date.parse(at) : 0, score });
  };
  const words = list => (list || []).map(m => m.text);
  for (const t of state.thoughts) add(t.id, '생각', [t.text, ...words(t.more)].join(' / 덧붙임: '), t.createdAt);
  for (const a of state.answers) add(a.id, '슬라임의 물음에 한 답', `${a.prompt} → ${[a.text, ...words(a.more)].join(' / ')}`, a.createdAt);
  for (const b of state.books) {
    for (const e of b.entries) add(e.id, `『${cutN(b.title, 24)}』 문장에 단 메모`, [e.note, ...words(e.more)].filter(Boolean).join(' / '), e.createdAt);
    for (const q of b.questions) add(q.id, `『${cutN(b.title, 24)}』 질문`, `${q.text}${q.answer ? ` → 지금의 답: ${q.answer}` : ' (아직 답 없음)'}${(q.history || []).length ? ` (그땐: ${q.history.at(-1).text})` : ''}`, q.createdAt);
  }
  for (const x of state.chats) {
    if (x.id === c.id) continue;
    const mine = x.messages.filter(m => m.role === 'user'); if (!mine.length) continue;
    add('chat:' + x.id, `이야기 — ${talkKind[x.topic.kind]}${x.topic.kind === 'free' ? '' : ` “${cutN(talkFull(x), 30)}”`}에서 내가 한 말`, mine.slice(-4).map(m => m.text).join(' / '), mine.at(-1).at);
  }
  const related = items.filter(x => x.score).sort((a, b) => b.score - a.score || b.at - a.at).slice(0, 20);
  const rest = items.filter(x => !related.includes(x)).sort((a, b) => b.at - a.at).slice(0, 55 - related.length);
  const day = at => at ? new Date(at).toLocaleDateString('ko-KR', { year: new Date(at).getFullYear() === new Date().getFullYear() ? undefined : 'numeric', month: 'long', day: 'numeric' }) : '';
  const tags = tagCounts().slice(0, 12).map(([t, n]) => `#${t} ${n}번`).join(', ');
  return [...(tags ? [{ date: '', kind: '자주 나온 주제어', text: tags }] : []), ...[...related, ...rest].sort((a, b) => a.at - b.at).map(x => ({ date: day(x.at), kind: x.kind, text: x.text }))];
}
// 슬라임이 답 아래에 건네는 '이어서 꺼낼 말' — 이야기마다 마지막 답의 것만, 이 화면에서만 기억합니다
const talkNext = {};
async function sendTalk(id, text) {
  if (talkPending || busy) return;
  talkError = ''; delete talkNext[id];
  if (text && !await change(s => { s.chats.find(x => x.id === id).messages.push({ role: 'user', text, at: now() }); }, '')) return;
  if ($('#talk-input')) $('#talk-input').value = '';
  talkPending = id; if (route().page === 'talk') renderTalk(id);
  try {
    const c = state.chats.find(x => x.id === id);
    const res = await fetch(AI_CHAT_ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(60000), body: JSON.stringify({
      name: state.profile.catName || '슬라임', tone: state.profile.tone, topic: talkTopic(c), memory: memoryFor(c),
      messages: [...c.messages.slice(-30).map(m => ({ role: m.role, text: m.text }))]
    }) });
    const out = await res.json().catch(() => ({}));
    if (!res.ok || typeof out.reply !== 'string') throw new Error(out.error || `연결 실패 (${res.status})`);
    talkPending = '';
    talkNext[id] = Array.isArray(out.next) ? out.next.filter(x => typeof x === 'string' && x.trim()).slice(0, 3) : [];
    await change(s => {
      const chat = s.chats.find(x => x.id === id); if (!chat) return;
      chat.messages.push({ role: 'assistant', text: out.reply, at: now() });
      if (out.usage) { chat.usage ||= { input: 0, output: 0 }; chat.usage.input += out.usage.input || 0; chat.usage.output += out.usage.output || 0; }
      addUsage(s, 'chat', out.usage);
    }, '');
    flashUsage('chat', out.usage);
  } catch (e) {
    talkError = `${ig(state.profile.catName || '슬라임')} 대답하지 못했어요. ${e.name === 'TimeoutError' ? '시간이 너무 오래 걸렸습니다.' : e.message}`;
  } finally { talkPending = ''; if (route().page === 'talk' && route().id === id) renderTalk(id); }
}
// 이야기 중 내가 한 말을 골라, 이야기를 시작한 기록으로 돌려 남깁니다 (질문 → 지금의 답, 문장 → 덧붙임·질문, 생각 → 덧붙임)
function talkKeep(id) {
  const c = state.chats.find(x => x.id === id); if (!c) return;
  const targets = keepTargets(c), mine = c.messages.map((m, i) => ({ ...m, i })).filter(m => m.role === 'user'), last = mine.at(-1);
  const where = targets.length > 1 ? radios('어디에 남길까', 'target', targets.map(t => [t[0], t[1]]), targets[0][0], false)
    : `<p class="keep-target"><b>${esc(targets[0][1])}</b><small>${esc(targets[0][2])}</small><input type="hidden" name="target" value="${targets[0][0]}"></p>`;
  openModal(keepLabel(c), `<p class="hint">이 이야기에서 남길 내 말을 고르고, 필요하면 다듬으세요.</p><form id="edit-form">${where}<fieldset class="field pick"><legend>내가 한 말</legend><div class="keep-list">${mine.map(m => `<label class="keep-item"><input type="checkbox" name="keep" value="${m.i}" ${m === last ? 'checked' : ''}><span>${esc(m.text)}</span></label>`).join('')}</div></fieldset>${area('남길 말', 'text', last?.text || '', true)}${submit('남기기')}</form>`);
  const form = $('#edit-form'), box = $('#f-text'); let typed = false;
  box.addEventListener('input', () => { typed = true; });
  form.addEventListener('change', e => { if (e.target.name === 'keep' && !typed) box.value = [...form.querySelectorAll('[name=keep]:checked')].map(x => c.messages[+x.value].text).join('\n'); });
  formHandler(data => {
    const text = data.get('text').trim(); if (!text) throw new Error('남길 말을 적어 주세요.');
    return saveKeep(c, data.get('target'), text);
  });
}
function saveKeep(c, target, text) {
  const { book, item } = talkSubject(c);
  const done = { answer: '질문의 답으로 남겼습니다. 예전 답은 “그땐”에 있어요.', memo: '문장 아래 덧붙였습니다.', question: '책의 질문으로 남겼습니다.', more: '생각 아래 덧붙였습니다.', amore: '답 아래 덧붙였습니다.', thought: '생각으로 남겼습니다.' }[target];
  const lost = () => { throw new Error('처음 이야기한 기록을 찾을 수 없습니다. 지워졌는지 확인해 주세요.'); };
  return change(s => {
    const b = book && s.books.find(x => x.id === book.id), line = { id: uid(), text, createdAt: now(), chat: c.id };
    if (target === 'answer') { const q = b?.questions.find(x => x.id === item?.id) || lost(); if (q.answer === text) return; if (q.answer) (q.history ||= []).push({ text: q.answer, at: q.answeredAt }); q.answer = text; q.answeredAt = now(); }
    else if (target === 'memo') { const e = b?.entries.find(x => x.id === item?.id) || lost(); (e.more ||= []).push(line); }
    else if (target === 'question') { if (!b) lost(); b.questions.push({ id: uid(), createdAt: now(), text, answer: '', answeredAt: '', from: c.topic.kind === 'entry' ? item?.id || '' : '', history: [] }); }
    else if (target === 'more') { const t = s.thoughts.find(x => x.id === item?.id) || lost(); (t.more ||= []).push(line); }
    else if (target === 'amore') { const a = s.answers.find(x => x.id === item?.id) || lost(); (a.more ||= []).push(line); }
    else s.thoughts.push({ id: uid(), createdAt: now(), text, more: [] });
  }, done);
}
// ── PC 서재: 왼쪽 위 이 책의 기록(이야기 목록처럼) · 왼쪽 아래 책 · 오른쪽 이야기 ──────────
const cutN = (t, n) => t.length > n ? t.slice(0, n) + '…' : t;
// 이야기가 어느 갈래에 속하나 — 책 id, 아니면 'thought'(생각 · 새 이야기 · 물음)
const laneOf = c => LANE[c.topic.kind] === 'book' ? (c.topic.kind === 'book' ? c.topic.ref : c.topic.book) : 'thought';
// 왼쪽 칸 (보통의 대화 앱처럼): 위에 이 책의 기록을 이야기 목록으로, 맨 아래에 책 표지. 하나를 고르면 오른쪽에서 그 기록으로 이야기합니다
function deskSideHtml(c, home) {
  const { book } = talkSubject(c), lane = laneOf(c), name = state.profile.catName || '슬라임';
  // no: 책 안에서의 번호(문장 1, 2… · 질문 Q1, Q2…) — 목록이 최근 순으로 바뀌어도 같은 기록은 같은 번호. full: 눌러 보기 전 전체 글(풍선 도움말)
  const row = (kind, ref, bookId, label, text, at, cls = '', no = '', full = '') => {
    const t = talkOf(kind, ref), n = t?.messages.length || 0, cur = c.topic.kind === kind && c.topic.ref === ref;
    return { at: Math.max(Date.parse(at) || 0, n ? lastAt(t) : 0), html: `<button class="rec-row ${cls} ${no ? 'numbered' : ''} ${n ? 'talked' : ''} ${cur ? 'on' : ''}" data-action="talk-${kind}" data-id="${esc(ref)}"${bookId ? ` data-book="${esc(bookId)}"` : ''}${cur ? ' aria-current="true"' : ''}${full ? ` title="${esc(full)}"` : ''}><span class="rec-line">${no ? `<b class="rec-no">${esc(no)}</b>` : ''}<span class="rec-text">${esc(text)}</span></span><span class="rec-kind">${esc(label)}${n ? `<em>${n}마디</em>` : ''}</span></button>` };
  };
  const list = rows => rows.sort((a, b) => b.at - a.at).map(r => r.html).join('');
  let head, body;
  if (lane !== 'thought' && book) {
    head = `<b>${esc(book.title)}</b><a class="text-link" href="#book/${esc(book.id)}">책 열기 ›</a>`;
    // 문장은 슬라임이 붙인 짧은 제목으로 (아직 없으면 앞부분), 질문은 내가 쓴 그대로
    const rows = [...book.entries.map((e, i) => row('entry', e.id, book.id, [e.page ? `p. ${e.page}` : '', e.note ? '메모 있음' : ''].filter(Boolean).join(' · ') || '문장', state.titles[e.id]?.t || cutN(e.text, 24), e.createdAt, '', String(i + 1), e.text)),
      ...book.questions.map((q, i) => row('question', q.id, book.id, q.answer ? '질문 · 답 있음' : '질문', q.text, q.createdAt, 'q', `Q${i + 1}`, q.text))];
    body = row('book', book.id, '', `문장 ${book.entries.length} · 질문 ${book.questions.length}`, '이 책 전체로 이야기', '', 'whole').html + (list(rows) || '<p class="hint">책 화면에서 문장이나 질문을 남기면 여기 쌓입니다.</p>');
  } else {
    head = `<b>생각</b><a class="text-link" href="#thoughts">생각 탭 ›</a>`;
    const free = state.chats.filter(x => x.topic.kind === 'free' && x.messages.length).map(x => ({ at: lastAt(x), html: `<a class="rec-row talked ${x.id === c.id ? 'on' : ''}" href="#talk/${esc(x.id)}"${x.id === c.id ? ' aria-current="true"' : ''}><span class="rec-text">${esc(talkName(x))}</span><span class="rec-kind">${esc(wa(name))} 이야기<em>${x.messages.length}마디</em></span></a>` }));
    const rows = [...state.thoughts.slice(-40).map(t => row('thought', t.id, '', `생각 · ${dayShort(t.createdAt)}`, t.text, t.createdAt)),
      ...state.answers.slice(-20).map(a => row('answer', a.id, '', `${name}의 물음`, a.prompt, a.createdAt, 'q')), ...free];
    body = `<button class="rec-row whole" data-action="talk-free"><span class="rec-text">＋ 새 이야기</span><span class="rec-kind">주제 없이</span></button>${list(rows)}`;
  }
  const recent = id => Math.max(0, ...state.chats.filter(x => x.messages.length && laneOf(x) === id).map(lastAt));
  const books = [...state.books].sort((a, b) => recent(b.id) - recent(a.id) || (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0));
  return `<aside class="desk-side" aria-label="기록과 책">
    <div class="side-top"><a class="side-back talk-back" href="${home.href}" aria-label="돌아가기" title="돌아가기">←</a><div class="side-title">${head}</div></div>
    <nav class="recs-list" aria-label="기록">${body}</nav>
    <div class="side-books" aria-label="책 고르기">${books.map(b => `<button class="rail-book ${b.id === lane ? 'on' : ''}" data-action="desk-book" data-id="${esc(b.id)}" title="${esc(b.title)}" aria-label="『${esc(b.title)}』 이야기" ${b.id === lane ? 'aria-current="true"' : ''}>${cover(b)}</button>`).join('')}<button class="rail-book rail-thought ${lane === 'thought' ? 'on' : ''}" data-action="desk-thoughts" title="생각" aria-label="생각 이야기" ${lane === 'thought' ? 'aria-current="true"' : ''}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 15.5c-1.9-.4-3-2-2.7-3.8.3-1.6 1.7-2.7 3.3-2.6.6-2.5 3-4.1 5.6-3.6 1.4.3 2.6 1.1 3.3 2.3 2.4-.4 4.6 1.3 4.9 3.7.3 2.4-1.5 4.4-3.9 4.5H5z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg></button></div>
  </aside>`;
}
async function deleteMore(id) {
  const all = s => [...s.thoughts, ...s.answers, ...s.books.flatMap(b => b.entries)];
  let gone = null;
  const ok = await change(s => { for (const x of all(s)) { const i = (x.more || []).findIndex(m => m.id === id); if (i >= 0) { gone = { parent: x.id, i, item: x.more[i] }; x.more.splice(i, 1); return; } } }, '');
  if (ok && gone) notice('덧붙인 말을 지웠습니다.', async () => {
    if (await change(s => { const x = all(s).find(y => y.id === gone.parent); if (!x) throw new Error('원래 기록이 지워졌습니다.'); if (!(x.more ||= []).some(m => m.id === id)) x.more.splice(gone.i, 0, gone.item); }, '되돌렸습니다.')) undoAction = null;
  });
}
// ── 나: 슬라임, 오늘의 말, 기록 모아보기, AI, 보관 ────────────────
const miniSlime = color => `<svg viewBox="0 0 64 64" aria-hidden="true"><ellipse cx="32" cy="55" rx="20" ry="3.5" fill="#000" opacity=".08"/><path d="M10 46C7 28 17 14 32 14s25 14 22 32c-1 6-43 6-44 0z" fill="${color}" stroke="rgba(0,0,0,.12)" stroke-width="2"/><ellipse cx="23" cy="25" rx="5" ry="2.8" fill="#fff" opacity=".8"/><circle cx="26" cy="35" r="2.6" fill="#3a3129"/><circle cx="38" cy="35" r="2.6" fill="#3a3129"/><path d="M29 40q3 3 6 0" fill="none" stroke="#3a3129" stroke-width="2" stroke-linecap="round"/></svg>`;
function usageBlock() {
  const u = state.usage || emptyUsage();
  if (!u.calls) return '<p class="hint">아직 AI를 부른 적이 없습니다. 부를 때마다 화면 아래에 잠깐 토큰 수가 뜨고, 여기에 모입니다.</p>';
  const rows = Object.entries(u.byKind).map(([k, v]) => `<tr><th>${esc(USAGE_LABEL[k] || k)}</th><td>${v.calls.toLocaleString()}번</td><td>${(v.input + v.output).toLocaleString()}</td><td>${fmtWon(dollars(v))}</td></tr>`).join('');
  return `<div class="usage-total"><b>${(u.input + u.output).toLocaleString()}</b><span>토큰 · 약 ${fmtWon(dollars(u))}</span></div>
    <p class="hint">${u.calls.toLocaleString()}번 불렀습니다 · 입력 ${u.input.toLocaleString()} · 출력 ${u.output.toLocaleString()}${u.since ? ` · ${esc(dateLabel(u.since))}부터` : ''}</p>
    <div class="usage-table"><table><thead><tr><th>종류</th><th>횟수</th><th>토큰</th><th>대략</th></tr></thead><tbody>${rows}</tbody></table></div>
    <p class="hint">Claude Haiku 5.5 값(입력 100만 토큰당 $0.10, 출력 $0.50)과 1달러 = ${WON_PER_USD.toLocaleString()}원으로 셈한 대략치입니다. 정확한 청구는 Anthropic 콘솔에서 확인하세요.</p>
    <button class="quiet" data-action="usage-reset">0부터 다시 세기</button>`;
}
// ── 슬라임이 본 나 ── 기록에서 바로 센 것. 주제어를 누르면 기록 지도에서 그 주제어를 펼칩니다.
let boardFocus = '';
function seenHtml() {
  const r = seenSelf(state), name = state.profile.catName || '슬라임';
  if (r.total < 3) return `<section class="me-card seen"><h2>${esc(ig(name))} 본 나</h2><p class="hint">기록이 조금 더 쌓이면 여기서 내가 요즘 어디에 머무는지 보여 줄게요. 생각을 먹이고, 책에 메모를 남겨 보세요.</p></section>`;
  const tag = ([t, n], cls = '') => `<button class="seen-tag ${cls}" data-action="seen-tag" data-id="${esc(t)}">#${esc(t)} <small>${n}</small></button>`;
  const max = Math.max(1, ...r.months.flatMap(m => m.tags.map(t => t[1])));
  const month = m => `<div class="seen-month"><b>${Number(m.key.slice(5))}월</b><small>기록 ${m.records}</small><div class="seen-bars">${m.tags.length ? m.tags.map(([t, n]) => `<button class="seen-bar" data-action="seen-tag" data-id="${esc(t)}"><span style="width:${Math.round(n / max * 100)}%"></span><em>#${esc(t)} ${n}</em></button>`).join('') : `<p class="hint">${state.profile.aiConsentAt ? '주제어가 아직 없어요' : '슬라임이 기록 읽기를 켜면 주제어가 붙어요'}</p>`}</div></div>`;
  return `<section class="me-card seen"><h2>${esc(ig(name))} 본 나</h2>
    <h3>달마다 머문 곳</h3>${r.months.map(month).join('')}
    ${r.fresh.length || r.faded.length ? `<h3>요즘 30일</h3>${r.fresh.length ? `<p class="seen-row"><span>새로 생김</span>${r.fresh.map(t => tag(t, 'new')).join('')}</p>` : ''}${r.faded.length ? `<p class="seen-row"><span>뜸해짐</span>${r.faded.map(t => tag(t, 'old')).join('')}</p>` : ''}` : ''}
    ${r.holding.length ? `<h3>오래 품은 질문</h3>${r.holding.map(q => `<button class="seen-item" data-action="seen-go" data-kind="question" data-id="${esc(q.id)}" data-book="${esc(q.book)}"><span>? ${esc(q.text)}</span><small>${q.days}일째</small></button>`).join('')}` : ''}
    ${r.changed.length ? `<h3>그땐 → 지금은</h3>${r.changed.map(q => `<button class="seen-item" data-action="seen-go" data-kind="question" data-id="${esc(q.id)}" data-book="${esc(q.book)}"><span>${esc(q.text)}</span><small>그땐 ${esc(cutN(q.then, 40))} → 지금은 ${esc(cutN(q.now, 40))}</small></button>`).join('')}` : ''}
    ${r.talked.length ? `<h3>가장 오래 이야기한 것</h3>${r.talked.map(c => `<a class="seen-item" href="#talk/${esc(c.id)}"><span>${esc(cutN(talkFull(state.chats.find(x => x.id === c.id)) || c.title, 60))}</span><small>${talkKind[c.kind]} · ${c.n}마디</small></a>`).join('')}` : ''}
  </section>`;
}
// 숨은 동작 안내 — 슬라임 · 기록 지도 · 이야기
let guideOpen = false;
const GUIDE = [
  ['슬라임 (첫 화면)', [
    ['톡 누르기', '출렁이고, 가끔 내가 남긴 기록을 꺼내 말해요.'],
    ['방울 누르기', '그 방울이 어떤 기록인지 말해 줘요. 방울 하나가 기록 하나예요.'],
    ['두 번 톡', '생각 먹이기 칸이 열려요.'],
    ['잡아당겼다 놓기', '늘어났다가 튕겨요. 세게 당겨 던지면 날아가요.'],
    ['꾹 누르고 있기', '부풀다가 펑 터지면서 기록 지도가 펼쳐져요. 터지기 전에 떼면 그대로예요.'],
    ['폰 흔들기', '흔드는 세기만큼 이리저리 날아가요. 아이폰은 처음에 허락을 물어요.'],
    ['빈 곳 끌기', '슬라임을 빙 돌려 볼 수 있어요.'],
    ['두 손가락 벌리기 · 모으기', '가까이 · 멀리.'],
    ['밤 9시 ~ 아침 6시', '방이 어두워지고 슬라임이 졸아요. 만지면 깨요.'],
  ]],
  ['기록 지도', [
    ['점 누르기', '그 기록 카드가 열려요. 이야기하기 · 기록 보기로 이어져요.'],
    ['큰 점(주제어 · 책) 누르기', '그 주제어나 책에 이어진 기록이 모여요.'],
    ['끌기 · 두 손가락 · 휠', '점을 옮기거나, 화면을 옮기고 확대해요. 오른쪽 위 단추는 전체 보기.'],
  ]],
  ['이야기', [
    ['먼저 말하기', '이야기는 내가 먼저 꺼내요. 슬라임은 이 앱에 남긴 기록을 기억하고 이어 말해요.'],
    ['남기기', '이야기 끝에 내 말을 처음 기록으로 돌려 남겨요 (질문 → 지금의 답, 문장 · 생각 → 덧붙이기).'],
    ['PC 모드', '이야기 화면을 폰에서도 노트북처럼 · Enter 보내기 · Shift+Enter 줄바꿈 · Ctrl+S 남기기.'],
  ]],
];
const guideHtml = () => `<details class="me-card guide" id="guide" ${guideOpen ? 'open' : ''}><summary><h2>슬라임 다루는 법</h2></summary>${GUIDE.map(([h, rows]) => `<h3>${h}</h3><dl>${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>`).join('')}</details>`;
function renderMe() {
  const p = state.profile, name = p.catName || '나만의 슬라임', s = stats(state), look = slimeLook();
  const first = beadList().find(b => b.at), days = first ? Math.max(1, Math.round((Date.now() - first.at) / 864e5)) : 0;
  $('#main').innerHTML = `<div class="narrow me">
    <section class="me-card me-slime">
      <div class="me-avatar">${miniSlime(look.color)}</div>
      <div class="me-who"><h1>${esc(name)}</h1><p>${days ? `<span>함께한 지 ${days}일</span> · ` : ''}<span>방울 ${beadList().length}개</span>${look.tag ? ` · <span>요즘 #${esc(look.tag)}</span>` : ''}</p></div>
      <button data-action="profile">바꾸기</button>
    </section>
    ${seenHtml()}
    ${guideHtml()}
    <section class="me-card"><h2>슬라임이 기록 읽기</h2>
      <p class="hint">켜면 내가 쓴 <b>생각, 메모와 덧붙인 말, 질문과 답, 이야기에서 한 말</b>을 AI(Anthropic Claude)에게 보내 주제어를 붙이고, 이야기와 책 정리 때 슬라임이 이걸 <b>기억</b>으로 씁니다. 책에서 옮겨 적은 문장은 내가 골라 이야기할 때만 보냅니다. 중계소는 글을 저장하지 않고, 결과는 이 기기에만 남습니다.</p>
      <div class="me-toggle"><button id="ai-toggle" class="${p.aiConsentAt ? '' : 'primary'}">${p.aiConsentAt ? '끄기' : '켜기'}</button><p class="hint" id="ai-status">${aiStatus()}</p></div>
    </section>
    <section class="me-card"><h2>PC 모드</h2><p class="hint">켜면 <b>이야기 화면이 폰에서도 노트북처럼</b> 넓은 화면을 줄여서 보입니다(가로로 눕히면 더 넓게). 다른 화면은 그대로입니다. 이야기는 왼쪽에 기록 목록과 책, 오른쪽에 대화로 나오고, <b>Enter로 보내고 Shift+Enter로 줄을 바꿉니다.</b> 블루투스 키보드를 쓰도록 화면 자판은 띄우지 않으며, 이야기 머리줄의 <b>자판</b> 단추로 다시 띄울 수 있습니다. 이야기 화면 오른쪽 위 <b>PC</b> 단추로도 켜고 끌 수 있습니다. 이 기기에만 적용됩니다.</p><div class="me-toggle"><button id="pc-toggle" class="${pcMode() ? '' : 'primary'}">${pcMode() ? 'PC 모드 끄기' : 'PC 모드 켜기'}</button></div></section>
    <section class="me-card"><h2>AI 사용량</h2>${usageBlock()}</section>
    <section class="me-card"><h2>보관</h2>
      <p class="hint">기록은 이 폰의 브라우저에만 있습니다. 가끔 파일로 내려받아 두세요. <b>${lastBackup() ? `마지막 백업: ${esc(dateLabel(lastBackup()))}` : '아직 백업한 적이 없습니다.'}</b></p>
      <button id="open-backup">백업과 복원</button>
    </section>
    <p class="me-foot">본 대로, 거짓 없이 · <span id="me-build">${esc($('#save-status').textContent)}</span></p>
  </div>`;
  if (guideOpen) { guideOpen = false; setTimeout(() => $('#guide')?.scrollIntoView({ block: 'start', behavior: 'smooth' }), 60); }
  $('#pc-toggle').onclick = () => { setPcMode(!pcMode()); renderMe(); notice(pcMode() ? 'PC 모드를 켰습니다. 이야기 화면이 노트북처럼 보이고 Enter로 보냅니다.' : 'PC 모드를 껐습니다.'); };
  $('#open-backup').onclick = () => { if (ready && !busy) settings(); };
  $('#ai-toggle').onclick = async () => {
    const on = !state.profile.aiConsentAt;
    if (await change(s => { s.profile.aiConsentAt = on ? now() : ''; }, on ? '슬라임이 기록을 읽기 시작합니다.' : '슬라임이 기록 읽기를 멈췄습니다.')) {
      if (on) { readBackoff = 0; await readRecords(); if (route().page === 'me') renderMe(); }
    }
  };
}
function settings() {
  const s = stats(state);
  openModal('백업과 복원',`<p class="hint">책 ${s.books}권 · 문장 ${s.entries}개 · 질문 ${s.questions}개<br>생각 ${s.thoughts}개 · 슬라임의 물음에 한 답 ${s.answers}개</p><p>기록은 이 기기의 브라우저에 저장됩니다.<br>휴대폰과 PC 사이에 자동으로 공유되지는 않습니다.</p><div class="storage-block"><h3>파일로 남겨두기</h3><p class="hint">직접 올린 표지 사진까지 포함해 내려받습니다. 검색으로 연결한 표지는 주소가 저장되어 인터넷 연결이 필요합니다.</p><button class="primary" id="export">전체 기록 내보내기</button></div><div class="storage-block"><h3>백업에서 가져오기</h3><p class="hint">이전 기록장의 JSON 파일도 읽을 수 있습니다. 파일을 고르면 복원할 내용을 먼저 보여드립니다.</p><label class="file-label">백업 파일 선택<input class="visually-hidden" type="file" id="import" accept=".json,application/json"></label><div id="restore-area"></div></div><div class="storage-block"><h3>직전 저장 상태</h3><p class="hint">바로 전 저장으로 돌아갑니다. 복원 시 현재 기록도 파일로 내려받습니다.</p><button id="previous">직전 상태 확인</button></div><div class="storage-block"><h3>오래 보관하기</h3><p class="hint">브라우저 데이터를 지우면 기록도 지워집니다. 중요한 기록은 파일로도 보관해주세요.</p><button id="persistent">브라우저에 보관 요청</button><p class="hint" id="persistent-status"></p></div>`);
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
  if (btn.dataset.talkFilter) { talkFilter = btn.dataset.talkFilter; renderTalks(); }
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
    case 'talk-free': talkFocus = true; startTalk('free'); break;
    case 'open-board': if (slime) slime.pop(); else location.hash = 'board'; break;
    case 'board-pick': board?.select(btn.dataset.id); break;
    case 'board-close': board?.select(null); $('#board-card').hidden = true; break;
    case 'board-fit': board?.fit(); break;
    case 'board-open': { const { kind } = btn.dataset; focusRec = id; if (kind === 'thought') location.hash = 'thoughts'; else if (kind === 'answer') { talkFilter = 'ask'; location.hash = 'talk'; } else { entryTab = kind === 'question' ? 'questions' : 'entries'; location.hash = `book/${book}`; } break; }
    case 'talk-book': { const b = currentBook() || state.books.find(x => x.id === id); if (b) { talkFocus = true; startTalk('book', b.id); } break; }
    case 'talk-thought': talkFocus = true; startTalk('thought', id); break;
    case 'talk-answer': talkFocus = true; startTalk('answer', id); break;
    case 'talk-entry': talkFocus = true; startTalk('entry', id, book); break;
    case 'talk-question': talkFocus = true; startTalk('question', id, book); break;
    case 'talk-quote': { if (ctxOpen) { ctxOpen = false; document.body.classList.remove('ctx-open'); $('[data-action=talk-ctx]')?.setAttribute('aria-pressed', 'false'); } const el = $('#talk-input'); if (el) { el.value = (el.value ? el.value.replace(/\s*$/, '\n') : '') + `“${btn.dataset.text}” `; el.dispatchEvent(new Event('input')); el.focus(); } break; }
    case 'talk-keep': talkKeep(route().id); break;
    case 'soft-kb': { try { localStorage.setItem('soft-kb', softKb() ? '0' : '1'); } catch {} renderTalk(route().id); $('#talk-input')?.focus(); notice(softKb() ? '화면 자판을 띄웁니다.' : '화면 자판을 숨깁니다. 블루투스 키보드로 적으세요.'); break; }
    case 'talk-next': { const el = $('#talk-input'); if (el) { el.value = el.value.trim() ? el.value.replace(/\s*$/, ' ') + btn.dataset.text : btn.dataset.text; el.dispatchEvent(new Event('input')); el.focus(); el.setSelectionRange(el.value.length, el.value.length); } break; }   // 눌러도 바로 보내지 않고 입력칸에 — 고쳐서 보내도 됩니다
    case 'desk-book': case 'desk-thoughts': {   // 왼쪽 아래 책(또는 생각)을 고르면 그 갈래에서 마지막으로 이야기한 것을 엽니다
      const lane = action === 'desk-book' ? id : 'thought', last = state.chats.filter(x => x.messages.length && laneOf(x) === lane).sort((a, b) => lastAt(b) - lastAt(a))[0];
      talkFocus = true;
      if (last) location.hash = `talk/${last.id}`; else if (lane === 'thought') startTalk('free'); else startTalk('book', id);
      break;
    }
    case 'talk-delete': deleteTalk(id); break;
    case 'guide-ok': try { localStorage.setItem('guide-seen', '1'); } catch {} renderHome(); break;
    case 'guide-open': try { localStorage.setItem('guide-seen', '1'); } catch {} guideOpen = true; location.hash = 'me'; break;
    case 'seen-tag': boardFocus = 'tag:' + id; location.hash = 'board'; break;
    case 'seen-go': focusRec = id; entryTab = 'questions'; location.hash = `book/${book}`; break;
    case 'summarize': { const b = currentBook(); if (b) summarizeBook(b.id); break; }
    case 'sum-go': entryTab = btn.dataset.tab; focusRec = id; renderBook(); break;
    case 'backup-now': exportState(); notice('기록을 파일로 내려받았습니다. 파일을 안전한 곳(드라이브 등)에 옮겨 두세요.'); break;
    case 'backup-later': try { localStorage.setItem('backup-snooze', String(Date.now() + 3 * 864e5)); } catch {} syncBackupNudge(); break;
    case 'delete-more': deleteMore(id); break;
    case 'ask-from': recordEditor('questions', book, undefined, false, id); break;
    case 'talk-ctx': ctxOpen = !ctxOpen; renderTalk(route().id); break;
    case 'pc-mode': { setPcMode(!pcMode()); ctxOpen = false; render(); notice(pcMode() ? 'PC 모드: 이야기 화면이 노트북처럼 보이고 Enter로 보냅니다.' : 'PC 모드를 껐습니다.'); break; }
    case 'talk-retry': { const c = state.chats.find(x => x.id === route().id); if (c?.messages.at(-1)?.role === 'user') sendTalk(c.id, ''); break; }
    case 'usage-reset': change(s => { s.usage = emptyUsage(); }, 'AI 사용량을 0부터 다시 셉니다.'); break;
    case 'edit-answer': answerEditor('', id); break;
  }
});
window.addEventListener('hashchange',() => { if (syncViewport()) return; if (dialog.open) closeModal(); render(); window.scrollTo(0,0); });
// 서재: Ctrl+S(⌘S)로 남기기 — 이야기에서 내가 한 말이 있을 때
document.addEventListener('keydown', e => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's' && route().page === 'talk' && route().id && !dialog.open && $('[data-action=talk-keep]')) { e.preventDefault(); talkKeep(route().id); } });
let resizeTimer = 0;
window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { if (route().page === 'talk' && route().id && !dialog.open && !!$('.talk-desk.desk') !== (pcMode() || matchMedia('(min-width: 760px)').matches)) { const d = $('#talk-input')?.value; render(); if (d && $('#talk-input')) { $('#talk-input').value = d; $('#talk-input').dispatchEvent(new Event('input')); } } }, 250); });
window.addEventListener('beforeunload',e => { if (busy) { e.preventDefault(); e.returnValue = ''; } });
channel && (channel.onmessage = async e => {
  if (e.data <= revision) return;
  if (dialog.open || busy) { notice('다른 창에서 기록이 변경됐습니다. 작성 내용을 복사한 뒤 새로고침해주세요.'); return; }
  try { const loaded = await load(db); state = loaded.state; revision = loaded.revision; render(); notice('다른 창의 기록을 불러왔습니다.'); } catch(e) { showError(e.message); }
});
async function init() {
  if (location.search.startsWith('?v=')) history.replaceState(null, '', location.pathname + location.hash);   // PC 모드를 켜고 끌 때 붙인 표시
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
