/* 나만의 슬라임 만들기 — 중계소 (Cloudflare Workers)
 *
 * 앱(index.html)은 여기로만 말을 겁니다. 열쇠는 이 안에만 있고 앱에는 들어가지 않습니다.
 * 열쇠는 코드에 적지 말고 Cloudflare의 Settings → Variables and Secrets 에 넣으세요.
 *   KAKAO_KEY      — 책 검색 (카카오 REST API 키)
 *   ANTHROPIC_KEY  — 슬라임이 기록 읽기 (Anthropic API 키)
 *
 * GET  /?q=독서의 기술   → 책 검색. [{ title, authors, publisher, cover, isbn }, ...]
 * POST /ai/tags          → 기록마다 주제어 1~3개. { items: [{ id, text }], known: [주제어] } → { items: [{ id, tags }] }
 * POST /ai/reflect       → 하루 한 번: '그땐/지금은/그사이' 말 몇 줄과 오늘의 질문 하나
 *                          { name, tone, today, items: [{ id, date, kind, text, tags }] } → { lines: [{ text, ids }], question }
 * GET  /ai/health        → 열쇠가 들어 있는지만 알려 줌 (열쇠 값은 절대 내보내지 않음)
 *
 * 이 중계소는 기록을 저장하지 않습니다. 받은 글을 AI에 넘기고 답만 돌려줍니다.
 */

// 이 주소에서 오는 요청만 받습니다. 앱 주소가 바뀌면 여기를 고치세요.
const ALLOWED = [
  'https://xldkfwl231-create.github.io',
  'http://127.0.0.1:4173',   // npm start 로 PC에서 시험할 때
  'http://localhost:4173',
];

const MODEL = 'claude-haiku-5-5';
const MAX_ITEMS = 30, MAX_TEXT = 1500, MAX_KNOWN = 80;

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const allow = ALLOWED.includes(origin) ? origin : ALLOWED[0];
    const cors = {
      'Access-Control-Allow-Origin': allow,
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Content-Type': 'application/json; charset=utf-8',
      'Vary': 'Origin',
    };
    const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: cors });

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: { ...cors, 'Access-Control-Max-Age': '86400' } });
    }

    const path = new URL(request.url).pathname.replace(/\/+$/, '');
    if (path === '/ai/health') return json({ ok: true, key: !!env.ANTHROPIC_KEY, model: MODEL });
    if (path === '/ai/tags') {
      if (request.method !== 'POST') return json({ error: 'POST만 받습니다' }, 405);
      if (!ALLOWED.includes(origin)) return json({ error: '허용되지 않은 주소입니다' }, 403);
      if (!env.ANTHROPIC_KEY) return json({ error: 'ANTHROPIC_KEY가 설정되지 않았습니다' }, 503);
      return tags(request, env, json);
    }
    if (path === '/ai/reflect') {
      if (request.method !== 'POST') return json({ error: 'POST만 받습니다' }, 405);
      if (!ALLOWED.includes(origin)) return json({ error: '허용되지 않은 주소입니다' }, 403);
      if (!env.ANTHROPIC_KEY) return json({ error: 'ANTHROPIC_KEY가 설정되지 않았습니다' }, 503);
      return reflect(request, env, json);
    }
    return bookSearch(request, env, cors);
  },
};

