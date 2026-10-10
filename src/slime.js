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
  camera.position.set(0, 0.95, 4.9); camera.lookAt(0, -0.15, 0);
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
  shadow.rotation.x = -Math.PI / 2; shadow.position.y = -0.62; scene.add(shadow);

  // 물리 상태
  let squash = 1, squashVel = 0, tilt = 0, spin = 0.25, lastT = performance.now(), idleTimer = 0, blinkTimer = 2.5, blink = 0;
  let down = null, pressing = null, pokes = 0, running = true;
  const raycaster = new THREE.Raycaster(), ndc = new THREE.Vector2(), tmp = new THREE.Vector3(), dir = new THREE.Vector3();

  function pick(e) {
    const r = canvas.getBoundingClientRect();
    if (!r.width || !r.height) return null;   // 화면에 안 보일 때
    ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    const hit = raycaster.intersectObject(body, false)[0];
    if (!hit) return null;
    const local = body.worldToLocal(hit.point.clone());
    const push = body.worldToLocal(hit.point.clone().add(raycaster.ray.direction)).sub(local).normalize();
    return { local, push };
  }
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
  function poke(hit) { impulse(hit, 2.6); squashVel -= 1.6; pokes++; onPoke(pokes); }
  function nudge() { // 가만히 있을 때 가끔 스스로 꿈틀
    tmp.set(Math.random() - 0.5, Math.random() * 0.6, Math.random() - 0.5).normalize();
    impulse({ local: tmp.clone(), push: tmp.clone().negate() }, 0.5, 0.7);
  }

  canvas.addEventListener('pointerdown', e => { try { canvas.setPointerCapture(e.pointerId); } catch {} down = { x: e.clientX, y: e.clientY, t: performance.now(), moved: false, hit: pick(e) }; });
  canvas.addEventListener('pointermove', e => {
    if (!down) return;
    const dx = e.clientX - down.x, dy = e.clientY - down.y;
    if (!down.moved && Math.hypot(dx, dy) > 8) { down.moved = true; pressing = null; }
    if (down.moved) { spin += dx * 0.012; tilt = THREE.MathUtils.clamp(tilt + dy * 0.005, -0.45, 0.45); down.x = e.clientX; down.y = e.clientY; }
  });
  const release = e => {
    if (!down) return;
    const held = performance.now() - down.t;
    if (!down.moved && down.hit) { if (pressing) { impulse(pressing, -1.2); squashVel += 1.2; pokes++; onPoke(pokes); } else poke(down.hit); }
    down = null; pressing = null;
  };
  canvas.addEventListener('pointerup', release); canvas.addEventListener('pointercancel', release);

  function step(dt) {
    const k = look.firmness, c = look.damping, couple = 18;
    if (down && !down.moved && down.hit && performance.now() - down.t > 160) pressing = down.hit;
    if (pressing) { impulse(pressing, 0.35 * dt * 8, 0.45); squashVel -= 0.9 * dt * 4; }
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
    // 몸 전체가 눌렸다 펴지는 스프링 (부피를 지키려고 옆으로 퍼집니다)
    squashVel += (-k * 0.9 * (squash - 1) - c * 1.4 * squashVel) * dt; squash += squashVel * dt;
    squash = THREE.MathUtils.clamp(squash, 0.6, 1.3);
    const breathe = reduced ? 0 : Math.sin(performance.now() / 1900) * 0.012;
    const sy = squash + breathe, sxz = 1 / Math.sqrt(sy);
    group.scale.set(sxz, sy, sxz); group.position.y = -0.6 + 0.6 * sy;
    group.rotation.set(tilt, spin, 0);
    shadow.scale.setScalar(sxz * (1.05 - (sy - 1) * 0.3)); shadow.material.opacity = 0.9 + (1 - sy) * 0.6;
    // 눈: 표면 흔들림을 따라가고, 가끔 깜빡
    for (let e = 0; e < 2; e++) { const i = nearest[e]; eyes[e].position.set(eyeRest[e].x + off[i * 3], eyeRest[e].y + off[i * 3 + 1], eyeRest[e].z + off[i * 3 + 2]); eyes[e].scale.y = blink > 0 ? 0.12 : 1; }
    blinkTimer -= dt; if (blinkTimer <= 0) { blink = 0.12; blinkTimer = 2.5 + Math.random() * 4; } if (blink > 0) blink -= dt;
    if (!reduced && !down) { idleTimer -= dt; if (idleTimer <= 0) { nudge(); idleTimer = 4 + Math.random() * 6; } }
  }
  function resize() {
    const w = container.clientWidth, h = container.clientHeight || w;
    if (!w || !h) return;
    renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix();
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
    energy() { let m = 0; for (let i = 0; i < off.length; i++) m = Math.max(m, Math.abs(off[i])); return { surface: m, squash, spin, pokes }; },
    setLook(next) {
      look = { ...look, ...next };
      material.color.set(look.color); material.attenuationColor.set(look.color); material.transmission = look.clarity;
    },
    poke() { tmp.set(0.1, 0.4, 0.9).normalize(); poke({ local: tmp.clone(), push: tmp.clone().negate() }); },
    destroy() {
      running = false; renderer.setAnimationLoop(null); ro.disconnect(); document.removeEventListener('visibilitychange', onVisible);
      geometry.dispose(); material.dispose(); eyeMat.dispose(); shadowTex.dispose(); shadow.geometry.dispose(); shadow.material.dispose();
      scene.environment?.dispose(); renderer.dispose(); canvas.remove(); delete container.__slime;
    }
  };
  container.__slime = api;
  return api;
}
