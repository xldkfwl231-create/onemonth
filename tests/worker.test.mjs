// 중계소의 /ai/tags — 실제 AI를 부르지 않고, 가짜 응답으로 입력 검사와 결과 정리를 확인합니다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker/book-search.js';

const APP = 'https://xldkfwl231-create.github.io';
const call = (body, { origin = APP, method = 'POST', path = '/ai/tags', env = { ANTHROPIC_KEY: 'test-key' } } = {}) =>
  worker.fetch(new Request('https://book-search.example.workers.dev' + path, { method, headers: { Origin: origin, 'Content-Type': 'application/json' }, body: method === 'POST' ? JSON.stringify(body) : undefined }), env);

function fakeAI(reply, check = () => {}) {
  globalThis.fetch = async (url, init) => {
    check(url, init);
    return new Response(JSON.stringify(reply), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
}

test('tags: sends the key only to Anthropic and returns cleaned tags', async () => {
  let sent;
  fakeAI({ stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: JSON.stringify({ items: [{ id: 'a', tags: ['회의', '기운', '회의', ' 일 ', '너무너무너무긴주제어입니다요'] }, { id: 'zzz', tags: ['남의 것'] }] }) }], usage: { input_tokens: 100, output_tokens: 20 } },
    (url, init) => { sent = { url, init }; });
  const res = await call({ items: [{ id: 'a', text: '회의만 끝나면 기운이 빠진다' }], known: ['독서'] });
  assert.equal(res.status, 200);
  const out = await res.json();
  assert.deepEqual(out.items, [{ id: 'a', tags: ['회의', '기운', '일'], gist: '' }]);   // 중복·공백·긴 말 정리, 모르는 id 버림, 요약 없으면 빈 칸
  assert.equal(out.bite, '');   // 방금 먹인 기록(fresh)이 없으면 한마디도 없음
  assert.equal(sent.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(sent.init.headers['x-api-key'], 'test-key');
  const body = JSON.parse(sent.init.body);
  assert.equal(body.model, 'claude-haiku-5-5');
  assert.equal(body.output_config.format.type, 'json_schema');
  assert.ok(!('temperature' in body));
});

test('tags: refuses unknown sites, missing key, wrong method and bad input', async () => {
  fakeAI({});
  assert.equal((await call({ items: [{ id: 'a', text: 'x' }] }, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await call({ items: [{ id: 'a', text: 'x' }] }, { env: {} })).status, 503);
  assert.equal((await call(null, { method: 'GET' })).status, 405);
  assert.equal((await call({ items: [] })).status, 400);
  assert.equal((await call({ items: Array.from({ length: 31 }, (_, i) => ({ id: 'i' + i, text: 't' })) })).status, 400);
  assert.equal((await call({ items: [{ id: 'a', text: '   ' }] })).status, 400);
});

test('tags: refusal and broken answers become errors, not crashes', async () => {
  fakeAI({ stop_reason: 'refusal', content: [] });
  assert.equal((await call({ items: [{ id: 'a', text: 'x' }] })).status, 422);
  fakeAI({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'not json' }] });
  assert.equal((await call({ items: [{ id: 'a', text: 'x' }] })).status, 502);
});

test('health tells whether the key is set without revealing it', async () => {
  const res = await call(null, { method: 'GET', path: '/ai/health', env: { ANTHROPIC_KEY: 'secret-value' } });
  const text = await res.text();
  assert.ok(!text.includes('secret-value'));
  assert.equal(JSON.parse(text).key, true);
});