// ── 슬라임이 기록 읽기: 주제어 뽑기 ─────────────────────────────
async function tags(request, env, json) {
  let body;
  try { body = await request.json(); } catch { return json({ error: '형식이 올바르지 않습니다' }, 400); }
  const items = Array.isArray(body?.items) ? body.items : null;
  if (!items || !items.length || items.length > MAX_ITEMS) return json({ error: `기록은 1~${MAX_ITEMS}개씩 보내 주세요` }, 400);
  const clean = [];
  for (const it of items) {
    if (typeof it?.id !== 'string' || it.id.length > 100 || typeof it?.text !== 'string' || !it.text.trim()) return json({ error: '기록 형식이 올바르지 않습니다' }, 400);
    clean.push({ id: it.id, text: it.text.slice(0, MAX_TEXT) });
  }
  const known = (Array.isArray(body.known) ? body.known : []).filter(t => typeof t === 'string' && t.length <= 12).slice(0, MAX_KNOWN);

  const system = [
    '당신은 한 사람이 자기 자신에 대해 적은 짧은 기록을 읽고, 기록마다 주제어를 붙이는 도우미입니다.',
    '규칙:',
    '- 기록마다 주제어 1~3개. 2~6글자의 한국어 명사. 예: 회의, 기운, 리더십, 혼자, 쇼츠, 운동, 일, 사람, 독서',
    '- 그 기록에 실제로 나온 내용만. 짐작하거나 확대하지 마세요.',
    '- 사람을 평가하거나 진단하는 말은 쓰지 마세요. 예: 내향적, 게으름, 우울, 문제, 성공',
    '- "이미 쓰는 주제어" 목록에 뜻이 같은 단어가 있으면 그 단어를 그대로 쓰세요. 비슷한 말을 새로 만들지 마세요.',
    '- 모든 기록의 id를 빠짐없이 그대로 돌려주세요.',
  ].join('\n');
  const user = JSON.stringify({ '이미 쓰는 주제어': known, '기록': clean });

  let res;
  try {
    res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': env.ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 4000,
        system,
        messages: [{ role: 'user', content: user }],
        output_config: {
          effort: 'low',
          format: {
            type: 'json_schema',
            schema: {
              type: 'object',
              properties: {
                items: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: { id: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } } },
                    required: ['id', 'tags'],
                    additionalProperties: false,
                  },
                },
              },
              required: ['items'],
              additionalProperties: false,
            },
          },
        },
      }),
    });
  } catch {
    return json({ error: 'AI 서버에 닿지 못했습니다' }, 502);
  }
  if (!res.ok) return json({ error: 'AI 요청 실패', status: res.status }, 502);
  const data = await res.json();
  if (data.stop_reason === 'refusal') return json({ error: 'AI가 이 기록을 처리하지 않았습니다' }, 422);
  if (data.stop_reason === 'max_tokens') return json({ error: '한 번에 너무 많이 보냈습니다' }, 413);
  const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  let out;
  try { out = JSON.parse(text); } catch { return json({ error: 'AI 답을 읽지 못했습니다' }, 502); }
  const ids = new Set(clean.map(c => c.id));
  const result = (out.items || [])
    .filter(it => ids.has(it.id) && Array.isArray(it.tags))
    .map(it => ({ id: it.id, tags: [...new Set(it.tags.filter(t => typeof t === 'string').map(t => t.trim()).filter(t => t && t.length <= 12))].slice(0, 3) }));
  return json({ items: result, model: MODEL, usage: data.usage ? { input: data.usage.input_tokens, output: data.usage.output_tokens } : undefined });
}

// ── AI 부르기 (공통) ───────────────────────────────────────────
async function askClaude(env, { system, user, schema, effort = 'low', maxTokens = 4000 }) {
  let res;
  try {
    res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': env.ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }], output_config: { effort, format: { type: 'json_schema', schema } } }),
    });
  } catch { return { error: ['AI 서버에 닿지 못했습니다', 502] }; }
  if (!res.ok) return { error: ['AI 요청 실패 ' + res.status, 502] };
  const data = await res.json();
  if (data.stop_reason === 'refusal') return { error: ['AI가 이 기록을 처리하지 않았습니다', 422] };
  if (data.stop_reason === 'max_tokens') return { error: ['한 번에 너무 많이 보냈습니다', 413] };
  const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  try { return { out: JSON.parse(text), usage: data.usage ? { input: data.usage.input_tokens, output: data.usage.output_tokens } : undefined }; }
  catch { return { error: ['AI 답을 읽지 못했습니다', 502] }; }
}

