// F1 yarışının 3D görünümü (Three.js). Sadece çizer: fizik, tur sayımı, ağ ve girdiler 2D oyunla aynı
// (racing.js). Dünya koordinatı (px) -> metre: 1 px = 0.2 m, 2D (x, y) -> 3D (x, 0, y).
// Kalite (düşük/orta/yüksek): çözünürlük, kenar yumuşatma, gölge, yansıma, görüş mesafesi, ağaç sayısı.
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';

const T = window.TRACK, TD = window.TRACKDRAW;
const S = 0.2; // m / px
const QUALITY = {
  dusuk: { ratio: 0.7, aa: false, shadow: 0, env: false, fogNear: 70, fogFar: 380, trees: 0.3, std: false },
  orta: { ratio: 1.0, aa: true, shadow: 1024, env: false, fogNear: 110, fogFar: 650, trees: 0.65, std: true },
  yuksek: { ratio: 2.0, aa: true, shadow: 2048, env: true, fogNear: 160, fogFar: 1100, trees: 1, std: true },
};
const SKY = 0x9fc9ee;

// Orta çizgiye göre ofsetli nokta (sol normal = (TY, -TX)), metre cinsinden
const ox = (i, off) => (T.X[i] + T.TY[i] * off) * S;
const oz = (i, off) => (T.Y[i] - T.TX[i] * off) * S;

function canvasTex(w, h, draw, repeat) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  if (repeat) {
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = 4;
  }
  return t;
}
function noise(ctx, w, h, base, amp, n, seed) {
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, w, h);
  let s = seed;
  const r = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  for (let k = 0; k < n; k++) {
    const v = Math.floor((r() - 0.5) * amp);
    ctx.fillStyle = `rgba(${v > 0 ? 255 : 0},${v > 0 ? 255 : 0},${v > 0 ? 255 : 0},${Math.abs(v) / 255})`;
    ctx.fillRect(r() * w, r() * h, 1 + r() * 2, 1 + r() * 2);
  }
}

// Şerit: iki ofset arasında pist boyunca dörtgenler. Dar virajda içe katlanan parçalar atlanır.
function ribbon(offA, offB, y, opts = {}) {
  const N = T.N, pos = [], uv = [], col = [], idx = [];
  const keep = opts.keep || (() => true);
  let v = 0;
  for (let i = 0; i <= N; i++) {
    const k = i % N;
    const a = typeof offA === 'function' ? offA(k) : offA, b = typeof offB === 'function' ? offB(k) : offB;
    pos.push(ox(k, a), y, oz(k, a), ox(k, b), y, oz(k, b));
    uv.push(0, v, 1, v);
    if (opts.color) {
      const c = opts.color(k);
      col.push(c.r, c.g, c.b, c.r, c.g, c.b);
    }
    v += (opts.vScale || 0.1);
  }
  for (let i = 0; i < N; i++) {
    const j = (i + 1) % N;
    if (!keep(i)) continue;
    // Katlanma kontrolü: her iki kenar da ileri gitmeli
    const fwd = (off) => (ox(j, off) - ox(i, off)) * T.TX[i] + (oz(j, off) - oz(i, off)) * T.TY[i] > 0;
    const a = typeof offA === 'function' ? offA(i) : offA, b = typeof offB === 'function' ? offB(i) : offB;
    if (!fwd(a) || !fwd(b)) continue;
    const p = i * 2;
    idx.push(p, p + 1, p + 2, p + 1, p + 3, p + 2);
  }
  // Yüzler yukarı baksın: ilk üçgenin normali aşağıysa tüm üçgenlerin sırasını çevir
  if (idx.length) {
    const P = (k) => [pos[k * 3], pos[k * 3 + 1], pos[k * 3 + 2]];
    const [a, b, c] = [P(idx[0]), P(idx[1]), P(idx[2])];
    const ny = (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]);
    if (ny < 0) for (let k = 0; k < idx.length; k += 3) [idx[k + 1], idx[k + 2]] = [idx[k + 2], idx[k + 1]];
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  if (opts.color) g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  // Normaller yukarı baksın (sarım yönünden bağımsız)
  const n = g.attributes.normal;
  for (let k = 0; k < n.count; k++) n.setXYZ(k, 0, 1, 0);
  return g;
}