test('summary: takes only my own words, keeps known ids, trims lengths', async () => {
  let body;
  fakeAI({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({ line: '판단 전에 보기.', held: [{ id: 'e1', why: '메모를 세 번 덧붙임' }, { id: 'nope', why: 'x' }, { id: 'e1', why: '중복' }], open: [{ id: 'q1', why: '아직 답 없음' }, { id: 'e1', why: '질문 아님' }], changed: [{ id: 'e1', then: '결론부터', now: '먼저 보기' }, { id: 'e1', then: '', now: 'x' }, { id: 'nope', then: 'a', now: 'b' }, { id: 'q1', then: '같음', now: '같음' }] }) }], usage: { input_tokens: 900, output_tokens: 120 } },
    (url, init) => { body = JSON.parse(init.body); });
  const res = await call({ name: '말랑', tone: 'we', book: { title: '책', author: '저자' },
    entries: [{ id: 'e1', page: '42', note: '결론부터 내는 편', more: ['회의에서 특히'], talk: ['빨리 끝내고 싶어서'], text: '옮겨 적은 문장' }],
    questions: [{ id: 'q1', text: '왜 피할까?', answer: '', history: [], talk: [] }], talk: [] }, { path: '/ai/summary' });
  assert.equal(res.status, 200);
  const out = await res.json();
  assert.deepEqual(out.held, [{ id: 'e1', why: '메모를 세 번 덧붙임' }]);
  assert.deepEqual(out.open, [{ id: 'q1', why: '아직 답 없음' }]);
  assert.deepEqual(out.changed, [{ id: 'e1', then: '결론부터', now: '먼저 보기' }]);   // 한 기록 안의 변화만, 같은 말은 버림
  assert.match(body.system, /남 얘기하듯/);
  assert.deepEqual(out.usage, { input: 900, output: 120 });
  assert.ok(!body.messages[0].content.includes('옮겨 적은 문장'));   // 책 문장은 AI로 가지 않음
  assert.equal(body.output_config.format.type, 'json_schema');
});

test('summary: refuses an empty book and unknown sites', async () => {
  fakeAI({});
  assert.equal((await call({ entries: [{ id: 'e', note: '' }], questions: [] }, { path: '/ai/summary' })).status, 400);
  assert.equal((await call({ entries: 'x', questions: [] }, { path: '/ai/summary' })).status, 400);
  assert.equal((await call({ entries: [], questions: [{ id: 'q', text: '왜?' }] }, { path: '/ai/summary', origin: 'https://evil.example' })).status, 403);
});

test('chat: what the app knows about me goes as quiet background, not quotes', async () => {
  let body;
  fakeAI({ stop_reason: 'end_turn', content: [{ type: 'text', text: '그렇구나.' }], usage: { input_tokens: 10, output_tokens: 5 } }, (url, init) => { body = JSON.parse(init.body); });
  const profile = [{ cat: '기준', text: '정해진 길이 있으면 오히려 편하다고 느낌' }, { cat: '고민', text: '' }, ...Array.from({ length: 50 }, (_, i) => ({ cat: '관심사', text: '관심 ' + i }))];
  const res = await call({ topic: { kind: 'free' }, profile, memory: [{ text: '예전 방식 기억' }], messages: [{ role: 'user', text: '요즘 어때?' }] }, { path: '/ai/chat' });
  assert.equal(res.status, 200);
  assert.match(body.system, /- 기준: 정해진 길이 있으면 오히려 편하다고 느낌/);
  assert.ok(!body.system.includes('관심 45'));   // 40개까지만
  assert.ok(!body.system.includes('예전 방식 기억'));   // 기록 원문(memory)은 더 받지 않음
  assert.match(body.system, /티 내지 마세요/);
  assert.match(body.system, /되물어도 됩니다/);   // 생각이 넓어지도록 되묻기 허용
  await call({ topic: { kind: 'free' }, messages: [{ role: 'user', text: '안녕' }] }, { path: '/ai/chat' });
  assert.ok(!body.system.includes('알고 있는 것 쓰는 법'));   // 메모가 없으면 그 부분도 없음
});

