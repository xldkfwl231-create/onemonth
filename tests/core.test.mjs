import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalize, backup, matchesBook, dateLabel, dayKey, safeCover, emptyState, nextQuestion, dayOf } from '../src/core.js';
const old = () => ({books:[{t:'독서의 기술',s:'8/1',e:[{l:'오래 남은 문장',d:'8/2'}]}],thoughts:[{t:'생각',d:'8/3'}],trips:[{p:'통영',n:'바다'}],cur:0});
test('legacy migration preserves every record, original dates and original input',() => {
  const input = old(), copy = structuredClone(input), s = normalize(input);
  assert.deepEqual(input,copy); assert.equal(s.books[0].entries[0].text,'오래 남은 문장'); assert.equal(s.thoughts[0].text,'생각'); assert.equal(s.moments[0].place,'통영'); assert.equal(s.moments[0].text,'바다'); assert.equal(s.books[0].createdAt,'8/1');
  assert.equal(new Set([s.books[0].id,s.books[0].entries[0].id,s.thoughts[0].id,s.moments[0].id]).size,4);
});
test('old single-line book migrates',() => { const s = normalize({books:[{t:'책',l:'문장',d:'1/2'}]}); assert.equal(s.books[0].entries[0].text,'문장'); });
test('complete backup round trip includes uploaded covers, answers, notes and years',() => {
  const s = normalize(old()); s.books[0].cover = 'data:image/jpeg;base64,YQ=='; s.books[0].entries[0].note='내 생각'; s.books[0].questions.push({id:crypto.randomUUID(),text:'왜?',answer:'그래서',createdAt:'2026-09-14T12:00:00Z',answeredAt:'2026-09-14T13:00:00Z'});
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
  s.thoughts.push({id:'m',createdAt:at(10).toISOString(),text:'본 것'});
  assert.equal(nextQuestion(s,at(20)),null);
  s.profile.tone = 'you'; assert.match(nextQuestion(s,at(20),['prompt']) === null ? '어?' : 'x',/어\?/);
});
test('late night belongs to the previous day',() => {
  assert.equal(dayOf(new Date(2026,8,30,2,0)),'2026-09-29'); assert.equal(dayOf(new Date(2026,8,30,5,0)),'2026-09-30');
});
