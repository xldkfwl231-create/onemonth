/* 기록장 — 도서 검색 중계소 (Cloudflare Workers)
 *
 * 앱(index.html)은 여기로만 말을 겁니다. 카카오 열쇠는 이 안에만 있고
 * 앱에는 들어가지 않습니다. 열쇠는 코드에 적지 말고 Cloudflare의
 * Settings → Variables → Secrets 에 KAKAO_KEY 라는 이름으로 넣으세요.
 *
 * 쓰는 법:  https://<이름>.workers.dev/?q=독서의 기술
 * 돌려주는 것: [{ title, authors, publisher, cover, isbn }, ...]
 */

// 이 주소에서 오는 요청만 받습니다. 앱 주소가 바뀌면 여기를 고치세요.
const ALLOWED = [
  'https://xldkfwl231-create.github.io',
  'http://127.0.0.1:4173',   // npm start 로 PC에서 시험할 때
  'http://localhost:4173',
];

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const allow = ALLOWED.includes(origin) ? origin : ALLOWED[0];

    const cors = {
      'Access-Control-Allow-Origin': allow,
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Content-Type': 'application/json; charset=utf-8',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: { ...cors, 'Access-Control-Max-Age': '86400' } });
    }

    const q = (new URL(request.url).searchParams.get('q') || '').trim();
    if (!q) return new Response('[]', { headers: cors });

    // 같은 검색어는 하루 동안 캐시에서 꺼내 씁니다 — 카카오 호출을 아낍니다.
    const cacheKey = new Request('https://cache/book?q=' + encodeURIComponent(q));
    const cached = await caches.default.match(cacheKey);
    if (cached) {
      const body = await cached.text();
      return new Response(body, { headers: cors });
    }

    let res;
    try {
      res = await fetch(
        'https://dapi.kakao.com/v3/search/book?target=title&size=10&query=' + encodeURIComponent(q),
        { headers: { Authorization: 'KakaoAK ' + env.KAKAO_KEY } }
      );
    } catch (e) {
      return new Response(JSON.stringify({ error: '검색 서버에 닿지 못했습니다' }), {
        status: 502, headers: cors,
      });
    }

    if (!res.ok) {
      return new Response(JSON.stringify({ error: '검색 실패', status: res.status }), {
        status: 502, headers: cors,
      });
    }

    const data = await res.json();
    const books = (data.documents || []).map(function (d) {
      return {
        title: d.title,
        authors: (d.authors || []).join(', '),
        publisher: d.publisher,
        cover: d.thumbnail,          // 표지 이미지 주소
        isbn: (d.isbn || '').split(' ').pop(),
      };
    });

    const body = JSON.stringify(books);
    const out = new Response(body, {
      headers: { ...cors, 'Cache-Control': 'public, max-age=86400' },
    });
    // 캐시에 넣는 건 응답을 돌려준 뒤에 해도 됩니다.
    await caches.default.put(cacheKey, out.clone());
    return new Response(body, { headers: cors });
  },
};
