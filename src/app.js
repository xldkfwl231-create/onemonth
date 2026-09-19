import { uid, now, emptyState, normalize, backup, stats, matchesBook, dateLabel, safeCover } from './core.js';
import { openStore, load, commit, previous } from './storage.js';
import { BOOK_SEARCH_ENDPOINT } from './config.js';

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
function status(message, error = false) { $('#save-status').textContent = message; $('#save-status').classList.toggle('error', error); }
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
function route() { const [page, id] = location.hash.slice(1).split('/'); return { page: page || 'shelf', id }; }
const currentBook = () => state.books.find(b => b.id === route().id);
function render() {
  if (!ready) return;
  const { page } = route();
  document.querySelectorAll('[data-nav]').forEach(a => { if (a.dataset.nav === (page === 'book' ? 'shelf' : page)) a.setAttribute('aria-current','page'); else a.removeAttribute('aria-current'); });
  if (page === 'book') renderBook();
  else if (page === 'questions') renderQuestions();
  else if (page === 'thoughts' || page === 'trips') renderJournal(page);
  else renderShelf();
}
function renderShelf() {
  $('#main').innerHTML = `<section aria-labelledby="shelf-title"><div class="intro"><div><p class="eyebrow">MY LITTLE LIBRARY</p><h1 id="shelf-title">나의 책장</h1><p>읽다가 머문 자리마다, 나만의 기록이 쌓입니다.</p></div><button class="primary intro-actions" data-action="add-book">＋ 책 추가</button></div><div class="toolbar"><div class="filters" aria-label="독서 상태">${[['all','전체'],['reading','읽는 중'],['finished','다 읽음']].map(([v,l]) => `<button data-filter="${v}" aria-pressed="${filter === v}">${l}</button>`).join('')}</div><div class="search-field"><label class="visually-hidden" for="local-search">책과 기록 검색</label><input type="search" id="local-search" placeholder="책 제목, 문장, 질문 찾기" value="${esc(query)}"></div></div><div id="shelf-results"></div></section>`;
  shelfResults();
  $('#local-search').oninput = e => { query = e.target.value; shelfResults(); };
}
function shelfResults() {
  const books = state.books.filter(b => (filter === 'all' || b.status === filter) && matchesBook(b, query));
  $('#shelf-results').innerHTML = books.length ? `${query ? `<p class="search-count" role="status">기록을 포함해 ${books.length}권을 찾았습니다.</p>` : ''}<div class="book-grid">${books.map(b => `<a class="book-tile" href="#book/${b.id}">${cover(b)}<h3>${esc(b.title)}</h3><p class="author">${esc(b.author || '저자 미기록')}</p><div class="counts"><span class="status-tag">${b.status === 'finished' ? '다 읽음' : '읽는 중'}</span>문장 ${b.entries.length} · 질문 ${b.questions.length}</div></a>`).join('')}</div>` : empty(state.books.length ? '아직 이 칸은 비어 있어요' : '첫 책을 놓아보세요', state.books.length ? '다른 검색어나 독서 상태로 찾아보세요.' : '곁에 두고 읽는 책 한 권이면 충분합니다.', !state.books.length ? '<button class="primary" data-action="add-book">내 책 추가하기</button>' : '');
}
function recordCard(e, b, type, showBook = false) {
  const question = type === 'questions';
  return `<article class="record ${question && e.answer ? 'answered' : ''}"><div class="meta"><span>${showBook ? `<a href="#book/${b.id}">${esc(b.title)}</a> · ` : ''}${esc(dateLabel(e.createdAt))}${!question && e.page ? ` · p. ${esc(e.page)}` : ''}</span>${question ? `<span class="q-label">${e.answer ? '답을 남긴 질문' : '아직 품고 있는 질문'}</span>` : '<span aria-hidden="true">문장</span>'}</div><p class="record-text">${esc(e.text)}</p>${e.note ? `<p class="note">${esc(e.note)}</p>` : ''}${question && e.answer ? `<p class="answer">${esc(e.answer)}</p><p class="hint">${esc(dateLabel(e.answeredAt))}에 남긴 답</p>` : ''}<div class="record-actions">${question ? `<button data-action="answer" data-book="${b.id}" data-id="${e.id}">${e.answer ? '답 수정' : '답 남기기'}</button>` : ''}<button data-action="edit-record" data-type="${type}" data-book="${b.id}" data-id="${e.id}">수정</button><button data-action="delete-record" data-type="${type}" data-book="${b.id}" data-id="${e.id}">삭제</button></div></article>`;
}
function renderBook() {
  const b = currentBook();
  if (!b) { $('#main').innerHTML = empty('책을 찾을 수 없어요', '책장에서 다른 책을 골라주세요.', '<a class="back" href="#shelf">← 책장으로</a>'); return; }
  const activeQuery = query.trim();
  const records = b[entryTab].filter(e => !activeQuery || [e.text,e.note || '',e.answer || '',e.page || ''].some(t => t.toLowerCase().includes(activeQuery.toLowerCase())));
  $('#main').innerHTML = `<div class="narrow"><a class="back" href="#shelf">← 책장으로</a><section class="book-hero" aria-labelledby="book-title">${cover(b)}<div><span class="status-tag">${b.status === 'finished' ? '다 읽음' : '읽는 중'}</span><h1 id="book-title">${esc(b.title)}</h1><p>${esc([b.author,b.publisher].filter(Boolean).join(' · ') || '나만의 독서 기록')}<br>${esc(dateLabel(b.createdAt))}부터${b.finishedAt ? `<br>${esc(dateLabel(b.finishedAt))} 완독` : ''}${b.isbn ? `<br>ISBN ${esc(b.isbn)}` : ''}</p><div class="actions"><button data-action="edit-book">책 정보 수정</button><button data-action="toggle-status">${b.status === 'finished' ? '다시 읽기' : '다 읽었어요'}</button></div></div></section><div class="toolbar"><div class="filters" aria-label="기록 종류"><button data-entry-tab="entries" aria-pressed="${entryTab === 'entries'}">문장 ${b.entries.length}</button><button data-entry-tab="questions" aria-pressed="${entryTab === 'questions'}">질문 ${b.questions.length}</button></div><button class="primary" data-action="add-record">＋ ${entryTab === 'entries' ? '문장' : '질문'} 남기기</button></div>${activeQuery ? `<p class="search-count">“${esc(query)}” 검색 중 <button class="quiet" data-action="clear-query">검색 해제</button></p>` : ''}<div class="record-list">${records.length ? [...records].reverse().map(e => recordCard(e,b,entryTab)).join('') : empty(activeQuery ? '일치하는 기록이 없어요' : entryTab === 'entries' ? '오래 두고 싶은 문장' : '서둘러 답하지 않아도 괜찮아요', activeQuery ? '검색을 해제하면 모든 기록이 보입니다.' : entryTab === 'entries' ? '읽다가 걸린 문장과 그때의 생각을 남겨보세요.' : '읽다가 생긴 물음을 적어두고, 나중의 나에게 건네보세요.')}</div><p class="section-note"><button class="quiet danger" data-action="delete-book">이 책 삭제</button></p></div>`;
}
function renderQuestions() {
  const qs = state.books.flatMap(b => b.questions.map(q => ({ b, q }))).filter(({q}) => questionFilter === 'all' || (questionFilter === 'open' ? !q.answer : !!q.answer)).reverse();
  $('#main').innerHTML = `<div class="narrow"><div class="intro"><div><p class="eyebrow">QUESTIONS TO KEEP</p><h1>남은 질문</h1><p>답을 기다리는 시간도 독서의 일부니까요.</p></div></div><div class="toolbar"><div class="filters" aria-label="답변 상태">${[['open','답을 기다리는'],['answered','답을 남긴'],['all','모든 질문']].map(([v,l]) => `<button data-question-filter="${v}" aria-pressed="${questionFilter === v}">${l}</button>`).join('')}</div></div><div class="record-list">${qs.map(({b,q}) => recordCard(q,b,'questions',true)).join('') || empty('질문을 위한 빈자리', '책을 열어 떠오른 물음을 남기면 이곳에 모입니다.')}</div></div>`;
}
function renderJournal(type) {
  const thoughts = type === 'thoughts';
  const list = [...state[type]].reverse();
  $('#main').innerHTML = `<div class="narrow"><div class="intro"><div><p class="eyebrow">${thoughts ? 'A PLACE FOR THOUGHTS' : 'PLACES & MOMENTS'}</p><h1>${thoughts ? '떠오르는 생각' : '다녀온 자리'}</h1><p>${thoughts ? '책 바깥에서 떠오른 것도, 잊기 전에.' : '어디에 갔는지, 무엇이 오래 남았는지.'}</p></div><button class="primary intro-actions" data-action="add-journal">＋ 기록</button></div><div class="record-list">${list.map(t => `<article class="record"><div class="meta"><span>${esc(dateLabel(t.createdAt))}</span></div>${t.place ? `<h3>${esc(t.place)}</h3>` : ''}<p class="record-text">${esc(t.text)}</p><div class="record-actions"><button data-action="edit-journal" data-id="${t.id}">수정</button><button data-action="delete-record" data-type="${type}" data-id="${t.id}">삭제</button></div></article>`).join('') || empty('아무렇게나, 한 줄부터', '잘 정리하지 않아도 괜찮습니다.')}</div></div>`;
}

