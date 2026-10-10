// Optional HTTPS endpoint running a book-search relay. No API keys belong here.
// 배포된 Cloudflare Worker — 카카오 열쇠는 Worker 안에만 있습니다.
export const BOOK_SEARCH_ENDPOINT = 'https://book-search.dmsxor111.workers.dev/';
// 슬라임이 기록 읽기 — 같은 중계소의 /ai/tags. AI 열쇠도 중계소 안에만 있습니다.
export const AI_ENDPOINT = new URL('ai/tags', BOOK_SEARCH_ENDPOINT).href;
export const AI_REFLECT_ENDPOINT = new URL('ai/reflect', BOOK_SEARCH_ENDPOINT).href;