test('chat: sends the conversation as turns, merges same-side lines, returns the reply', async () => {
  let body;
  fakeAI({ stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: '  그 문장에서 "관찰"이 걸렸구나. 판단 없이 본다는 건 결론을 미루는 일이라 어려운 게 당연해.  ' }], usage: { input_tokens: 400, output_tokens: 60 } },
    (url, init) => { body = JSON.parse(init.body); });
  const res = await call({ name: '말랑', tone: 'we', topic: { kind: 'book', title: '어떻게 살아낼 것인가', author: '짐 콜린스', notes: ['해 보자. 판단 없이.'] },
    messages: [{ role: 'assistant', text: '어떤 게 마음에 남았어?' }, { role: 'user', text: '관찰하라는 말' }, { role: 'user', text: '그게 어렵더라' }] }, { path: '/ai/chat' });
  assert.equal(res.status, 200);
  const out = await res.json();
  assert.match(out.reply, /^그 문장에서/);
  assert.deepEqual(out.usage, { input: 400, output: 60 });
  assert.equal(body.messages.length, 1);                       // 맨 앞 슬라임 말은 빼고, 이어진 사람 말은 하나로
  assert.equal(body.messages[0].content, '관찰하라는 말\n\n그게 어렵더라');
  assert.ok(!('next' in out));   // 이어서 꺼낼 말 단추는 없앰
  assert.ok(!body.output_config.format);
  assert.match(body.system, /어떻게 살아낼 것인가/);
  assert.match(body.system, /무조건 맞장구치지 마세요/);
});

test('chat: the last turn must be the person, and bad roles are refused', async () => {
  fakeAI({});
  assert.equal((await call({ messages: [{ role: 'user', text: 'a' }, { role: 'assistant', text: 'b' }] }, { path: '/ai/chat' })).status, 400);
  assert.equal((await call({ messages: [{ role: 'system', text: 'a' }] }, { path: '/ai/chat' })).status, 400);
  assert.equal((await call({ messages: [] }, { path: '/ai/chat' })).status, 400);
});

test('titles: one short title per sentence, unknown ids and punctuation dropped', async () => {
  let body;
  fakeAI({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({ items: [{ id: 'a', title: ' “고슴도치 찾기.” ' }, { id: 'b', title: '' }, { id: 'zzz', title: '남의 것' }] }) }], usage: { input_tokens: 50, output_tokens: 9 } },
    (url, init) => { body = JSON.parse(init.body); });
  const res = await call({ book: '어떻게 살아낼 것인가', items: [{ id: 'a', text: '고슴도치를 찾는 과정' }, { id: 'b', text: '절벽' }] }, { path: '/ai/titles' });
  assert.equal(res.status, 200);
  const out = await res.json();
  assert.deepEqual(out.items, [{ id: 'a', title: '고슴도치 찾기' }]);
  assert.deepEqual(out.usage, { input: 50, output: 9 });
  assert.equal(body.output_config.format.type, 'json_schema');
  assert.match(body.messages[0].content, /어떻게 살아낼 것인가/);
  assert.equal((await call({ items: [] }, { path: '/ai/titles' })).status, 400);
  assert.equal((await call({ items: [{ id: 'a', text: 'x' }] }, { path: '/ai/titles', origin: 'https://evil.example' })).status, 403);
});

test('tags: short gist per record, and a bite for the record just fed', async () => {
  let body;
  fakeAI({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({ items: [{ id: 'a', tags: ['출근'], gist: ' “혼자 걷는 출근길.” ' }, { id: 'b', tags: [], gist: '회의 뒤 피곤' }], bite: ' 출근길 얘기가 또 나왔네. ' }) }], usage: { input_tokens: 60, output_tokens: 30 } },
    (url, init) => { body = JSON.parse(init.body); });
  const res = await call({ items: [{ id: 'a', text: '혼자 걷는 출근길이 좋았다' }, { id: 'b', text: '회의 끝나면 피곤' }], fresh: 'a', name: '뚱이', tone: 'you' });
  const out = await res.json();
  assert.deepEqual(out.items.map(x => x.gist), ['혼자 걷는 출근길', '회의 뒤 피곤']);
  assert.equal(out.bite, '출근길 얘기가 또 나왔네.');
  assert.match(body.system, /id a/);
  assert.match(body.system, /뚱이/);
  assert.deepEqual(body.output_config.format.schema.required, ['items', 'bite']);
  // 모르는 id를 fresh로 보내면 한마디를 청하지 않고, 와도 버립니다
  await call({ items: [{ id: 'a', text: 'x' }], fresh: 'zzz' });
  assert.match(body.system, /bite는 빈 문자열/);
});