function openModal(title, body, key = '') {
  modalCleanup(); modalCleanup = () => {}; modalFocus = document.activeElement;
  draftKey = key ? `reading-draft:${key}` : ''; modalDirty = false;
  $('#dialog-content').innerHTML = `<div class="dialog-inner"><div class="dialog-head"><h2 id="dialog-title">${title}</h2><button type="button" class="quiet" data-close aria-label="닫기">×</button></div>${body}<p id="form-error" class="form-error" role="alert"></p></div>`;
  if (!dialog.open) dialog.showModal();
  $('[data-close]').onclick = () => closeModal();
  if (draftKey) {
    try { const draft = JSON.parse(sessionStorage.getItem(draftKey) || 'null'); if (draft) { for (const [name,value] of Object.entries(draft)) { const el = dialog.querySelector(`[name="${name}"]`); if (el && el.type !== 'file') el.value = value; } notice('이 창에 남아 있던 초안을 불러왔습니다.'); modalDirty = true; } } catch {}
  }
}
function preserveDraft() {
  if (!draftKey) return;
  const values = {};
  dialog.querySelectorAll('input[name],textarea[name],select[name]').forEach(el => { if (el.type !== 'file') values[el.name] = el.value; });
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
  const type = route().page, trip = type === 'trips', item = state[type].find(x => x.id === id);
  openModal(`${trip ? '여행' : '생각'} ${item ? '수정' : '남기기'}`, `<form id="edit-form">${trip ? field('다녀온 곳','place',item?.place,'required maxlength="500"') : ''}${area(trip ? '기억에 남는 순간' : '지금 떠오른 것','text',item?.text,true)}${submit('기록 저장')}</form>`, `${type}:${id || 'new'}`);
  formHandler(data => change(s => {
    const text = data.get('text').trim(), place = trip ? data.get('place').trim() : undefined;
    if (!text || (trip && !place)) throw new Error('빈칸을 채워주세요.');
    const values = {text,...(trip ? {place} : {})};
    if (item) Object.assign(s[type].find(x => x.id === id),values);
    else s[type].push({id:uid(),createdAt:now(),...values});
  }));
}
async function imageData(file) {
  if (!['image/jpeg','image/png','image/webp'].includes(file.type)) throw new Error('JPG, PNG, WebP 사진을 선택해주세요. HEIC 사진은 JPG로 변환해주세요.');
  if (file.size > 20 * 1024 * 1024) throw new Error('20MB 이하의 사진을 선택해주세요.');
  const bitmap = await createImageBitmap(file);
  try {
    const ratio = Math.min(1,800 / Math.max(bitmap.width,bitmap.height));
    const canvas = document.createElement('canvas'); canvas.width = Math.max(1,Math.round(bitmap.width * ratio)); canvas.height = Math.max(1,Math.round(bitmap.height * ratio));
    const ctx = canvas.getContext('2d'); ctx.fillStyle = '#fcfaf3'; ctx.fillRect(0,0,canvas.width,canvas.height); ctx.drawImage(bitmap,0,0,canvas.width,canvas.height);
    return canvas.toDataURL('image/jpeg',.84);
  } finally { bitmap.close(); }
}
function bookEditor(existing) {
  let selectedCover = existing?.cover || '', selectedColor = existing?.color || 'forest', imageBusy = false;
  let controller, requestId = 0, alive = true;
  openModal(existing ? '책 정보 수정' : '책장에 한 권 더', `<div class="search-box"><label for="book-query">제목이나 ISBN으로 표지 찾기</label><div class="search-row"><input type="search" id="book-query" placeholder="책 제목 또는 ISBN" maxlength="200"><button id="search-books" type="button">검색</button></div><p class="hint" style="margin:8px 0 0">검색어는 ${BOOK_SEARCH_ENDPOINT ? '연결된 도서 검색 서비스' : 'Open Library'}로 전송됩니다. ${BOOK_SEARCH_ENDPOINT ? '' : '국내 도서는 없거나 다른 판본일 수 있어요.'}</p><div id="search-status" class="hint" role="status"></div><div class="search-results" id="search-results"></div></div><form id="edit-form"><div class="cover-editor"><div id="cover-preview">${cover(existing || {title:'나의 책',color:'forest'})}</div><div class="cover-options"><label class="file-label">표지 사진 고르기<input type="file" class="visually-hidden" id="cover-file" accept="image/jpeg,image/png,image/webp"></label><button class="quiet" type="button" id="remove-cover">사진 제거</button><div class="colors" aria-label="글자 표지 색상">${[['forest','숲'],['clay','흙'],['blue','파랑'],['sand','모래']].map(([c,l]) => `<button type="button" data-color="${c}" aria-label="${l}색 표지" aria-pressed="${selectedColor === c}"><i></i></button>`).join('')}</div><p class="hint" style="margin:7px 0 0">JPG · PNG · WebP / 사진은 기기에 저장됩니다.</p></div></div>${field('책 제목','title',existing?.title,'required maxlength="500" placeholder="어떤 책을 읽고 있나요?"')}<div class="field-row">${field('저자 · 선택','author',existing?.author,'maxlength="1000"')}${field('출판사 · 선택','publisher',existing?.publisher,'maxlength="500"')}</div>${field('ISBN · 선택','isbn',existing?.isbn,'maxlength="100"')}<p class="hint">다른 판본인지 표지와 저자를 확인해주세요. 사진 없이도 추가할 수 있어요.</p>${submit(existing ? '변경 저장' : '책장에 넣기')}</form>`, `book:${existing?.id || 'new'}`);
  modalCleanup = () => { alive = false; controller?.abort(); };
  const refreshCover = () => { $('#cover-preview').innerHTML = cover({title:$('#f-title').value || '나의 책',cover:selectedCover,color:selectedColor}); };
  refreshCover();
  $('#f-title').addEventListener('input',refreshCover);
  document.querySelectorAll('[data-color]').forEach(btn => btn.onclick = () => { selectedColor = btn.dataset.color; modalDirty = true; document.querySelectorAll('[data-color]').forEach(b => b.setAttribute('aria-pressed',String(b === btn))); refreshCover(); });
  $('#remove-cover').onclick = () => { selectedCover = ''; modalDirty = true; refreshCover(); };
  $('#cover-file').onchange = async e => {
    const file = e.target.files[0]; if (!file) return;
    imageBusy = true; $('#edit-form [type=submit]').disabled = true;
    try { const data = await imageData(file); if (alive) { selectedCover = data; modalDirty = true; refreshCover(); $('#form-error').textContent = ''; } }
    catch(e) { if (alive) showError(e.message); }
    finally { imageBusy = false; if (alive) $('#edit-form [type=submit]').disabled = false; }
  };
  async function search() {
    const q = $('#book-query').value.trim(); if (!q) { $('#book-query').focus(); return; }
    controller?.abort(); controller = new AbortController(); const token = ++requestId;
    const timeout = setTimeout(() => controller.abort(),15000);
    $('#search-status').textContent = '책과 표지를 찾는 중…'; $('#search-results').replaceChildren();
    try {
      const url = BOOK_SEARCH_ENDPOINT ? `${BOOK_SEARCH_ENDPOINT}${BOOK_SEARCH_ENDPOINT.includes('?') ? '&' : '?'}q=${encodeURIComponent(q)}` : `https://openlibrary.org/search.json?q=${encodeURIComponent(q)}&limit=8&fields=key,title,author_name,cover_i,first_publish_year`;
      const response = await fetch(url,{signal:controller.signal});
      if (!response.ok) throw new Error('검색 서비스에 연결하지 못했습니다. 잠시 후 다시 시도하거나 사진을 직접 골라주세요.');
      const data = await response.json();
      // 중계소는 {books:[...]} 또는 [...] 를, 저자는 author 또는 authors 로 줄 수 있습니다.
      const results = BOOK_SEARCH_ENDPOINT ? (Array.isArray(data) ? data : data.books || []).map(b => ({...b,author:b.author || (Array.isArray(b.authors) ? b.authors.join(', ') : b.authors) || ''})) : (data.docs || []).map(d => ({title:d.title,author:(d.author_name || []).join(', '),publisher:'',isbn:'',cover:d.cover_i ? `https://covers.openlibrary.org/b/id/${d.cover_i}-L.jpg?default=false` : '',sourceUrl:`https://openlibrary.org${d.key}`}));
      if (!Array.isArray(results)) throw new Error('검색 결과 형식이 올바르지 않습니다.');
      if (!alive || token !== requestId) return;
      $('#search-status').textContent = results.length ? `${results.length}건 · 책을 선택하면 아래에 정보가 채워집니다.` : '찾은 책이 없습니다. 아래에서 제목을 적고 사진을 골라주세요.';
      $('#search-results').innerHTML = results.slice(0,20).map((b,i) => `<button type="button" class="search-result" data-result="${i}">${cover({title:b.title,cover:safeCover(b.cover)})}<span><b>${esc(b.title)}</b><small>${esc([b.author,b.publisher].filter(Boolean).join(' · ') || '저자 정보 없음')}</small>${b.isbn ? `<small>ISBN ${esc(b.isbn)}</small>` : ''}</span></button>`).join('');
      $('#search-results').querySelectorAll('[data-result]').forEach(btn => btn.onclick = () => {
        const b = results[Number(btn.dataset.result)];
        ['title','author','publisher','isbn'].forEach(k => { $(`#f-${k}`).value = b[k] || ''; }); selectedCover = safeCover(b.cover); refreshCover(); modalDirty = true; preserveDraft();
        $('#search-status').textContent = `“${b.title}” 선택됨 · 아래 정보를 확인하고 저장해주세요.`;
        $('#f-title').focus();
      });
    } catch(e) { if (alive && token === requestId) $('#search-status').textContent = e.name === 'AbortError' ? '검색 시간이 초과되었습니다. 다시 시도하거나 사진을 직접 골라주세요.' : e.message; }
    finally { clearTimeout(timeout); }
  }
  $('#search-books').onclick = search;
  $('#book-query').onkeydown = e => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); search(); } };
  formHandler(async data => {
    if (imageBusy) throw new Error('사진을 처리하는 중입니다. 잠시 기다려주세요.');
    const values = {title:data.get('title').trim(),author:data.get('author').trim(),publisher:data.get('publisher').trim(),isbn:data.get('isbn').trim(),cover:selectedCover,color:selectedColor};
    if (!values.title) throw new Error('책 제목을 입력해주세요.');
    if (values.isbn && state.books.some(b => b.id !== existing?.id && b.isbn.replace(/[\s-]/g,'') === values.isbn.replace(/[\s-]/g,''))) throw new Error('같은 ISBN의 책이 이미 책장에 있습니다. 기존 책을 확인해주세요.');
    const id = existing?.id || uid();
    const ok = await change(s => { if (existing) Object.assign(s.books.find(b => b.id === id),values); else s.books.push({id,...values,status:'reading',createdAt:now(),finishedAt:'',entries:[],questions:[]}); });
    if (ok) { query = ''; location.hash = `book/${id}`; }
    return ok;
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
function exportState(data = state, prefix = 'reading-notebook') { download(backup(data),`${prefix}-${new Date().toISOString().slice(0,10)}.json`); }
function settings() {
  const s = stats(state);
  openModal('기록 보관함',`<p class="hint">책 ${s.books}권 · 문장 ${s.entries}개 · 질문 ${s.questions}개<br>생각 ${s.thoughts}개 · 여행 ${s.trips}개</p><p>기록은 이 기기의 브라우저에 저장됩니다.<br>휴대폰과 PC 사이에 자동으로 공유되지는 않습니다.</p><div class="storage-block"><h3>파일로 남겨두기</h3><p class="hint">직접 올린 표지 사진까지 포함해 내려받습니다. 검색으로 연결한 표지는 주소가 저장되어 인터넷 연결이 필요합니다.</p><button class="primary" id="export">전체 기록 내보내기</button></div><div class="storage-block"><h3>백업에서 가져오기</h3><p class="hint">이전 기록장의 JSON 파일도 읽을 수 있습니다. 파일을 고르면 복원할 내용을 먼저 보여드립니다.</p><label class="file-label">백업 파일 선택<input class="visually-hidden" type="file" id="import" accept=".json,application/json"></label><div id="restore-area"></div></div><div class="storage-block"><h3>직전 저장 상태</h3><p class="hint">바로 전 저장으로 돌아갑니다. 복원 시 현재 기록도 파일로 내려받습니다.</p><button id="previous">직전 상태 확인</button></div><div class="storage-block"><h3>오래 보관하기</h3><p class="hint">브라우저 데이터를 지우면 기록도 지워집니다. 중요한 기록은 파일로도 보관해주세요.</p><button id="persistent">브라우저에 보관 요청</button><p class="hint" id="persistent-status"></p></div>`);
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
  $('#restore-area').innerHTML = `<div class="restore-preview"><b>${label}</b><p>책 ${s.books}권 · 문장 ${s.entries}개 · 질문 ${s.questions}개<br>생각 ${s.thoughts}개 · 여행 ${s.trips}개</p><p>현재 기록 전체를 이 내용으로 교체합니다.<br>교체 전 현재 기록은 백업 파일로 내려받습니다.</p><button id="confirm-restore" class="primary">현재 기록 백업 후 교체</button></div>`;
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
    if (loaded.migrated) notice('이전 기록을 모두 가져왔습니다. 원본 데이터도 그대로 보관했습니다.');
    if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('./sw.js').then(() => { status('이 브라우저에 저장됨'); }).catch(() => { status('저장 가능 · 오프라인 준비 실패'); });
  } catch(e) {
    status('불러오기 실패 · 원본 보존됨',true);
    $('#main').innerHTML = `<div class="empty"><h2>기록을 안전하게 열지 못했습니다</h2><p>${esc(e.message)}</p><p>기존 기록은 덮어쓰지 않았습니다. 원본을 내려받아 보관해주세요.</p><button id="download-original">이전 원본 내려받기</button><p class="hint">파일을 직접 열었다면, 로컬 서버 또는 배포된 주소로 접속해주세요.</p></div>`;
    $('#download-original').onclick = () => { try { const raw = localStorage.getItem('onemonth_v1'); if (raw) download(raw,'original-onemonth.json'); else notice('이 브라우저에 이전 기록이 없습니다.'); } catch(e) { notice(e.message); } };
  }
}
init();