// Dikey duvar şeridi (bariyer / reklam panoları)
function wall(off, h, color) {
  const N = T.N, pos = [], col = [], idx = [];
  for (let i = 0; i <= N; i++) {
    const k = i % N, c = color(k);
    pos.push(ox(k, off), 0, oz(k, off), ox(k, off), h, oz(k, off));
    col.push(c.r, c.g, c.b, c.r * 0.8, c.g * 0.8, c.b * 0.8);
  }
  for (let i = 0; i < N; i++) {
    const j = (i + 1) % N;
    const fwd = (ox(j, off) - ox(i, off)) * T.TX[i] + (oz(j, off) - oz(i, off)) * T.TY[i] > 0;
    if (!fwd) continue;
    const p = i * 2;
    idx.push(p, p + 2, p + 1, p + 1, p + 2, p + 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

// Geçici araç gövdesi (gerçek .glb model gelene kadar): ölçüler F1'e yakın, +x yönüne bakar
function buildCar(color, mat) {
  const car = new THREE.Group();
  const paint = mat(color, 0.35, 0.4);
  const carbon = mat(0x1b1d22, 0.6, 0.3);
  const tyre = mat(0x111111, 0.9, 0);
  const box = (w, h, d, m, x, y, z) => {
    const o = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
    o.position.set(x, y, z);
    o.castShadow = true;
    car.add(o);
    return o;
  };
  box(4.9, 0.07, 1.4, carbon, 0, 0.1, 0); // taban
  box(2.6, 0.5, 0.8, paint, 0.1, 0.42, 0); // şasi
  const nose = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.3, 1.9, 10), paint);
  nose.rotation.z = Math.PI / 2;
  nose.position.set(2.15, 0.36, 0);
  nose.castShadow = true;
  car.add(nose);
  box(1.6, 0.42, 1.5, paint, -0.35, 0.36, 0); // yan kutular
  box(1.5, 0.45, 0.5, paint, -1.1, 0.8, 0); // motor kapağı / hava girişi
  box(0.55, 0.05, 1.95, carbon, 2.75, 0.12, 0); // ön kanat
  box(0.5, 0.06, 1.0, paint, -2.35, 0.95, 0); // arka kanat
  box(0.5, 0.65, 0.04, carbon, -2.35, 0.65, 0.5);
  box(0.5, 0.65, 0.04, carbon, -2.35, 0.65, -0.5);
  box(0.9, 0.12, 0.55, mat(0x0c0c0e, 0.8, 0), 0.25, 0.68, 0); // kokpit boşluğu
  // Halo: sürücünün başının önünde yatay yay + ortada öne eğik ayak (kokpitten kalın siyah yay olarak görünür)
  const haloMat = mat(0x0b0c0f, 0.35, 0.5);
  const haloG = new THREE.Group();
  const arc = new THREE.Mesh(new THREE.TorusGeometry(0.46, 0.05, 10, 32, Math.PI), haloMat);
  arc.rotation.z = -Math.PI / 2; // yay +x (ön) tarafında
  haloG.add(arc);
  haloG.rotation.x = -Math.PI / 2; // yatay düzleme yatır
  haloG.position.set(-0.28, 1.0, 0);
  car.add(haloG);
  const pillar = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.42, 0.09), haloMat);
  pillar.position.set(0.26, 0.86, 0);
  pillar.rotation.z = -0.55;
  car.add(pillar);
  // Aynalar
  for (const z of [0.62, -0.62]) {
    box(0.04, 0.03, 0.18, carbon, 0.25, 0.86, z * 0.85);
    box(0.08, 0.1, 0.2, paint, 0.27, 0.9, z);
  }
  box(1.6, 0.03, 0.22, mat(0xf4f4f4, 0.4, 0.2), 1.2, 0.5, 0); // burun üstü beyaz şerit
  // Tekerlekler (ön ikisi direksiyonla döner)
  const wheels = [];
  for (const [x, z, front] of [[1.65, 0.82, 1], [1.65, -0.82, 1], [-1.6, 0.8, 0], [-1.6, -0.8, 0]]) {
    const holder = new THREE.Group();
    holder.position.set(x, 0.36, z);
    const w = new THREE.Mesh(new THREE.CylinderGeometry(0.36, 0.36, front ? 0.34 : 0.42, 18), tyre);
    w.rotation.x = Math.PI / 2;
    w.castShadow = true;
    holder.add(w);
    car.add(holder);
    wheels.push({ holder, w, front });
  }
  car.userData.wheels = wheels;
  return car;
}

