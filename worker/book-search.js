/* 나만의 슬라임 만들기 — 중계소 (Cloudflare Workers)
 *
 * 앱(index.html)은 여기로만 말을 겁니다. 열쇠는 이 안에만 있고 앱에는 들어가지 않습니다.
 * 열쇠는 코드에 적지 말고 Cloudflare의 Settings → Variables and Secrets 에 넣으세요.
 *   KAKAO_KEY      — 책 검색 (카카오 REST API 키)
 *   ANTHROPIC_KEY  — 슬라임이 기록 읽기 (Anthropic API 키)
 *
 * GET  /?q=독서의 기술   → 책 검색. [{ title, authors, publisher, cover, isbn }, ...]
 * POST /ai/tags          → 기록마다 주제어 1~3개와 짧은 요약. { items: [{ id, text }], known: [주제어], fresh?, name?, tone? } → { items: [{ id, tags, gist }], bite: 방금 먹인 기록(fresh)에 슬라임이 하는 한마디 }
 * POST /ai/know          → 슬라임이 아는 나: 예전 메모 + 새 기록으로 나에 대한 메모를 고쳐 씀. { items: [{ cat, text, src }], records: [{ id, date, kind, text }], removed: [text] } → { items: [{ cat, text, src: [id] }] }
 * POST /ai/links         → 방금 먹인 기록과 뜻이 이어지는 예전 기록. { fresh: { id, text }, candidates: [{ id, date, text }] } → { items: [{ id, why }] } (0~2개)
 * POST /ai/titles        → 책 문장마다 짧은 제목. { book, items: [{ id, text }] } → { items: [{ id, title }] }
 * POST /ai/chat          → 슬라임과 이야기. { name, tone, topic, profile: [{ cat, text }], messages: [{ role, text }] } → { reply }
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
    if (path === '/ai/know') {
      if (request.method !== 'POST') return json({ error: 'POST만 받습니다' }, 405);
      if (!ALLOWED.includes(origin)) return json({ error: '허용되지 않은 주소입니다' }, 403);
      if (!env.ANTHROPIC_KEY) return json({ error: 'ANTHROPIC_KEY가 설정되지 않았습니다' }, 503);
      return know(request, env, json);
    }
    if (path === '/ai/links') {
      if (request.method !== 'POST') return json({ error: 'POST만 받습니다' }, 405);
      if (!ALLOWED.includes(origin)) return json({ error: '허용되지 않은 주소입니다' }, 403);
      if (!env.ANTHROPIC_KEY) return json({ error: 'ANTHROPIC_KEY가 설정되지 않았습니다' }, 503);
      return linksFor(request, env, json);
    }
    if (path === '/ai/titles') {
      if (request.method !== 'POST') return json({ error: 'POST만 받습니다' }, 405);
      if (!ALLOWED.includes(origin)) return json({ error: '허용되지 않은 주소입니다' }, 403);
      if (!env.ANTHROPIC_KEY) return json({ error: 'ANTHROPIC_KEY가 설정되지 않았습니다' }, 503);
      return titles(request, env, json);
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
  // fresh: 방금 먹인 기록의 id — 슬라임이 그 기록을 보고 한 줄 말합니다 (bite)
  const fresh = typeof body.fresh === 'string' && clean.some(c => c.id === body.fresh) ? body.fresh : '';
  const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim().slice(0, 30) : '슬라임';
  const tone = body.tone === 'you' ? 'you' : 'we';

  const system = [
    '당신은 한 사람이 자기 자신에 대해 적은 짧은 기록을 읽고, 기록마다 주제어를 붙이는 도우미입니다.',
    '규칙:',
    '- 기록마다 주제어 1~3개. 2~6글자의 한국어 명사. 예: 회의, 기운, 리더십, 혼자, 쇼츠, 운동, 일, 사람, 독서',
    '- 그 기록에 실제로 나온 내용만. 짐작하거나 확대하지 마세요.',
    '- 사람을 평가하거나 진단하는 말은 쓰지 마세요. 예: 내향적, 게으름, 우울, 문제, 성공',
    '- "이미 쓰는 주제어" 목록에 뜻이 같은 단어가 있으면 그 단어를 그대로 쓰세요. 비슷한 말을 새로 만들지 마세요.',
    '- 모든 기록의 id를 빠짐없이 그대로 돌려주세요.',
    '- 기록마다 gist도 붙이세요: 무슨 기록인지 한눈에 알아볼 짧은 요약. 한국어 8~20글자. 원문을 앞에서부터 자르지 말고 뜻을 줄여 쓰세요. 마침표·따옴표 없이. 예: 혼자 걷는 출근길이 좋았던 날, 회의 뒤 기운이 빠짐',
    ...(fresh ? [
      `- bite: 방금 먹인 기록(id ${fresh})을 보고 "${name}"라는 작은 슬라임이 하는 한마디. 반말 한 문장, 15~40글자.`,
      '  칭찬·위로·조언·평가 말고, 본 것을 짚으세요. 그 기록의 핵심이나 다른 기록과 겹치는 주제어가 있으면 그걸로. 예: "출근길 얘기가 또 나왔네. 이번엔 피곤한 쪽이야."',
      tone === 'we' ? '  이 사람을 "우리"라고 불러도 됩니다.' : '  이 사람을 "너"라고 부르세요.',
      '  물음표로 끝내지 마세요.',
    ] : ['- bite는 빈 문자열로 두세요.']),
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
                    properties: { id: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } }, gist: { type: 'string' } },
                    required: ['id', 'tags', 'gist'],
                    additionalProperties: false,
                  },
                },
                bite: { type: 'string' },
              },
              required: ['items', 'bite'],
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
    .map(it => ({ id: it.id, tags: [...new Set(it.tags.filter(t => typeof t === 'string').map(t => t.trim()).filter(t => t && t.length <= 12))].slice(0, 3), gist: typeof it.gist === 'string' ? it.gist.replace(/["'“”‘’.。]/g, '').trim().slice(0, 30) : '' }));
  const bite = fresh && typeof out.bite === 'string' ? out.bite.trim().slice(0, 80) : '';
  return json({ items: result, bite, model: MODEL, usage: data.usage ? { input: data.usage.input_tokens, output: data.usage.output_tokens } : undefined });
}

// ── 슬라임이 아는 나: 기록에서 나에 대한 메모를 뒤에서 정리 ─────────────
// 대화에서는 이 메모만 배경으로 씁니다(기록 원문 대신). 나 탭에서 보고, 틀린 건 지울 수 있습니다(removed: 다시 쓰지 말 것).
const KNOW_CATS = ['관심사', '고민', '기준', '요즘', '바뀐 생각'], MAX_KNOW = 30, MAX_KNOW_RECORDS = 80;
async function know(request, env, json) {
  let body;
  try { body = await request.json(); } catch { return json({ error: '형식이 올바르지 않습니다' }, 400); }
  const recs = Array.isArray(body?.records) ? body.records : null;
  if (!recs || recs.length > MAX_KNOW_RECORDS) return json({ error: `기록은 0~${MAX_KNOW_RECORDS}개씩 보내 주세요` }, 400);
  const str = (v, n) => typeof v === 'string' ? v.slice(0, n) : '';
  const records = recs.filter(r => typeof r?.id === 'string' && r.id.length <= 100 && typeof r.text === 'string' && r.text.trim()).map(r => ({ id: r.id, date: str(r.date, 20), kind: str(r.kind, 30), text: r.text.slice(0, 400) }));
  const prev = (Array.isArray(body.items) ? body.items : []).slice(0, MAX_KNOW).filter(k => typeof k?.text === 'string' && k.text.trim())
    .map(k => ({ cat: KNOW_CATS.includes(k.cat) ? k.cat : '요즘', text: k.text.slice(0, 120), src: (Array.isArray(k.src) ? k.src : []).filter(x => typeof x === 'string' && x.length <= 100).slice(0, 5) }));
  const removed = (Array.isArray(body.removed) ? body.removed : []).filter(x => typeof x === 'string').slice(-50).map(x => x.slice(0, 120));
  if (!records.length && !prev.length) return json({ error: '정리할 기록이 없습니다' }, 400);
  const system = [
    '당신은 한 사람이 자기 앱에 남긴 기록(생각, 책에 단 메모, 질문과 답, 대화에서 한 말)을 읽고, 이 사람에 대한 메모를 정리하는 도우미입니다.',
    '이 메모는 나중에 이 사람과 대화하는 AI가 배경으로 쓰고, 이 사람도 직접 읽습니다.',
    '규칙:',
    `- 갈래(cat)는 ${KNOW_CATS.map(c => `"${c}"`).join(', ')} 가운데 하나. 관심사: 자주 다루는 것 · 고민: 되풀이되는 걱정이나 풀고 싶은 문제 · 기준: 판단할 때 쓰는 가치나 원칙 · 요즘: 지금 처한 상황 · 바뀐 생각: 예전과 달라진 생각(그땐 → 지금은).`,
    '- 항목마다 한 줄(text), 15~60글자. "~함", "~임", "~에 관심"처럼 짧게 맺으세요. 예: 정해진 길이 있으면 오히려 편하다고 느낌',
    '- 기록에 실제로 나온 것만. 짐작해서 성격을 진단하거나 평가하지 마세요. 예: 게으름, 불안형, 내향적 같은 말 금지.',
    '- src: 그 항목의 근거가 된 기록 id 1~3개(받은 기록이나 예전 메모의 src에서만).',
    '- 예전 메모가 있으면 그것을 바탕으로 고쳐 쓰세요. 새 기록으로 달라진 건 고치고, 여전히 맞는 건 두고, 겹치는 건 합치세요.',
    '- "지운 것" 목록에 있는 내용은 다시 쓰지 마세요. 이 사람이 틀렸다고 지운 것입니다.',
    `- 모두 합쳐 ${MAX_KNOW}개 이하. 중요한 것부터.`,
  ].join('\n');
  const user = JSON.stringify({ 예전_메모: prev, 새_기록: records, 지운_것: removed });
  const schema = { type: 'object', properties: { items: { type: 'array', items: { type: 'object', properties: { cat: { type: 'string' }, text: { type: 'string' }, src: { type: 'array', items: { type: 'string' } } }, required: ['cat', 'text', 'src'], additionalProperties: false } } }, required: ['items'], additionalProperties: false };
  const r = await askClaude(env, { system, user, schema, effort: 'medium', maxTokens: 6000 });
  if (r.error) return json({ error: r.error[0] }, r.error[1]);
  const ids = new Set([...records.map(x => x.id), ...prev.flatMap(k => k.src)]), gone = new Set(removed.map(x => x.trim()));
  const items = (Array.isArray(r.out?.items) ? r.out.items : [])
    .filter(k => typeof k?.text === 'string' && k.text.trim() && !gone.has(k.text.trim()))
    .slice(0, MAX_KNOW)
    .map(k => ({ cat: KNOW_CATS.includes(k.cat) ? k.cat : '요즘', text: k.text.trim().slice(0, 80), src: [...new Set((Array.isArray(k.src) ? k.src : []).filter(x => ids.has(x)))].slice(0, 3) }));
  return json({ items, model: MODEL, usage: r.usage });
}

// ── 이어 주기: 방금 먹인 기록과 뜻이 이어지는 예전 기록 찾기 ─────────────
// 같은 낱말이 아니라 같은 고민 · 반대 생각 · 원인과 결과 · 같은 장면처럼 뜻으로 이어진 것만. 없으면 비워 둡니다.
const MAX_LINK_CANDIDATES = 40;
async function linksFor(request, env, json) {
  let body;
  try { body = await request.json(); } catch { return json({ error: '형식이 올바르지 않습니다' }, 400); }
  const f = body?.fresh, cands = Array.isArray(body?.candidates) ? body.candidates : null;
  if (typeof f?.id !== 'string' || f.id.length > 100 || typeof f?.text !== 'string' || !f.text.trim()) return json({ error: '방금 기록이 없습니다' }, 400);
  if (!cands || !cands.length || cands.length > MAX_LINK_CANDIDATES) return json({ error: `예전 기록은 1~${MAX_LINK_CANDIDATES}개씩 보내 주세요` }, 400);
  const clean = [];
  for (const c of cands) {
    if (typeof c?.id !== 'string' || c.id.length > 100 || c.id === f.id || typeof c?.text !== 'string' || !c.text.trim()) return json({ error: '예전 기록 형식이 올바르지 않습니다' }, 400);
    clean.push({ id: c.id, date: typeof c.date === 'string' ? c.date.slice(0, 20) : '', text: c.text.slice(0, 300) });
  }
  const system = [
    '당신은 한 사람이 자기 자신에 대해 적은 기록들 사이의 연결을 찾는 도우미입니다.',
    '방금 적은 기록 하나와 예전 기록 목록을 받습니다. 방금 기록과 뜻으로 이어지는 예전 기록을 0~2개 고르세요.',
    '이어진다는 것: 같은 고민이 다시 나옴, 반대되는 생각, 원인과 결과, 같은 장면이나 사람, 예전 질문에 대한 지금의 답.',
    '같은 낱말이 나온다는 것만으로는 이어진 게 아닙니다. 확실하지 않으면 고르지 말고 비워 두세요.',
    '고른 것마다 why: 어떻게 이어지는지 반말로 짧게(10~30글자). 평가나 조언은 쓰지 마세요. 예: 둘 다 혼자일 때 기운이 났다는 얘기',
    'id는 받은 것 중에서만 고르세요.',
  ].join('\n');
  const user = JSON.stringify({ 방금_기록: f.text.slice(0, 600), 예전_기록: clean });
  const schema = { type: 'object', properties: { items: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, why: { type: 'string' } }, required: ['id', 'why'], additionalProperties: false } } }, required: ['items'], additionalProperties: false };
  const r = await askClaude(env, { system, user, schema, effort: 'low', maxTokens: 2000 });
  if (r.error) return json({ error: r.error[0] }, r.error[1]);
  const ids = new Set(clean.map(c => c.id)), seen = new Set();
  const items = (Array.isArray(r.out?.items) ? r.out.items : [])
    .filter(it => ids.has(it?.id) && !seen.has(it.id) && seen.add(it.id))
    .slice(0, 2)
    .map(it => ({ id: it.id, why: typeof it.why === 'string' ? it.why.trim().slice(0, 60) : '' }));
  return json({ items, model: MODEL, usage: r.usage });
}

// ── 문장 제목: 이야기 목록에서 알아보기 쉽게, 책에서 옮겨 적은 문장마다 짧은 제목 ─────────
// 문장은 제목을 만드는 데만 쓰고 남기지 않습니다.
const MAX_TITLE_TEXT = 600;
async function titles(request, env, json) {
  let body;
  try { body = await request.json(); } catch { return json({ error: '형식이 올바르지 않습니다' }, 400); }
  const items = Array.isArray(body?.items) ? body.items : null;
  if (!items || !items.length || items.length > MAX_ITEMS) return json({ error: `문장은 1~${MAX_ITEMS}개씩 보내 주세요` }, 400);
  const clean = [];
  for (const it of items) {
    if (typeof it?.id !== 'string' || it.id.length > 100 || typeof it?.text !== 'string' || !it.text.trim()) return json({ error: '문장 형식이 올바르지 않습니다' }, 400);
    clean.push({ id: it.id, text: it.text.slice(0, MAX_TITLE_TEXT) });
  }
  const book = typeof body.book === 'string' ? body.book.slice(0, 200) : '';
  const system = [
    '당신은 한 사람이 책을 읽다 옮겨 적은 문장들에, 목록에서 한눈에 알아볼 수 있는 짧은 제목을 붙이는 도우미입니다.',
    '규칙:',
    '- 문장마다 제목 하나. 한국어로 6~16글자. 무엇에 대한 문장인지 핵심만 담은 명사구. 예: 고슴도치 찾기, 절벽 앞에서의 선택, 타고난 잠재력',
    '- 문장을 앞에서부터 그대로 자르지 말고, 뜻을 줄여 쓰세요.',
    '- 마침표, 따옴표, 이모지를 쓰지 마세요.',
    '- 모든 문장의 id를 빠짐없이 그대로 돌려주세요.',
  ].join('\n');
  const user = JSON.stringify({ 책: book, 문장: clean });
  const schema = { type: 'object', properties: { items: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, title: { type: 'string' } }, required: ['id', 'title'], additionalProperties: false } } }, required: ['items'], additionalProperties: false };
  const r = await askClaude(env, { system, user, schema, effort: 'low', maxTokens: 3000 });
  if (r.error) return json({ error: r.error[0] }, r.error[1]);
  const ids = new Set(clean.map(x => x.id));
  const out = (Array.isArray(r.out?.items) ? r.out.items : [])
    .filter(it => ids.has(it?.id) && typeof it.title === 'string')
    .map(it => ({ id: it.id, title: it.title.replace(/["'“”‘’.。]/g, '').trim().slice(0, 24) }))
    .filter(it => it.title);
  return json({ items: out, model: MODEL, usage: r.usage });
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
const MAX_TURNS = 40, MAX_TURN_TEXT = 1500, MAX_PROFILE = 40;
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
  // 이 사람에 대해 알고 있는 것 — 앱이 기록에서 미리 정리해 둔 메모(나 탭의 '슬라임이 아는 나'). 배경으로만 씁니다.
  const known = (Array.isArray(body.profile) ? body.profile : []).slice(0, MAX_PROFILE)
    .filter(k => typeof k?.text === 'string' && k.text.trim())
    .map(k => `- ${typeof k.cat === 'string' && k.cat ? k.cat.slice(0, 20) + ': ' : ''}${k.text.slice(0, 200).replace(/\s+/g, ' ')}`);
  const about = topic.kind === 'book' ? `책 『${topic.title}』${topic.author ? `(${topic.author})` : ''}` : topic.kind === 'thought' ? '이 사람이 적어 둔 생각 하나' : '이 사람이 꺼내는 이야기';
  const system = [
    `당신은 "${name}"라는 이름의 작은 슬라임이고, 이 사람과 편하게 이야기하는 대화 상대입니다. 지금은 ${about}에 대해 이야기합니다.`,
    '',
    '대화 방식:',
    '- 똑똑하고 편한 친구처럼 자연스럽게 이야기하세요. 이 사람의 말에 진짜로 반응하고, 아는 것은 성실히 답하고, 내 생각도 솔직하게 말하세요.',
    '- 생각이 넓어지도록 도와주세요. 필요하면 한 번에 하나씩 되물어도 됩니다. 이 사람이 미처 생각 못 한 쪽을 여는 질문이면 좋습니다. 매번 묻지는 말고, 물을 때는 답이나 생각을 먼저 말한 뒤 짧게.',
    '- 무조건 맞장구치지 마세요. 동의하면 이유를, 다르게 보면 다르게 보는 이유를 말하세요. 다만 이 사람 자체를 평가하거나 진단하지는 마세요. ("너는 ~한 사람이야" 금지)',
    '- 길이는 보통 2~4문장. 이 사람이 길게 설명해 달라고 하면 그만큼.',
    tone === 'we' ? '- 당신과 이 사람은 가까운 사이라서 이 사람을 "우리"라고 부르기도 합니다.' : '- 이 사람을 "너"라고 부르세요. 다정한 반말.',
    '- 책에 대해 확실히 아는 내용은 꺼내도 됩니다. 확실하지 않으면 아는 척하지 말고 그렇다고 말하세요.',
    '- 건강·법률·돈처럼 전문 판단이 필요한 이야기는 전문가에게 묻기를 권하세요.',
    '- 마크다운 기호(#, *, -)를 쓰지 말고 말하듯 쓰세요.',
    '',
    '지금 이야기의 주제 (이 사람이 직접 적은 것):',
    JSON.stringify(topic),
    ...(known.length ? [
      '',
      '이 사람에 대해 알고 있는 것 (앱이 이 사람의 기록에서 정리해 둔 메모):',
      ...known,
      '',
      '알고 있는 것 쓰는 법:',
      '- 배경 지식으로만 쓰세요. 이 사람을 이해하고 말을 고르는 데 쓰되, 티 내지 마세요.',
      '- "예전에 ~라고 했잖아", "기록에 보니"처럼 기록을 꺼내 인용하거나 날짜를 대지 마세요.',
      '- 이 사람이 자기에 대해 묻거나("나 예전에 뭐라고 했지?"), 지금 이야기에 꼭 필요할 때만 자연스럽게 짧게 언급하세요.',
      '- 메모에 없는 일을 지어내지 마세요.',
    ] : []),
  ].join('\n');
  const r = await askClaude(env, { system, messages: clean, effort: 'medium', maxTokens: 3000 });
  if (r.error) return json({ error: r.error[0] }, r.error[1]);
  const reply = (r.text || '').trim().slice(0, 1500);
  if (!reply) return json({ error: 'AI 답이 비어 있습니다' }, 502);
  return json({ reply, model: MODEL, usage: r.usage });
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
