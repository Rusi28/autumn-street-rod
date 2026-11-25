import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { TRACKS } from '../data/gameData.js';

const HW = 7.5; // Út fél-szélessége
const wrapAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

export class RaceEngine {
  constructor(canvas, onFinish) {
    this.canvas = canvas;
    this.onFinish = onFinish;
    this.running = false;
    this.input = { left: false, right: false, gas: false, brake: false };
    this.loader = new GLTFLoader();

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.25;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x090e1a);
    this.scene.fog = new THREE.Fog(0x0c1324, 55, 290);

    // Finomabb környezeti tükröződés éjszakára
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.35;

    this.camera = new THREE.PerspectiveCamera(65, window.innerWidth / window.innerHeight, 0.5, 500);

    // Hideg éjszakai derítés
    this.scene.add(new THREE.HemisphereLight(0x2c426e, 0x0b0f18, 0.9));

    // Holdfény (a Hold pozíciójához kötve)
    this.moonAngle = 0.55; // Honnan süssön a Hold
    this.moonLight = new THREE.DirectionalLight(0xa8c8ff, 1.8);
    this.scene.add(this.moonLight);

    // Látható Hold az égen (nem fogja el a köd)
    this.moonMesh = new THREE.Mesh(
      new THREE.SphereGeometry(14, 16, 16),
      new THREE.MeshBasicMaterial({ color: 0xf2f7ff, fog: false })
    );
    this.scene.add(this.moonMesh);

    this.worldGroup = new THREE.Group();
    this.scene.add(this.worldGroup);

    this.playerGroup = new THREE.Group();
    this.aiGroup = new THREE.Group();
    this.scene.add(this.playerGroup, this.aiGroup);

    // Játékos autó fényszórója (helyi +Z irányba világít előre)
    this.headlight = new THREE.SpotLight(0xfff1cc, 18, 65, Math.PI / 4.5, 0.55, 1.2);
    this.headlight.position.set(0, 1.1, 1.8);
    this.headlightTarget = new THREE.Object3D();
    this.headlightTarget.position.set(0, 0.2, 24);
    this.playerGroup.add(this.headlight, this.headlightTarget);
    this.headlight.target = this.headlightTarget;

    this.audioCtx = null;
    this.osc = null;
    this.gain = null;

    // --- 2.5D Atlas Textúrák előkészítése ---
    const texLoader = new THREE.TextureLoader();
    this.atlasTexture = texLoader.load('/images/bldgs_atlas.png');
    this.atlasTexture.colorSpace = THREE.SRGBColorSpace;

    this.crowdTexture = texLoader.load('/images/crowd.png');
    this.crowdTexture.colorSpace = THREE.SRGBColorSpace;

    // Billboardok listája, amiket a kamera felé kell fordítani minden frame-ben
    this.billboards = [];

    this.bindInputs();
    window.addEventListener('resize', () => this.resize());
    this.resize();
  }

  initAudio() {
    if (this.audioCtx) {
      if (this.audioCtx.state === 'suspended') this.audioCtx.resume();
      return;
    }
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      this.audioCtx = new AC();
      this.osc = this.audioCtx.createOscillator();
      this.osc.type = 'sawtooth';
      const filter = this.audioCtx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = 550;
      this.gain = this.audioCtx.createGain();
      this.gain.gain.value = 0;
      this.osc.connect(filter);
      filter.connect(this.gain);
      this.gain.connect(this.audioCtx.destination);
      this.osc.start();
    } catch (_) {}
  }

  beep(freq = 440, duration = 0.15) {
    if (!this.audioCtx) return;
    try {
      const o = this.audioCtx.createOscillator();
      const g = this.audioCtx.createGain();
      o.type = 'sine';
      o.frequency.value = freq;
      g.gain.setValueAtTime(0.12, this.audioCtx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.001, this.audioCtx.currentTime + duration);
      o.connect(g);
      g.connect(this.audioCtx.destination);
      o.start();
      o.stop(this.audioCtx.currentTime + duration);
    } catch (_) {}
  }

  updateLights(stage) {
    const box = document.getElementById('start-lights');
    if (!box) return;
    if (stage === 'hide') {
      box.classList.add('hidden');
      return;
    }
    box.classList.remove('hidden');
    box.querySelector('.red').classList.toggle('on', stage === 3);
    box.querySelector('.yellow').classList.toggle('on', stage === 2 || stage === 1);
    box.querySelector('.green').classList.toggle('on', stage === 0);
  }

  clearWorld() {
    while (this.worldGroup.children.length) {
      this.worldGroup.remove(this.worldGroup.children[0]);
    }
    this.billboards = [];
  }

  // --- 2.5D KRAKTEREK (BILLBOARD-OK) LÉTREHOZÁSA ---
  addPedestrian(x, y, z, idx = 0) {
    // 2 sor és 10 oszlop van az osztott crowd.png sprite atlaszon
    const colCount = 10;
    const rowCount = 2;
    const colIdx = idx % colCount;
    const rowIdx = Math.floor(idx / colCount) % rowCount;

    const map = this.crowdTexture.clone();
    map.repeat.set(1 / colCount, 1 / rowCount);
    map.offset.set(colIdx / colCount, (rowCount - 1 - rowIdx) / rowCount);
    map.needsUpdate = true;

    // Korrigáljuk az arányokat
    const material = new THREE.SpriteMaterial({ map, transparent: true, alphaTest: 0.1 });
    const sprite = new THREE.Sprite(material);
    sprite.position.set(x, y + 1.25, z);
    // Kicsi, emberi méretarányok
    sprite.scale.set(1.9, 2.5, 1);

    this.worldGroup.add(sprite);
    this.billboards.push(sprite);
  }