// ── 슬라임의 하루 말: '그땐 / 지금은 / 그사이' + 오늘의 질문 ─────────────
const MAX_REFLECT_ITEMS = 60, MAX_REFLECT_TEXT = 400;
async function reflect(request, env, json) {
  let body;
  try { body = await request.json(); } catch { return json({ error: '형식이 올바르지 않습니다' }, 400); }
  const items = Array.isArray(body?.items) ? body.items : null;
  if (!items || items.length < 3 || items.length > MAX_REFLECT_ITEMS) return json({ error: `기록은 3~${MAX_REFLECT_ITEMS}개 보내 주세요` }, 400);
  const clean = [];
  for (const it of items) {
    if (typeof it?.id !== 'string' || it.id.length > 100 || typeof it?.text !== 'string' || !it.text.trim()) return json({ error: '기록 형식이 올바르지 않습니다' }, 400);
    clean.push({ id: it.id, date: String(it.date || '').slice(0, 10), kind: String(it.kind || '').slice(0, 10), text: it.text.slice(0, MAX_REFLECT_TEXT), tags: (Array.isArray(it.tags) ? it.tags : []).filter(t => typeof t === 'string').slice(0, 3) });
  }
  const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim().slice(0, 30) : '슬라임';
  const tone = body.tone === 'you' ? 'you' : 'we';
  const today = typeof body.today === 'string' ? body.today.slice(0, 10) : '';

  const system = [
    `당신은 "${name}"라는 이름의 작은 슬라임입니다. 한 사람이 자기 자신에 대해 적은 기록을 오래 지켜봐 왔습니다.`,
    '이 사람은 자신을 판단 없이, 본 대로 관찰하는 연습(짐 콜린스의 "버그북")을 하고 있습니다. 당신은 그 관찰을 돕는 거울입니다.',
    '',
    '할 일: 기록을 읽고 (1) 이 사람에게 건넬 짧은 말 2~4줄, (2) 오늘 물어볼 질문 1개를 만드세요.',
    '',
    '말(lines) 규칙:',
    '- 시간에 따라 달라진 게 보이면 "그땐 / 지금은 / 그사이"의 흐름으로 말하세요. 예: "9월엔 회의가 끝나면 기운이 빠진다고 했는데, 요즘은 회의 얘기가 없네. 그사이 뭐가 달라졌을까?"',
    '- 달라진 게 없으면 요즘 자주 돌아오는 말을 짚으세요. 예: "요즘 \'혼자\'라는 말이 세 번 나왔어."',
    '- 이 사람이 실제로 쓴 말을 짧게 따옴표로 인용하세요. 기록에 없는 일을 지어내지 마세요.',
    '- 평가하거나 진단하거나 결론 내리지 마세요. "너는 내향적이야", "좋아졌네", "문제야" 같은 말 금지. 조언도 하지 마세요.',
    '- 맞는지 확인하는 질문("맞아?")이 아니라, 그사이의 마음을 궁금해하는 말로 끝내도 좋습니다.',
    '- 한 줄은 80자 이내. 다정한 반말.',
    tone === 'we'
      ? '- 당신과 이 사람은 하나입니다. "우리"라고 말하세요. 예: "9월엔 우리 회의 끝나고 지쳤다고 했는데…"'
      : '- 이 사람을 "너"라고 부르세요. 예: "9월엔 너 회의 끝나고 지쳤다고 했는데…"',
    '- 각 줄에는 근거가 된 기록의 id를 ids에 넣으세요.',
    '',
    '질문(question) 규칙:',
    '- 최근 기록에서 이어지는, 오늘 하루를 돌아보게 하는 열린 질문 하나. 예/아니오로 답할 수 없게.',
    '- 50자 이내. 다정한 반말. 판단 금지.',
    '- 같은 말을 되풀이하지 말고, 최근 기록에서 아직 묻지 않은 쪽을 물으세요.',
  ].join('\n');
  const user = JSON.stringify({ 오늘: today, 기록: clean });
  const schema = {
    type: 'object',
    properties: {
      lines: { type: 'array', items: { type: 'object', properties: { text: { type: 'string' }, ids: { type: 'array', items: { type: 'string' } } }, required: ['text', 'ids'], additionalProperties: false } },
      question: { type: 'string' },
    },
    required: ['lines', 'question'],
    additionalProperties: false,
  };
  const r = await askClaude(env, { system, user, schema, effort: 'medium', maxTokens: 6000 });
  if (r.error) return json({ error: r.error[0] }, r.error[1]);
  const ids = new Set(clean.map(c => c.id));
  const lines = (Array.isArray(r.out.lines) ? r.out.lines : [])
    .filter(l => typeof l?.text === 'string' && l.text.trim())
    .map(l => ({ text: l.text.trim().slice(0, 120), ids: (Array.isArray(l.ids) ? l.ids : []).filter(id => ids.has(id)).slice(0, 5) }))
    .slice(0, 4);
  const question = typeof r.out.question === 'string' ? r.out.question.trim().slice(0, 80) : '';
  return json({ lines, question, model: MODEL, usage: r.usage });
}

// ── 책 검색 (카카오) ────────────────────────────────────────────
async function bookSearch(request, env, cors) {
  const q = (new URL(request.url).searchParams.get('q') || '').trim();
  if (!q) return new Response('[]', { headers: cors });

  // 같은 검색어는 하루 동안 캐시에서 꺼내 씁니다 — 카카오 호출을 아낍니다.
  const cacheKey = new Request('https://cache/book?q=' + encodeURIComponent(q));
  const cached = await caches.default.match(cacheKey);
  if (cached) return new Response(await cached.text(), { headers: cors });

  let res;
  try {
    res = await fetch(
      'https://dapi.kakao.com/v3/search/book?target=title&size=10&query=' + encodeURIComponent(q),
      { headers: { Authorization: 'KakaoAK ' + env.KAKAO_KEY } }
    );
  } catch (e) {
    return new Response(JSON.stringify({ error: '검색 서버에 닿지 못했습니다' }), { status: 502, headers: cors });
  }
  if (!res.ok) return new Response(JSON.stringify({ error: '검색 실패', status: res.status }), { status: 502, headers: cors });

  const data = await res.json();
  const books = (data.documents || []).map(d => ({
    title: d.title,
    authors: (d.authors || []).join(', '),
    publisher: d.publisher,
    cover: d.thumbnail,          // 표지 이미지 주소
    isbn: (d.isbn || '').split(' ').pop(),
  }));
  const body = JSON.stringify(books);
  await caches.default.put(cacheKey, new Response(body, { headers: { ...cors, 'Cache-Control': 'public, max-age=86400' } }));
  return new Response(body, { headers: cors });
}
