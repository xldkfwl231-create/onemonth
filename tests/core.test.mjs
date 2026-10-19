import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalize, backup, matchesBook, dateLabel, dayKey, safeCover, emptyState, nextQuestion, dayOf, boardGraph, localGraph, seenSelf } from '../src/core.js';
const old = () => ({books:[{t:'독서의 기술',s:'8/1',e:[{l:'오래 남은 문장',d:'8/2'}]}],thoughts:[{t:'생각',d:'8/3'}],trips:[{p:'통영',n:'바다'}],cur:0});
test('legacy migration preserves every record, original dates and original input',() => {
  const input = old(), copy = structuredClone(input), s = normalize(input);
  assert.deepEqual(input,copy); assert.equal(s.books[0].entries[0].text,'오래 남은 문장'); assert.equal(s.thoughts[0].text,'생각'); assert.equal(s.moments[0].place,'통영'); assert.equal(s.moments[0].text,'바다'); assert.equal(s.books[0].createdAt,'8/1');
  assert.equal(new Set([s.books[0].id,s.books[0].entries[0].id,s.thoughts[0].id,s.moments[0].id]).size,4);
});
test('old single-line book migrates',() => { const s = normalize({books:[{t:'책',l:'문장',d:'1/2'}]}); assert.equal(s.books[0].entries[0].text,'문장'); });
test('complete backup round trip includes uploaded covers, answers, notes and years',() => {
  const s = normalize(old()); s.books[0].cover = 'data:image/jpeg;base64,YQ=='; s.books[0].entries[0].note='내 생각'; s.books[0].questions.push({id:crypto.randomUUID(),text:'왜?',answer:'그래서',createdAt:'2026-09-14T12:00:00Z',answeredAt:'2026-09-14T13:00:00Z',from:'',history:[]});
  assert.deepEqual(normalize(JSON.parse(backup(s))),s);
});
test('malformed restores are rejected instead of wiping existing state',() => {
  for (const bad of [{},null,[],{thoughts:'oops'},{books:[null]},{books:[{t:'책',e:{}}]},{books:[{t:'책',e:[{}]}]},{books:[],thoughts:[{}]},{version:3,books:[]},{version:4,books:[]}]) assert.throws(() => normalize(bad));
  const s=normalize(old()); s.books[0].entries[0].id=s.books[0].id; assert.throws(() => normalize(s),/ID/);
});
test('restored cover URLs reject executable or malformed schemes',() => {
  for (const url of ['javascript:alert(1)','data:image/svg+xml;base64,YQ==','http://example.com/a.jpg','https://name:password@example.com/a.jpg']) assert.throws(() => safeCover(url));
  assert.equal(safeCover('https://example.com/book.jpg'),'https://example.com/book.jpg');
});
test('search finds text, author, page, personal notes and answers',() => {
  const b=normalize(old()).books[0]; b.author='김작가'; b.entries[0].page='42'; b.entries[0].note='도서관'; b.questions.push({text:'물음',answer:'답변'});
  for (const q of ['독서','문장','김작가','42','도서관','답변']) assert.equal(matchesBook(b,q),true);
  assert.equal(matchesBook(b,'존재하지 않음'),false);
});
test('legacy dates do not invent a year',() => { assert.equal(dateLabel('8/1'),'8/1 · 이전 기록'); assert.match(dateLabel('2026-09-14T12:00:00Z'),/2026/); });
test('empty state is a valid backup',() => { assert.deepEqual(normalize(JSON.parse(backup(emptyState()))),emptyState()); });
test('records from the same day share one date group',() => {
  const a = new Date(2026,8,19,9,0).toISOString(), b = new Date(2026,8,19,23,30).toISOString(), c = new Date(2026,8,20,0,10).toISOString();
  assert.equal(dayKey(a),dayKey(b)); assert.notEqual(dayKey(b),dayKey(c));
  assert.equal(dayKey('8/1'),'8/1'); assert.equal(dayKey(''),'');
});
test('version 2 backups move into version 3 without losing records',() => {
  const v2 = {version:2,books:[{id:'b',title:'책',status:'reading',entries:[{id:'e',text:'문장',createdAt:'2026-09-19T01:00:00.000Z'}],questions:[{id:'q',text:'왜?'}]}],thoughts:[{id:'t',text:'생각',createdAt:''}],trips:[{id:'r',place:'통영',text:'바다',createdAt:''}]};
  const s = normalize(v2);
  assert.equal(s.version,3); assert.equal(s.books[0].entries[0].id,'e'); assert.equal(s.books[0].questions[0].id,'q'); assert.equal(s.thoughts[0].id,'t');
  assert.deepEqual(s.moments.map(m => [m.id,m.place,m.text]),[['r','통영','바다']]);
  assert.deepEqual(normalize(JSON.parse(backup(s))),s);
});
test('the cat asks for a sentence in the evening, one observation a day, then rests',() => {
  const s = emptyState(), at = (h,m=0) => new Date(2026,8,30,h,m);
  assert.equal(nextQuestion(s,at(9)).type,'moment');
  assert.equal(nextQuestion(s,at(9),['prompt']),null);
  s.books.push({...normalize({version:2,books:[{id:'b',title:'책',status:'reading',entries:[],questions:[]}],thoughts:[],trips:[]}).books[0]});
  assert.equal(nextQuestion(s,at(9)).type,'moment');                 // 아침에는 책을 묻지 않는다
  assert.equal(nextQuestion(s,at(20)).type,'book');
  assert.equal(nextQuestion(s,at(20),['book']).type,'moment');
  s.books[0].entries.push({id:'e',text:'문장',page:'',note:'',createdAt:at(19).toISOString()});
  s.answers.push({id:'m',createdAt:at(10).toISOString(),prompt:'?',text:'본 것'});
  assert.equal(nextQuestion(s,at(20)),null);
  s.profile.tone = 'you'; assert.match(nextQuestion(s,at(20),['prompt']) === null ? '어?' : 'x',/어\?/);
});
test('late night belongs to the previous day',() => {
  assert.equal(dayOf(new Date(2026,8,30,2,0)),'2026-09-29'); assert.equal(dayOf(new Date(2026,8,30,5,0)),'2026-09-30');
});