// Hazır araç modeli (models/f1.glb ayrıntılı, f1_lo.glb rakipler için hafif). Model: Peter Kiss, CC BY-NC-SA.
// Yüklenince: ön kanattan aracın önü bulunur ve +x'e çevrilir, yere oturtulur; tekerlek parçaları kendi
// merkezleri etrafında dönen pivotlara alınır (ön tekerlekler ayrıca direksiyonla döner).
const WHEELS = { fl: [/^fl_/, /^wheel\.Ft\.L/], fr: [/^fr_/, /^wheel\.Ft\.R/], rl: [/^rl_/, /^wheel\.Bk\.L/], rr: [/^rr_/, /^wheel\.Bk\.R/] };
const PAINT = 'Carbon Fiber Procedural'; // modelin gövde malzemesi: oyuncu rengine boyanır
const CARBON = /^Carbon Fiber \(no UV\)/; // prosedürel karbon dışa aktarılamadı: koyu karbon rengi verilir
function prepModel(gltf) {
  const src = gltf.scene;
  src.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(src), ctr = box.getCenter(new THREE.Vector3());
  const fw = src.getObjectByName('front_wing_mixer');
  const fc = fw ? new THREE.Box3().setFromObject(fw).getCenter(new THREE.Vector3()) : ctr.clone().add(new THREE.Vector3(1, 0, 0));
  const yaw = Math.atan2(-(fc.z - ctr.z), fc.x - ctr.x); // önü +x'e döndürmek için
  const root = new THREE.Group();
  const holder = new THREE.Group();
  holder.add(src);
  src.position.sub(ctr);
  holder.rotation.y = -yaw;
  root.add(holder);
  root.updateMatrixWorld(true);
  const b2 = new THREE.Box3().setFromObject(root);
  holder.position.y = -b2.min.y;
  root.updateMatrixWorld(true);
  // Tekerlek pivotları
  const wheels = [];
  for (const [key, pats] of Object.entries(WHEELS)) {
    const parts = [];
    src.traverse((o) => { if (o.isMesh && pats.some((re) => re.test(o.name))) parts.push(o); });
    if (!parts.length) continue;
    const wb = new THREE.Box3();
    for (const o of parts) wb.expandByObject(o);
    const wc = wb.getCenter(new THREE.Vector3());
    const steer = new THREE.Group(), spin = new THREE.Group();
    steer.position.copy(wc);
    root.add(steer);
    steer.add(spin);
    root.updateMatrixWorld(true);
    for (const o of parts) spin.attach(o);
    wheels.push({ key, front: key[0] === 'f' });
  }
  root.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = false; } });
  // Sürücünün başı: kokpit boşluğunun üst ortası (kokpit kamerası buradan bakar)
  const ck = root.getObjectByName('cockpit_inner');
  if (ck) {
    const cb = new THREE.Box3().setFromObject(ck);
    root.userData.head = new THREE.Vector3((cb.min.x + cb.max.x) / 2 - (cb.max.x - cb.min.x) * 0.15, cb.max.y, 0);
  }
  return root;
}
function cloneCar(tpl, color) {
  const car = tpl.clone(true);
  const paint = new Map();
  car.traverse((o) => {
    if (!o.isMesh) return;
    const ms = Array.isArray(o.material) ? o.material : [o.material];
    const out = ms.map((m) => {
      if (CARBON.test(m.name)) {
        if (!paint.has(m)) paint.set(m, new THREE.MeshStandardMaterial({ color: 0x15171b, roughness: 0.45, metalness: 0.3 }));
        return paint.get(m);
      }
      if (m.name !== PAINT) return m;
      if (!paint.has(m)) {
        const p = new THREE.MeshPhysicalMaterial({ color, roughness: 0.32, metalness: 0.15, clearcoat: 0.8, clearcoatRoughness: 0.12 });
        paint.set(m, p);
      }
      return paint.get(m);
    });
    o.material = Array.isArray(o.material) ? out : out[0];
  });
  // Tekerlek pivotlarını isimle bul (klon kendi pivotlarını taşır)
  const wheels = [];
  for (const g of car.children) {
    if (g.isGroup && g.children.length === 1 && g.children[0].isGroup && g !== car.children[0]) {
      wheels.push({ holder: g, w: g.children[0], front: g.position.x > 0, model: true });
    }
  }
  car.userData.wheels = wheels;
  car.userData.head = tpl.userData.head;
  return car;
}

