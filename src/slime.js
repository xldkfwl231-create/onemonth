// 말랑한 3D 슬라임. 톡 치면 출렁이고, 길게 누르면 눌리고, 끌면 돌아갑니다.
// 모습(색·투명도·단단함)은 밖에서 정해 줍니다 — 나중에 요약이 정하게 될 자리입니다.
import * as THREE from '../vendor/three.module.min.js';

export const DEFAULT_LOOK = { color: '#a9d3a4', clarity: 0.55, firmness: 42, damping: 4.2 };

export function mountSlime(container, { look = {}, onPoke = () => {}, reduced = false } = {}) {
  look = { ...DEFAULT_LOOK, ...look };
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'low-power' });
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  const canvas = renderer.domElement;
  canvas.style.touchAction = 'none';
  canvas.setAttribute('aria-label', '슬라임. 톡 치거나 끌어 보세요.');
  container.appendChild(canvas);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 30);
  camera.position.set(0, 1.5, 6.4); camera.lookAt(0, -0.25, 0);
  scene.add(new THREE.HemisphereLight(0xfff7e8, 0xb9c3aa, 1.1));
  const key = new THREE.DirectionalLight(0xffffff, 1.6); key.position.set(2.5, 4, 3); scene.add(key);
  const rim = new THREE.DirectionalLight(0xe2ebff, 0.9); rim.position.set(-3, 2.5, -2.5); scene.add(rim);

  // 종이 톤의 작은 방을 비춰서 젤리 표면에 부드러운 반사가 생기게 합니다.
  const pmrem = new THREE.PMREMGenerator(renderer);
  const room = new THREE.Scene(); room.background = new THREE.Color(0xefe9db);
  const pane = (color, x, y, z, size) => { const m = new THREE.Mesh(new THREE.PlaneGeometry(size, size), new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide })); m.position.set(x, y, z); m.lookAt(0, 0, 0); room.add(m); };
  pane(0xffffff, 2, 4, 2, 4); pane(0xfff0d6, -3.5, 2, 1, 3); pane(0xd7e1ea, 0, 1.5, -4, 5); pane(0xffffff, 0, 5, 0, 2.5);
  scene.environment = pmrem.fromScene(room, 0.05).texture;
  pmrem.dispose();

  // 몸: 바닥이 살짝 눌린 동그란 덩어리
  const geometry = new THREE.SphereGeometry(1, 48, 32);
  const pos = geometry.attributes.position, count = pos.count;
  const rest = new Float32Array(count * 3), off = new Float32Array(count * 3), vel = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    let x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const bulge = 1 + 0.025 * Math.sin(3.1 * x + 1) * Math.sin(2.3 * z) + 0.02 * Math.cos(2.7 * y);
    x *= bulge; z *= bulge; y = y * 0.9 * bulge;
    if (y < -0.5) y = -0.5 + (y + 0.5) * 0.22;   // 바닥에 앉은 느낌
    rest[i * 3] = x; rest[i * 3 + 1] = y; rest[i * 3 + 2] = z;
    pos.setXYZ(i, x, y, z);
  }
  // 이웃 목록 — 출렁임이 옆으로 번지게
  const neighbors = Array.from({ length: count }, () => new Set());
  const index = geometry.index.array;
  for (let i = 0; i < index.length; i += 3) { const a = index[i], b = index[i + 1], c = index[i + 2]; neighbors[a].add(b).add(c); neighbors[b].add(a).add(c); neighbors[c].add(a).add(b); }
  const nb = neighbors.map(s => Int32Array.from(s));
  geometry.computeVertexNormals();

  const color = new THREE.Color(look.color);
  const material = new THREE.MeshPhysicalMaterial({
    color, roughness: 0.22, metalness: 0, transmission: look.clarity, thickness: 1.3, ior: 1.33,
    clearcoat: 0.7, clearcoatRoughness: 0.25, attenuationColor: color.clone(), attenuationDistance: 1.4, envMapIntensity: 0.9
  });
  const body = new THREE.Mesh(geometry, material);
  const group = new THREE.Group(); group.add(body); scene.add(group);

  // 눈 두 개 — 최소한의 표정. 표면 바로 바깥에 붙여서 젤리 너머로 일그러져 보이지 않게 합니다.
  const eyeMat = new THREE.MeshStandardMaterial({ color: 0x33302a, roughness: 0.35 });
  const nearest = [-0.3, 0.3].map(x => { const y = 0.2, z = 0.95; let best = 0, d = Infinity; for (let i = 0; i < count; i++) { const dd = (rest[i * 3] - x) ** 2 + (rest[i * 3 + 1] - y) ** 2 + (rest[i * 3 + 2] - z) ** 2; if (dd < d) { d = dd; best = i; } } return best; });
  const eyeRest = nearest.map(i => new THREE.Vector3(rest[i * 3], rest[i * 3 + 1], rest[i * 3 + 2]).multiplyScalar(1.045));
  const eyes = eyeRest.map(p => { const e = new THREE.Mesh(new THREE.SphereGeometry(0.075, 20, 14), eyeMat); e.position.copy(p); e.lookAt(p.clone().multiplyScalar(2)); e.scale.z = 0.45; group.add(e); return e; });

  // 바닥 그림자
  const shade = document.createElement('canvas'); shade.width = shade.height = 128;
  const g = shade.getContext('2d'), grad = g.createRadialGradient(64, 64, 8, 64, 64, 64);
  grad.addColorStop(0, 'rgba(70,75,60,.32)'); grad.addColorStop(1, 'rgba(70,75,60,0)'); g.fillStyle = grad; g.fillRect(0, 0, 128, 128);
  const shadowTex = new THREE.CanvasTexture(shade); shadowTex.colorSpace = THREE.SRGBColorSpace;
  const shadow = new THREE.Mesh(new THREE.PlaneGeometry(2.6, 2.6), new THREE.MeshBasicMaterial({ map: shadowTex, transparent: true, depthWrite: false }));
  shadow.rotation.x = -Math.PI / 2; shadow.position.y = -0.64; scene.add(shadow);

  // 물리 상태 — 표면(꼭짓점 스프링) · 몸 전체의 눌림(세 축 스프링) · 바닥 위 자리와 속도(던지기)
  const BASE = 0.78, FLOOR = -0.64;                         // 몸 크기, 바닥 높이
  const sq = [1, 1, 1], sqv = [0, 0, 0];                     // x·y·z 눌림 (1 = 원래)
  const at = new THREE.Vector3(0, 0, 0), go = new THREE.Vector3(0, 0, 0);   // 자리(바닥 기준, y = 뛰어오른 높이), 속도
  let bounds = { x: 1.0, zNear: 0.95, zFar: -1.15 };
  let tilt = 0, spin = 0.25, lastT = performance.now(), idleTimer = 0, blinkTimer = 2.5, blink = 0;
  let down = null, pressing = null, pokes = 0, running = true;
  const raycaster = new THREE.Raycaster(), ndc = new THREE.Vector2(), tmp = new THREE.Vector3(), floorPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -FLOOR - 0.45);

  function castFrom(e) {
    const r = canvas.getBoundingClientRect();
    if (!r.width || !r.height) return false;   // 화면에 안 보일 때
    ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    raycaster.setFromCamera(ndc, camera); return true;
  }
  function pick(e) {
    if (!castFrom(e)) return null;
    const hit = raycaster.intersectObject(body, false)[0];
    if (!hit) return null;
    const local = body.worldToLocal(hit.point.clone());
    const push = body.worldToLocal(hit.point.clone().add(raycaster.ray.direction)).sub(local).normalize();
    return { local, push };
  }
  // 손가락이 가리키는 바닥 위 지점 (끌어서 옮길 때)
  function floorPoint(e) { if (!castFrom(e)) return null; return raycaster.ray.intersectPlane(floorPlane, new THREE.Vector3()); }
  // 한 점을 누르면 그 둘레가 들어가고, 반대쪽이 살짝 부풀어 오릅니다.
  function impulse(hit, strength, radius = 0.5) {
    const p = hit.local, far = p.clone().normalize().multiplyScalar(-1);
    if (![p.x, p.y, p.z, hit.push.x, hit.push.y, hit.push.z, strength].every(Number.isFinite)) { console.warn('slime: bad impulse', hit, strength); return; }
    for (let i = 0; i < count; i++) {
      const dx = rest[i * 3] - p.x, dy = rest[i * 3 + 1] - p.y, dz = rest[i * 3 + 2] - p.z;
      const w = Math.exp(-(dx * dx + dy * dy + dz * dz) / (radius * radius));
      const fx = rest[i * 3] - far.x, fy = rest[i * 3 + 1] - far.y, fz = rest[i * 3 + 2] - far.z;
      const w2 = Math.exp(-(fx * fx + fy * fy + fz * fz) / 0.9) * 0.3;
      vel[i * 3] += (hit.push.x * w - far.x * w2) * strength;
      vel[i * 3 + 1] += (hit.push.y * w - far.y * w2) * strength;
      vel[i * 3 + 2] += (hit.push.z * w - far.z * w2) * strength;
    }
  }
  // 한 축으로 눌리면 다른 두 축은 퍼집니다 (부피 지키기)
  function squish(axis, amount) { for (let a = 0; a < 3; a++) sqv[a] += a === axis ? -amount : amount * 0.45; }
  function poke(hit) { impulse(hit, 2.6); squish(1, 1.6); pokes++; onPoke(pokes); }
  function nudge() { // 가만히 있을 때 가끔 스스로 꿈틀
    tmp.set(Math.random() - 0.5, Math.random() * 0.6, Math.random() - 0.5).normalize();
    impulse({ local: tmp.clone(), push: tmp.clone().negate() }, 0.5, 0.7);
  }
  // 벽·바닥에 닿을 때: 그 방향으로 눌리고, 부딪힌 면이 출렁입니다.
  function bump(axis, speed) {
    squish(axis, Math.min(2.2, speed * 0.9));
    tmp.set(0, 0, 0); tmp.setComponent(axis, Math.sign(go.getComponent(axis)) || 1);
    const localDir = tmp.clone().applyQuaternion(group.quaternion.clone().invert());
    impulse({ local: localDir.clone(), push: localDir.clone().negate() }, Math.min(2, speed * 0.5), 0.75);
  }

  canvas.addEventListener('pointerdown', e => {
    try { canvas.setPointerCapture(e.pointerId); } catch {}
    const hit = pick(e), fp = floorPoint(e);
    down = { x: e.clientX, y: e.clientY, t: performance.now(), moved: false, hit, grab: hit && fp ? fp.clone().sub(at).setY(0) : null, last: fp, lastT: performance.now(), fling: new THREE.Vector3() };
  });
  canvas.addEventListener('pointermove', e => {
    if (!down) return;
    const dx = e.clientX - down.x, dy = e.clientY - down.y;
    if (!down.moved && Math.hypot(dx, dy) > 8) { down.moved = true; pressing = null; }
    if (!down.moved) return;
    if (down.grab) {                                    // 슬라임을 잡고 끌기 — 손가락 아래로 따라옵니다
      const fp = floorPoint(e); if (!fp) return;
      const now = performance.now(), dt = Math.max(0.008, (now - down.lastT) / 1000);
      const target = fp.clone().sub(down.grab).setY(0);
      down.fling.lerp(target.clone().sub(at).divideScalar(dt), 0.5);   // 최근 손 속도
      go.set(0, go.y, 0); at.x = target.x; at.z = target.z;
      down.last = fp; down.lastT = now;
    } else {                                            // 빈 데서 끌면 돌려 봅니다
      spin += dx * 0.012; tilt = THREE.MathUtils.clamp(tilt + dy * 0.005, -0.45, 0.45);
    }
    down.x = e.clientX; down.y = e.clientY;
  });
  const release = e => {
    if (!down) return;
    if (!down.moved && down.hit) { if (pressing) { impulse(pressing, -1.2); squish(1, -1.2); pokes++; onPoke(pokes); } else poke(down.hit); }
    else if (down.moved && down.grab && performance.now() - down.lastT < 120) {   // 던지기
      const f = down.fling.clone().setY(0), speed = Math.min(7, f.length());
      if (speed > 0.6) { f.setLength(speed); go.set(f.x, Math.min(3.2, speed * 0.55), f.z); pokes++; onPoke(pokes); }
    }
    down = null; pressing = null;
  };
  canvas.addEventListener('pointerup', release); canvas.addEventListener('pointercancel', release);

  function step(dt) {
    const k = look.firmness, c = look.damping, couple = 18;
    if (down && !down.moved && down.hit && performance.now() - down.t > 160) pressing = down.hit;
    if (pressing) { impulse(pressing, 0.35 * dt * 8, 0.45); squish(1, 0.9 * dt * 4); }
    // 표면
    for (let i = 0; i < count; i++) {
      const n = nb[i]; let ax = 0, ay = 0, az = 0;
      for (let j = 0; j < n.length; j++) { const m = n[j] * 3; ax += off[m]; ay += off[m + 1]; az += off[m + 2]; }
      const inv = n.length ? 1 / n.length : 0, b = i * 3;   // 구 꼭대기엔 이웃 없는 점이 있습니다
      const cp = n.length ? couple : 0;
      vel[b] += (-k * off[b] - c * vel[b] + cp * (ax * inv - off[b])) * dt;
      vel[b + 1] += (-k * off[b + 1] - c * vel[b + 1] + cp * (ay * inv - off[b + 1])) * dt;
      vel[b + 2] += (-k * off[b + 2] - c * vel[b + 2] + cp * (az * inv - off[b + 2])) * dt;
      off[b] += vel[b] * dt; off[b + 1] += vel[b + 1] * dt; off[b + 2] += vel[b + 2] * dt;
      pos.setXYZ(i, rest[b] + off[b], rest[b + 1] + off[b + 1], rest[b + 2] + off[b + 2]);
    }
    pos.needsUpdate = true; geometry.computeVertexNormals();
    // 던져진 뒤: 중력, 바닥에 통통, 벽에 튕김, 미끄러지다 멈춤
    const dragging = down?.moved && down.grab;
    if (!dragging) {
      if (at.y > 0 || go.y > 0) go.y -= 9.5 * dt;
      at.addScaledVector(go, dt);
      if (at.y <= 0) { at.y = 0; if (go.y < -0.4) { bump(1, -go.y); go.y = -go.y * 0.45; } else go.y = 0; }
      const onFloor = at.y === 0;
      if (onFloor) { const slow = Math.exp(-2.2 * dt); go.x *= slow; go.z *= slow; if (Math.hypot(go.x, go.z) < 0.04) { go.x = go.z = 0; } }
      if (at.x > bounds.x) { at.x = bounds.x; if (go.x > 0.3) bump(0, go.x); go.x = -go.x * 0.55; }
      if (at.x < -bounds.x) { at.x = -bounds.x; if (go.x < -0.3) bump(0, -go.x); go.x = -go.x * 0.55; }
      if (at.z > bounds.zNear) { at.z = bounds.zNear; if (go.z > 0.3) bump(2, go.z); go.z = -go.z * 0.55; }
      if (at.z < bounds.zFar) { at.z = bounds.zFar; if (go.z < -0.3) bump(2, -go.z); go.z = -go.z * 0.55; }
    } else { at.x = THREE.MathUtils.clamp(at.x, -bounds.x, bounds.x); at.z = THREE.MathUtils.clamp(at.z, bounds.zFar, bounds.zNear); }
    // 몸 전체의 눌림 스프링
    for (let a = 0; a < 3; a++) { sqv[a] += (-k * 0.9 * (sq[a] - 1) - c * 1.4 * sqv[a]) * dt; sq[a] = THREE.MathUtils.clamp(sq[a] + sqv[a] * dt, 0.55, 1.4); }
    const breathe = reduced ? 0 : Math.sin(performance.now() / 1900) * 0.012;
    const sy = sq[1] + breathe;
    group.scale.set(BASE * sq[0], BASE * sy, BASE * sq[2]);
    group.position.set(at.x, FLOOR + 0.6 * BASE * sy + at.y, at.z);
    group.rotation.set(tilt, spin, THREE.MathUtils.clamp(-go.x * 0.06, -0.3, 0.3));   // 움직이는 쪽으로 살짝 기웁니다
    const lift = 1 - Math.min(0.7, at.y * 0.35);
    shadow.position.set(at.x, FLOOR - 0.005, at.z); shadow.scale.setScalar(BASE * (sq[0] + sq[2]) * 0.55 * lift * 1.05);
    shadow.material.opacity = (0.9 + (1 - sy) * 0.6) * lift;
    // 눈: 표면 흔들림을 따라가고, 가끔 깜빡
    for (let e = 0; e < 2; e++) { const i = nearest[e]; eyes[e].position.set(eyeRest[e].x + off[i * 3], eyeRest[e].y + off[i * 3 + 1], eyeRest[e].z + off[i * 3 + 2]); eyes[e].scale.y = blink > 0 ? 0.12 : 1; }
    blinkTimer -= dt; if (blinkTimer <= 0) { blink = 0.12; blinkTimer = 2.5 + Math.random() * 4; } if (blink > 0) blink -= dt;
    if (!reduced && !down) { idleTimer -= dt; if (idleTimer <= 0) { nudge(); idleTimer = 4 + Math.random() * 6; } }
  }
  function resize() {
    const w = container.clientWidth, h = container.clientHeight || w;
    if (!w || !h) return;
    renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix();
    bounds.x = Math.max(0.5, 1.7 * camera.aspect - 0.75);   // 화면 가장자리 안쪽에서 튕기도록
  }
  const ro = new ResizeObserver(resize); ro.observe(container); resize();

  function frame(now) {
    if (!running) return;
    const dt = Math.min(0.033, (now - lastT) / 1000); lastT = now;
    step(dt); renderer.render(scene, camera);
  }
  renderer.setAnimationLoop(frame);
  const onVisible = () => { if (document.hidden) renderer.setAnimationLoop(null); else { lastT = performance.now(); renderer.setAnimationLoop(frame); } };
  document.addEventListener('visibilitychange', onVisible);

  const api = {
    // 표면이 얼마나 움직이고 있는지 (확인용)
    tick(dt = 1 / 60) { step(dt); renderer.render(scene, camera); },   // 화면이 숨겨져 있을 때 확인용
    energy() { let m = 0; for (let i = 0; i < off.length; i++) m = Math.max(m, Math.abs(off[i])); return { surface: m, squash: sq[1], at: at.toArray().map(v => +v.toFixed(3)), speed: +go.length().toFixed(3), spin, pokes }; },
    setLook(next) {
      look = { ...look, ...next };
      material.color.set(look.color); material.attenuationColor.set(look.color); material.transmission = look.clarity;
    },
    poke() { tmp.set(0.1, 0.4, 0.9).normalize(); poke({ local: tmp.clone(), push: tmp.clone().negate() }); },
    throw(x = 4, z = 0) { go.set(x, Math.min(3.2, Math.hypot(x, z) * 0.55), z); },   // 확인용
    destroy() {
      running = false; renderer.setAnimationLoop(null); ro.disconnect(); document.removeEventListener('visibilitychange', onVisible);
      geometry.dispose(); material.dispose(); eyeMat.dispose(); shadowTex.dispose(); shadow.geometry.dispose(); shadow.material.dispose();
      scene.environment?.dispose(); renderer.dispose(); canvas.remove(); delete container.__slime;
    }
  };
  container.__slime = api;
  return api;
}
