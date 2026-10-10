import { uid, now, emptyState, normalize, backup, stats, matchesBook, dateLabel, dayKey, safeCover, ENERGY, WITH, CHOSEN, dayOf, nextQuestion, isIso } from './core.js';
import { catSvg } from './cat.js';
import { openStore, load, commit, previous } from './storage.js';
import { BOOK_SEARCH_ENDPOINT } from './config.js';

const BUILD = '1010a';   // 폰에서 어떤 판을 보고 있는지 확인용
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
let state = emptyState(), db, revision = 0, busy = false, ready = false;
let filter = 'all', query = '', entryTab = 'entries', questionFilter = 'open';
let collapsed = new Set(), foldBook = '';   // 접어둔 날짜 (문장 목록)
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
  return `<div class="cover ${esc(b.color || 'forest')}"><div class="cover-fallback" ${b.cover ? 'aria-hidden="true"' : ''}><b>${esc(b.title || '나의 책')}</b><span>READING NOTES</span></div>${b.cover ? `<img src="${esc(b.cover)}" alt="${esc(b.title)} 표지" loading="lazy" referrerpolicy="no-referrer">` : ''}</div>`;
}
document.addEventListener('error', e => { if (e.target instanceof HTMLImageElement) { e.target.hidden = true; e.target.parentElement.querySelector('.cover-fallback')?.removeAttribute('aria-hidden'); } }, true);
const empty = (title, message, action = '') => `<div class="empty"><div class="empty-illustration" aria-hidden="true"><i></i><i></i><i></i></div><h2>${title}</h2><p>${message}</p>${action}</div>`;
function route() { const [page, id] = location.hash.slice(1).split('/'); return { page: page || 'cat', id }; }
const currentBook = () => state.books.find(b => b.id === route().id);
function render() {
  if (!ready) return;
  const { page } = route();
  const tab = { book:'shelf', questions:'shelf', shelf:'shelf', moments:'moments', trips:'moments', day:'moments', thoughts:'thoughts' }[page] || 'cat';
  document.querySelectorAll('[data-nav]').forEach(a => { if (a.dataset.nav === tab) a.setAttribute('aria-current','page'); else a.removeAttribute('aria-current'); });
  document.body.dataset.page = page;
  if (page === 'book') renderBook();
  else if (page === 'questions') renderQuestions();
  else if (page === 'thoughts') renderThoughts();
  else if (page === 'shelf') renderShelf();
  else if (page === 'moments' || page === 'trips' || page === 'day') renderMoments();
  else renderCat();
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
// ── 고양이 · 순간 ───────────────────────────────────────────
const say = pair => pair[state.profile.tone === 'you' ? 1 : 0];
const todayKey = () => dayOf(new Date());
const labelOf = (options, value) => options.find(o => o[0] === value)?.[1] || '';
// 오늘 넘어간 질문은 이 기기에만 잠깐 기억합니다 — 기록이 아니라서 데이터에 넣지 않습니다.
const skipped = () => { try { return JSON.parse(localStorage.getItem(`cat-skip:${todayKey()}`) || '[]'); } catch { return []; } };
function skip(slot) { try { localStorage.setItem(`cat-skip:${todayKey()}`, JSON.stringify([...skipped(), slot])); } catch {} renderCat(); }
function bubble() {
  if (!state.profile.catName) return `<div class="bubble"><p class="bubble-text">안녕. 나는 아직 이름이 없는 고양이야. 이름을 지어 줄래?</p><div class="bubble-actions"><button class="primary" data-action="profile">이름 지어 주기</button></div></div>`;
  const q = nextQuestion(state, new Date(), skipped());
  if (!q) return `<div class="bubble done"><p class="bubble-text">${say(['오늘 관찰은 여기까지. 잘 지켜봤다.', '오늘 관찰은 여기까지야. 고마워.'])}</p></div>`;
  let body;
  if (q.type === 'book') body = `<div class="bubble-actions"><button class="primary" data-action="cat-book" data-book="${esc(q.bookId)}">문장 남기기</button></div>`;
  else body = `<div class="bubble-actions"><button class="primary" data-action="cat-moment" data-prompt="${esc(q.text)}">적어 볼게</button></div>`;
  return `<div class="bubble"><p class="bubble-slot">${esc(q.title)}</p><p class="bubble-text">${esc(q.text)}</p>${body}<button class="quiet skip-q" data-action="cat-skip" data-slot="${q.slot}">오늘은 넘어갈래</button></div>`;
}
function renderCat() {
  const date = todayKey(), s = stats(state), name = state.profile.catName;
  const reading = state.books.filter(b => b.status === 'reading');
  const current = reading[reading.length - 1] || state.books[state.books.length - 1];
  const seen = s.entries + s.questions + s.thoughts + s.moments;
  const today = new Date(`${date}T12:00:00`).toLocaleDateString('ko-KR', { year:'numeric', month:'long', day:'numeric', weekday:'short' });
  $('#main').innerHTML = `<section class="room cat-home" aria-labelledby="room-title">
    <p class="room-date">${esc(today)}</p>
    <h1 id="room-title">${esc(name || '나만의 고양이')}</h1>
    <p class="cat-status">아직 돌아다니는 중 · 관찰 ${seen}개</p>
    <div class="room-scene">
      <img src="assets/room-empty.webp" alt="" width="2176" height="1632">
      ${spines(state.books)}
      <a class="hotspot board" href="#thoughts" aria-label="생각 ${state.thoughts.length}개"></a>
      <a class="hotspot shelf" href="#shelf" aria-label="책 ${state.books.length}권"></a>
      <div class="cat-spot">${catSvg('calm', esc(name || '고양이'))}</div>
    </div>
    ${bubble()}
    <div class="cat-actions"><button data-action="add-moment">＋ 순간 남기기</button><a class="text-link" href="#moments">남긴 순간 ${s.moments} <span aria-hidden="true">›</span></a></div>
    ${current ? `<div class="room-current">
      <a class="room-book" href="#book/${esc(current.id)}">${cover(current)}</a>
      <div class="room-meta">
        <span class="status-tag">${current.status === 'finished' ? '다 읽음' : '읽는 중'}</span>
        <h2>${esc(current.title)}</h2>
        <p class="muted">${esc([current.author, current.publisher].filter(Boolean).join(' · ') || '문장 ' + current.entries.length + ' · 질문 ' + current.questions.length)}</p>
      </div>
      <a class="primary continue" href="#book/${esc(current.id)}">이어가기 <span aria-hidden="true">›</span></a>
    </div>` : ''}
  </section>`;
}
function momentCard(m) {
  const tags = [labelOf(ENERGY, m.energy), labelOf(WITH, m.with), labelOf(CHOSEN, m.chosen)].filter(Boolean);
  return `<article class="record"><div class="meta"><span>${esc(dateLabel(m.createdAt))}${m.from === 'cat' ? ' · 고양이가 물어서' : ''}</span><span aria-hidden="true">순간</span></div>${m.place ? `<h3>${esc(m.place)}</h3>` : ''}<p class="record-text">${esc(m.text)}</p>${tags.length ? `<p class="tags">${tags.map(t => `<span class="status-tag">${esc(t)}</span>`).join('')}</p>` : ''}<div class="record-actions"><button data-action="edit-moment" data-id="${esc(m.id)}">수정</button><button data-action="delete-record" data-type="moments" data-id="${esc(m.id)}">삭제</button></div></article>`;
}
function renderMoments() {
  $('#main').innerHTML = `<div class="narrow"><a class="back" href="#cat">← 고양이에게</a><div class="intro"><div><p class="eyebrow">MOMENTS</p><h1>남긴 순간</h1><p>무엇을 했는지보다, 그때 어땠는지.</p></div><button class="primary intro-actions" data-action="add-moment">＋ 순간</button></div><div class="record-list">${[...state.moments].reverse().map(momentCard).join('') || empty('한 장면, 한 줄부터', '운동, 코딩, 게임, 사람. 무엇이든 본 대로 적어 보세요.')}</div></div>`;
}
function renderShelf() {
  $('#main').innerHTML = `<section aria-labelledby="shelf-title"><div class="intro"><div><p class="eyebrow">MY LITTLE LIBRARY</p><h1 id="shelf-title">나의 책장</h1><p>읽다가 머문 자리마다, 나만의 기록이 쌓입니다. <a class="text-link" href="#questions">남은 질문 ${state.books.reduce((n, b) => n + b.questions.filter(q => !q.answer).length, 0)} ›</a></p></div><button class="primary intro-actions" data-action="add-book">＋ 책 추가</button></div><div class="toolbar"><div class="filters" aria-label="독서 상태">${[['all','전체'],['reading','읽는 중'],['finished','다 읽음']].map(([v,l]) => `<button data-filter="${v}" aria-pressed="${filter === v}">${l}</button>`).join('')}</div><div class="search-field"><label class="visually-hidden" for="local-search">책과 기록 검색</label><input type="search" id="local-search" placeholder="책 제목, 문장, 질문 찾기" value="${esc(query)}"></div></div><div id="shelf-results"></div></section>`;
  shelfResults();
  $('#local-search').oninput = e => { query = e.target.value; shelfResults(); };
}
function shelfResults() {
  const books = state.books.filter(b => (filter === 'all' || b.status === filter) && matchesBook(b, query));
  $('#shelf-results').innerHTML = books.length ? `${query ? `<p class="search-count" role="status">기록을 포함해 ${books.length}권을 찾았습니다.</p>` : ''}<div class="book-grid">${books.map(b => `<a class="book-tile" href="#book/${esc(b.id)}">${cover(b)}<h3>${esc(b.title)}</h3><p class="author">${esc(b.author || '저자 미기록')}</p><div class="counts"><span class="status-tag">${b.status === 'finished' ? '다 읽음' : '읽는 중'}</span>문장 ${b.entries.length} · 질문 ${b.questions.length}</div></a>`).join('')}</div>` : empty(state.books.length ? '아직 이 칸은 비어 있어요' : '첫 책을 놓아보세요', state.books.length ? '다른 검색어나 독서 상태로 찾아보세요.' : '곁에 두고 읽는 책 한 권이면 충분합니다.', !state.books.length ? '<button class="primary" data-action="add-book">내 책 추가하기</button>' : '');
}
function recordCard(e, b, type, showBook = false) {
  const question = type === 'questions';
  return `<article class="record ${question && e.answer ? 'answered' : ''}"><div class="meta"><span>${showBook ? `<a href="#book/${esc(b.id)}">${esc(b.title)}</a> · ` : ''}${esc(dateLabel(e.createdAt))}${!question && e.page ? ` · p. ${esc(e.page)}` : ''}</span>${question ? `<span class="q-label">${e.answer ? '답을 남긴 질문' : '아직 품고 있는 질문'}</span>` : '<span aria-hidden="true">문장</span>'}</div><p class="record-text">${esc(e.text)}</p>${e.note ? `<p class="note">${esc(e.note)}</p>` : ''}${question && e.answer ? `<p class="answer">${esc(e.answer)}</p><p class="hint">${esc(dateLabel(e.answeredAt))}에 남긴 답</p>` : ''}<div class="record-actions">${question ? `<button data-action="answer" data-book="${b.id}" data-id="${e.id}">${e.answer ? '답 수정' : '답 남기기'}</button>` : ''}<button data-action="edit-record" data-type="${type}" data-book="${b.id}" data-id="${e.id}">수정</button><button data-action="delete-record" data-type="${type}" data-book="${b.id}" data-id="${e.id}">삭제</button></div></article>`;
}
// 문장을 날짜로 묶고, 날짜 줄을 눌러 접었다 폅니다.
function groupedRecords(records, b, type) {
  const groups = [];
  for (const e of [...records].reverse()) {
    const key = dayKey(e.createdAt);
    const last = groups[groups.length - 1];
    if (last && last.key === key) last.items.push(e); else groups.push({ key, items: [e] });
  }
  return groups.map(g => {
    const isOpen = !collapsed.has(g.key);
    return `<section class="day ${isOpen ? 'open' : ''}">
      <button class="day-head" data-day="${esc(g.key)}" aria-expanded="${isOpen}">
        <span class="day-chevron" aria-hidden="true">${isOpen ? '⌄' : '›'}</span>
        <span class="day-label">${esc(dateLabel(g.items[0].createdAt))}</span>
        <span class="day-count">${g.items.length}</span>
      </button>
      ${isOpen ? `<div class="day-body">${g.items.map(e => recordCard(e, b, type)).join('')}</div>` : ''}
    </section>`;
  }).join('');
}
function renderBook() {
  const b = currentBook();
  if (!b) { $('#main').innerHTML = empty('책을 찾을 수 없어요', '책장에서 다른 책을 골라주세요.', '<a class="back" href="#shelf">← 책장으로</a>'); return; }
  if (foldBook !== b.id) {   // 책을 새로 열면 맨 위 날짜만 펴둡니다
    foldBook = b.id;
    const days = [...new Set([...b.entries].reverse().map(e => dayKey(e.createdAt)))];
    collapsed = new Set(days.slice(1));
  }
  const activeQuery = query.trim();
  const records = b[entryTab].filter(e => !activeQuery || [e.text,e.note || '',e.answer || '',e.page || ''].some(t => t.toLowerCase().includes(activeQuery.toLowerCase())));
  $('#main').innerHTML = `<div class="narrow"><a class="back" href="#shelf">← 책장으로</a><section class="book-hero" aria-labelledby="book-title">${cover(b)}<span class="status-tag">${b.status === 'finished' ? '다 읽음' : '읽는 중'}</span><h1 id="book-title">${esc(b.title)}</h1><p class="book-sub">${esc([b.author,b.publisher].filter(Boolean).join(' · ') || '나만의 독서 기록')}</p><p class="book-sub small">${esc(dateLabel(b.createdAt))}부터${b.finishedAt ? ` · ${esc(dateLabel(b.finishedAt))} 완독` : ''}</p><div class="actions"><button data-action="edit-book">책 정보 수정</button><button data-action="toggle-status">${b.status === 'finished' ? '다시 읽기' : '다 읽었어요'}</button></div></section><div class="kind-cards"><button class="kind entries" data-entry-tab="entries" aria-pressed="${entryTab === 'entries'}"><span class="kind-mark" aria-hidden="true">&ldquo;</span><b>문장</b><span class="kind-count">${b.entries.length}</span><i></i><span class="kind-go" aria-hidden="true">→</span></button><button class="kind questions" data-entry-tab="questions" aria-pressed="${entryTab === 'questions'}"><span class="kind-mark" aria-hidden="true">?</span><b>질문</b><span class="kind-count">${b.questions.length}${b.questions.filter(q => q.answer).length ? ` · 답 ${b.questions.filter(q => q.answer).length}` : ''}</span><i></i><span class="kind-go" aria-hidden="true">→</span></button></div><div class="toolbar record-toolbar">${entryTab === 'entries' && b.entries.length ? `<button class="quiet" data-action="fold-all">${collapsed.size ? '모두 펼치기' : '모두 접기'}</button>` : ''}<button class="primary" data-action="add-record">＋ ${entryTab === 'entries' ? '문장' : '질문'} 남기기</button></div>${activeQuery ? `<p class="search-count">“${esc(query)}” 검색 중 <button class="quiet" data-action="clear-query">검색 해제</button></p>` : ''}<div class="record-list">${records.length ? (entryTab === 'entries' ? groupedRecords(records,b,entryTab) : [...records].reverse().map(e => recordCard(e,b,entryTab)).join('')) : empty(activeQuery ? '일치하는 기록이 없어요' : entryTab === 'entries' ? '오래 두고 싶은 문장' : '서둘러 답하지 않아도 괜찮아요', activeQuery ? '검색을 해제하면 모든 기록이 보입니다.' : entryTab === 'entries' ? '읽다가 걸린 문장과 그때의 생각을 남겨보세요.' : '읽다가 생긴 물음을 적어두고, 나중의 나에게 건네보세요.')}</div><p class="section-note"><button class="quiet danger" data-action="delete-book">이 책 삭제</button></p></div>`;
}
function renderQuestions() {
  const qs = state.books.flatMap(b => b.questions.map(q => ({ b, q }))).filter(({q}) => questionFilter === 'all' || (questionFilter === 'open' ? !q.answer : !!q.answer)).reverse();
  $('#main').innerHTML = `<div class="narrow"><a class="back" href="#shelf">← 책장으로</a><div class="intro"><div><p class="eyebrow">QUESTIONS TO KEEP</p><h1>남은 질문</h1><p>답을 기다리는 시간도 독서의 일부니까요.</p></div></div><div class="toolbar"><div class="filters" aria-label="답변 상태">${[['open','답을 기다리는'],['answered','답을 남긴'],['all','모든 질문']].map(([v,l]) => `<button data-question-filter="${v}" aria-pressed="${questionFilter === v}">${l}</button>`).join('')}</div></div><div class="record-list">${qs.map(({b,q}) => recordCard(q,b,'questions',true)).join('') || empty('질문을 위한 빈자리', '책을 열어 떠오른 물음을 남기면 이곳에 모입니다.')}</div></div>`;
}
function renderThoughts() {
  $('#main').innerHTML = `<div class="narrow"><div class="intro"><div><p class="eyebrow">A PLACE FOR THOUGHTS</p><h1>떠오르는 생각</h1><p>책 바깥에서 떠오른 것도, 잊기 전에.</p></div><button class="primary intro-actions" data-action="add-journal">＋ 기록</button></div><div class="record-list">${[...state.thoughts].reverse().map(t => `<article class="record"><div class="meta"><span>${esc(dateLabel(t.createdAt))}</span></div><p class="record-text">${esc(t.text)}</p><div class="record-actions"><button data-action="edit-journal" data-id="${esc(t.id)}">수정</button><button data-action="delete-record" data-type="thoughts" data-id="${esc(t.id)}">삭제</button></div></article>`).join('') || empty('아무렇게나, 한 줄부터', '잘 정리하지 않아도 괜찮습니다.')}</div></div>`;
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
const radios = (label, name, options, value, optional = true) => `<fieldset class="field pick ${optional ? 'optional' : ''}"><legend>${label}${optional ? ' · 선택' : ''}</legend><div class="chips">${options.map(([v,l]) => `<label class="chip-radio"><input type="radio" name="${name}" value="${v}" ${value === v ? 'checked' : ''}><span>${esc(l)}</span></label>`).join('')}</div></fieldset>`;
function momentEditor(id, prompt = '') {
  const item = state.moments.find(x => x.id === id), name = state.profile.catName || '고양이';
  openModal(item ? '순간 수정' : '순간 남기기', `${prompt ? `<p class="prompt">${esc(prompt)}</p>` : `<p class="hint">판단 없이, 본 대로. “${esc(name)}는 오늘…”</p>`}<form id="edit-form">${area('한 장면 한 줄','text',item?.text,true)}${radios('기운','energy',ENERGY,item?.energy)}${radios('누구와','with',WITH,item?.with)}${radios('골랐나','chosen',CHOSEN,item?.chosen)}${field('장소 · 선택','place',item?.place,'maxlength="500"')}${submit('기록 저장')}</form>`, `moment:${id || (prompt ? 'cat' : 'new')}`);
  // 선택 칸은 다시 누르면 풀립니다.
  dialog.querySelectorAll('.optional input[type=radio]').forEach(r => {
    r.dataset.on = r.checked ? '1' : '';
    r.onclick = () => { const was = r.dataset.on; dialog.querySelectorAll(`input[name="${r.name}"]`).forEach(x => { x.dataset.on = ''; }); if (was) r.checked = false; else r.dataset.on = '1'; modalDirty = true; };
  });
  formHandler(data => change(s => {
    const text = data.get('text').trim(); if (!text) throw new Error('기록할 내용을 입력해주세요.');
    const values = { text, energy: data.get('energy') || '', with: data.get('with') || '', chosen: data.get('chosen') || '', place: data.get('place').trim() };
    if (item) Object.assign(s.moments.find(x => x.id === id), values);
    else s.moments.push({ id: uid(), createdAt: now(), ...values, from: prompt ? 'cat' : 'self' });
  }));
}
function profileEditor() {
  const p = state.profile, first = !p.catName;
  openModal(first ? '고양이와 처음 만나기' : '고양이 설정', `<p class="hint">이 고양이는 나를 닮았습니다. 좋은 답도 나쁜 답도 없으니, 본 대로만 알려 주세요.</p><form id="edit-form">${field('고양이 이름','catName',p.catName,'required maxlength="30" placeholder="예: 보리"')}${radios('고양이 말투','tone',[['we','“우리 오늘 뭘 봤지?”'],['you','“오늘 뭘 봤어?”']],p.tone,false)}${submit(first ? '만나서 반가워' : '저장')}</form>`);
  formHandler(data => {
    const catName = data.get('catName').trim(); if (!catName) throw new Error('고양이 이름을 지어 주세요.');
    return change(s => { s.profile = { ...s.profile, catName, tone: data.get('tone') === 'you' ? 'you' : 'we' }; }, first ? `${catName}, 만나서 반가워.` : '고양이 설정을 저장했습니다.');
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
function exportState(data = state, prefix = 'my-cat') { download(backup(data),`${prefix}-${new Date().toISOString().slice(0,10)}.json`); }
function settings() {
  const s = stats(state);
  openModal('기록 보관함',`<p class="hint">책 ${s.books}권 · 문장 ${s.entries}개 · 질문 ${s.questions}개<br>생각 ${s.thoughts}개 · 순간 ${s.moments}개</p><p>기록은 이 기기의 브라우저에 저장됩니다.<br>휴대폰과 PC 사이에 자동으로 공유되지는 않습니다.</p><div class="storage-block"><h3>고양이</h3><p class="hint">이름과 말투를 고칩니다.</p><button id="cat-profile">고양이 설정</button></div><div class="storage-block"><h3>파일로 남겨두기</h3><p class="hint">직접 올린 표지 사진까지 포함해 내려받습니다. 검색으로 연결한 표지는 주소가 저장되어 인터넷 연결이 필요합니다.</p><button class="primary" id="export">전체 기록 내보내기</button></div><div class="storage-block"><h3>백업에서 가져오기</h3><p class="hint">이전 기록장의 JSON 파일도 읽을 수 있습니다. 파일을 고르면 복원할 내용을 먼저 보여드립니다.</p><label class="file-label">백업 파일 선택<input class="visually-hidden" type="file" id="import" accept=".json,application/json"></label><div id="restore-area"></div></div><div class="storage-block"><h3>직전 저장 상태</h3><p class="hint">바로 전 저장으로 돌아갑니다. 복원 시 현재 기록도 파일로 내려받습니다.</p><button id="previous">직전 상태 확인</button></div><div class="storage-block"><h3>오래 보관하기</h3><p class="hint">브라우저 데이터를 지우면 기록도 지워집니다. 중요한 기록은 파일로도 보관해주세요.</p><button id="persistent">브라우저에 보관 요청</button><p class="hint" id="persistent-status"></p></div>`);
  $('#cat-profile').onclick = () => profileEditor();
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
  $('#restore-area').innerHTML = `<div class="restore-preview"><b>${label}</b><p>책 ${s.books}권 · 문장 ${s.entries}개 · 질문 ${s.questions}개<br>생각 ${s.thoughts}개 · 순간 ${s.moments}개</p><p>현재 기록 전체를 이 내용으로 교체합니다.<br>교체 전 현재 기록은 백업 파일로 내려받습니다.</p><button id="confirm-restore" class="primary">현재 기록 백업 후 교체</button></div>`;
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
  if (btn.dataset.day !== undefined) { const k = btn.dataset.day; collapsed.has(k) ? collapsed.delete(k) : collapsed.add(k); renderBook(); return; }
  if (btn.dataset.action === 'fold-all') { const b = currentBook(); if (b) { const all = new Set(b.entries.map(e => dayKey(e.createdAt))); collapsed = collapsed.size ? new Set() : all; renderBook(); } return; }
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
    case 'add-moment': momentEditor(); break;
    case 'edit-moment': momentEditor(id); break;
    case 'cat-moment': momentEditor(undefined, btn.dataset.prompt); break;
    case 'cat-book': recordEditor('entries', book); break;
    case 'cat-skip': skip(btn.dataset.slot); break;
  }
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
