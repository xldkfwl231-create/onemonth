import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalize, backup, matchesBook, dateLabel, safeCover, emptyState } from '../src/core.js';
const old = () => ({books:[{t:'독서의 기술',s:'8/1',e:[{l:'오래 남은 문장',d:'8/2'}]}],thoughts:[{t:'생각',d:'8/3'}],trips:[{p:'통영',n:'바다'}],cur:0});
test('legacy migration preserves every record, original dates and original input',() => {
  const input = old(), copy = structuredClone(input), s = normalize(input);
  assert.deepEqual(input,copy); assert.equal(s.books[0].entries[0].text,'오래 남은 문장'); assert.equal(s.thoughts[0].text,'생각'); assert.equal(s.trips[0].place,'통영'); assert.equal(s.books[0].createdAt,'8/1');
  assert.equal(new Set([s.books[0].id,s.books[0].entries[0].id,s.thoughts[0].id,s.trips[0].id]).size,4);
});
test('old single-line book migrates',() => { const s = normalize({books:[{t:'책',l:'문장',d:'1/2'}]}); assert.equal(s.books[0].entries[0].text,'문장'); });
test('complete backup round trip includes uploaded covers, answers, notes and years',() => {
  const s = normalize(old()); s.books[0].cover = 'data:image/jpeg;base64,YQ=='; s.books[0].entries[0].note='내 생각'; s.books[0].questions.push({id:crypto.randomUUID(),text:'왜?',answer:'그래서',createdAt:'2026-09-14T12:00:00Z',answeredAt:'2026-09-14T13:00:00Z'});
  assert.deepEqual(normalize(JSON.parse(backup(s))),s);
});
test('malformed restores are rejected instead of wiping existing state',() => {
  for (const bad of [{},null,[],{thoughts:'oops'},{books:[null]},{books:[{t:'책',e:{}}]},{books:[{t:'책',e:[{}]}]},{books:[],thoughts:[{}]},{version:3,books:[]}]) assert.throws(() => normalize(bad));
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
test('empty v2 state is a valid backup',() => { assert.deepEqual(normalize(JSON.parse(backup(emptyState()))),emptyState()); });
