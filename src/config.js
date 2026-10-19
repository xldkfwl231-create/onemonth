// Optional HTTPS endpoint running a book-search relay. No API keys belong here.
// 배포된 Cloudflare Worker — 카카오 열쇠는 Worker 안에만 있습니다.
export const BOOK_SEARCH_ENDPOINT = 'https://book-search.dmsxor111.workers.dev/';
// 슬라임이 기록 읽기 — 같은 중계소의 /ai/tags. AI 열쇠도 중계소 안에만 있습니다.
export const AI_ENDPOINT = new URL('ai/tags', BOOK_SEARCH_ENDPOINT).href;
export const AI_SUMMARY_ENDPOINT = new URL('ai/summary', BOOK_SEARCH_ENDPOINT).href;
export const AI_CHAT_ENDPOINT = new URL('ai/chat', BOOK_SEARCH_ENDPOINT).href;
// 이야기 목록의 문장 제목
export const AI_TITLES_ENDPOINT = new URL('ai/titles', BOOK_SEARCH_ENDPOINT).href;
// 이어 주기 — 방금 먹인 생각과 이어지는 예전 기록
export const AI_LINKS_ENDPOINT = new URL('ai/links', BOOK_SEARCH_ENDPOINT).href;
// 슬라임이 아는 나 — 기록에서 나에 대한 메모를 뒤에서 정리
export const AI_KNOW_ENDPOINT = new URL('ai/know', BOOK_SEARCH_ENDPOINT).href;
