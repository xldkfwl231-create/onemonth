import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(fileURLToPath(new URL('..',import.meta.url)));
const mime = {'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json','.svg':'image/svg+xml','.png':'image/png','.webp':'image/webp'};
const server = http.createServer(async (req,res) => {
  try {
    const url = new URL(req.url,'http://localhost');
    if (!['GET','HEAD'].includes(req.method)) { res.writeHead(405); res.end(); return; }
    if (url.pathname === '/api/books') {
      if (!process.env.KAKAO_REST_API_KEY) { res.writeHead(503,{'Content-Type':'application/json'}); res.end(JSON.stringify({error:'KAKAO_REST_API_KEY is not configured'})); return; }
      const q = url.searchParams.get('q')?.trim();
      if (!q || q.length > 200) { res.writeHead(400); res.end(); return; }
      const upstream = await fetch(`https://dapi.kakao.com/v3/search/book?query=${encodeURIComponent(q)}&size=8`,{headers:{Authorization:`KakaoAK ${process.env.KAKAO_REST_API_KEY}`},signal:AbortSignal.timeout(12000)});
      if (!upstream.ok) { res.writeHead(502); res.end(); return; }
      const data = await upstream.json();
      res.writeHead(200,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});
      res.end(JSON.stringify({books:data.documents.map(d => ({title:d.title,author:d.authors.join(', '),publisher:d.publisher,isbn:d.isbn.split(' ').filter(Boolean).at(-1) || '',cover:d.thumbnail}))})); return;
    }
    if (url.pathname === '/src/config.js' && process.env.KAKAO_REST_API_KEY) { res.writeHead(200,{'Content-Type':mime['.js'],'Cache-Control':'no-store'}); res.end('export const BOOK_SEARCH_ENDPOINT = "/api/books";'); return; }
    const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
    // Expose only app assets, not .git, keys, tests, or the local server source.
    if (!/^(index\.html|legacy-records\.html|manifest\.json|icon\.svg|sw\.js|src\/[a-z-]+\.(js|css))$/.test(relative)) { res.writeHead(404); res.end(); return; }
    const data = await readFile(path.join(root,relative));
    res.writeHead(200,{'Content-Type':mime[path.extname(relative)] || 'application/octet-stream','Cache-Control':'no-cache'}); res.end(req.method === 'HEAD' ? undefined : data);
  } catch(e) { res.writeHead(e.code === 'ENOENT' ? 404 : 502); res.end('Request failed'); }
});
server.listen(Number(process.env.PORT || 4173),'127.0.0.1',() => console.log(`Reading notebook: http://127.0.0.1:${server.address().port}`));
