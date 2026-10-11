// 기록 지도 — 기록(점)이 주제어 · 책(큰 점)으로 이어진 그림. 슬라임이 터지면 가운데서 펼쳐집니다.
// 바깥 도구 없이 캔버스에 직접 그립니다: 밀어내는 힘 + 줄의 당기는 힘 + 가운데로 모이는 힘.
export const BOARD_COLORS = { entry: '#f4c430', question: '#8a7cf0', thought: '#ff7a59', answer: '#5aa2ff', tag: '#8fcf9e', book: '#c49a6c' };
const RADIUS = { entry: 6, question: 6, thought: 6, answer: 6 };

export function mountBoard(canvas, { nodes, links, onSelect = () => {}, reduced = false } = {}) {
  const ctx = canvas.getContext('2d');
  const byId = new Map(nodes.map(n => [n.id, n]));
  const edges = links.filter(l => byId.has(l.s) && byId.has(l.t)).map(l => ({ ...l, a: byId.get(l.s), b: byId.get(l.t) }));
  const near = new Map(nodes.map(n => [n.id, new Set()]));
  for (const e of edges) { near.get(e.a.id).add(e.b.id); near.get(e.b.id).add(e.a.id); }
  for (const n of nodes) {
    n.r = n.kind === 'tag' ? 9 + Math.min(14, Math.sqrt(n.count || 1) * 4) : n.kind === 'book' ? 13 : RADIUS[n.kind] || 6;
    n.w = n.kind === 'tag' || n.kind === 'book' ? 2.6 : 1;
    const a = Math.random() * Math.PI * 2, d = Math.random() * 6;   // 모두 가운데에서 시작 — 터진 자리에서 퍼져 나감
    n.x = Math.cos(a) * d; n.y = Math.sin(a) * d; n.vx = Math.cos(a) * 9; n.vy = Math.sin(a) * 9;
  }
  let W = 0, H = 0, dpr = 1, alpha = 1, raf = 0, dirty = true, alive = true, sel = null, touched = false, fitted = false;
  const view = { x: 0, y: 0, k: 1 };

  function resize() {
    const r = canvas.getBoundingClientRect(); dpr = Math.min(2, window.devicePixelRatio || 1);
    W = r.width; H = r.height; canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr); dirty = true; loop();
  }
  // ── 힘 ──
  function tick() {
    const n = nodes.length;
    for (let i = 0; i < n; i++) {
      const p = nodes[i];
      for (let j = i + 1; j < n; j++) {
        const q = nodes[j]; let dx = q.x - p.x, dy = q.y - p.y, d2 = dx * dx + dy * dy;
        if (d2 > 40000) continue; if (d2 < 1) { dx = Math.random() - 0.5; dy = Math.random() - 0.5; d2 = 1; }
        const f = 110 * alpha * p.w * q.w / d2;
        p.vx -= dx * f / p.w; p.vy -= dy * f / p.w; q.vx += dx * f / q.w; q.vy += dy * f / q.w;
      }
    }
    for (const e of edges) {
      const dx = e.b.x - e.a.x, dy = e.b.y - e.a.y, d = Math.hypot(dx, dy) || 1;
      const len = e.kind === 'from' ? 28 : e.kind === 'book' ? 38 : 44, k = (d - len) / d * 0.06 * alpha;
      e.a.vx += dx * k / e.a.w; e.a.vy += dy * k / e.a.w; e.b.vx -= dx * k / e.b.w; e.b.vy -= dy * k / e.b.w;
    }
    for (const p of nodes) {
      p.vx -= p.x * 0.016 * alpha; p.vy -= p.y * 0.016 * alpha;
      if (p.fixed) { p.vx = p.vy = 0; continue; }
      p.vx *= 0.62; p.vy *= 0.62; p.x += p.vx; p.y += p.vy;
    }
    alpha = Math.max(0, alpha * 0.985 - 0.0004);
  }
  // 펼쳐진 뒤 한 번, 화면에 다 들어오게 맞춥니다 (손대기 전까지만)
  function fit() {
    if (!nodes.length || !W) return;
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const p of nodes) { x0 = Math.min(x0, p.x - p.r); x1 = Math.max(x1, p.x + p.r); y0 = Math.min(y0, p.y - p.r); y1 = Math.max(y1, p.y + p.r); }
    const pad = 46, k = Math.min(2.2, Math.max(0.35, Math.min((W - pad * 2) / (x1 - x0 || 1), (H - pad * 2 - 90) / (y1 - y0 || 1))));
    view.k = k; view.x = -(x0 + x1) / 2 * k; view.y = -(y0 + y1) / 2 * k + 10; dirty = true;
  }
  // ── 그리기 ──
  const toScreen = (x, y) => [W / 2 + view.x + x * view.k, H / 2 + view.y + y * view.k];
  const toWorld = (sx, sy) => [(sx - W / 2 - view.x) / view.k, (sy - H / 2 - view.y) / view.k];
  const R = p => p.r * Math.max(1, 0.8 / view.k);   // 멀리서 봐도 점이 너무 작아지지 않게
  function draw() {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, W, H);
    ctx.translate(W / 2 + view.x, H / 2 + view.y); ctx.scale(view.k, view.k);
    const lit = sel ? near.get(sel.id) : null, on = p => !sel || p === sel || lit.has(p.id);
    ctx.lineWidth = 1.2 / view.k;
    for (const e of edges) {
      const hot = sel && (e.a === sel || e.b === sel);
      ctx.strokeStyle = hot ? 'rgba(108,178,124,.9)' : sel ? 'rgba(74,60,49,.06)' : e.kind === 'tag' ? 'rgba(108,178,124,.35)' : 'rgba(150,120,90,.28)';
      ctx.beginPath(); ctx.moveTo(e.a.x, e.a.y); ctx.lineTo(e.b.x, e.b.y); ctx.stroke();
    }
    for (const p of nodes) {
      ctx.globalAlpha = on(p) ? 1 : 0.18;
      ctx.fillStyle = BOARD_COLORS[p.kind] || '#ccc';
      ctx.beginPath();
      if (p.kind === 'book') { const s = R(p); ctx.roundRect ? ctx.roundRect(p.x - s * 0.8, p.y - s, s * 1.6, s * 2, 3) : ctx.rect(p.x - s * 0.8, p.y - s, s * 1.6, s * 2); }
      else ctx.arc(p.x, p.y, R(p), 0, Math.PI * 2);
      ctx.fill();
      if (p.talk) { ctx.strokeStyle = '#3f8a52'; ctx.lineWidth = 2.2 / view.k; ctx.stroke(); }
      if (p === sel) { ctx.strokeStyle = '#4a3c31'; ctx.lineWidth = 2.6 / view.k; ctx.beginPath(); ctx.arc(p.x, p.y, R(p) + 4 / view.k, 0, Math.PI * 2); ctx.stroke(); }
    }
    // 글자: 주제어와 책은 늘, 기록은 크게 볼 때나 고른 것 곁만
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    for (const p of nodes) {
      const hub = p.kind === 'tag' || p.kind === 'book', show = hub || view.k > 1.7 || (sel && (p === sel || lit.has(p.id)));
      if (!show) continue;
      ctx.globalAlpha = on(p) ? 1 : 0.25;
      const size = (hub ? 12.5 : 11) / view.k, text = p.kind === 'tag' ? '#' + p.label : p.label.length > 16 ? p.label.slice(0, 16) + '…' : p.label;
      ctx.font = `${hub ? 400 : 400} ${size}px ${hub ? 'Jua' : 'Gowun Dodum'}, sans-serif`;
      ctx.lineWidth = 3.2 / view.k; ctx.strokeStyle = 'rgba(255,246,234,.92)'; ctx.fillStyle = '#4a3c31';
      ctx.strokeText(text, p.x, p.y + R(p) + 3 / view.k); ctx.fillText(text, p.x, p.y + R(p) + 3 / view.k);
    }
    ctx.globalAlpha = 1;
  }
  function loop() {
    if (raf || !alive) return;
    raf = requestAnimationFrame(() => {
      raf = 0; if (!alive) return;
      let moving = false;
      if (alpha > 0.004) { for (let i = 0; i < (reduced ? 6 : 1); i++) tick(); moving = true; if (!fitted && !touched && alpha < 0.25) { fitted = true; fit(); } }
      if (!fitted && !touched && !moving) { fitted = true; fit(); }
      if (moving || dirty) { draw(); dirty = false; }
      if (moving) loop();
    });
  }
  // ── 손으로 다루기: 끌어서 옮기기, 두 손가락·휠로 확대, 톡 눌러 고르기 ──
  const pointers = new Map(); let drag = null, pinch = null;
  function hit(sx, sy) {
    const [x, y] = toWorld(sx, sy); let best = null, bd = Infinity;
    for (const p of nodes) { const d = Math.hypot(p.x - x, p.y - y); if (d < R(p) + 9 / view.k && d < bd) { best = p; bd = d; } }
    return best;
  }
  const local = e => { const r = canvas.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  canvas.addEventListener('pointerdown', e => {
    try { canvas.setPointerCapture(e.pointerId); } catch {}
    touched = true; const [sx, sy] = local(e); pointers.set(e.pointerId, [sx, sy]);
    if (pointers.size === 2) { const [a, b] = [...pointers.values()]; pinch = { d0: Math.hypot(a[0] - b[0], a[1] - b[1]), k0: view.k }; if (drag?.node) drag.node.fixed = false; drag = null; return; }
    const node = hit(sx, sy);
    drag = { sx, sy, x0: view.x, y0: view.y, node, moved: false };
    if (node) { node.fixed = true; }
  });
  canvas.addEventListener('pointermove', e => {
    const [sx, sy] = local(e); if (pointers.has(e.pointerId)) pointers.set(e.pointerId, [sx, sy]);
    if (pinch && pointers.size >= 2) { const [a, b] = [...pointers.values()]; zoomAt((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, pinch.k0 * Math.hypot(a[0] - b[0], a[1] - b[1]) / Math.max(10, pinch.d0) / view.k); return; }
    if (!drag) return;
    if (!drag.moved && Math.hypot(sx - drag.sx, sy - drag.sy) > 6) drag.moved = true;
    if (!drag.moved) return;
    if (drag.node) { const [x, y] = toWorld(sx, sy); drag.node.x = x; drag.node.y = y; alpha = Math.max(alpha, 0.25); loop(); }
    else { view.x = drag.x0 + sx - drag.sx; view.y = drag.y0 + sy - drag.sy; dirty = true; loop(); }
  });
  const up = e => {
    pointers.delete(e.pointerId);
    if (pinch) { if (pointers.size < 2) pinch = null; return; }
    if (!drag) return;
    if (drag.node) drag.node.fixed = false;
    if (!drag.moved) select(drag.node ? drag.node.id : null, true);
    drag = null;
  };
  canvas.addEventListener('pointerup', up); canvas.addEventListener('pointercancel', up);
  function zoomAt(sx, sy, f) {
    const k = Math.min(4, Math.max(0.25, view.k * f)), [x, y] = toWorld(sx, sy);
    view.k = k; view.x = sx - W / 2 - x * k; view.y = sy - H / 2 - y * k; dirty = true; loop();
  }
  canvas.addEventListener('wheel', e => { e.preventDefault(); touched = true; const [sx, sy] = local(e); zoomAt(sx, sy, Math.exp(-e.deltaY * 0.0015)); }, { passive: false });
  function select(id, fromTap = false) {
    sel = id ? byId.get(id) || null : null; dirty = true; loop();
    if (fromTap || id) onSelect(sel);
    if (sel && !fromTap) { const [sx, sy] = toScreen(sel.x, sel.y); if (sx < 40 || sx > W - 40 || sy < 60 || sy > H - 60) { view.x -= sx - W / 2; view.y -= sy - H / 2; dirty = true; loop(); } }
  }
  const ro = new ResizeObserver(resize); ro.observe(canvas); resize();
  return {
    select: id => select(id),
    zoom: f => zoomAt(W / 2, H / 2, f),
    fit: () => { fit(); loop(); },
    settle(n = 400) { for (let i = 0; i < n && alpha > 0.004; i++) tick(); fitted = true; fit(); draw(); },   // 확인용
    stats: () => ({ nodes: nodes.length, links: edges.length, alpha: +alpha.toFixed(3), k: +view.k.toFixed(2), sel: sel?.id || null }),
    destroy() { alive = false; cancelAnimationFrame(raf); ro.disconnect(); }
  };
}