test('the slime asks today\'s own question when it has one, and bad insights are dropped', () => {
  const s = emptyState(), at = new Date(2026,9,11,9);
  s.insights = { date: '2026-10-11', at: '', question: '오늘은 누구랑 있을 때 편했어?', lines: [{ text: '그땐', ids: ['x'] }] };
  assert.equal(nextQuestion(s, at).text, '오늘은 누구랑 있을 때 편했어?');
  s.insights.date = '2026-10-10'; assert.notEqual(nextQuestion(s, at).text, '오늘은 누구랑 있을 때 편했어?');
  assert.deepEqual(normalize(JSON.parse(backup({ ...s, insights: { date: 3 } }))).insights, null);
  assert.equal(normalize(JSON.parse(backup(s))).insights.lines[0].text, '그땐');
});

test('chats and usage survive a backup round trip, and broken ones are refused or zeroed', () => {
  const s = emptyState();
  s.chats.push({ id: 'c1', createdAt: '2026-10-11T01:00:00.000Z', topic: { kind: 'entry', ref: 'e1', book: 'b1', title: '책' }, usage: { input: 400, output: 60 }, messages: [{ role: 'user', text: '관찰하라는 말', at: '' }, { role: 'assistant', text: '어떤 느낌이었어?', at: '' }] });
  s.usage = { since: '2026-10-11', calls: 2, input: 900, output: 80, byKind: { chat: { calls: 1, input: 400, output: 60 } } };
  assert.deepEqual(normalize(JSON.parse(backup(s))), s);
  const bad = structuredClone(s); bad.chats[0].messages[0].role = 'system'; assert.throws(() => normalize(bad));
  const weird = structuredClone(s); weird.usage = { calls: -5, input: 'lots' }; assert.deepEqual(normalize(weird).usage, { since: '', calls: 0, input: 0, output: 0, byKind: {} });
});

test('talk results stay with their record: added lines, earlier answers and the sentence a question came from', () => {
  const s = normalize({ version: 3, profile: { catName: '', tone: 'we', aiConsentAt: '' },
    books: [{ id: 'b', title: '책', status: 'reading', entries: [{ id: 'e', text: '문장', more: [{ id: 'm1', text: '이야기에서 덧붙임', createdAt: '2026-10-10T01:00:00Z', chat: 'c' }] }],
      questions: [{ id: 'q', text: '왜?', answer: '지금은 이래', from: 'e', history: [{ text: '그땐 저랬다', at: '2026-10-01T01:00:00Z' }] }] }],
    thoughts: [{ id: 't', text: '생각', more: [{ id: 'm2', text: '더 생각해 보니' }] }, { id: 't2', text: '옛 생각' }], answers: [], moments: [], chats: [] });
  assert.equal(s.books[0].entries[0].more[0].chat, 'c');
  assert.equal(s.books[0].questions[0].from, 'e');
  assert.equal(s.books[0].questions[0].history[0].text, '그땐 저랬다');
  assert.equal(s.thoughts[0].more[0].text, '더 생각해 보니');
  assert.deepEqual(s.thoughts[1].more, []);
  assert.deepEqual(normalize(JSON.parse(backup(s))), s);
  assert.ok(matchesBook(s.books[0], '덧붙임') && matchesBook(s.books[0], '저랬다'));
  assert.throws(() => normalize({ version: 3, books: [], thoughts: [{ id: 't', text: 'a', more: [{ id: 't', text: 'b' }] }], moments: [] }), /ID/);
});