// --- 2.5D BÉRHÁZ HOMLOKZAT + TEXTÚRÁZOTT OLDALFALAK ---
  create25DBuilding(x, z, h, sizeZ, index, rotY = 0) {
    const bGroup = new THREE.Group();
    const idx = ((index % 4) + 4) % 4;

    // 4 ház-variáció gyorsítótárazása (mobilon is sokkal gyorsabb)
    if (!this.buildingMatSets) {
      const roofMat = new THREE.MeshLambertMaterial({ color: 0x262120 });
      this.buildingMatSets = [0, 1, 2, 3].map((i) => {
        const tex = this.atlasTexture.clone();
        tex.repeat.set(0.19, 0.84);
        tex.offset.set(0.25 * i + 0.03, 0.04);
        tex.needsUpdate = true;

        const frontMat = new THREE.MeshLambertMaterial({
          map: tex,
          emissive: new THREE.Color(0xffffff),
          emissiveMap: tex,
          emissiveIntensity: 0.45 // Ha még világosabbat akarsz, emeld 0.6-ra
        });

        const sideMat = new THREE.MeshLambertMaterial({
          map: tex,
          color: 0x9e8f86,
          emissive: new THREE.Color(0xd8c8be),
          emissiveMap: tex,
          emissiveIntensity: 0.3 // Az oldalfal picit sötétebb marad a 3D hatás miatt
        });

        return [
          sideMat,  // jobb oldal
          sideMat,  // bal oldal
          roofMat,  // tető
          roofMat,  // alja
          frontMat, // utca felőli homlokzat (+Z)
          sideMat   // hátfal (-Z)
        ];
      });
    }

    const depth = 10;
    const building = new THREE.Mesh(
      new THREE.BoxGeometry(sizeZ, h, depth),
      this.buildingMatSets[idx]
    );
    building.position.set(0, h / 2, -depth / 2);
    bGroup.add(building);

    bGroup.position.set(x, 0, z);
    bGroup.rotation.y = rotY;
    this.worldGroup.add(bGroup);
  }

  // --- PROCEDURÁLIS FÉNYUDVAR (HALO) TEXTÚRA ---
  getGlowTexture() {
    if (this.glowTex) return this.glowTex;
    const c = document.createElement('canvas');
    c.width = 128;
    c.height = 128;
    const ctx = c.getContext('2d');
    const g = ctx.createRadialGradient(64, 64, 4, 64, 64, 64);
    g.addColorStop(0, 'rgba(255, 226, 150, 0.95)');
    g.addColorStop(0.35, 'rgba(255, 175, 75, 0.45)');
    g.addColorStop(1, 'rgba(255, 140, 40, 0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 128, 128);
    this.glowTex = new THREE.CanvasTexture(c);
    return this.glowTex;
  }

  // --- PROCEDURÁLIS KŐLAPOS, FALAVELES JÁRDA TEXTÚRA ---
  getSidewalkTexture(repeatY = 40) {
    const c = document.createElement('canvas');
    c.width = 128;
    c.height = 128;
    const ctx = c.getContext('2d');

    // Kőlap alap
    ctx.fillStyle = '#5c5855';
    ctx.fillRect(0, 0, 128, 128);

    // Szegélykő az út felőli szélen
    ctx.fillStyle = '#7a746e';
    ctx.fillRect(0, 0, 14, 128);
    ctx.fillRect(114, 0, 14, 128);

    // Kőlap fugák
    ctx.strokeStyle = 'rgba(25, 22, 20, 0.45)';
    ctx.lineWidth = 3;
    ctx.strokeRect(0, 0, 128, 64);
    ctx.strokeRect(0, 64, 128, 64);
    ctx.beginPath();
    ctx.moveTo(64, 0); ctx.lineTo(64, 128);
    ctx.stroke();

    // Pár lehullott őszi falevél
    const leafCols = ['#d96b27', '#e89b32', '#9e3824'];
    for (let i = 0; i < 14; i++) {
      ctx.fillStyle = leafCols[i % leafCols.length];
      ctx.fillRect((i * 37) % 110 + 8, (i * 53) % 118 + 4, 5, 4);
    }

    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(1, repeatY);
    return tex;
  }

  // --- RETRÓ UTCAI LÁMPA FÉNYUDVARRAL ÉS TALAJFÉNNYEL ---
  addStreetLamp(x, z, rotY) {
    const g = new THREE.Group();
    const metalMat = new THREE.MeshLambertMaterial({ color: 0x1e242e });

    // Talpazat + oszlop + ívelt kar
    const base = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.28, 0.7, 6), metalMat);
    base.position.y = 0.35;
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.13, 6.2, 6), metalMat);
    pole.position.y = 3.1;
    const arm = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 1.8), metalMat);
    arm.position.set(0, 6.15, 0.85);

    // Lámpabúra + világító izzó
    const hood = new THREE.Mesh(new THREE.ConeGeometry(0.45, 0.28, 6), metalMat);
    hood.position.set(0, 6.1, 1.65);
    const bulb = new THREE.Mesh(
      new THREE.SphereGeometry(0.24, 6, 6),
      new THREE.MeshBasicMaterial({ color: 0xfff0c2 })
    );
    bulb.position.set(0, 5.9, 1.65);

    // Meleg fényudvar (halo) a lámpa körül
    const glowMat = new THREE.SpriteMaterial({
      map: this.getGlowTexture(),
      color: 0xffc978,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false
    });
    const halo = new THREE.Sprite(glowMat);
    halo.position.set(0, 5.85, 1.65);
    halo.scale.set(4.5, 4.5, 1);

    // Fényfolt az aszfalton / járdán a lámpa alatt
    const pool = new THREE.Mesh(
      new THREE.PlaneGeometry(7.5, 7.5),
      new THREE.MeshBasicMaterial({
        map: this.getGlowTexture(),
        color: 0xffb85c,
        transparent: true,
        opacity: 0.42,
        blending: THREE.AdditiveBlending,
        depthWrite: false
      })
    );
    pool.rotation.x = -Math.PI / 2;
    pool.position.set(0, 0.3, 1.8);

    g.add(base, pole, arm, hood, bulb, halo, pool);
    g.position.set(x, 0, z);
    g.rotation.y = rotY;
    this.worldGroup.add(g);
  }

  // --- 2D FA TEXTÚRA AUTOMATIKUS FEHÉR-HÁTTÉR ELTÁVOLÍTÁSSAL ---
  getTreeTexture() {
    if (this.treeTex) return this.treeTex;
    const c = document.createElement('canvas');
    c.width = 512;
    c.height = 512;
    const ctx = c.getContext('2d');
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;

    const img = new Image();
    img.src = '/images/tree_autumn.jpg';
    img.onload = () => {
      ctx.drawImage(img, 0, 0, 512, 512);
      const imgData = ctx.getImageData(0, 0, 512, 512);
      const d = imgData.data;
      // A fehér és majdnem fehér háttérpixeleket átlátszóra állítjuk
      for (let i = 0; i < d.length; i += 4) {
        if (d[i] > 232 && d[i + 1] > 232 && d[i + 2] > 232) {
          d[i + 3] = 0;
        }
      }
      ctx.putImageData(imgData, 0, 0);
      tex.needsUpdate = true;
    };

    this.treeTex = tex;
    return tex;
  }

  // --- 2.5D FESTETT ŐSZI FA (BILLBOARD SPRITE) ---
  addAutumnTree(x, z, scale = 1) {
    const g = new THREE.Group();

    // Pici árnyalat-eltérés fánként, hogy éjszaka is változatos legyen
    const tints = [0xd8c8b8, 0xe8b896, 0xc99684, 0xdfb088];
    const tint = tints[Math.abs(Math.round(x * 3 + z * 7)) % tints.length];

    const mat = new THREE.SpriteMaterial({
      map: this.getTreeTexture(),
      color: tint,
      transparent: true,
      alphaTest: 0.2
    });

    const sprite = new THREE.Sprite(mat);
    const h = 7.2 * scale;
    sprite.scale.set(h, h, 1);
    sprite.position.y = h * 0.48; // A törzs alja érjen le a járdára
    g.add(sprite);

    // Lehullott levélkupac a fa tövében
    const leavesBase = new THREE.Mesh(
      new THREE.CircleGeometry(1.7 * scale, 7),
      new THREE.MeshBasicMaterial({ color: 0x6e3015, transparent: true, opacity: 0.65 })
    );
    leavesBase.rotation.x = -Math.PI / 2;
    leavesBase.position.y = 0.29;
    g.add(leavesBase);

    g.position.set(x, 0, z);
    this.worldGroup.add(g);
  }

  createZebraMesh(width) {
    const group = new THREE.Group();
    const stripeMat = new THREE.MeshBasicMaterial({ color: 0xf2ece1 });
    const count = 6;
    const step = width / count;
    for (let i = 0; i < count; i++) {
      const s = new THREE.Mesh(new THREE.PlaneGeometry(step * 0.55, 3.2), stripeMat);
      s.rotation.x = -Math.PI / 2;
      s.position.set(-width / 2 + step * (i + 0.5), 0.06, 0);
      group.add(s);
    }
    return group;
  }

  // --- EGYENES GYORSULÁSI PÁLYA ---
  buildDragWorld(distance) {
    this.clearWorld();
    this.scene.background = new THREE.Color(0x090e1a);
    this.scene.fog = new THREE.Fog(0x0c1324, 55, 290);

    const road = new THREE.Mesh(
      new THREE.PlaneGeometry(16, distance + 280),
      new THREE.MeshLambertMaterial({ color: 0x2c323d })
    );
    road.rotation.x = -Math.PI / 2;
    road.position.z = -distance / 2;
    this.worldGroup.add(road);

    // Szaggatott felezővonal
    const dashMat = new THREE.MeshBasicMaterial({ color: 0xe9c46a });
    for (let z = 10; z > -distance - 40; z -= 10) {
      const d = new THREE.Mesh(new THREE.PlaneGeometry(0.32, 4.5), dashMat);
      d.rotation.x = -Math.PI / 2;
      d.position.set(0, 0.04, z);
      this.worldGroup.add(d);
    }

    // Járdák
    const sidewalkMat = new THREE.MeshLambertMaterial({
      map: this.getSidewalkTexture(Math.round((distance + 280) / 8))
    });
    [-11.5, 11.5].forEach((x) => {
      const sw = new THREE.Mesh(new THREE.BoxGeometry(7, 0.28, distance + 280), sidewalkMat);
      sw.position.set(x, 0.14, -distance / 2);
      this.worldGroup.add(sw);
    });

    // Épületek, lámpák és gyalogosok a pálya mentén
    for (let z = 15; z > -distance - 100; z -= 24) {
      // Bal és jobb oldal
      [-19.5, 19.5].forEach((x) => {
        const h = 18 + ((Math.abs(z) * 3) % 8); // bérházak magassága
        const rot = x < 0 ? Math.PI / 2 : -Math.PI / 2;
        const bIdx = (Math.floor(Math.abs(z) / 24) + (x > 0 ? 2 : 0)) % 4; // 0, 1, 2, 3 az atlaszból
        this.create25DBuilding(x, z, h, 20, bIdx, rot);
      });

      // Díszítés, lámpák, gyalogosok
      if (Math.abs(z) % 48 < 24) {
        this.addStreetLamp(-8.6, z, Math.PI / 2);
        this.addStreetLamp(8.6, z, -Math.PI / 2);
        // Gyalogosok a járda szélén
        this.addPedestrian(-9.1, 0.14, z + 3, Math.abs(Math.round(z)));
        this.addPedestrian(9.1, 0.14, z - 3, Math.abs(Math.round(z * 2)));
      } else {
        this.addAutumnTree(-13.2, z + 5, 0.9);
        this.addAutumnTree(13.2, z - 5, 1.05);
      }
    }

    // Rajt és cél zebra
    const startZebra = this.createZebraMesh(15);
    startZebra.position.set(0, 0, -2.5);
    this.worldGroup.add(startZebra);

    const finishZebra = this.createZebraMesh(15);
    finishZebra.position.set(0, 0, -distance);
    this.worldGroup.add(finishZebra);
  }

  // --- KANYARGÓS VÁROSI KÖRPÁLYA ---
  buildCircuitWorld(trackKey) {
    this.clearWorld();
    this.scene.background = new THREE.Color(0x090e1a);
    this.scene.fog = new THREE.Fog(0x0c1324, 55, 290);

    const raw = TRACKS[trackKey] || TRACKS.downtown;
    const curve = new THREE.CatmullRomCurve3(
      raw.map((q) => new THREE.Vector3(q[0], 0, q[1])),
      true,
      'centripetal'
    );
    const L = curve.getLength();
    const N = Math.round(L / 4);
    const P = curve.getSpacedPoints(N).slice(0, N);

    const K = P.map((b, i) => {
      const a = P[(i - 2 + N) % N];
      const d = P[(i + 2) % N];
      const u = b.clone().sub(a);
      const v = d.clone().sub(b);
      return Math.abs(Math.atan2(u.x * v.z - u.z * v.x, u.x * v.x + u.z * v.z)) / ((u.length() + v.length()) / 2);
    });

    const nm = P.map((p, i) => {
      const a = P[(i - 1 + N) % N];
      const b = P[(i + 1) % N];
      return new THREE.Vector3(b.z - a.z, 0, -(b.x - a.x)).normalize();
    });

    const d0 = P[1].clone().sub(P[N - 1]);
    this.track = { P, N, L, K, nm, S: L / N, a0: Math.atan2(d0.x, d0.z) };

    const pos = [], col = [], idx = [];
    const strip = (o1, y1, o2, y2, cf) => {
      const base = pos.length / 3;
      for (let i = 0; i <= N; i++) {
        const j = i % N;
        const p = P[j], m = nm[j], c = cf(i);
        pos.push(p.x + m.x * o1, y1, p.z + m.z * o1, p.x + m.x * o2, y2, p.z + m.z * o2);
        col.push(...c, ...c);
        if (i < N) {
          const k = base + i * 2;
          idx.push(k, k + 1, k + 2, k + 1, k + 3, k + 2);
        }
      }
    };

    strip(-HW, 0.02, HW, 0.02, (i) => (i % 2 ? [0.17, 0.19, 0.23] : [0.2, 0.22, 0.26]));
    strip(-0.18, 0.04, 0.18, 0.04, (i) => (i % 6 < 3 ? [0.92, 0.78, 0.42] : [0.18, 0.2, 0.24]));
    strip(HW, 0.22, HW + 4.8, 0.22, () => [0.6, 0.57, 0.52]);
    strip(-HW - 4.8, 0.22, -HW, 0.22, () => [0.6, 0.57, 0.52]);

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    geo.setIndex(idx);
    this.worldGroup.add(new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide })));

    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(2500, 2500),
      new THREE.MeshBasicMaterial({ color: 0x3b444f })
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.05;
    this.worldGroup.add(ground);

    // Zebrás rajt/cél
    const startZebra = this.createZebraMesh(HW * 1.9);
    startZebra.position.set(P[0].x, 0, P[0].z);
    startZebra.rotation.y = this.track.a0;
    this.worldGroup.add(startZebra);

    // 2.5D Épületek, gyalogosok és lámpák a kanyargós pálya mentén
    const minDistSq = (HW + 11) ** 2;
    for (let i = 0; i < N; i += 4) {
      const p = P[i], m = nm[i];
      for (const side of [-1, 1]) {
        const bx = p.x + m.x * side * (HW + 14);
        const bz = p.z + m.z * side * (HW + 14);
        if (P.every((q) => (q.x - bx) ** 2 + (q.z - bz) ** 2 > minDistSq)) {
          if (i % 12 === 0) {
            this.addAutumnTree(bx, bz, 1.15);
          } else {
            const h = 18 + ((i * 7 + (side > 0 ? 5 : 2)) % 8);
            const rotY = Math.atan2(m.x, m.z) + (side > 0 ? Math.PI : 0);
            const bIdx = (Math.floor(i / 4) + (side > 0 ? 2 : 0)) % 4; // Atlaszból
            this.create25DBuilding(bx, bz, h, 15.5, bIdx, rotY);
          }
        }
        // Utcai lámpák és gyalogosok a járda szélén
        if (i % 8 === 0) {
          const lx = p.x + m.x * side * (HW + 1.4);
          const lz = p.z + m.z * side * (HW + 1.4);
          this.addStreetLamp(lx, lz, Math.atan2(-m.x * side, -m.z * side));
          
          const px = p.x + m.x * side * (HW + 2.2);
          const pz = p.z + m.z * side * (HW + 2.2);
          this.addPedestrian(px, 0.22, pz, i + (side > 0 ? 3 : 0));
        }
      }
    }
  }

  loadCarModel(url, fallbackColor, targetGroup) {
    for (let i = targetGroup.children.length - 1; i >= 0; i--) {
      const ch = targetGroup.children[i];
      if (ch !== this.headlight && ch !== this.headlightTarget) {
        targetGroup.remove(ch);
      }
    }
	
    this.loader.load(
      url,
      (gltf) => {
        const model = gltf.scene;
        model.traverse((child) => {
          if (child.isMesh) {
            if (!child.geometry.attributes.normal) {
              child.geometry.computeVertexNormals();
            }
            if (!child.material || !child.material.map) {
              child.material = new THREE.MeshToonMaterial({ color: fallbackColor });
            } else {
              child.material.metalness = 0.1;
              child.material.roughness = 0.85;
              child.material.needsUpdate = true;
            }
          }
        });

        const box = new THREE.Box3().setFromObject(model);
        const size = box.getSize(new THREE.Vector3());
        const maxDim = Math.max(size.x, size.y, size.z);
        if (maxDim > 0) model.scale.setScalar(4.3 / maxDim);

        box.setFromObject(model);
        const center = box.getCenter(new THREE.Vector3());
        model.position.x -= center.x;
        model.position.z -= center.z;
        model.position.y -= box.min.y;
        model.rotation.y = 0;

        targetGroup.add(model);
      },
      undefined,
      () => {
        const body = new THREE.Mesh(
          new THREE.BoxGeometry(2.0, 0.75, 4.3),
          new THREE.MeshToonMaterial({ color: fallbackColor })
        );
        body.position.y = 0.65;
        const cabin = new THREE.Mesh(
          new THREE.BoxGeometry(1.65, 0.6, 2.1),
          new THREE.MeshToonMaterial({ color: 0x263242 })
        );
        cabin.position.set(0, 1.25, -0.15);
        targetGroup.add(body, cabin);
      }
    );
  }

  start(stats, carModelUrl, opponent, mp = null) {
    this.initAudio();
    this.stats = stats;
    this.opponent = opponent;
    this.mode = opponent.mode || 'drag';
    this.mp = mp;
    this.oppNet = null;
    this.netTimer = 0;

    if (this.mp) {
      this.mp.socket.off('opp_state');
      this.mp.socket.on('opp_state', (data) => {
        this.oppNet = data;
      });
    }

    this.loadCarModel(carModelUrl, 0xb8293d, this.playerGroup);
    this.loadCarModel(opponent.modelUrl, 0xe9b44c, this.aiGroup);

    const side = this.mp && this.mp.slot === 1 ? 1 : -1;
    if (this.mode === 'circuit') {
      this.buildCircuitWorld(opponent.track);
      const T = this.track;
      const m0 = T.nm[0];
      this.laps = opponent.laps || 1;
      this.player = { x: T.P[0].x + m0.x * 2.6 * side, z: T.P[0].z + m0.z * 2.6 * side, a: T.a0, vx: 0, vz: 0, i: 0, u: 0, d: 2.6 };
      this.ai = { x: T.P[0].x - m0.x * 2.6 * side, z: T.P[0].z - m0.z * 2.6 * side, a: T.a0, vx: 0, vz: 0, i: 0, u: 0, d: 2.6 };
      this.camAngle = T.a0;
    } else {
      this.distance = opponent.distance || 400;
      this.buildDragWorld(this.distance);
      this.player = { x: 3.2 * side, z: 0, speed: 0 };
      this.ai = { x: -3.2 * side, z: 0, speed: 0 };
    }

    this.canvas.style.display = 'block';
    this.countdown = 3.0;
    this.lastBeepStage = 4;
    this.updateLights(3);
    document.getElementById('hud-status').textContent = 'KÉSZÜLJ...';
    this.running = true;
    this.lastTime = performance.now();
    this.loop(this.lastTime);
  }

  stop() {
    this.updateLights('hide');
    this.running = false;
    this.canvas.style.display = 'none';
    if (this.gain) this.gain.gain.value = 0;
  }

  nearestSplineIndex(car) {
    const T = this.track;
    let best = 1e9, bi = car.i;
    for (let k = -14; k <= 14; k++) {
      const i = (car.i + k + T.N) % T.N;
      const p = T.P[i];
      const d = (p.x - car.x) ** 2 + (p.z - car.z) ** 2;
      if (d < best) { best = d; bi = i; }
    }
    return [bi, Math.sqrt(best)];
  }

  stepCircuitCar(c, ctrl, accel, topSpeed, grip, armor, dt) {
    const T = this.track;
    const sn = Math.sin(c.a), cs = Math.cos(c.a);
    let vf = c.vx * sn + c.vz * cs;
    let vl = c.vx * cs - c.vz * sn;

    if (ctrl.thr > 0) vf += ctrl.thr * accel * Math.max(0, 1 - vf / (topSpeed + 6)) * dt;
    if (ctrl.brk > 0) {
      vf -= (vf > 1 ? 50 : 20) * ctrl.brk * dt;
      if (vf < -10) vf = -10;
    }
    vf -= vf * 0.12 * dt;
    if (!ctrl.thr && !ctrl.brk) vf -= Math.sign(vf) * Math.min(Math.abs(vf), 4 * dt);

    const yaw = (2.3 / (1 + Math.abs(vf) / 18)) * Math.min(1, Math.abs(vf) / 5) * Math.sign(vf);
    const latGrip = grip * (1 - 0.45 * Math.min(1, Math.abs(ctrl.st) * Math.abs(vf) / 42));
    vl *= Math.exp(-latGrip * dt);
    vf -= vf * Math.abs(vl) * 0.008 * dt;

    c.vx = sn * vf + cs * vl;
    c.vz = cs * vf - sn * vl;
    c.a -= ctrl.st * yaw * dt;
    c.x += c.vx * dt;
    c.z += c.vz * dt;

    const [i, d] = this.nearestSplineIndex(c);
    let di = i - c.i;
    if (di > T.N / 2) di -= T.N;
    if (di < -T.N / 2) di += T.N;
    c.u += di;
    c.i = i;
    c.d = d;

    const lim = HW + 0.8;
    if (d > lim) {
      const p = T.P[i];
      const nx = (c.x - p.x) / d, nz = (c.z - p.z) / d;
      c.x = p.x + nx * lim;
      c.z = p.z + nz * lim;
      const vn = c.vx * nx + c.vz * nz;
      if (vn > 0) {
        c.vx -= nx * vn * 1.4;
        c.vz -= nz * vn * 1.4;
      }
      const damp = clamp(0.82 + (armor - 1) * 0.15, 0.78, 0.94);
      c.vx *= damp;
      c.vz *= damp;
      c.d = lim;
    }
  }

  pollGamepad() {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    const gp = [...pads].find((g) => g && g.connected);
    if (!gp) return null;
    return {
      gas: gp.buttons[7]?.value > 0.1,
      brake: gp.buttons[6]?.value > 0.1,
      steer: Math.abs(gp.axes[0] || 0) > 0.15 ? gp.axes[0] : 0
    };
  }
   
   updateMoon(dt) {
    this.moonAngle += dt * 0.015;
    const dist = 260;
    const mx = Math.sin(this.moonAngle) * dist;
    const my = 115;
    const mz = -Math.cos(this.moonAngle) * dist;

    this.moonMesh.position.set(
      this.camera.position.x + mx,
      my,
      this.camera.position.z + mz
    );

    this.moonLight.position.set(
      this.player.x + mx * 0.4,
      my * 0.6,
      this.player.z + mz * 0.4
    );
    this.moonLight.target.position.set(this.player.x, 0, this.player.z);
    this.moonLight.target.updateMatrixWorld();
  }

   loop(now) {
    if (!this.running) return;
    requestAnimationFrame((t) => this.loop(t));
    const dt = Math.min(0.05, (now - this.lastTime) / 1000);
    this.lastTime = now;

    const gp = this.pollGamepad();
    const gas = this.input.gas || (gp && gp.gas);
    const brake = this.input.brake || (gp && gp.brake);
    let steer = (this.input.right ? 1 : 0) - (this.input.left ? 1 : 0);
    if (gp && gp.steer) steer = gp.steer;

    let playerSpeed = 0;

    // Rajtlámpa visszaszámlálás
    if (this.countdown > 0) {
      this.countdown -= dt;
      const stage = Math.max(0, Math.ceil(this.countdown));
      if (stage < this.lastBeepStage) {
        this.lastBeepStage = stage;
        this.updateLights(stage);
        this.beep(stage === 0 ? 880 : 440, stage === 0 ? 0.35 : 0.14);
        document.getElementById('hud-status').textContent = stage === 0 ? 'RAJT!' : `${stage}...`;
      }

      this.playerGroup.position.set(this.player.x, 0, this.player.z);
      this.aiGroup.position.set(this.ai.x, 0, this.ai.z);
      if (this.mode === 'circuit') {
        this.playerGroup.rotation.y = this.player.a;
        this.aiGroup.rotation.y = this.ai.a;
        this.camera.position.set(this.player.x - Math.sin(this.camAngle) * 8.5, 4.0, this.player.z - Math.cos(this.camAngle) * 8.5);
        this.camera.lookAt(this.player.x + Math.sin(this.camAngle) * 10, 1.2, this.player.z + Math.cos(this.camAngle) * 10);
      } else {
        this.playerGroup.rotation.y = Math.PI;
        this.aiGroup.rotation.y = Math.PI;
        this.camera.position.set(this.player.x * 0.45, 3.8, this.player.z + 8.5);
        this.camera.lookAt(this.player.x * 0.5, 1.0, this.player.z - 12);
      }

      if (this.osc && this.gain) {
        this.osc.frequency.value = 55 + (gas ? 45 : 0);
        this.gain.gain.value = 0.04 + (gas ? 0.05 : 0);
      }

      if (this.countdown <= 0) {
        setTimeout(() => this.updateLights('hide'), 900);
      }

      // Billboard-ok (sprite-ok) kamera felé fordítása
      this.billboards.forEach(sp => {
        sp.quaternion.copy(this.camera.quaternion);
      });

	  this.updateMoon(dt);
      this.renderer.render(this.scene, this.camera);
      return;
    }

    if (this.mode === 'circuit') {
      const T = this.track;
      this.stepCircuitCar(
        this.player,
        { thr: gas ? 1 : 0, brk: brake ? 1 : 0, st: steer },
        this.stats.accel,
        this.stats.topSpeed,
        this.stats.grip,
        this.stats.armor,
        dt
      );

      if (this.mp) {
        if (this.oppNet) {
          this.ai.x += (this.oppNet.x - this.ai.x) * Math.min(1, dt * 15);
          this.ai.z += (this.oppNet.z - this.ai.z) * Math.min(1, dt * 15);
          this.ai.a += wrapAngle(this.oppNet.a - this.ai.a) * Math.min(1, dt * 15);
          this.ai.u = this.oppNet.u;
        }
      } else {
        const aiSp = Math.hypot(this.ai.vx, this.ai.vz);
        const look = Math.ceil((8 + aiSp * 0.3) / T.S);
        const tg = T.P[(this.ai.i + look) % T.N];
        const err = wrapAngle(Math.atan2(tg.x - this.ai.x, tg.z - this.ai.z) - this.ai.a);
        const checkDist = Math.ceil((aiSp * aiSp / 60 + 12) / T.S);
        let kMax = 0;
        for (let k = 0; k <= checkDist; k++) kMax = Math.max(kMax, T.K[(this.ai.i + k) % T.N]);
        const targetV = Math.min(this.opponent.aiTopSpeed, 10 * (Math.sqrt(1 + 0.44 / Math.max(kMax, 1e-3)) - 1)) * (this.opponent.aiSkill || 0.85);

        this.stepCircuitCar(
          this.ai,
          { thr: aiSp < targetV ? 1 : 0, brk: aiSp > targetV + 2.5 ? 1 : 0, st: -clamp(err * 2.4, -1, 1) },
          this.opponent.aiAccel,
          this.opponent.aiTopSpeed,
          9,
          1.0,
          dt
        );
      }

      // Autó-autó ütközés
      const dx = this.player.x - this.ai.x;
      const dz = this.player.z - this.ai.z;
      const dist = Math.hypot(dx, dz);
      if (dist < 2.8 && dist > 0.01) {
        const nx = dx / dist, nz = dz / dist;
        const overlap = (2.8 - dist) * 0.5;
        this.player.x += nx * overlap; this.player.z += nz * overlap;
        this.player.vx = (this.player.vx + nx * 6) * 0.85;
        this.player.vz = (this.player.vz + nz * 6) * 0.85;
        if (!this.mp) {
          this.ai.x -= nx * overlap; this.ai.z -= nz * overlap;
          this.ai.vx = (this.ai.vx - nx * 6) * 0.85;
          this.ai.vz = (this.ai.vz - nz * 6) * 0.85;
        }
      }

      this.playerGroup.position.set(this.player.x, 0, this.player.z);
      this.playerGroup.rotation.y = this.player.a;
      this.aiGroup.position.set(this.ai.x, 0, this.ai.z);
      this.aiGroup.rotation.y = this.ai.a;

      playerSpeed = Math.hypot(this.player.vx, this.player.vz);
      this.camAngle += wrapAngle(this.player.a - this.camAngle) * Math.min(1, dt * 6);
      const camD = 8.5 + playerSpeed * 0.06;
      this.camera.position.set(
        this.player.x - Math.sin(this.camAngle) * camD,
        4.0,
        this.player.z - Math.cos(this.camAngle) * camD
      );
      this.camera.lookAt(
        this.player.x + Math.sin(this.camAngle) * 10,
        1.2,
        this.player.z + Math.cos(this.camAngle) * 10
      );

      const targetU = T.N * this.laps;
      const pct = clamp(Math.round((this.player.u / targetU) * 100), 0, 100);
      const posLabel = this.player.u >= this.ai.u ? '1/2' : '2/2';
      document.getElementById('hud-progress').textContent = `Helyezés: ${posLabel} · ${pct}%`;

      if (this.mp) {
        if (this.player.u >= targetU) {
          this.mp.socket.emit('player_finished', { code: this.mp.code });
          return;
        }
      } else if (this.player.u >= targetU || this.ai.u >= targetU) {
        const won = this.player.u >= this.ai.u;
        this.stop();
        if (this.onFinish) this.onFinish(won, this.opponent);
        return;
      }
    } else {
      // Egyenes gyorsulási mód
      if (gas) this.player.speed = Math.min(this.stats.topSpeed, this.player.speed + this.stats.accel * dt);
      else if (brake) this.player.speed = Math.max(0, this.player.speed - 38 * dt);
      else this.player.speed = Math.max(0, this.player.speed - 10 * dt);

      this.player.x = clamp(this.player.x + steer * this.stats.grip * dt * (this.player.speed > 1 ? 1 : 0), -6.5, 6.5);
      this.player.z -= this.player.speed * dt;

      if (this.mp) {
        if (this.oppNet) {
          this.ai.x += (this.oppNet.x - this.ai.x) * Math.min(1, dt * 15);
          this.ai.z += (this.oppNet.z - this.ai.z) * Math.min(1, dt * 15);
          this.ai.speed = this.oppNet.speed;
        }
      } else {
        this.ai.speed = Math.min(this.opponent.aiTopSpeed, this.ai.speed + this.opponent.aiAccel * dt);
        this.ai.z -= this.ai.speed * dt;
      }

      this.playerGroup.position.set(this.player.x, 0, this.player.z);
      this.playerGroup.rotation.y = Math.PI;
      this.aiGroup.position.set(this.ai.x, 0, this.ai.z);
      this.aiGroup.rotation.y = Math.PI;

      playerSpeed = this.player.speed;
      this.camera.position.set(this.player.x * 0.45, 3.8, this.player.z + 8.5);
      this.camera.lookAt(this.player.x * 0.5, 1.0, this.player.z - 12);

      const covered = Math.min(this.distance, Math.round(-this.player.z));
      document.getElementById('hud-progress').textContent = `${covered} / ${this.distance} m`;

      if (this.mp) {
        if (-this.player.z >= this.distance) {
          this.mp.socket.emit('player_finished', { code: this.mp.code });
          return;
        }
      } else if (-this.player.z >= this.distance || -this.ai.z >= this.distance) {
        const won = -this.player.z >= -this.ai.z;
        this.stop();
        if (this.onFinish) this.onFinish(won, this.opponent);
        return;
      }
    }

    // Pozíció küldése multiplayerben
    if (this.mp) {
      this.netTimer += dt;
      if (this.netTimer >= 0.035) {
        this.netTimer = 0;
        this.mp.socket.emit('state', {
          code: this.mp.code,
          data: {
            x: this.player.x,
            z: this.player.z,
            a: this.player.a || Math.PI,
            speed: playerSpeed,
            u: this.player.u || 0
          }
        });
      }
    }

    if (this.osc && this.gain) {
      this.osc.frequency.value = 55 + playerSpeed * 3.0 + (gas ? 18 : 0);
      this.gain.gain.value = 0.04 + (gas ? 0.04 : 0);
    }

    // Kamera felé fordítás a futam alatt
    this.billboards.forEach(sp => {
      sp.quaternion.copy(this.camera.quaternion);
    });

    document.getElementById('hud-speed').textContent = `${Math.round(playerSpeed * 3.6)} km/h`;
    this.updateMoon(dt);
	this.renderer.render(this.scene, this.camera);
  }

  bindInputs() {
    const mapKey = (code, val) => {
      if (code === 'ArrowUp' || code === 'KeyW') this.input.gas = val;
      if (code === 'ArrowDown' || code === 'KeyS') this.input.brake = val;
      if (code === 'ArrowLeft' || code === 'KeyA') this.input.left = val;
      if (code === 'ArrowRight' || code === 'KeyD') this.input.right = val;
    };
    window.addEventListener('keydown', (e) => mapKey(e.code, true));
    window.addEventListener('keyup', (e) => mapKey(e.code, false));

    const bindTouch = (id, key) => {
      const el = document.getElementById(id);
      if (!el) return;
      const set = (v) => (e) => {
        e.preventDefault();
        this.input[key] = v;
      };
      el.addEventListener('pointerdown', set(true));
      el.addEventListener('pointerup', set(false));
      el.addEventListener('pointerleave', set(false));
      el.addEventListener('pointercancel', set(false));
    };
    bindTouch('t-left', 'left');
    bindTouch('t-right', 'right');
    bindTouch('t-gas', 'gas');
    bindTouch('t-brake', 'brake');
  }

  resize() {
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
  }
}