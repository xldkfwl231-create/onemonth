// 말랑한 3D 슬라임.
//  톡 치면 출렁 · 잡아당기면 엿처럼 늘어났다 되돌아옴 · 세게 당겼다 놓으면 날아가 구르다 떨어짐
//  빈 데를 끌면 카메라가 돌고, 두 손가락(또는 휠)으로 확대·축소.
// 모습(색·투명도·단단함)은 밖에서 정해 줍니다 — 나중에 요약이 정하게 될 자리입니다.
import * as THREE from '../vendor/three.module.min.js';

export const DEFAULT_LOOK = { color: '#a9d3a4', clarity: 0.62, firmness: 42, damping: 4.2 };

export function mountSlime(container, { look = {}, onPoke = () => {}, onBead = () => {}, onDoubleTap = () => {}, reduced = false } = {}) {
  look = { ...DEFAULT_LOOK, ...look };
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'low-power' });
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  const canvas = renderer.domElement;
  canvas.style.touchAction = 'none';
  canvas.setAttribute('aria-label', '슬라임. 톡 치거나 잡아당겨 보세요.');
  container.appendChild(canvas);

  const BASE = 0.8, FLOOR = -0.64;                         // 몸 크기, 바닥 높이
  const bounds = { x: 1.3, z: 1.2 };                       // 벽 — 화면 크기에 맞춰 다시 잽니다
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 40);
  const orbit = { theta: 0.12, phi: 0.42, dist: 6.2 };     // 카메라: 돌아가는 각, 내려다보는 각, 거리
  const lookAt = new THREE.Vector3(0, FLOOR + 0.45, 0);
  function placeCamera() {
    const { theta, phi, dist } = orbit;
    camera.position.set(lookAt.x + dist * Math.cos(phi) * Math.sin(theta), lookAt.y + dist * Math.sin(phi), lookAt.z + dist * Math.cos(phi) * Math.cos(theta));
    camera.lookAt(lookAt); fitArena();
  }
  placeCamera();

  // 빛: 한쪽에서 세게 와서 그림자가 길게 지도록
  const hemi = new THREE.HemisphereLight(0xfff7e8, 0xc9cdb8, 0.75); scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xfff4df, 2.4); sun.position.set(2.6, 5.2, 2.2); sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024); sun.shadow.camera.left = sun.shadow.camera.bottom = -3.2; sun.shadow.camera.right = sun.shadow.camera.top = 3.2;
  sun.shadow.camera.near = 1; sun.shadow.camera.far = 14; sun.shadow.radius = 4; sun.shadow.bias = -0.0006; scene.add(sun);
  const rim = new THREE.DirectionalLight(0xe2ebff, 0.6); rim.position.set(-3, 2.5, -2.5); scene.add(rim);
  const floor = new THREE.Mesh(new THREE.CircleGeometry(3, 48), new THREE.ShadowMaterial({ opacity: 0.22 }));   // 그림자 범위 안에서만 — 넓으면 가장자리에 네모난 경계가 보임
  floor.rotation.x = -Math.PI / 2; floor.position.y = FLOOR; floor.receiveShadow = true; scene.add(floor);

  // 종이 톤의 작은 방을 비춰서 젤리 표면에 부드러운 반사가 생기게 합니다.
  const pmrem = new THREE.PMREMGenerator(renderer);
  const room = new THREE.Scene(); room.background = new THREE.Color(0xefe9db);
  const pane = (color, x, y, z, size) => { const m = new THREE.Mesh(new THREE.PlaneGeometry(size, size), new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide })); m.position.set(x, y, z); m.lookAt(0, 0, 0); room.add(m); };
  pane(0xffffff, 2, 4, 2, 4); pane(0xfff0d6, -3.5, 2, 1, 3); pane(0xd7e1ea, 0, 1.5, -4, 5); pane(0xffffff, 0, 5, 0, 2.5);
  scene.environment = pmrem.fromScene(room, 0.05).texture;
  pmrem.dispose();

  // 몸: 아래가 넓고 바닥이 눌린 덩어리. 중심이 원점, 바닥이 y = -0.5
  const geometry = new THREE.SphereGeometry(1, 56, 36);
  const pos = geometry.attributes.position, count = pos.count;
  const rest = new Float32Array(count * 3), off = new Float32Array(count * 3), vel = new Float32Array(count * 3);
  const height = new Float32Array(count), wPull = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    let x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const wide = 1 + 0.16 * Math.max(0, -y);                                        // 아래쪽이 넓게
    const bulge = 1 + 0.02 * Math.sin(3.1 * x + 1) * Math.sin(2.3 * z);
    x *= wide * bulge; z *= wide * bulge; y *= 0.88;
    if (y < -0.5) y = -0.5 + (y + 0.5) * 0.18;
    rest[i * 3] = x; rest[i * 3 + 1] = y; rest[i * 3 + 2] = z;
    height[i] = Math.pow(THREE.MathUtils.clamp((y + 0.5) / 1.1, 0, 1), 1.6);        // 바닥 0 … 꼭대기 1 (흔들림이 위로 갈수록 큼)
    pos.setXYZ(i, x, y, z);
  }
  const neighbors = Array.from({ length: count }, () => new Set());
  const index = geometry.index.array;
  for (let i = 0; i < index.length; i += 3) { const a = index[i], b = index[i + 1], c = index[i + 2]; neighbors[a].add(b).add(c); neighbors[b].add(a).add(c); neighbors[c].add(a).add(b); }
  const nb = neighbors.map(s => Int32Array.from(s));
  geometry.computeVertexNormals();

  const color = new THREE.Color(look.color);
  const material = new THREE.MeshPhysicalMaterial({
    color, roughness: 0.1, metalness: 0, transmission: look.clarity, thickness: 0.8, ior: 1.22,   // 얇고 덜 굴절되게 — 안의 방울이 또렷하게
    clearcoat: 1, clearcoatRoughness: 0.08, attenuationColor: color.clone(), attenuationDistance: 3.2, envMapIntensity: 1.1
  });
  const body = new THREE.Mesh(geometry, material); body.castShadow = true;
  const group = new THREE.Group(); group.add(body); scene.add(group);

  // 얼굴: 눈 둘, 볼 둘, 입 하나 — 표면 바로 바깥에 붙여서 젤리 너머로 일그러져 보이지 않게
  const eyeMat = new THREE.MeshStandardMaterial({ color: 0x33302a, roughness: 0.35 });
  const cheekMat = new THREE.MeshStandardMaterial({ color: 0xf2a39b, roughness: 0.9, transparent: true, opacity: 0.55 });
  const nearestTo = (x, y, z) => { let best = 0, d = Infinity; for (let i = 0; i < count; i++) { const dd = (rest[i * 3] - x) ** 2 + (rest[i * 3 + 1] - y) ** 2 + (rest[i * 3 + 2] - z) ** 2; if (dd < d) { d = dd; best = i; } } return best; };
  function sticker(mesh, x, y, z, lift = 1.045) {
    const i = nearestTo(x, y, z), r = new THREE.Vector3(rest[i * 3], rest[i * 3 + 1], rest[i * 3 + 2]).multiplyScalar(lift);
    mesh.position.copy(r); mesh.lookAt(r.clone().multiplyScalar(2)); group.add(mesh);
    return { mesh, i, r };
  }
  const eyes = [-0.3, 0.3].map(x => { const e = new THREE.Mesh(new THREE.SphereGeometry(0.075, 20, 14), eyeMat); e.scale.z = 0.45; return sticker(e, x, 0.2, 0.95); });
  const cheeks = [-0.5, 0.5].map(x => sticker(new THREE.Mesh(new THREE.CircleGeometry(0.075, 20), cheekMat), x, 0.06, 0.86, 1.02));
  const mouth = sticker(new THREE.Mesh(new THREE.TorusGeometry(0.075, 0.016, 8, 18, Math.PI), eyeMat), 0, 0.04, 0.98, 1.03);
  mouth.mesh.rotateZ(Math.PI);                                   // 웃는 입이 되도록 호를 아래로
  const stickers = [...eyes, ...cheeks, mouth];

  // ── 방울: 슬라임이 먹은 기록 ── 몸 안에 비쳐 보입니다. 오래된 건 아래, 최근 건 위.
  const BEAD_MAX = 160, BEAD_COLORS = { thought: 0xff7a59, entry: 0xffd23f, answer: 0x5aa2ff };
  const beadGeo = new THREE.IcosahedronGeometry(1, 2);
  const beadMat = new THREE.MeshStandardMaterial({ roughness: 0.3, metalness: 0, emissive: 0x6a6a6a });
  const beadMesh = new THREE.InstancedMesh(beadGeo, beadMat, BEAD_MAX);
  beadMesh.count = 0; beadMesh.frustumCulled = false; group.add(beadMesh);
  let beads = [];                                                // { id, kind, home: Vector3, pos: Vector3, vy, size, falling }
  const hash = str => { let h = 2166136261; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0) / 4294967295; };
  function slotFor(id, rank, total) {
    const y = total <= 1 ? -0.05 : -0.36 + 0.66 * (rank / (total - 1));    // 오래된 순서로 아래에서 위로
    const r = Math.max(0.08, Math.sqrt(Math.max(0, 0.62 - (y * 1.25) ** 2)) * 0.82);
    const a = hash(id) * Math.PI * 2, d = Math.sqrt(hash(id + '·')) * r;
    return new THREE.Vector3(Math.cos(a) * d, y, Math.sin(a) * d);
  }
  const beadColor = new THREE.Color(), m4 = new THREE.Matrix4(), q0 = new THREE.Quaternion(), v3 = new THREE.Vector3();
  function paintBeads() {
    beadMesh.count = beads.length;
    beads.forEach((b, i) => { beadMesh.setColorAt(i, beadColor.set(BEAD_COLORS[b.kind] || 0xffffff)); });
    if (beadMesh.instanceColor) beadMesh.instanceColor.needsUpdate = true;
  }
  // list: [{ id, kind }] 오래된 것부터. drop: 새로 떨어뜨릴 id 목록
  function setBeads(list, drop = []) {
    list = list.slice(-BEAD_MAX);
    const size = THREE.MathUtils.clamp(0.1 - list.length * 0.0003, 0.055, 0.09);
    const old = new Map(beads.map(b => [b.id, b]));
    let delay = 0;
    beads = list.map((it, rank) => {
      const home = slotFor(it.id, rank, list.length), prev = old.get(it.id);
      if (prev) return { ...prev, kind: it.kind, home, size };
      if (drop.includes(it.id)) { delay += Math.min(0.35, 2.5 / drop.length); return { id: it.id, kind: it.kind, home, size, pos: new THREE.Vector3(home.x * 0.4, 2.6 + delay * 2.2, home.z * 0.4), vy: 0, falling: true, splashed: false }; }
      return { id: it.id, kind: it.kind, home, size, pos: home.clone(), vy: 0, falling: false };
    });
    paintBeads();
  }
  function stepBeads(dt, sag) {
    for (let i = 0; i < beads.length; i++) {
      const b = beads[i];
      if (b.falling) {
        b.vy -= 6 * dt; b.pos.y += b.vy * dt;
        b.pos.x += (b.home.x - b.pos.x) * Math.min(1, dt * 2); b.pos.z += (b.home.z - b.pos.z) * Math.min(1, dt * 2);
        if (!b.splashed && b.pos.y < 0.85) {                     // 몸에 닿는 순간 퐁
          b.splashed = true; b.vy *= 0.25;
          tmp.set(b.pos.x, 0.9, b.pos.z).normalize(); impulse({ local: tmp.clone(), push: new THREE.Vector3(0, -1, 0) }, 2.4, 0.55); squish(1, 1.1); wobble(b.pos.x, b.pos.z, 1.2);
        }
        if (b.pos.y <= b.home.y) { b.pos.copy(b.home); b.falling = false; }
      } else b.pos.lerp(b.home, Math.min(1, dt * 3));
      const h = Math.pow(THREE.MathUtils.clamp((b.pos.y + 0.5) / 1.1, 0, 1), 1.6);   // 몸과 같이 흔들리게
      const wob = 0.012 * Math.sin(performance.now() / 900 + i);
      v3.set(b.pos.x + lean.x * h, b.pos.y - sag * h + wob, b.pos.z + lean.y * h);
      m4.compose(v3, q0, new THREE.Vector3(b.size, b.size, b.size)); beadMesh.setMatrixAt(i, m4);
    }
    beadMesh.instanceMatrix.needsUpdate = true;
  }
  function pickBead(e) {
    if (!beads.length || !castFrom(e.clientX, e.clientY)) return null;
    beadMesh.computeBoundingSphere();
    const hit = raycaster.intersectObject(beadMesh, false)[0];
    return hit && hit.instanceId != null ? beads[hit.instanceId]?.id : null;
  }

  // ── 밤: 어두워지고 눈을 감고 졺. 만지면 잠깐 깹니다 ──
  let night = false, awakeUntil = 0;

  // ── 물리 상태 ──
  // lean: 윗부분이 옆으로 기우는 젤리 흔들림 / pull: 잡아당긴 만큼 늘어남 / sq: 세 축 눌림 / off: 표면의 잔물결
  const lean = new THREE.Vector2(), leanV = new THREE.Vector2();
  const pull = new THREE.Vector3(), pullV = new THREE.Vector3(); let grabLocal = null;
  const sq = [1, 1, 1], sqv = [0, 0, 0];
  const HOME = new THREE.Vector3(0, 0, -0.75);                                   // 쉬는 자리 — 화면 위쪽, 질문 상자에 안 가리게
  const at = HOME.clone(), go = new THREE.Vector3();                             // 자리(x·z 바닥, y 뛰어오른 높이), 속도
  const tumble = new THREE.Quaternion(), spinAxis = new THREE.Vector3(0, 0, 1); let spinRate = 0;   // 날아가며 구르기
  let lastT = performance.now(), idleTimer = 1.5, blinkTimer = 2.5, blink = 0;
  let down = null, pressing = null, pinch = null, pokes = 0, running = true, lastTap = 0;
  const pointers = new Map();
  const raycaster = new THREE.Raycaster(), ndc = new THREE.Vector2(), tmp = new THREE.Vector3();
  const dragPlane = new THREE.Plane();

  function castFrom(x, y) {
    const r = canvas.getBoundingClientRect();
    if (!r.width || !r.height) return false;   // 화면에 안 보일 때
    ndc.set(((x - r.left) / r.width) * 2 - 1, -((y - r.top) / r.height) * 2 + 1);
    raycaster.setFromCamera(ndc, camera); return true;
  }
  function pick(e) {
    if (!castFrom(e.clientX, e.clientY)) return null;
    const hit = raycaster.intersectObject(body, false)[0];
    if (!hit) return null;
    const local = body.worldToLocal(hit.point.clone());
    const push = body.worldToLocal(hit.point.clone().add(raycaster.ray.direction)).sub(local).normalize();
    return { local, push, world: hit.point.clone() };
  }
  // 손가락이 가리키는 점 — 잡은 곳을 지나고 카메라를 마주 보는 면 위에서
  function planePoint(e) { if (!castFrom(e.clientX, e.clientY)) return null; return raycaster.ray.intersectPlane(dragPlane, new THREE.Vector3()); }
  const finite = (...v) => v.every(Number.isFinite);

  // 한 점을 누르면 그 둘레가 들어가고, 반대쪽이 살짝 부풀어 오릅니다.
  function impulse(hit, strength, radius = 0.5) {
    const p = hit.local, far = p.clone().normalize().multiplyScalar(-1);
    if (!finite(p.x, p.y, p.z, hit.push.x, hit.push.y, hit.push.z, strength)) return;
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
  function squish(axis, amount) { for (let a = 0; a < 3; a++) sqv[a] += a === axis ? -amount : amount * 0.45; }   // 한 축으로 눌리면 다른 축은 퍼짐
  function wobble(x, z, amount) { leanV.x += x * amount; leanV.y += z * amount; }                                   // 윗부분을 옆으로 밀기
  function poke(hit) { impulse(hit, 2.2); squish(1, 1.4); wobble(hit.push.x, hit.push.z, 3.2); pokes++; onPoke(pokes); }
  function nudge() { const a = Math.random() * Math.PI * 2; wobble(Math.cos(a), Math.sin(a), 0.35 + Math.random() * 0.3); }
  // 벽·바닥에 닿을 때
  function bump(axis, speed) {
    squish(axis, Math.min(2.4, speed * 0.9));
    if (axis !== 1) wobble(axis === 0 ? -Math.sign(go.x) : 0, axis === 2 ? -Math.sign(go.z) : 0, Math.min(3, speed));
    else wobble(go.x, go.z, 0.6);
  }
  function grab(hit) {
    grabLocal = hit.local.clone();
    for (let i = 0; i < count; i++) { const dx = rest[i * 3] - grabLocal.x, dy = rest[i * 3 + 1] - grabLocal.y, dz = rest[i * 3 + 2] - grabLocal.z; wPull[i] = Math.exp(-(dx * dx + dy * dy + dz * dz) / 1.6); }
    camera.getWorldDirection(tmp); dragPlane.setFromNormalAndCoplanarPoint(tmp, hit.world);
  }

  // ── 손짓 ──
  // ── 흔들기 ── 폰을 흔든 세기만큼 슬라임이 날아갑니다. 살짝 흔들면 출렁이기만.
  // 아이폰은 사용자가 화면을 한 번 만진 뒤에야 움직임 센서를 허락받을 수 있어서, 첫 터치 때 묻습니다.
  let motionAsked = false, lastShake = 0, grav = null;
  function askMotion() {
    if (motionAsked) return; motionAsked = true;
    const D = window.DeviceMotionEvent;
    if (D && typeof D.requestPermission === 'function') D.requestPermission().catch(() => {});
  }
  function onMotion(e) {
    if (reduced || down) return;
    let a = e.acceleration;                                     // 중력을 뺀 값 (대부분의 폰)
    if (!a || a.x == null) {                                    // 없으면 중력 포함 값에서 천천히 변하는 부분(중력)을 빼서 씁니다
      const g = e.accelerationIncludingGravity; if (!g || g.x == null) return;
      grav = grav ? { x: grav.x * 0.9 + g.x * 0.1, y: grav.y * 0.9 + g.y * 0.1, z: grav.z * 0.9 + g.z * 0.1 } : { x: g.x, y: g.y, z: g.z };
      a = { x: g.x - grav.x, y: g.y - grav.y, z: g.z - grav.z };
    }
    const m = Math.hypot(a.x, a.y, a.z || 0), now = performance.now();
    if (!Number.isFinite(m) || m < 4 || now - lastShake < 220) return;
    lastShake = now;
    api.shake(-a.x, a.y, m);
  }
  window.addEventListener('devicemotion', onMotion);

  canvas.addEventListener('pointerdown', e => {
    askMotion();
    try { canvas.setPointerCapture(e.pointerId); } catch {}
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2) {                       // 두 손가락: 확대·축소
      const [a, b] = [...pointers.values()]; pinch = { d0: Math.hypot(a.x - b.x, a.y - b.y), dist0: orbit.dist }; down = null; pressing = null; return;
    }
    const hit = pick(e), bead = pickBead(e);
    down = { x: e.clientX, y: e.clientY, t: performance.now(), moved: false, hit, lastT: performance.now(), fling: new THREE.Vector3(), lastP: null, bead };
    if (hit) { grab(hit); down.lastP = hit.world.clone(); }
  });
  canvas.addEventListener('pointermove', e => {
    const p = pointers.get(e.pointerId); if (p) { p.x = e.clientX; p.y = e.clientY; }
    if (pinch && pointers.size >= 2) { const [a, b] = [...pointers.values()]; orbit.dist = THREE.MathUtils.clamp(pinch.dist0 * pinch.d0 / Math.max(10, Math.hypot(a.x - b.x, a.y - b.y)), 3.2, 10); placeCamera(); return; }
    if (!down) return;
    const dx = e.clientX - down.x, dy = e.clientY - down.y;
    if (!down.moved && Math.hypot(dx, dy) > 8) { down.moved = true; pressing = null; }
    if (!down.moved) return;
    if (down.hit) {                                  // 잡아당기기 — 잡은 점이 손가락을 따라 늘어납니다
      const q = planePoint(e); if (!q) return;
      const now = performance.now(), dt = Math.max(0.008, (now - down.lastT) / 1000);
      if (down.lastP) down.fling.lerp(q.clone().sub(down.lastP).divideScalar(dt), 0.5);
      down.lastP = q; down.lastT = now;
      const d = q.clone().sub(down.hit.world);        // 세게 당길수록 덜 늘어나게 (끊기지 않도록)
      const len = d.length(), soft = len < 1.5 ? len : 1.5 + (len - 1.5) * 0.3;
      if (len > 0) d.setLength(Math.min(soft, 2.6));
      pull.copy(body.worldToLocal(body.localToWorld(new THREE.Vector3()).add(d)));
      pullV.set(0, 0, 0);
      lean.set(THREE.MathUtils.clamp(pull.x * 0.35, -0.5, 0.5), THREE.MathUtils.clamp(pull.z * 0.35, -0.5, 0.5));
    } else {                                         // 빈 데: 카메라 돌리기
      orbit.theta -= dx * 0.009; orbit.phi = THREE.MathUtils.clamp(orbit.phi + dy * 0.007, 0.08, 1.45); placeCamera();
    }
    down.x = e.clientX; down.y = e.clientY;
  });
  const release = e => {
    pointers.delete(e.pointerId);
    if (pinch) { if (pointers.size < 2) pinch = null; return; }
    if (!down) return;
    if (!down.moved && down.hit) {
      awakeUntil = performance.now() + 6000;
      if (pressing) { impulse(pressing, -1.2); squish(1, -1.2); pokes++; onPoke(pokes); }
      else {
        const now = performance.now();
        if (now - lastTap < 320) { lastTap = 0; onDoubleTap(); }       // 두 번 톡 → 기록하기
        else { lastTap = now; if (down.bead) { impulse(down.hit, 1.2); onBead(down.bead); } else poke(down.hit); }
      }
    }
    else if (down.moved && down.hit) {
      const f = down.fling.clone(), speed = f.length(), fresh = performance.now() - down.lastT < 120;
      if (fresh && speed > 3.2) {                    // 세게 당겼다 놓기 → 날아갑니다
        f.setLength(Math.min(7.5, speed)); if (f.y < 1.2) f.y = Math.max(f.y, Math.min(3.4, speed * 0.5));
        go.copy(f); if (at.y < 0.01) at.y = 0.02;
        spinAxis.set(0, 1, 0).cross(f).normalize(); if (!finite(spinAxis.x, spinAxis.y, spinAxis.z) || spinAxis.lengthSq() < 0.1) spinAxis.set(0, 0, 1);
        spinRate = Math.min(9, speed * 1.3);
        pull.multiplyScalar(0.3); pokes++; onPoke(pokes);
      }
      pullV.add(pull.clone().multiplyScalar(-6));    // 놓으면 튕겨 돌아갑니다
      wobble(pull.x, pull.z, 4);
    }
    down = null; pressing = null;
  };
  canvas.addEventListener('pointerup', release); canvas.addEventListener('pointercancel', release);
  canvas.addEventListener('wheel', e => { e.preventDefault(); orbit.dist = THREE.MathUtils.clamp(orbit.dist * (1 + e.deltaY * 0.0012), 3.2, 10); placeCamera(); }, { passive: false });

  // ── 한 프레임 ──
  const dq = new THREE.Quaternion(), upright = new THREE.Quaternion();
  function step(dt) {
    const k = look.firmness, c = look.damping, couple = 18;
    const dragging = !!(down?.moved && down.hit);
    if (down && !down.moved && down.hit && performance.now() - down.t > 160) pressing = down.hit;
    if (pressing) { impulse(pressing, 0.35 * dt * 8, 0.45); squish(1, 0.9 * dt * 4); }
    // 늘어남 되돌아오기 (덜 감쇠시켜 몇 번 출렁이게)
    if (!dragging) { pullV.addScaledVector(pull, -k * 1.3 * dt).addScaledVector(pullV, -c * 0.75 * dt); pull.addScaledVector(pullV, dt); if (pull.lengthSq() < 1e-6 && pullV.lengthSq() < 1e-6) { pull.set(0, 0, 0); pullV.set(0, 0, 0); } }
    // 윗부분 흔들림
    leanV.addScaledVector(lean, -k * 1.5 * dt).addScaledVector(leanV, -c * 0.9 * dt); lean.addScaledVector(leanV, dt);
    lean.x = THREE.MathUtils.clamp(lean.x, -0.9, 0.9); lean.y = THREE.MathUtils.clamp(lean.y, -0.9, 0.9);
    // 표면 잔물결
    for (let i = 0; i < count; i++) {
      const n = nb[i]; let ax = 0, ay = 0, az = 0;
      for (let j = 0; j < n.length; j++) { const m = n[j] * 3; ax += off[m]; ay += off[m + 1]; az += off[m + 2]; }
      const inv = n.length ? 1 / n.length : 0, b = i * 3, cp = n.length ? couple : 0;
      vel[b] += (-k * off[b] - c * vel[b] + cp * (ax * inv - off[b])) * dt;
      vel[b + 1] += (-k * off[b + 1] - c * vel[b + 1] + cp * (ay * inv - off[b + 1])) * dt;
      vel[b + 2] += (-k * off[b + 2] - c * vel[b + 2] + cp * (az * inv - off[b + 2])) * dt;
      off[b] += vel[b] * dt; off[b + 1] += vel[b + 1] * dt; off[b + 2] += vel[b + 2] * dt;
    }
    // 꼭짓점 자리 = 원래 + 흔들림(높이만큼) + 늘어남(잡은 곳 가까울수록) + 잔물결
    const stretching = pull.lengthSq() > 1e-6, sag = (lean.x * lean.x + lean.y * lean.y) * 0.25;
    for (let i = 0; i < count; i++) {
      const b = i * 3, h = height[i], w = stretching ? wPull[i] : 0;
      pos.setXYZ(i, rest[b] + lean.x * h + pull.x * w + off[b], rest[b + 1] + pull.y * w + off[b + 1] - sag * h, rest[b + 2] + lean.y * h + pull.z * w + off[b + 2]);
    }
    pos.needsUpdate = true; geometry.computeVertexNormals();
    // 날아가기: 중력, 구르기, 바닥·벽에 튕김, 미끄러지다 멈춤
    const flying = at.y > 0 || go.lengthSq() > 0;
    if (!dragging && flying) {
      go.y -= 9.5 * dt; at.addScaledVector(go, dt);
      if (spinRate > 0) { dq.setFromAxisAngle(spinAxis, spinRate * dt); tumble.premultiply(dq); }
      if (at.y <= 0) {
        at.y = 0;
        if (go.y < -0.6) { bump(1, -go.y); go.y = -go.y * 0.42; spinRate *= 0.45; }
        else { go.y = 0; spinRate = 0; const slow = Math.exp(-2.6 * dt); go.x *= slow; go.z *= slow; if (Math.hypot(go.x, go.z) < 0.05) go.set(0, 0, 0); }
      }
      for (const [axis, key] of [[0, 'x'], [2, 'z']]) {
        const lim = bounds[key], hi = key === 'z' ? lim * 0.3 : lim;   // 화면 아래쪽(카메라 쪽)은 말풍선에 가리니 조금만
        if (at[key] > hi) { at[key] = hi; if (go[key] > 0.3) bump(axis, go[key]); go[key] = -go[key] * 0.55; }
        if (at[key] < -lim) { at[key] = -lim; if (go[key] < -0.3) bump(axis, -go[key]); go[key] = -go[key] * 0.55; }
      }
    }
    if (at.y === 0 && spinRate === 0) tumble.slerp(upright, 1 - Math.exp(-7 * dt));   // 떨어지면 다시 바로 섭니다
    // 바닥에 내려앉으면 천천히 가운데로 미끄러져 돌아옵니다 (오목한 접시 위처럼)
    if (!dragging && at.y === 0 && (at.x !== HOME.x || at.z !== HOME.z)) { const dx = at.x - HOME.x, dz = at.z - HOME.z, d = Math.hypot(dx, dz); if (d < 0.12 && go.lengthSq() < 0.04) { at.x = HOME.x; at.z = HOME.z; go.set(0, 0, 0); } else { go.x -= dx * 2.6 * dt; go.z -= dz * 2.6 * dt; const slow = Math.exp(-1.2 * dt); go.x *= slow; go.z *= slow; at.x += go.x * dt * (flying ? 0 : 1); at.z += go.z * dt * (flying ? 0 : 1); } }
    // 몸 전체의 눌림 스프링
    for (let a = 0; a < 3; a++) { sqv[a] += (-k * 0.9 * (sq[a] - 1) - c * 1.4 * sqv[a]) * dt; sq[a] = THREE.MathUtils.clamp(sq[a] + sqv[a] * dt, 0.55, 1.4); }
    const breathe = reduced ? 0 : Math.sin(performance.now() / 1900) * 0.012;
    const sy = sq[1] + breathe;
    group.scale.set(BASE * sq[0], BASE * sy, BASE * sq[2]);
    group.quaternion.copy(tumble);
    group.position.set(at.x, FLOOR + 0.5 * BASE * sy + at.y, at.z);
    // 얼굴: 흔들림과 늘어남을 따라감, 눈은 가끔 깜빡
    for (const { mesh, i, r } of stickers) {
      const h = height[i], w = stretching ? wPull[i] : 0;
      mesh.position.set(r.x + lean.x * h + pull.x * w + off[i * 3], r.y + pull.y * w + off[i * 3 + 1] - sag * h, r.z + lean.y * h + pull.z * w + off[i * 3 + 2]);
    }
    stepBeads(dt, sag);
    const asleep = night && performance.now() > awakeUntil;
    for (const e of eyes) e.mesh.scale.y = asleep ? 0.1 : blink > 0 ? 0.12 : 1;
    blinkTimer -= dt; if (blinkTimer <= 0) { blink = 0.12; blinkTimer = 2.5 + Math.random() * 4; } if (blink > 0) blink -= dt;
    if (!reduced && !down && !flying) { idleTimer -= dt; if (idleTimer <= 0) { nudge(); idleTimer = 3.5 + Math.random() * 5; } }
  }

  function resize() {
    const w = container.clientWidth, h = container.clientHeight || w;
    if (!w || !h) return;
    renderer.setSize(w, h, false); camera.aspect = w / h;
    // 가로 시야를 고정해서 세로로 긴 폰에서도 슬라임이 화면의 절반쯤 차지하게
    camera.fov = THREE.MathUtils.clamp(2 * Math.atan(0.285 / camera.aspect) * 180 / Math.PI, 24, 88);
    camera.updateProjectionMatrix(); fitArena();
  }
  // 보이는 화면 안에서만 튕기도록 — 카메라 거리와 비율로 벽을 잽니다
  function fitArena() {
    const halfH = Math.tan(camera.fov * Math.PI / 360) * orbit.dist, halfW = halfH * camera.aspect;
    bounds.x = Math.max(0.5, halfW * 0.82 - 0.55); bounds.z = Math.max(0.5, Math.min(3, halfH * 0.5));
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
    tick(dt = 1 / 60) { step(dt); renderer.render(scene, camera); },   // 화면이 숨겨져 있을 때 확인용
    energy() { let m = 0; for (let i = 0; i < off.length; i++) m = Math.max(m, Math.abs(off[i])); return { surface: +m.toFixed(4), lean: +lean.length().toFixed(3), pull: +pull.length().toFixed(3), squash: +sq[1].toFixed(3), at: at.toArray().map(v => +v.toFixed(3)), speed: +go.length().toFixed(3), spin: +spinRate.toFixed(2), orbit: { ...orbit }, pokes }; },
    poke() { tmp.set(0.1, 0.4, 0.9).normalize(); poke({ local: tmp.clone(), push: tmp.clone().negate() }); },
    // 흔들기: (x, y) 는 화면 기준 방향(오른쪽 +, 위 +), strength 는 m/s²
    shake(x, y, strength) {
      const dir = new THREE.Vector2(x, -y); if (dir.lengthSq() < 1e-4) dir.set(Math.random() - 0.5, Math.random() - 0.5);
      dir.normalize().rotateAround(new THREE.Vector2(), (Math.random() - 0.5) * 0.6);   // 매번 조금씩 다른 데로
      if (strength < 11) { wobble(dir.x, dir.y, Math.min(3, strength * 0.35)); squish(1, Math.min(1.2, strength * 0.12)); return; }
      const speed = THREE.MathUtils.clamp((strength - 8) * 0.55, 2.5, 9);
      go.set(dir.x * speed, Math.min(4.2, 1.2 + speed * 0.45), dir.y * speed); if (at.y < 0.01) at.y = 0.02;
      spinAxis.set(0, 1, 0).cross(go).normalize(); if (spinAxis.lengthSq() < 0.1) spinAxis.set(0, 0, 1);
      spinRate = Math.min(10, speed * 1.4); squish(1, 1.2);
      pokes++; onPoke(pokes);
    },
    stretch(x = 1.2, y = 0.3, z = 0) { tmp.set(0.2, 0.3, 0.9).normalize(); grab({ local: tmp.clone(), push: tmp.clone().negate(), world: body.localToWorld(tmp.clone()) }); pull.set(x, y, z); pullV.set(0, 0, 0); },   // 확인용
    throw(x = 4, z = 0) { go.set(x, Math.min(3.4, Math.hypot(x, z) * 0.5), z); at.y = 0.02; spinAxis.set(0, 1, 0).cross(go).normalize(); spinRate = Math.min(9, go.length() * 1.3); },   // 확인용
    setBeads,
    beadCount() { return { total: beads.length, falling: beads.filter(b => b.falling).length }; },   // 확인용
    setNight(on) {
      night = !!on;
      sun.intensity = night ? 0.9 : 2.4; sun.color.set(night ? 0xbfc8ff : 0xfff4df);
      hemi.intensity = night ? 0.45 : 0.75; hemi.color.set(night ? 0xb9b4ff : 0xfff7e8);
      beadMat.emissive.set(night ? 0x9a9a9a : 0x6a6a6a);                 // 밤엔 방울이 은은하게 빛남
    },
    setLook(next) {
      look = { ...look, ...next };
      material.color.set(look.color); material.attenuationColor.set(look.color); material.transmission = look.clarity;
    },
    destroy() {
      running = false; window.removeEventListener('devicemotion', onMotion); renderer.setAnimationLoop(null); ro.disconnect(); document.removeEventListener('visibilitychange', onVisible);
      geometry.dispose(); material.dispose(); eyeMat.dispose(); cheekMat.dispose(); beadGeo.dispose(); beadMat.dispose(); beadMesh.dispose(); floor.geometry.dispose(); floor.material.dispose(); sun.shadow.map?.dispose();
      scene.environment?.dispose(); renderer.dispose(); canvas.remove(); delete container.__slime;
    }
  };
  container.__slime = api;
  return api;
}