test('answers to the slime keep added lines, and a talk can start from an answer', () => {
  const s = normalize({ version: 3, profile: { catName: '', tone: 'we', aiConsentAt: '' }, books: [], thoughts: [], moments: [], answers: [{ id: 'a', prompt: '오늘은?', text: '좋았다', more: [{ id: 'm', text: '이야기해 보니 사실 피곤했다' }] }],
    chats: [{ id: 'c', topic: { kind: 'answer', ref: 'a', title: '오늘은?' }, messages: [] }] });
  assert.equal(s.answers[0].more[0].text, '이야기해 보니 사실 피곤했다');
  assert.equal(s.chats[0].topic.kind, 'answer');
  assert.deepEqual(normalize(JSON.parse(backup(s))), s);
});

test('the record map links records to their tags and books, and questions to the sentence they came from', () => {
  const s = normalize({ version: 3, profile: { catName: '', tone: 'we', aiConsentAt: '' }, moments: [],
    books: [{ id: 'b', title: '책', status: 'reading', entries: [{ id: 'e', text: '문장' }], questions: [{ id: 'q', text: '왜?', from: 'e' }, { id: 'q2', text: '어떻게?' }] }],
    thoughts: [{ id: 't', text: '생각' }, { id: 't2', text: '다른 생각' }], answers: [{ id: 'a', prompt: '오늘은?', text: '좋았다' }],
    readings: { t: { tags: ['몰입'] }, a: { tags: ['몰입', '혼자'] }, e: { tags: ['관찰'] } },
    chats: [{ id: 'c', topic: { kind: 'thought', ref: 't' }, messages: [{ role: 'user', text: '음' }, { role: 'assistant', text: '응' }] }] });
  const g = boardGraph(s), node = id => g.nodes.find(n => n.id === id), linked = (a, b) => g.links.some(l => l.s === a && l.t === b);
  assert.equal(node('tag:몰입').count, 2);
  assert.ok(linked('t', 'tag:몰입') && linked('a', 'tag:혼자') && linked('e', 'tag:관찰'));
  assert.ok(linked('e', 'book:b') && linked('q', 'e') && linked('q2', 'book:b'));
  assert.equal(node('t').talk, 2);
  assert.ok(!g.links.some(l => l.s === 't2'));   // 주제어가 아직 없는 생각은 홀로
  assert.equal(g.nodes.length, 3 + 1 + 2 + 1 + 3);
});

test('a book keeps its summary, and a broken one is dropped', () => {
  const base = { version: 3, profile: { catName: '', tone: 'we', aiConsentAt: '' }, thoughts: [], answers: [], moments: [], chats: [] };
  const s = normalize({ ...base, books: [{ id: 'b', title: '책', status: 'reading', entries: [], questions: [], summary: { at: '2026-10-11T00:00:00Z', n: 4, line: '한 줄', held: [{ id: 'e', why: '왜' }, 'x'], open: [], changed: [{ then: '그땐', now: '지금은' }, { then: 1 }] } }] });
  assert.deepEqual(s.books[0].summary, { at: '2026-10-11T00:00:00Z', n: 4, line: '한 줄', held: [{ id: 'e', why: '왜' }], open: [], changed: [{ then: '그땐', now: '지금은' }] });
  assert.deepEqual(normalize(JSON.parse(backup(s))), s);
  assert.equal(normalize({ ...base, books: [{ id: 'b', title: '책', status: 'reading', entries: [], questions: [], summary: 'x' }] }).books[0].summary, null);
});