export function create(quality) {
  let Q = QUALITY[quality] || QUALITY.orta, qName = quality;
  let renderer = null, canvas = null;
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(SKY);
  scene.fog = new THREE.Fog(SKY, Q.fogNear, Q.fogFar);
  const camera = new THREE.PerspectiveCamera(78, innerWidth / innerHeight, 0.08, Q.fogFar + 50);
  const mat = (color, rough, metal, extra) => (Q.std
    ? new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal, ...extra })
    : new THREE.MeshLambertMaterial({ color, ...extra }));

  // Işık: gökyüzü + güneş (gölge kamerası aracı takip eder)
  const hemi = new THREE.HemisphereLight(0xdfefff, 0x4d6b35, 1.1);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xfff4e0, 2.2);
  sun.position.set(80, 120, 40);
  scene.add(sun, sun.target);

  const world = new THREE.Group();
  scene.add(world);
  function buildWorld() {
    world.clear();
    const H = T.HALF, K = T.KERB_W, RO = T.RUNOFF, R = T.REGION;
    // Zemin (çim)
    const grassTex = canvasTex(256, 256, (c, w, h) => noise(c, w, h, '#4f7d33', 60, 9000, 7), true);
    grassTex.repeat.set(R.w * S / 12, R.h * S / 12);
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(R.w * S + 600, R.h * S + 600), mat(0xffffff, 1, 0, { map: grassTex }));
    ground.rotation.x = -Math.PI / 2;
    ground.position.set((R.x + R.w / 2) * S, 0, (R.y + R.h / 2) * S);
    ground.receiveShadow = true;
    world.add(ground);
    // Kaçış alanı: biraz daha açık, biçilmiş çim
    const runoffMat = mat(0x5f9440, 1, 0, { polygonOffset: true, polygonOffsetFactor: -1 });
    for (const side of [1, -1]) {
      const m = new THREE.Mesh(ribbon(side * H, side * (H + RO), 0.01), runoffMat);
      m.receiveShadow = true;
      world.add(m);
    }
    // Asfalt
    const asphalt = canvasTex(256, 256, (c, w, h) => noise(c, w, h, '#3d3f43', 70, 14000, 3), true);
    asphalt.repeat.set(4, 1);
    const road = new THREE.Mesh(ribbon(-H, H, 0.02, { vScale: 0.12 }), mat(0xffffff, 0.92, 0, { map: asphalt, polygonOffset: true, polygonOffsetFactor: -2 }));
    road.receiveShadow = true;
    world.add(road);
    // Beyaz kenar çizgileri
    const lineMat = mat(0xf2f2f2, 0.8, 0, { polygonOffset: true, polygonOffsetFactor: -3 });
    for (const side of [1, -1]) world.add(new THREE.Mesh(ribbon(side * (H - 2.5), side * H, 0.025), lineMat));
    // Kerbler: virajlarda kırmızı-beyaz
    const red = new THREE.Color(0xd8262b), white = new THREE.Color(0xf4f4f4);
    const kerbMat = mat(0xffffff, 0.7, 0, { vertexColors: true, polygonOffset: true, polygonOffsetFactor: -4 });
    for (const side of [1, -1]) {
      const bit = side > 0 ? 1 : 2;
      const g = ribbon(side * (H - K), side * (H + 2), 0.04, {
        keep: (i) => !!(T.KERB[i] & bit),
        color: (i) => (Math.floor(i / 2) % 2 ? red : white),
      });
      const m = new THREE.Mesh(g, kerbMat);
      m.receiveShadow = true;
      world.add(m);
    }
    // Lastik bariyerleri + reklam panoları
    const ads = [new THREE.Color(0x1e5bd8), new THREE.Color(0xf2f2f2), new THREE.Color(0xd8262b), new THREE.Color(0x111111), new THREE.Color(0xf2c21b)];
    const wallMat = mat(0xffffff, 0.8, 0, { vertexColors: true, side: THREE.DoubleSide });
    for (const side of [1, -1]) world.add(new THREE.Mesh(wall(side * (H + RO), 1.1, (i) => ads[Math.floor(i / 14) % ads.length]), wallMat));
    // Start/bitiş çizgisi (dama) ve grid kutuları
    const chk = canvasTex(64, 16, (c) => {
      for (let x = 0; x < 16; x++) for (let y = 0; y < 4; y++) { c.fillStyle = (x + y) % 2 ? '#111' : '#fff'; c.fillRect(x * 4, y * 4, 4, 4); }
    });
    chk.magFilter = THREE.NearestFilter;
    const fin = new THREE.Mesh(new THREE.PlaneGeometry(T.ROAD_W * S, 1.6), mat(0xffffff, 0.8, 0, { map: chk, polygonOffset: true, polygonOffsetFactor: -5 }));
    fin.rotation.x = -Math.PI / 2;
    fin.rotation.z = -Math.atan2(T.TY[0], T.TX[0]) + Math.PI / 2;
    fin.position.set(T.X[0] * S, 0.03, T.Y[0] * S);
    world.add(fin);
    for (let k = 0; k < 12; k++) {
      const g = T.gridSlot(k);
      const box = new THREE.Mesh(new THREE.PlaneGeometry(0.5, 2.4), lineMat);
      box.rotation.x = -Math.PI / 2;
      box.rotation.z = -g.a;
      box.position.set((g.x + Math.cos(g.a) * 16) * S, 0.03, (g.y + Math.sin(g.a) * 16) * S);
      world.add(box);
    }
    // Tribünler: basamaklı, seyirci dokulu
    const crowd = canvasTex(256, 64, (c, w, h) => {
      c.fillStyle = '#2b2f3a';
      c.fillRect(0, 0, w, h);
      const cols = ['#e84d4d', '#f2c21b', '#ffffff', '#2f6fd6', '#2e9e5b', '#f28c28', '#c74bd6'];
      let s = 11;
      const r = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
      for (let k = 0; k < 1400; k++) { c.fillStyle = cols[Math.floor(r() * cols.length)]; c.fillRect(r() * w, r() * h, 2, 3); }
    }, true);
    const standMat = mat(0xffffff, 0.9, 0, { map: crowd });
    const roofMat = mat(0xd9dde3, 0.5, 0.3);
    for (const st of TD.STANDS) {
      const N = T.N, len = (st.i1 - st.i0 + N) % N;
      for (let k = 0; k < len; k += 6) {
        const i = (st.i0 + k) % N, ang = Math.atan2(T.TY[i], T.TX[i]);
        for (let row = 0; row < 4; row++) {
          const off = st.side * (st.gap + 8 + row * (TD.STAND_DEPTH / 4));
          const h = 2 + row * 2.2;
          const b = new THREE.Mesh(new THREE.BoxGeometry(6.4, h, TD.STAND_DEPTH * S / 4), standMat);
          b.position.set(ox(i, off), h / 2, oz(i, off));
          b.rotation.y = -ang;
          b.castShadow = Q.shadow > 1024;
          b.receiveShadow = !!Q.shadow;
          world.add(b);
        }
        const roof = new THREE.Mesh(new THREE.BoxGeometry(6.4, 0.25, TD.STAND_DEPTH * S + 2), roofMat);
        const offR = st.side * (st.gap + 8 + TD.STAND_DEPTH / 2);
        roof.position.set(ox(i, offR), 11.5, oz(i, offR));
        roof.rotation.y = -ang;
        world.add(roof);
      }
    }
    // Ağaçlar (instanced)
    const trees = TD.TREES.filter((_, k) => (k * 0.618) % 1 < Q.trees);
    const crown = new THREE.InstancedMesh(new THREE.ConeGeometry(1, 2.6, 7), mat(0x2f6b2a, 1, 0), trees.length);
    const trunk = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.18, 0.25, 1.6, 6), mat(0x6b4a2b, 1, 0), trees.length);
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3(), p = new THREE.Vector3();
    trees.forEach(([x, y, r], k) => {
      const s = r * S * 1.6;
      m4.compose(p.set(x * S, 1.6 * s * 0.5 + s * 1.3, y * S), q, sc.set(s, s, s));
      crown.setMatrixAt(k, m4);
      m4.compose(p.set(x * S, 0.8 * s, y * S), q, sc.set(s, s, s));
      trunk.setMatrixAt(k, m4);
    });
    crown.castShadow = Q.shadow > 1024;
    world.add(crown, trunk);
  }

  // Araçlar: model yüklenene kadar geçici gövde, sonra hazır model (kendi aracın ayrıntılı, rakipler hafif)
  const models = { hi: null, lo: null };
  const draco = new DRACOLoader().setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.7/');
  const loader = new GLTFLoader().setDRACOLoader(draco);
  for (const k of ['lo', 'hi']) {
    loader.load(`models/f1${k === 'lo' ? '_lo' : ''}.glb`, (g) => {
      models[k] = prepModel(g);
      for (const e of cars.values()) scene.remove(e.obj);
      cars.clear(); // bir sonraki karede modelle yeniden kurulur
    }, undefined, (e) => console.warn('araç modeli yüklenemedi', k, e));
  }
  const cars = new Map(); // id -> {obj, color, kind}
  function carFor(id, color, mine) {
    const want = mine && qName !== 'dusuk' && models.hi ? 'hi' : models.lo ? 'lo' : models.hi ? 'hi' : 'box';
    let e = cars.get(id);
    if (e && e.color === color && e.kind === want) return e;
    if (e) scene.remove(e.obj);
    const obj = want === 'box' ? buildCar(color, mat) : cloneCar(models[want], new THREE.Color(color));
    e = { obj, color, spin: 0, kind: want };
    scene.add(e.obj);
    cars.set(id, e);
    return e;
  }

  function makeRenderer() {
    if (renderer) {
      renderer.dispose();
      canvas.remove();
    }
    canvas = document.createElement('canvas');
    canvas.id = 'c3d';
    canvas.style.cssText = 'position:fixed;inset:0;display:none';
    document.body.insertBefore(canvas, document.getElementById('c')); // 2D katman (HUD, ışıklar, harita) üstte kalır
    renderer = new THREE.WebGLRenderer({ canvas, antialias: Q.aa, powerPreference: 'high-performance' });
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.shadowMap.enabled = !!Q.shadow;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.setPixelRatio(Q.ratio < 1 ? Q.ratio : Math.min(devicePixelRatio || 1, Q.ratio));
    renderer.setSize(innerWidth, innerHeight, false);
    sun.castShadow = !!Q.shadow;
    if (Q.shadow) {
      sun.shadow.mapSize.set(Q.shadow, Q.shadow);
      const sc = sun.shadow.camera;
      sc.left = sc.bottom = -45;
      sc.right = sc.top = 45;
      sc.near = 1;
      sc.far = 300;
      sun.shadow.bias = -0.0005;
    }
    if (Q.env) {
      const pm = new THREE.PMREMGenerator(renderer);
      scene.environment = pm.fromScene(new RoomEnvironment(), 0.04).texture;
      scene.environmentIntensity = 0.3; // sadece parlak yüzeylerde yansıma; sahneyi soldurmasın
      pm.dispose();
    } else scene.environment = null;
    hemi.intensity = Q.env ? 0.85 : 1.1;
  }

  function setQuality(q) {
    if (!QUALITY[q] || q === qName) return;
    qName = q;
    Q = QUALITY[q];
    scene.fog.near = Q.fogNear;
    scene.fog.far = Q.fogFar;
    camera.far = Q.fogFar + 50;
    camera.updateProjectionMatrix();
    for (const e of cars.values()) scene.remove(e.obj);
    cars.clear();
    const shown = canvas && canvas.style.display !== 'none';
    makeRenderer();
    buildWorld();
    if (shown) canvas.style.display = 'block';
  }

  makeRenderer();
  buildWorld();

  // Kamera: 'kokpit' (kask hizası) ya da 'arka' (takip). Basit ivme hissi: gaz/fren baş öne-arkaya,
  // viraj yana; kerb ve çimde titreşim. (Ayrıntılı EA tarzı his 4. aşamada.)
  let camMode = 'kokpit';
  const cam = { lon: 0, lat: 0, vib: 0, prevV: null, prevA: null, chase: null };
  function frame(rr, myId, colors, dt) {
    if (renderer.domElement.width !== Math.floor(innerWidth * renderer.getPixelRatio())) {
      renderer.setSize(innerWidth, innerHeight, false);
      camera.aspect = innerWidth / innerHeight;
      camera.updateProjectionMatrix();
    }
    // Araçları yerleştir
    const seen = new Set();
    for (const [id, r] of rr) {
      seen.add(id);
      const e = carFor(id, colors(id), id === myId);
      e.obj.position.set(r.x * S, 0, r.y * S);
      e.obj.rotation.y = -r.a;
      const v = Math.hypot(r.car.vx, r.car.vy) * 12; // m/s
      e.spin += (v * dt) / 0.36;
      for (const w of e.obj.userData.wheels) {
        if (w.front) w.holder.rotation.y = -(r.car.steer || 0) * 0.35;
        if (w.model) w.w.rotation.z = -e.spin; // modelde aks z ekseninde
        else w.w.rotation.y = -e.spin;
      }
    }
    for (const [id, e] of cars) if (!seen.has(id)) { scene.remove(e.obj); cars.delete(id); }
    const me = rr.get(myId);
    if (me) {
      const c = me.car, v = Math.hypot(c.vx, c.vy) * 12, a = me.a;
      const fx = Math.cos(a), fz = Math.sin(a);
      // İvmeler (m/s²): boyuna hız değişimi, yanal = v · dönüş hızı
      const dts = Math.max(dt, 1 / 240);
      let lon = 0, lat = 0;
      if (cam.prevV != null) {
        lon = (v - cam.prevV) / dts;
        let da = a - cam.prevA;
        while (da > Math.PI) da -= 2 * Math.PI;
        while (da < -Math.PI) da += 2 * Math.PI;
        lat = v * (da / dts);
      }
      cam.prevV = v;
      cam.prevA = a;
      const k = 1 - Math.exp(-dt * 6);
      cam.lon += (Math.max(-40, Math.min(40, lon)) - cam.lon) * k;
      cam.lat += (Math.max(-40, Math.min(40, lat)) - cam.lat) * k;
      const rough = c.surface === 'grass' ? 1 : c.surface === 'kerb' ? 0.55 : 0.06;
      cam.vib += ((rough * Math.min(1, v / 40)) - cam.vib) * k;
      const t = performance.now() / 1000;
      const shake = cam.vib * 0.035;
      const sx = Math.sin(t * 71) * shake, sy = Math.sin(t * 53 + 1) * shake;
      // Yanal birim (sol): (fz, -fx)
      const lx = fz, lz = -fx;
      if (camMode === 'kokpit') {
        // EA F1 kokpit kamerası: kask hizasının hafif üstü (1.24 m), sürücünün başı (araç merkezinin 0.45 m gerisi),
        // ~8° aşağı bakış; halo ve ön lastikler ekranın alt yarısında
        const back = cam.lon * 0.004, side = -cam.lat * 0.003;
        const head = (cars.get(myId) || {}).obj?.userData.head; // modelde kokpitin üstü; geçici gövdede sabit
        const ax = head ? head.x : -0.45, ay = head ? head.y + 0.42 : 1.24;
        const hx = me.x * S + fx * (ax - back) + lx * side, hz = me.y * S + fz * (ax - back) + lz * side;
        camera.position.set(hx + lx * sx, ay + sy - Math.abs(cam.lon) * 0.0008, hz + lz * sx);
        camera.up.set(lx * cam.lat * 0.0012, 1, lz * cam.lat * 0.0012).normalize();
        camera.lookAt(hx + fx * 30, ay - 4.2 - cam.lon * 0.02, hz + fz * 30);
        camera.fov = 56 + Math.min(6, v / 15);
      } else {
        const want = new THREE.Vector3(me.x * S - fx * 9.5, 3.1, me.y * S - fz * 9.5);
        if (!cam.chase) cam.chase = want.clone();
        cam.chase.lerp(want, 1 - Math.exp(-dt * 8));
        camera.position.copy(cam.chase);
        camera.up.set(0, 1, 0);
        camera.lookAt(me.x * S + fx * 6, 0.9, me.y * S + fz * 6);
        camera.fov = 70 + Math.min(8, v / 12);
      }
      camera.updateProjectionMatrix();
      sun.target.position.set(me.x * S, 0, me.y * S);
      sun.position.set(me.x * S + 60, 110, me.y * S + 35);
    }
    renderer.render(scene, camera);
  }

  return {
    show(on) { canvas.style.display = on ? 'block' : 'none'; if (!on) { cam.prevV = null; cam.chase = null; } },
    frame,
    setQuality,
    toggleCam() { camMode = camMode === 'kokpit' ? 'arka' : 'kokpit'; cam.chase = null; return camMode; },
    get camMode() { return camMode; },
    _dbg: () => ({ calls: renderer.info.render.calls, tris: renderer.info.render.triangles, cam: camera.position.toArray().map((v) => +v.toFixed(1)), size: [canvas.width, canvas.height], disp: canvas.style.display, cars: cars.size }),
  };
}
