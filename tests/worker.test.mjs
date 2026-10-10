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
  assert.deepEqual(out.items, [{ id: 'a', tags: ['회의', '기운', '일'] }]);   // 중복·공백·긴 말 정리, 모르는 id 버림
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

test('reflect: speaks as the slime, keeps only known ids, trims lengths', async () => {
  let body;
  fakeAI({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({ lines: [{ text: '9월엔 우리 회의 끝나고 지쳤다고 했는데, 요즘은 회의 얘기가 없네. 그사이 뭐가 달라졌을까?', ids: ['t1', 'nope'] }, { text: '   ', ids: [] }], question: '오늘 기운이 났던 순간은 어땠어?' }) }] },
    (url, init) => { body = JSON.parse(init.body); });
  const items = [{ id: 't1', date: '2026-09-20', kind: '생각', text: '회의만 끝나면 기운이 빠진다', tags: ['회의'] }, { id: 't2', date: '2026-10-03', kind: '생각', text: '리더십', tags: [] }, { id: 't3', date: '2026-10-08', kind: '답', text: '쇼츠', tags: [] }];
  const res = await call({ name: '말랑', tone: 'we', today: '2026-10-11', items }, { path: '/ai/reflect' });
  assert.equal(res.status, 200);
  const out = await res.json();
  assert.equal(out.lines.length, 1);
  assert.deepEqual(out.lines[0].ids, ['t1']);
  assert.equal(out.question, '오늘 기운이 났던 순간은 어땠어?');
  assert.match(body.system, /말랑/); assert.match(body.system, /우리/);
  assert.equal(body.output_config.effort, 'medium');
});

test('reflect: needs at least 3 records and an allowed site', async () => {
  fakeAI({});
  assert.equal((await call({ items: [{ id: 'a', text: 'x' }] }, { path: '/ai/reflect' })).status, 400);
  assert.equal((await call({ items: [1, 2, 3].map(i => ({ id: 'a' + i, text: 'x' })) }, { path: '/ai/reflect', origin: 'https://evil.example' })).status, 403);
});