test('seen self counts tags by month, new and faded tags, held questions and changed answers', () => {
  const today = new Date(2026, 9, 20), at = (m, d) => new Date(2026, m, d, 12).toISOString();
  const s = normalize({ version: 3, profile: { catName: '', tone: 'we', aiConsentAt: '' }, moments: [], answers: [],
    thoughts: [{ id: 't1', text: 'a', createdAt: at(7, 3) }, { id: 't2', text: 'b', createdAt: at(7, 9) }, { id: 't3', text: 'c', createdAt: at(9, 15), more: [{ id: 'm', text: 'd', createdAt: at(9, 18) }] }],
    books: [{ id: 'b', title: '책', status: 'reading', entries: [], questions: [
      { id: 'q1', text: '오래된 질문', createdAt: at(7, 1), answer: '' },
      { id: 'q2', text: '바뀐 질문', createdAt: at(8, 1), answer: '지금은 이래', answeredAt: at(9, 10), history: [{ text: '그땐 저래', at: at(8, 5) }] }] }],
    readings: { t1: { tags: ['회의'] }, t2: { tags: ['회의', '피로'] }, t3: { tags: ['혼자'] } },
    chats: [{ id: 'c', topic: { kind: 'thought', ref: 't3', title: 'c' }, messages: [{ role: 'user', text: 'x' }, { role: 'assistant', text: 'y' }] }] });
  const r = seenSelf(s, today);
  assert.deepEqual(r.months.map(m => m.key), ['2026-08', '2026-09', '2026-10']);
  assert.deepEqual(r.months[0].tags, [['회의', 2], ['피로', 1]]);
  assert.deepEqual(r.months[2].tags, [['혼자', 2]]);                 // 덧붙인 말도 그 생각의 주제어로 셈
  assert.deepEqual(r.fresh, [['혼자', 2]]);
  assert.deepEqual(r.faded, [['회의', 2]]);
  assert.equal(r.holding[0].id, 'q1'); assert.equal(r.holding[0].days, 79);   // 8월 1일 낮 → 10월 20일 0시
  assert.deepEqual(r.changed[0], { id: 'q2', book: 'b', text: '바뀐 질문', then: '그땐 저래', now: '지금은 이래' });
  assert.equal(r.talked[0].n, 2);
});
test('sentence titles survive a backup round trip and bad ones are dropped', () => {
  const s = emptyState(); s.titles = { e1: { t: '고슴도치 찾기', h: '123' }, e2: { t: 7 }, e3: 'x', [ 'x'.repeat(101) ]: { t: 'long id' } };
  const back = normalize(JSON.parse(backup(s)).data);
  assert.deepEqual(back.titles, { e1: { t: '고슴도치 찾기', h: '123' } });
  assert.deepEqual(normalize({ version: 2, books: [], thoughts: [] }).titles, {});   // 예전 백업에는 없음
});
test('links: kept through backup, bad ones dropped, and drawn on the map only when both records exist and not refused', () => {
  const s = emptyState();
  s.thoughts = [{ id: 't1', text: '혼자 걷는 출근길', more: [], createdAt: '2026-10-01T00:00:00Z' }, { id: 't2', text: '혼자 있을 때 기운', more: [], createdAt: '2026-10-02T00:00:00Z' }, { id: 't3', text: '회의', more: [], createdAt: '2026-10-03T00:00:00Z' }];
  s.links = [{ a: 't1', b: 't2', at: '2026-10-02T00:00:00Z', why: '둘 다 혼자' }, { a: 't1', b: 't3', no: true }, { a: 't1', b: 'gone' }, { a: 't1', b: 't1' }, { a: 5, b: 't2' }];
  const back = normalize(JSON.parse(backup(s)).data);
  assert.equal(back.links.length, 3);
  assert.deepEqual(back.links[0], { a: 't1', b: 't2', at: '2026-10-02T00:00:00Z', why: '둘 다 혼자' });
  assert.equal(back.links[1].no, true);
  const drawn = boardGraph(back).links.filter(l => l.kind === 'link');
  assert.deepEqual(drawn, [{ s: 't1', t: 't2', kind: 'link' }]);
  assert.deepEqual(normalize({ version: 2, books: [], thoughts: [] }).links, []);
});
test('local graph: neighbours, what my links link to, and a few recent records through a tag', () => {
  const s = emptyState(), at = d => `2026-10-${String(d).padStart(2, '0')}T00:00:00Z`;
  s.thoughts = Array.from({ length: 10 }, (_, i) => ({ id: 't' + i, text: '생각 ' + i, more: [], createdAt: at(i + 1) }));
  s.readings = { t0: { tags: ['산책'] }, t1: { tags: ['산책'] }, t2: { tags: ['산책'] }, t3: { tags: ['산책'] }, t9: { tags: ['회의'] } };
  s.links = [{ a: 't0', b: 't5' }, { a: 't5', b: 't6' }, { a: 't6', b: 't7' }, { a: 't0', b: 't8', no: true }];
  const g = boardGraph(s), ids = c => localGraph(g, c, 2).nodes.map(n => n.id).sort();
  // t0 → 주제어 #산책(그 주제어의 최근 기록 2개: t3, t2), 이어 둔 t5, t5가 이어 둔 t6. t7은 세 다리, t8은 '아니야', t9는 다른 주제어
  assert.deepEqual(ids('t0'), ['t0', 't2', 't3', 't5', 't6', 'tag:산책']);
  assert.ok(localGraph(g, 't0', 2).links.every(l => ids('t0').includes(l.s) && ids('t0').includes(l.t)));
  assert.deepEqual(ids('tag:산책'), ['t0', 't1', 't2', 't3', 't5', 'tag:산책']);   // 주제어 가운데: 달린 기록과 그 기록이 이어 둔 것
  assert.deepEqual(localGraph(g, 'nope'), { nodes: [], links: [] });
});
