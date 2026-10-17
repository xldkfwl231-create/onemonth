/* 나만의 슬라임 만들기 — 중계소 (Cloudflare Workers)
 *
 * 앱(index.html)은 여기로만 말을 겁니다. 열쇠는 이 안에만 있고 앱에는 들어가지 않습니다.
 * 열쇠는 코드에 적지 말고 Cloudflare의 Settings → Variables and Secrets 에 넣으세요.
 *   KAKAO_KEY      — 책 검색 (카카오 REST API 키)
 *   ANTHROPIC_KEY  — 슬라임이 기록 읽기 (Anthropic API 키)
 *
 * GET  /?q=독서의 기술   → 책 검색. [{ title, authors, publisher, cover, isbn }, ...]
 * POST /ai/tags          → 기록마다 주제어 1~3개. { items: [{ id, text }], known: [주제어] } → { items: [{ id, tags }] }
 * POST /ai/chat          → 슬라임과 이야기(토론). { name, tone, topic, memory: [{ date, kind, text }], messages: [{ role, text }] } → { reply, next: [이어서 꺼낼 말] }
 *                          memory = 이 사람이 앱에 남긴 것들 — 슬라임은 이걸 기억으로 삼아 이야기합니다
 * POST /ai/summary       → 책 한 권 정리. { name, tone, book, entries: [{ id, page, note, more, talk }], questions: [{ id, text, answer, history, talk }], talk }
 *                          → { line, held: [{ id, why }], open: [{ id, why }], changed: [{ id, then, now }] }  (책에서 옮겨 적은 문장은 받지 않음)
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
    if (path === '/ai/chat') {
      if (request.method !== 'POST') return json({ error: 'POST만 받습니다' }, 405);
      if (!ALLOWED.includes(origin)) return json({ error: '허용되지 않은 주소입니다' }, 403);
      if (!env.ANTHROPIC_KEY) return json({ error: 'ANTHROPIC_KEY가 설정되지 않았습니다' }, 503);
      return chat(request, env, json);
    }
    if (path === '/ai/summary') {
      if (request.method !== 'POST') return json({ error: 'POST만 받습니다' }, 405);
      if (!ALLOWED.includes(origin)) return json({ error: '허용되지 않은 주소입니다' }, 403);
      if (!env.ANTHROPIC_KEY) return json({ error: 'ANTHROPIC_KEY가 설정되지 않았습니다' }, 503);
      return summary(request, env, json);
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
async function askClaude(env, { system, user, messages, schema, effort = 'low', maxTokens = 4000 }) {
  let res;
  try {
    res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': env.ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, system, messages: messages || [{ role: 'user', content: user }], output_config: schema ? { effort, format: { type: 'json_schema', schema } } : { effort } }),
    });
  } catch { return { error: ['AI 서버에 닿지 못했습니다', 502] }; }
  if (!res.ok) return { error: ['AI 요청 실패 ' + res.status, 502] };
  const data = await res.json();
  if (data.stop_reason === 'refusal') return { error: ['AI가 이 기록을 처리하지 않았습니다', 422] };
  if (data.stop_reason === 'max_tokens') return { error: ['한 번에 너무 많이 보냈습니다', 413] };
  const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  if (!schema) return { text, usage: data.usage ? { input: data.usage.input_tokens, output: data.usage.output_tokens } : undefined };
  try { return { out: JSON.parse(text), usage: data.usage ? { input: data.usage.input_tokens, output: data.usage.output_tokens } : undefined }; }
  catch { return { error: ['AI 답을 읽지 못했습니다', 502] }; }
}

// ── 책 한 권 정리: 붙든 문장 · 아직 답 못 한 질문 · 그사이 바뀐 생각 ─────────────
// 책에서 옮겨 적은 문장은 받지 않습니다. 이 사람이 쓴 말(메모 · 덧붙임 · 질문 · 답 · 이야기)만으로 정리하고,
// 문장은 id로만 가리킵니다 — 앱이 자기 기기에 있는 문장을 꺼내 보여 줍니다.
const MAX_SUM_ENTRIES = 80, MAX_SUM_QUESTIONS = 60, MAX_SUM_TEXT = 400, MAX_SUM_LIST = 10;
async function summary(request, env, json) {
  let body;
  try { body = await request.json(); } catch { return json({ error: '형식이 올바르지 않습니다' }, 400); }
  const str = (v, n = MAX_SUM_TEXT) => typeof v === 'string' ? v.slice(0, n) : '';
  const list = v => (Array.isArray(v) ? v : []).filter(x => typeof x === 'string' && x.trim()).slice(-MAX_SUM_LIST).map(x => x.slice(0, MAX_SUM_TEXT));
  const id = v => typeof v === 'string' && v && v.length <= 100 ? v : null;
  if (!Array.isArray(body?.entries) || !Array.isArray(body?.questions) || body.entries.length > MAX_SUM_ENTRIES || body.questions.length > MAX_SUM_QUESTIONS) return json({ error: '책 기록 형식이 올바르지 않습니다' }, 400);
  const entries = body.entries.map(e => ({ id: id(e?.id), page: str(e?.page, 20), note: str(e?.note), more: list(e?.more), talk: list(e?.talk) })).filter(e => e.id);
  const questions = body.questions.map(q => ({ id: id(q?.id), text: str(q?.text), answer: str(q?.answer), history: list(q?.history), talk: list(q?.talk) })).filter(q => q.id && q.text);
  const talk = list(body.talk);
  const words = entries.some(e => e.note || e.more.length || e.talk.length) || questions.length || talk.length;
  if (!words) return json({ error: '정리할 내 말이 아직 없습니다' }, 400);
  const name = str(body.name, 30).trim() || '슬라임', tone = body.tone === 'you' ? 'you' : 'we';
  const book = { title: str(body.book?.title, 200), author: str(body.book?.author, 100) };
  const system = [
    `당신은 "${name}"라는 이름의 작은 슬라임입니다. 이 사람이 책 한 권을 읽으며 남긴 자기 말을 모아 정리해 줍니다.`,
    '받는 것: 문장마다 이 사람이 단 메모(note)와 덧붙인 말(more), 그 문장으로 나눈 이야기에서 이 사람이 한 말(talk), 이 사람이 쓴 질문과 지금의 답(answer)·예전 답(history). 책 문장 자체는 받지 않습니다.',
    '',
    '만들 것:',
    '- line: 이 책이 이 사람에게 남긴 것을 한 줄로. 이 사람이 쓴 말에 기대어. 80자 이내.',
    '- held: 이 사람이 가장 오래, 많이 붙든 문장 최대 5개 (entries의 id). why에는 왜 붙들었는지를 이 사람의 말로 60자 이내.',
    '- open: 아직 답을 못 했거나 답이 흔들리는 질문 최대 5개 (questions의 id). why에는 무엇이 아직 열려 있는지 60자 이내.',
    '- changed: 그사이 바뀐 생각 최대 4개. 반드시 한 기록 안에서만 찾으세요: 같은 질문의 예전 답(history) → 지금의 답(answer), 같은 문장의 메모(note) → 덧붙인 말(more), 같은 기록으로 나눈 이야기(talk)의 앞 → 뒤. id에는 그 기록(entries 또는 questions)의 id. then(그땐)과 now(지금은)는 각각 80자 이내.',
    '- 서로 다른 기록의 말을 짝짓지 마세요. 생각이 실제로 달라진 게 아니면 넣지 마세요. 바뀐 게 없으면 빈 목록.',
    '',
    '규칙:',
    '- 기록에 없는 일을 지어내지 마세요. 이 사람이 쓴 말을 짧게 인용해도 좋습니다.',
    '- 이 사람을 평가하거나 진단하지 마세요. 조언도 하지 마세요. 본 대로만.',
    '- 다정한 반말로, 이 사람에게 직접 말하듯 쓰세요. "~했대", "~래", "이 사람은"처럼 남 얘기하듯 쓰지 마세요.',
    tone === 'we' ? '- 당신과 이 사람은 하나입니다. 주어는 "우리"로. 예: "우리는 보기 전에 결론부터 내는 편이라는 걸 봤어."' : '- 이 사람을 "너"라고 부르세요. 예: "너는 보기 전에 결론부터 내는 편이라는 걸 봤어."',
    '- id는 받은 것 중에서만 고르세요.',
  ].join('\n');
  const user = JSON.stringify({ 책: book, 문장들: entries, 질문들: questions, 책_이야기: talk });
  const schema = {
    type: 'object',
    properties: {
      line: { type: 'string' },
      held: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, why: { type: 'string' } }, required: ['id', 'why'], additionalProperties: false } },
      open: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, why: { type: 'string' } }, required: ['id', 'why'], additionalProperties: false } },
      changed: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, then: { type: 'string' }, now: { type: 'string' } }, required: ['id', 'then', 'now'], additionalProperties: false } },
    },
    required: ['line', 'held', 'open', 'changed'],
    additionalProperties: false,
  };
  const r = await askClaude(env, { system, user, schema, effort: 'medium', maxTokens: 6000 });
  if (r.error) return json({ error: r.error[0] }, r.error[1]);
  const eIds = new Set(entries.map(e => e.id)), qIds = new Set(questions.map(q => q.id)), o = r.out || {};
  const pick = (v, ok) => (Array.isArray(v) ? v : []).filter(x => typeof x?.id === 'string' && ok.has(x.id)).filter((x, i, a) => a.findIndex(y => y.id === x.id) === i).slice(0, 5).map(x => ({ id: x.id, why: str(x.why, 120).trim() }));
  return json({
    line: str(o.line, 160).trim(),
    held: pick(o.held, eIds), open: pick(o.open, qIds),
    changed: (Array.isArray(o.changed) ? o.changed : []).filter(c => typeof c?.then === 'string' && typeof c?.now === 'string' && c.then.trim() && c.now.trim() && (eIds.has(c.id) || qIds.has(c.id)) && c.then.trim() !== c.now.trim()).slice(0, 4).map(c => ({ id: c.id, then: c.then.trim().slice(0, 160), now: c.now.trim().slice(0, 160) })),
    model: MODEL, usage: r.usage,
  });
}

// ── 슬라임과 이야기 (토론) ──────────────────────────────────────
const MAX_TURNS = 40, MAX_TURN_TEXT = 1500, MAX_MEMORY = 60, MAX_MEMORY_TEXT = 400;
async function chat(request, env, json) {
  let body;
  try { body = await request.json(); } catch { return json({ error: '형식이 올바르지 않습니다' }, 400); }
  const msgs = Array.isArray(body?.messages) ? body.messages.slice(-MAX_TURNS) : null;
  if (!msgs || !msgs.length) return json({ error: '대화가 비어 있습니다' }, 400);
  const clean = [];
  for (const m of msgs) {
    if (!['user', 'assistant'].includes(m?.role) || typeof m.text !== 'string' || !m.text.trim()) return json({ error: '대화 형식이 올바르지 않습니다' }, 400);
    const last = clean[clean.length - 1];
    if (last && last.role === m.role) last.content += '\n\n' + m.text.slice(0, MAX_TURN_TEXT);   // 같은 쪽 말이 이어지면 합침
    else clean.push({ role: m.role, content: m.text.slice(0, MAX_TURN_TEXT) });
  }
  while (clean.length && clean[0].role !== 'user') clean.shift();
  if (!clean.length || clean[clean.length - 1].role !== 'user') return json({ error: '마지막 말은 사람이 해야 합니다' }, 400);

  const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim().slice(0, 30) : '슬라임';
  const tone = body.tone === 'you' ? 'you' : 'we';
  const t = body.topic && typeof body.topic === 'object' ? body.topic : {};
  const topic = {
    kind: ['book', 'thought', 'free'].includes(t.kind) ? t.kind : 'free',
    title: typeof t.title === 'string' ? t.title.slice(0, 200) : '',
    author: typeof t.author === 'string' ? t.author.slice(0, 100) : '',
    notes: (Array.isArray(t.notes) ? t.notes : []).filter(n => typeof n === 'string').slice(0, 20).map(n => n.slice(0, 400)),
  };
  // 기억 — 이 사람이 이 앱에 남긴 것들 (오래된 것부터). 슬라임은 이걸 바탕으로 이어 말합니다.
  const memory = (Array.isArray(body.memory) ? body.memory : []).slice(-MAX_MEMORY)
    .filter(m => typeof m?.text === 'string' && m.text.trim())
    .map(m => `- ${typeof m.date === 'string' && m.date ? `[${m.date.slice(0, 20)}] ` : ''}${typeof m.kind === 'string' ? m.kind.slice(0, 40) + ': ' : ''}${m.text.slice(0, MAX_MEMORY_TEXT).replace(/\s+/g, ' ')}`);
  const about = topic.kind === 'book' ? `책 『${topic.title}』${topic.author ? `(${topic.author})` : ''}` : topic.kind === 'thought' ? '이 사람이 적어 둔 생각 하나' : '이 사람이 꺼내는 이야기';
  const system = [
    `당신은 "${name}"라는 이름의 작은 슬라임입니다. 이 사람이 적는 기록을 오래 지켜봐 온 친구이고, 지금은 ${about}에 대해 함께 이야기합니다.`,
    '',
    '대화 방식:',
    '- 당신은 맞장구 상대가 아니라 생각을 함께 밀고 나가는 상대입니다. 이 사람이 스스로 미처 못 본 쪽을 보여 주는 것이 당신의 일입니다.',
    '- 답마다 실제로 보태는 것을 꼭 하나 넣으세요. 아래 가운데 지금 말에 가장 쓸모 있는 하나를 고릅니다.',
    '  반대쪽 생각: 이 사람의 결론과 다르게 볼 근거',
    '  숨은 전제: 이 말이 당연하게 깔고 있는 가정',
    '  구체적인 예: 막연한 말을 실제 장면으로',
    '  그땐과 지금: 기억 속 예전 말과 지금 말이 어긋나는 곳',
    '  책의 관점: 이 책이나 널리 알려진 생각이 이 문제를 보는 방식 (확실히 아는 것만)',
    '- "맞아", "좋은 생각이야", "그럴 수 있어", "충분히 이해해"처럼 빈 동의로 시작하지 마세요. 정말 동의하면 왜 동의하는지 이유를 대고, 그다음 한 걸음 더 나가세요.',
    '- 이 사람의 말을 그대로 되풀이하거나 다른 말로 바꿔 돌려주지 마세요.',
    '- 생각과 의견에는 솔직하게 반대해도 됩니다. 하지만 이 사람 자체를 평가하거나 진단하지는 마세요. ("너는 ~한 사람이야" 금지)',
    '- 짧게. 2~5문장. 다정하지만 무르지 않은 반말.',
    tone === 'we' ? '- 당신과 이 사람은 하나라서 이 사람을 "우리"라고 부르기도 합니다. 그래도 한 마음 안에 여러 목소리가 있듯, 당신은 우리 안의 다른 쪽 목소리입니다. 하나라는 이유로 동의하지 마세요.' : '- 이 사람을 "너"라고 부르세요.',
    '- 질문하는 사람은 이 사람입니다. reply에서는 되묻지 말고 물음표로 끝내지 마세요. "궁금해", "어때?", "왜일까?"처럼 되묻는 말도 하지 마세요.',
    '- 대신 next에 이 사람이 이어서 꺼낼 만한 말을 2~3개 적으세요. 이 사람의 목소리(나를 주어로 한 반말)로, 20자 안팎으로 짧게. 서로 다른 방향이어야 합니다. 예: 방금 말에 반박해 보기, 내 경험으로 구체화하기, 책이나 예전 기록과 견주기, 지금까지를 한 줄로 정리하기.',
    '- 이 사람이 한 말의 뜻을 정말 알 수 없을 때만 짧게 확인해도 됩니다.',
    '- 책에 대해 확실히 아는 내용은 관점으로 꺼내도 됩니다. 확실하지 않으면 아는 척하지 말고 그렇다고 말하세요.',
    '- 건강·법률·돈처럼 전문 판단이 필요한 이야기는 전문가에게 묻기를 권하세요.',
    '- 마크다운 기호(#, *, -)를 쓰지 말고 말하듯 쓰세요.',
    '',
    '배경 (이 사람이 직접 적은 것):',
    JSON.stringify(topic),
    ...(memory.length ? [
      '',
      '기억 (이 사람이 이 앱에 지금까지 남긴 것 — 생각, 메모, 질문과 답, 다른 이야기에서 한 말):',
      ...memory,
      '',
      '기억 쓰는 법:',
      '- 당신은 이 기억을 모두 알고 있는 슬라임입니다. 지금 말과 어긋나는 예전 말이 있으면 그것부터 꺼내세요. 예: "10월 3일엔 아침 산책이 좋다고 했는데, 지금은 아침이 버겁다고 하네."',
      '- 지금 말과 같은 예전 말을 꺼내 맞다고 확인해 주는 데만 쓰지 마세요. 같은 말이 되풀이되고 있다면, 되풀이된다는 사실 자체를 짚으세요.',
      '- 기억에 없는 일을 지어내지 마세요. 날짜와 말은 적힌 그대로만 쓰세요.',
      '- 기억을 늘어놓지 말고, 지금 말과 닿는 것 한두 개만.',
      '- "기억이 안 난다"고 할 필요가 있으면 솔직하게 말하세요.',
    ] : []),
  ].join('\n');
  // reply: 슬라임의 말 · next: 이 사람이 이어서 꺼낼 만한 말 (앱에서 단추로 보여 줍니다)
  const schema = { type: 'object', properties: { reply: { type: 'string' }, next: { type: 'array', items: { type: 'string' } } }, required: ['reply', 'next'], additionalProperties: false };
  const r = await askClaude(env, { system, messages: clean, schema, effort: 'medium', maxTokens: 3000 });
  if (r.error) return json({ error: r.error[0] }, r.error[1]);
  const reply = (typeof r.out?.reply === 'string' ? r.out.reply : '').trim().slice(0, 1500);
  if (!reply) return json({ error: 'AI 답이 비어 있습니다' }, 502);
  const next = [...new Set((Array.isArray(r.out.next) ? r.out.next : []).filter(x => typeof x === 'string').map(x => x.trim()).filter(x => x && x.length <= 60))].slice(0, 3);
  return json({ reply, next, model: MODEL, usage: r.usage });
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
