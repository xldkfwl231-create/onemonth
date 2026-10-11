import { uid, now, emptyState, normalize, backup, stats, matchesBook, dateLabel, safeCover, emptyUsage, dayOf, isIso } from './core.js';
import { mountSlime } from './slime.js';
import { openStore, load, commit, previous } from './storage.js';
import { BOOK_SEARCH_ENDPOINT, AI_ENDPOINT, AI_REFLECT_ENDPOINT, AI_CHAT_ENDPOINT } from './config.js';

const BUILD = '1012i';   // 폰에서 어떤 판을 보고 있는지 확인용
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
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
  if (page !== 'home') document.body.classList.remove('night');
  const tab = { book:'shelf', questions:'shelf', shelf:'shelf', thoughts:'thoughts', me:'me', answers:'talk', talk:'talk' }[page] || 'home';
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
// 이름이 없을 때만 말풍선으로 이름을 묻습니다
const nameBubble = () => state.profile.catName ? '' : `<div class="bubble"><p class="bubble-text">안녕. 나는 아직 이름이 없는 슬라임이야. 이름을 지어 줄래?</p><div class="bubble-actions"><button class="primary" data-action="profile">이름 지어 주기</button></div></div>`;
// 생각 먹이기 — 주제 없이 떠오른 걸 적으면 생각 탭에 남고, 슬라임 안에 방울로 떨어집니다
const feedDraft = { get: () => { try { return localStorage.getItem('feed-draft') || ''; } catch { return ''; } }, set: v => { try { v ? localStorage.setItem('feed-draft', v) : localStorage.removeItem('feed-draft'); } catch {} } };
function feedHtml() {
  const name = state.profile.catName || '슬라임';
  return `<form class="feed" id="feed-form"><label class="visually-hidden" for="feed-input">${esc(name)}에게 먹일 생각</label><textarea id="feed-input" rows="1" maxlength="5000" placeholder="떠오른 생각을 적으면 ${esc(name)}이 먹어요">${esc(feedDraft.get())}</textarea><button class="primary" type="submit" aria-label="먹이기"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V6M6.5 11.5 12 6l5.5 5.5" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg></button></form>`;
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
// 슬라임이 먹은 기록 — 생각, 책 문장, 슬라임에게 한 답. 오래된 것부터.
// ── AI 사용량 ── 요청마다 아래에 잠깐 보여 주고, '나'에 모아 둡니다. 값은 Claude Haiku 5.5 기준 대략치.
const USAGE_LABEL = { tags: '주제어 붙이기', reflect: '오늘의 말', chat: '이야기' };
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
      addUsage(s, 'tags', body.usage);
    }, '');
    flashUsage('tags', body.usage);
    const tag = lastFed && state.readings[lastFed]?.tags?.[0];
    if (tag && route().page === 'home') { lastFed = ''; setTimeout(() => showSay(`음… #${tag} 맛이 나.`), 1200); }
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
    await change(s => { s.insights = { date, at: now(), question: out.question || '', lines: (out.lines || []).map(l => ({ text: l.text, ids: l.ids || [] })) }; addUsage(s, 'reflect', out.usage); }, '');
    flashUsage('reflect', out.usage);
  } catch { reflectBackoff = Date.now() + 15 * 60e3; }
  finally { reflecting = false; }
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
  return `<a class="home-name" href="#me" aria-label="${esc(name)} — 나 화면으로">${miniSlime(look.color)}<b>${esc(name)}</b><span>방울 ${n}${look.tag ? ` · #${esc(look.tag)}` : ''}</span></a><span class="home-day">${icon}${esc(day)}</span>`;
}
function renderHome() {
  // 슬라임이 떠 있는 동안에는 말풍선만 바꿉니다 — 출렁이던 게 멈추지 않도록
  if (slime && $('#slime-stage')) { $('#home-bubble').innerHTML = nameBubble(); $('#home-bubble').hidden = !!state.profile.catName; syncBeads(); $('#home-top').innerHTML = homeTop(); return; }
  $('#main').innerHTML = `<section class="slime-home" aria-label="슬라임">
    <div class="home-top" id="home-top">${homeTop()}</div>
    <div class="slime-stage" id="slime-stage"><div class="slime-say" id="slime-say" role="status" hidden></div></div>
    <div class="home-bubble" id="home-bubble" ${state.profile.catName ? 'hidden' : ''}>${nameBubble()}</div>
    ${feedHtml()}
  </section>`;
  wireFeed();
  try { slime = mountSlime($('#slime-stage'), { onPoke: maybeSay, onBead: id => showSay(beadText(id)), onDoubleTap: () => $('#feed-input')?.focus(), reduced: matchMedia('(prefers-reduced-motion: reduce)').matches }); syncBeads(); syncNight(); }
  catch (e) { $('#slime-stage').innerHTML = `<p class="empty">이 브라우저에서는 슬라임을 그릴 수 없습니다.<br><small>${esc(e.message)}</small></p>`; }
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
function renderBook() {
  const b = currentBook();
  if (!b) { $('#main').innerHTML = empty('책을 찾을 수 없어요', '책장에서 다른 책을 골라주세요.', '<a class="back" href="#shelf">← 책장으로</a>'); return; }
  const activeQuery = query.trim();
  const records = b[entryTab].filter(e => !activeQuery || [e.text,e.note || '',e.answer || '',e.page || ''].some(t => t.toLowerCase().includes(activeQuery.toLowerCase())));
  $('#main').innerHTML = `<div class="narrow"><a class="back" href="#shelf">← 책장으로</a><section class="book-hero" aria-labelledby="book-title">${cover(b)}<span class="status-tag">${b.status === 'finished' ? '다 읽음' : '읽는 중'}</span><h1 id="book-title">${esc(b.title)}</h1><p class="book-sub">${esc([b.author,b.publisher].filter(Boolean).join(' · ') || '나만의 독서 기록')}</p><p class="book-sub small">${esc(dateLabel(b.createdAt))}부터${b.finishedAt ? ` · ${esc(dateLabel(b.finishedAt))} 완독` : ''}</p><div class="actions">${talkButton('book', b.id, '', 'primary')}</div><div class="actions small-actions"><button class="quiet" data-action="edit-book">책 정보 수정</button><button class="quiet" data-action="toggle-status">${b.status === 'finished' ? '다시 읽기' : '다 읽었어요'}</button></div></section><div class="book-tabs"><div class="seg" role="group" aria-label="문장과 질문"><button class="entries" data-entry-tab="entries" aria-pressed="${entryTab === 'entries'}"><span aria-hidden="true">“</span> 문장 <small>${b.entries.length}</small></button><button class="questions" data-entry-tab="questions" aria-pressed="${entryTab === 'questions'}"><span aria-hidden="true">?</span> 질문 <small>${b.questions.length}${b.questions.filter(q => q.answer).length ? ` · 답 ${b.questions.filter(q => q.answer).length}` : ''}</small></button></div><button class="primary" data-action="add-record">＋ ${entryTab === 'entries' ? '문장' : '질문'}</button></div>${activeQuery ? `<p class="search-count">“${esc(query)}” 검색 중 <button class="quiet" data-action="clear-query">검색 해제</button></p>` : ''}<div class="quotes">${records.length ? [...records].reverse().map(e => quoteCard(e,b,entryTab)).join('') : empty(activeQuery ? '일치하는 기록이 없어요' : entryTab === 'entries' ? '오래 두고 싶은 문장' : '서둘러 답하지 않아도 괜찮아요', activeQuery ? '검색을 해제하면 모든 기록이 보입니다.' : entryTab === 'entries' ? '읽다가 걸린 문장과 그때의 생각을 남겨보세요.' : '읽다가 생긴 물음을 적어두고, 나중의 나에게 건네보세요.')}</div><p class="section-note"><button class="quiet danger" data-action="delete-book">이 책 삭제</button></p></div>`;
  focusRecord();
}
function renderQuestions() {
  const qs = state.books.flatMap(b => b.questions.map(q => ({ b, q }))).filter(({q}) => questionFilter === 'all' || (questionFilter === 'open' ? !q.answer : !!q.answer)).reverse();
  $('#main').innerHTML = `<div class="narrow"><a class="back" href="#shelf">← 책장으로</a><div class="intro"><div><h1>모든 책의 질문</h1><p>답을 기다리는 시간도 독서의 일부니까요.</p></div></div><div class="toolbar"><div class="filters" aria-label="답변 상태">${[['open','답을 기다리는'],['answered','지금의 답이 있는'],['all','모두']].map(([v,l]) => `<button data-question-filter="${v}" aria-pressed="${questionFilter === v}">${l}</button>`).join('')}</div></div><div class="quotes">${qs.map(({b,q}) => quoteCard(q,b,'questions',true)).join('') || empty('질문을 위한 빈자리', '책을 열어 떠오른 물음을 남기면 이곳에 모입니다.')}</div></div>`;
  focusRecord();
}
function renderThoughts() {
  $('#main').innerHTML = `<div class="narrow"><div class="intro"><div><h1>떠오르는 생각</h1><p>책과 상관없이, 스스로 떠오른 것.</p></div><button class="primary intro-actions" data-action="add-journal">＋ 기록</button></div>${state.thoughts.length ? timeline([...state.thoughts].reverse(), t => `<span class="tl-date">${esc(dayShort(t.createdAt))}</span><p class="tl-text">${esc(t.text)}</p>${moreHtml(t.more)}${tagLine(t.id)}<div class="q-actions">${talkButton('thought', t.id)}<button data-action="edit-journal" data-id="${esc(t.id)}">수정</button><button data-action="delete-record" data-type="thoughts" data-id="${esc(t.id)}">삭제</button></div>`) : empty('아무렇게나, 한 줄부터', '잘 정리하지 않아도 괜찮습니다.')}</div>`;
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
  return cut60(c.topic.title || '');
}
// 이야기의 주제 글 전체 — 자르지 않습니다 (지워졌으면 저장해 둔 제목)
function talkFull(c) {
  const { book, item } = talkSubject(c);
  if (c.topic.kind === 'book') return book?.title || c.topic.title || '';
  if (c.topic.kind === 'answer') return item?.prompt || c.topic.title || '';
  return item?.text || c.topic.title || '';
}
function talkOpener(c) {
  const we = state.profile.tone !== 'you', { book } = talkSubject(c), t = talkFull(c);
  if (c.topic.kind === 'book') return `『${t}』 얘기 하자. 어떤 게 마음에 남았어?`;
  if (c.topic.kind === 'entry') return `${book ? `『${book.title}』에서 고른 문장이야.

` : ''}“${t}”

이 문장, 어디가 마음에 걸렸어?`;
  if (c.topic.kind === 'question') return `“${t}”

이 질문, ${we ? '우리' : '너랑'} 같이 붙잡아 볼까?`;
  if (c.topic.kind === 'thought') return `“${t}”

이 생각, ${we ? '우리' : '너랑'} 같이 더 들여다볼까?`;
  if (c.topic.kind === 'answer') return `내가 이렇게 물었지.

“${t}”

그 답, ${we ? '우리' : '너랑'} 조금 더 들여다볼까?`;
  return '무슨 얘기부터 할까? 책이든 요즘 생각이든 다 좋아.';
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
function talkListHtml(currentId, only) {
  const list = only || [...state.chats].sort((a, b) => lastAt(b) - lastAt(a));
  return list.length ? list.map(c => { const last = c.messages[c.messages.length - 1]; return `<a class="talk-item ${c.id === currentId ? 'on' : ''}" href="#talk/${esc(c.id)}" ${c.id === currentId ? 'aria-current="page"' : ''}><span class="status-tag">${talkKind[c.topic.kind]}</span><b>${esc(talkName(c))}</b>${['entry', 'question'].includes(c.topic.kind) && talkSubject(c).book ? `<small class="from">『${esc(talkSubject(c).book.title)}』</small>` : ''}<small>${esc(last ? last.text.slice(0, 60) : '아직 아무 말도 안 했어요')}</small><small>${esc(dateLabel(c.createdAt))} · ${c.messages.length}마디</small></a>`; }).join('')
    : empty('아직 나눈 이야기가 없어요', '책·문장·질문·생각에서 "이야기하기"를 누르거나, 새 이야기로 시작해 보세요.');
}
// PC 모드 — 폰을 노트북에 연결해 이야기할 때. 이 기기에만 기억합니다. (예전 'Enter로 보내기'를 켜 두었으면 켠 것으로)
function pcMode() {
  try { const v = localStorage.getItem('pc-mode'); if (v === '1' || v === '0') return v === '1'; return localStorage.getItem('enter-sends') === '1'; } catch { return false; }
}
function setPcMode(on) { try { localStorage.setItem('pc-mode', on ? '1' : '0'); localStorage.removeItem('enter-sends'); } catch {} }
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
    ...state.chats.filter(c => c.topic.kind !== 'answer' || !state.answers.some(a => a.id === c.topic.ref)).map(c => ({ lane: LANE[c.topic.kind], at: lastAt(c), html: () => talkListHtml('', [c]) })),
    ...state.answers.map(a => { const c = talkOf('answer', a.id); return { lane: 'ask', at: Math.max(Date.parse(a.createdAt) || 0, c ? lastAt(c) : 0), html: () => askCard(a) }; })
  ].sort((x, y) => y.at - x.at);
  const count = k => items.filter(x => k === 'all' || x.lane === k).length;
  const shown = items.filter(x => talkFilter === 'all' || x.lane === talkFilter);
  const lanes = [['all', '전체'], ['book', '책'], ['thought', '생각'], ...(state.answers.length ? [['ask', `${name}의 물음`]] : [])];
  if (talkFilter === 'ask' && !state.answers.length) talkFilter = 'all';
  const none = { all: ['아직 주고받은 게 없어요', '책·문장·질문·생각에서 "이야기하기"를 누르거나, ＋ 새 이야기로 시작해 보세요.'], book: ['책 이야기가 아직 없어요', '책장에서 문장이나 질문을 열고 "이야기하기"를 눌러 보세요.'], thought: ['생각 이야기가 아직 없어요', '생각 탭에서 "이야기하기"를 누르거나, 새 이야기로 시작해 보세요.'], ask: ['아직 답한 물음이 없어요', '첫 화면의 물음표를 누르면 오늘의 물음이 있습니다.'] }[talkFilter];
  $('#main').innerHTML = `<div class="narrow"><div class="intro"><div><h1>이야기</h1><p>${esc(name)}과 주고받은 것 — 내가 꺼낸 이야기와, ${esc(name)}이 물어 내가 한 답.</p></div><button class="primary intro-actions" data-action="talk-free">＋ 새 이야기</button></div><div class="toolbar"><div class="filters" aria-label="이야기 갈래">${lanes.map(([v, l]) => `<button data-talk-filter="${v}" aria-pressed="${talkFilter === v}">${esc(l)} <small>${count(v)}</small></button>`).join('')}</div></div><div class="talk-list">${shown.length ? shown.map(x => x.html()).join('') : empty(...none)}</div></div>`;
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
  const keep = old && document.activeElement === old ? [old.selectionStart, old.selectionEnd] : null;
  const face = miniSlime(slimeLook().color);
  const bubbleHtml = (role, text) => role === 'assistant' ? `<div class="talk-msg slime">${face}<p>${esc(text)}</p></div>` : `<div class="talk-msg me"><p>${esc(text)}</p></div>`;
  const pending = talkPending === id, on = !!state.profile.aiConsentAt, pc = pcMode(), wide = pc || matchMedia('(min-width: 760px)').matches, enterSends = enterSendsPref();
  document.body.classList.toggle('pc', pc); document.body.classList.toggle('desk-on', wide); document.body.classList.toggle('ctx-open', ctxOpen);
  $('#main').innerHTML = `<div class="talk-desk ${wide ? 'desk' : ''}">
    <aside class="talk-side" aria-label="이야기 목록"><div class="talk-side-head"><a class="back" href="#talk">← 이야기</a><button class="primary" data-action="talk-free">＋ 새 이야기</button></div><div class="talk-list">${talkListHtml(id)}</div></aside>
    <section class="talk" aria-label="이야기">
      <div class="talk-head"><a class="back talk-back" href="${home.href}">${home.label}</a><h1 class="talk-title"><span class="status-tag">${talkKind[c.topic.kind]}</span><span class="title-text" title="눌러서 전체 보기">${esc(c.topic.kind === 'free' ? `${name}과 이야기` : talkFull(c))}</span></h1><div class="talk-tools">${c.messages.some(m => m.role === 'user') ? `<button class="quiet" data-action="talk-keep">${keepLabel(c)}</button>` : ''}<button class="tool ctx-toggle" data-action="talk-ctx" aria-pressed="${ctxOpen}" aria-label="이야기의 배경 보기" title="배경 보기"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 4h11l3 3v13H5z M9 10h7 M9 14h7" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/></svg></button><button class="tool" data-action="pc-mode" aria-pressed="${pc}" aria-label="PC 모드 ${pc ? '끄기' : '켜기'}" title="PC 모드"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 6h14v9H5z M3 18h18" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/></svg><span>PC</span></button></div></div>
      <div class="talk-log" id="talk-log">
        ${bubbleHtml('assistant', talkOpener(c))}
        ${c.messages.map(m => bubbleHtml(m.role, m.text)).join('')}
        ${pending ? `<div class="talk-msg slime typing">${face}<p><i></i><i></i><i></i></p></div>` : ''}
        ${talkError && !pending ? `<div class="talk-error"><p>${esc(talkError)}</p><button data-action="talk-retry">다시 보내기</button></div>` : ''}
      </div>
      ${on ? `<form class="talk-form" id="talk-form"><label class="visually-hidden" for="talk-input">${esc(name)}에게 할 말</label><textarea id="talk-input" rows="1" maxlength="1500" placeholder="${esc(name)}에게 말하기${enterSends ? ' · Enter 보내기, Shift+Enter 줄바꿈' : ''}">${esc(draft)}</textarea><button class="primary" type="submit" ${pending ? 'disabled' : ''} aria-label="보내기"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12l15-7-5 15-2.5-6.5z" fill="currentColor"/></svg></button></form>`
         : `<div class="talk-form off"><p>이야기하려면 '나'에서 <b>슬라임이 기록 읽기</b>를 켜 주세요.</p><a class="text-link" href="#me">켜러 가기 ›</a></div>`}
    </section>
    <aside class="talk-ctx" aria-label="이야기의 배경"><button class="quiet ctx-close" data-action="talk-ctx">닫기 ✕</button>${talkContextHtml(c)}</aside>
  </div>`;
  $('.talk-back').onclick = () => { if (home.tab) entryTab = home.tab; if (home.filter) talkFilter = home.filter; focusRec = c.topic.kind === 'book' || c.topic.kind === 'free' ? '' : c.topic.ref; };
  $('.title-text').onclick = e => e.currentTarget.classList.toggle('open');   // 긴 문장은 두 줄까지, 누르면 전체
  const log = $('#talk-log'); if (log) { log.scrollTop = log.scrollHeight; log.lastElementChild?.scrollIntoView({ block: 'end' }); }
  const input = $('#talk-input');
  if (input) {
    const grow = () => { input.style.height = 'auto'; input.style.height = Math.min(wide ? 220 : 140, input.scrollHeight) + 'px'; };
    input.oninput = grow; grow();
    // PC: Enter로 보내고 Shift+Enter로 줄바꿈. 폰: 보내기 단추 (Ctrl+Enter도 됨)
    input.onkeydown = e => { if (e.key === 'Escape' && ctxOpen) { ctxOpen = false; renderTalk(id); return; } if (e.key === 'Enter' && !e.isComposing && ((enterSends && !e.shiftKey) || e.ctrlKey || e.metaKey)) { e.preventDefault(); $('#talk-form').requestSubmit(); } };
    $('#talk-form').onsubmit = e => { e.preventDefault(); const t = input.value.trim(); if (t) sendTalk(id, t); };
    if (keep) { input.focus({ preventScroll: true }); input.setSelectionRange(...keep); }
    else if ((wide || talkFocus) && !pending) input.focus({ preventScroll: true });
    talkFocus = false;
  }
}
async function sendTalk(id, text) {
  if (talkPending || busy) return;
  talkError = '';
  if (text && !await change(s => { s.chats.find(x => x.id === id).messages.push({ role: 'user', text, at: now() }); }, '')) return;
  if ($('#talk-input')) $('#talk-input').value = '';
  talkPending = id; if (route().page === 'talk') renderTalk(id);
  try {
    const c = state.chats.find(x => x.id === id);
    const res = await fetch(AI_CHAT_ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(60000), body: JSON.stringify({
      name: state.profile.catName || '슬라임', tone: state.profile.tone, topic: talkTopic(c),
      messages: [{ role: 'assistant', text: talkOpener(c) }, ...c.messages.slice(-30).map(m => ({ role: m.role, text: m.text }))]
    }) });
    const out = await res.json().catch(() => ({}));
    if (!res.ok || typeof out.reply !== 'string') throw new Error(out.error || `연결 실패 (${res.status})`);
    talkPending = '';
    await change(s => {
      const chat = s.chats.find(x => x.id === id); if (!chat) return;
      chat.messages.push({ role: 'assistant', text: out.reply, at: now() });
      if (out.usage) { chat.usage ||= { input: 0, output: 0 }; chat.usage.input += out.usage.input || 0; chat.usage.output += out.usage.output || 0; }
      addUsage(s, 'chat', out.usage);
    }, '');
    flashUsage('chat', out.usage);
  } catch (e) {
    talkError = `${state.profile.catName || '슬라임'}이 대답하지 못했어요. ${e.name === 'TimeoutError' ? '시간이 너무 오래 걸렸습니다.' : e.message}`;
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
    const target = data.get('target'), { book, item } = talkSubject(c);
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
  });
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
function renderMe() {
  const p = state.profile, name = p.catName || '나만의 슬라임', s = stats(state), look = slimeLook();
  const first = beadList().find(b => b.at), days = first ? Math.max(1, Math.round((Date.now() - first.at) / 864e5)) : 0;
  const ins = state.insights?.date === todayKey() && state.insights.lines.length ? state.insights : null;
  $('#main').innerHTML = `<div class="narrow me">
    <section class="me-card me-slime">
      <div class="me-avatar">${miniSlime(look.color)}</div>
      <div class="me-who"><h1>${esc(name)}</h1><p>${days ? `<span>함께한 지 ${days}일</span> · ` : ''}<span>방울 ${beadList().length}개</span>${look.tag ? ` · <span>요즘 #${esc(look.tag)}</span>` : ''}</p></div>
      <button data-action="profile">바꾸기</button>
    </section>
    ${ins ? `<section class="me-card me-today"><h2>오늘 ${esc(name)}의 말</h2>${ins.lines.map(l => `<p class="me-line">${esc(l.text)}</p>`).join('')}</section>` : ''}
    <section class="me-card"><h2>슬라임이 기록 읽기</h2>
      <p class="hint">켜면 내가 쓴 <b>생각, 슬라임의 물음에 한 답, 책 문장에 단 메모와 덧붙인 말</b>을 AI(Anthropic Claude)에게 보내 주제어를 붙이고, 하루 한 번 '그땐 / 지금은' 말을 만듭니다. 책에서 옮겨 적은 문장은 보내지 않습니다. 중계소는 글을 저장하지 않고, 결과는 이 기기에만 남습니다.</p>
      <div class="me-toggle"><button id="ai-toggle" class="${p.aiConsentAt ? '' : 'primary'}">${p.aiConsentAt ? '끄기' : '켜기'}</button><p class="hint" id="ai-status">${aiStatus()}</p></div>
    </section>
    <section class="me-card"><h2>PC 모드</h2><p class="hint">폰을 노트북에 연결해 이야기할 때 켜 두세요. 이야기 화면이 아래 탭 없이 화면 높이를 다 쓰고, 글씨가 조금 커지고, <b>Enter로 보내고 Shift+Enter로 줄을 바꿉니다.</b> 이야기 화면 오른쪽 위 <b>PC</b> 단추로도 켜고 끌 수 있습니다. 이 기기에만 적용됩니다.</p><div class="me-toggle"><button id="pc-toggle" class="${pcMode() ? '' : 'primary'}">${pcMode() ? 'PC 모드 끄기' : 'PC 모드 켜기'}</button></div></section>
    <section class="me-card"><h2>AI 사용량</h2>${usageBlock()}</section>
    <section class="me-card"><h2>보관</h2>
      <p class="hint">기록은 이 폰의 브라우저에만 있습니다. 가끔 파일로 내려받아 두세요.</p>
      <button id="open-backup">백업과 복원</button>
    </section>
    <p class="me-foot">본 대로, 거짓 없이 · <span id="me-build">${esc($('#save-status').textContent)}</span></p>
  </div>`;
  $('#pc-toggle').onclick = () => { setPcMode(!pcMode()); renderMe(); notice(pcMode() ? 'PC 모드를 켰습니다. 이야기 화면을 넓게 쓰고 Enter로 보냅니다.' : 'PC 모드를 껐습니다.'); };
  $('#open-backup').onclick = () => { if (ready && !busy) settings(); };
  $('#ai-toggle').onclick = async () => {
    const on = !state.profile.aiConsentAt;
    if (await change(s => { s.profile.aiConsentAt = on ? now() : ''; }, on ? '슬라임이 기록을 읽기 시작합니다.' : '슬라임이 기록 읽기를 멈췄습니다.')) {
      if (on) { readBackoff = 0; reflectBackoff = 0; await readRecords(); if (route().page === 'me') renderMe(); }
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
    case 'talk-book': { const b = currentBook(); if (b) { talkFocus = true; startTalk('book', b.id); } break; }
    case 'talk-thought': talkFocus = true; startTalk('thought', id); break;
    case 'talk-answer': talkFocus = true; startTalk('answer', id); break;
    case 'talk-entry': talkFocus = true; startTalk('entry', id, book); break;
    case 'talk-question': talkFocus = true; startTalk('question', id, book); break;
    case 'talk-quote': { if (ctxOpen) { ctxOpen = false; document.body.classList.remove('ctx-open'); $('[data-action=talk-ctx]')?.setAttribute('aria-pressed', 'false'); } const el = $('#talk-input'); if (el) { el.value = (el.value ? el.value.replace(/\s*$/, '\n') : '') + `“${btn.dataset.text}” `; el.dispatchEvent(new Event('input')); el.focus(); } break; }
    case 'talk-keep': talkKeep(route().id); break;
    case 'delete-more': deleteMore(id); break;
    case 'ask-from': recordEditor('questions', book, undefined, false, id); break;
    case 'talk-ctx': ctxOpen = !ctxOpen; renderTalk(route().id); break;
    case 'pc-mode': { setPcMode(!pcMode()); ctxOpen = false; render(); notice(pcMode() ? 'PC 모드: 화면을 넓게 쓰고 Enter로 보냅니다.' : 'PC 모드를 껐습니다.'); break; }
    case 'talk-retry': { const c = state.chats.find(x => x.id === route().id); if (c?.messages.at(-1)?.role === 'user') sendTalk(c.id, ''); break; }
    case 'usage-reset': change(s => { s.usage = emptyUsage(); }, 'AI 사용량을 0부터 다시 셉니다.'); break;
    case 'edit-answer': answerEditor('', id); break;
  }
});
window.addEventListener('hashchange',() => { if (dialog.open) closeModal(); render(); window.scrollTo(0,0); });
let resizeTimer = 0;
window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { if (route().page === 'talk' && route().id && !dialog.open && !!$('.talk-desk.desk') !== (pcMode() || matchMedia('(min-width: 760px)').matches)) { const d = $('#talk-input')?.value; render(); if (d && $('#talk-input')) { $('#talk-input').value = d; $('#talk-input').dispatchEvent(new Event('input')); } } }, 250); });
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