test('links: up to two known, distinct records with a short why', async () => {
  let body;
  fakeAI({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({ items: [{ id: 'b', why: ' 둘 다 혼자일 때 기운이 났다는 얘기 ' }, { id: 'b', why: '중복' }, { id: 'zzz', why: '모르는 것' }, { id: 'c', why: '' }, { id: 'd', why: '셋째' }] }) }], usage: { input_tokens: 80, output_tokens: 20 } },
    (url, init) => { body = JSON.parse(init.body); });
  const res = await call({ fresh: { id: 'a', text: '혼자 산책할 때 기운이 난다' }, candidates: [{ id: 'b', date: '10월 3일', text: '생각: 혼자 걷는 출근길이 좋았다' }, { id: 'c', text: '메모: 회의 뒤 피곤' }, { id: 'd', text: '질문: 왜 혼자일 때' }] }, { path: '/ai/links' });
  assert.equal(res.status, 200);
  const out = await res.json();
  assert.deepEqual(out.items, [{ id: 'b', why: '둘 다 혼자일 때 기운이 났다는 얘기' }, { id: 'c', why: '' }]);
  assert.match(body.messages[0].content, /혼자 산책할 때/);
  assert.match(body.system, /같은 낱말이 나온다는 것만으로는/);
  assert.equal((await call({ fresh: { id: 'a', text: 'x' }, candidates: [] }, { path: '/ai/links' })).status, 400);
  assert.equal((await call({ fresh: { id: 'a', text: 'x' }, candidates: [{ id: 'a', text: '자기 자신' }] }, { path: '/ai/links' })).status, 400);
  assert.equal((await call({ fresh: { id: 'a', text: 'x' }, candidates: [{ id: 'b', text: 'y' }] }, { path: '/ai/links', origin: 'https://evil.example' })).status, 403);
});

test('know: rewrites notes about me from new records, drops removed items and unknown sources', async () => {
  let body;
  fakeAI({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({ items: [
    { cat: '기준', text: ' 정해진 길이 있으면 편하다고 느낌 ', src: ['r1', 'zzz', 'p1'] },
    { cat: '이상한갈래', text: '요즘 부채가 마음에 걸림', src: ['r2'] },
    { cat: '관심사', text: '독서', src: [] },
    { cat: '고민', text: '게으름', src: ['r1'] } ] }) }], usage: { input_tokens: 300, output_tokens: 80 } }, (url, init) => { body = JSON.parse(init.body); });
  const res = await call({ items: [{ cat: '관심사', text: '산책', src: ['p1'] }], records: [{ id: 'r1', date: '10월 3일', kind: '생각', text: '정해진 길이면 편해' }, { id: 'r2', kind: '메모', text: '부채라는 절벽' }], removed: ['게으름'] }, { path: '/ai/know' });
  assert.equal(res.status, 200);
  const out = await res.json();
  assert.deepEqual(out.items, [
    { cat: '기준', text: '정해진 길이 있으면 편하다고 느낌', src: ['r1', 'p1'] },   // 모르는 근거 버림, 예전 메모의 근거는 둠
    { cat: '요즘', text: '요즘 부채가 마음에 걸림', src: ['r2'] },              // 모르는 갈래는 '요즘'
    { cat: '관심사', text: '독서', src: [] } ]);                                 // 내가 지운 '게으름'은 다시 안 씀
  const sent = JSON.parse(body.messages[0].content);
  assert.deepEqual(sent.지운_것, ['게으름']);
  assert.equal(sent.예전_메모[0].text, '산책');
  assert.match(body.system, /진단하거나 평가하지 마세요/);
  assert.equal((await call({ items: [], records: [] }, { path: '/ai/know' })).status, 400);
  assert.equal((await call({ records: Array.from({ length: 81 }, (_, i) => ({ id: 'x' + i, text: 't' })) }, { path: '/ai/know' })).status, 400);
});
