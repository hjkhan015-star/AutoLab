// shared/module-base.js — common bootstrap for all learning modules.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

export { THREE, OrbitControls };
export const DEG = Math.PI / 180;
export const TAU = Math.PI * 2;

/* ---------- Iframe detection ---------- */
export function detectEmbed() {
  const embedded = window.parent && window.parent !== window;
  if (embedded) document.body.classList.add('embedded');
  return embedded;
}

/* ---------- Quality tier detection ---------- */
function detectQuality() {
  const isCoarse = matchMedia('(pointer: coarse)').matches;
  const cores    = navigator.hardwareConcurrency || 4;
  const mem      = navigator.deviceMemory || 4;
  const dpr      = window.devicePixelRatio || 1;

  const isLowEnd = cores <= 4 || mem <= 2;
  const isMidEnd = !isLowEnd && (cores <= 6 || mem <= 4 || (isCoarse && dpr >= 2.5));
  const isHighEnd = !isLowEnd && !isMidEnd;

  let dprCap;
  if (isLowEnd)      dprCap = 1.5;
  else if (isMidEnd) dprCap = 1.75;
  else               dprCap = 2;

  const look = isLowEnd
    ? { antialias: false, shadows: false, shadowMapSize: 0, rimLight: false,
        grid: false, floorSegments: 32, fogDensityMul: 1.15,
        toneMapping: false, exposure: 1.0 }
    : isMidEnd
    ? { antialias: true, shadows: true, shadowMapSize: 1024, rimLight: true,
        grid: true, floorSegments: 48, fogDensityMul: 1.0,
        toneMapping: true, exposure: 1.05 }
    : { antialias: true, shadows: true, shadowMapSize: 2048, rimLight: true,
        grid: true, floorSegments: 64, fogDensityMul: 0.9,
        toneMapping: true, exposure: 1.1 };

  return { isCoarse, cores, mem, dpr, isLowEnd, isMidEnd, isHighEnd, dprCap, look };
}

/* ═══════════════════════════════════════════════════════════
   VIEW MANAGER — theme + wireframe + x-ray
   ═══════════════════════════════════════════════════════════ */
function createViewManager(scene, renderer, camera) {
  const DARK_BG     = 0x0b0e14;
  const LIGHT_BG    = 0xdde2ea;    // soft grey-blue, less strain than pure white
  const DARK_FLOOR  = 0x12161f;
  const LIGHT_FLOOR = 0xcbd0d8;

  const state = { theme: 'dark', wireframe: false, xray: false };

  const originals = {
    bg:   scene.background instanceof THREE.Color ? scene.background.clone() : null,
    fog:  scene.fog && scene.fog.color ? scene.fog.color.clone() : null,
    hemi: null, hemiIntensity: 0.55,
    floor: null, floorColor: null,
    grid: null,
    meshMap: new Map(),
    matSet: new Set()
  };

  const wireCache = new Map();
  const xrayCache = new Map();

  /* One-time scan for static references (lights, floor, grid).
     These exist immediately after buildScene() returns. */
  function collectStatics() {
    scene.traverse((obj) => {
      if (obj.isHemisphereLight && !originals.hemi) {
        originals.hemi = obj;
        originals.hemiIntensity = obj.intensity;
      }
      if (obj.userData) {
        if (obj.userData.__isFloor && obj.material && obj.material.color) {
          originals.floor = obj.material;
          originals.floorColor = obj.material.color.clone();
        }
        if (obj.userData.__isGrid) {
          originals.grid = obj;
        }
      }
    });
  }

  /* Incremental mesh scanner — safe to call every frame.
     Never overwrites tracked meshes, so we never capture a
     wireframe/x-ray variant as the "original". */
  function collectNewMeshes() {
    scene.traverse((obj) => {
      if (!(obj.isMesh || obj.isInstancedMesh)) return;
      if (originals.meshMap.has(obj)) return;
      const mat = obj.material;
      if (Array.isArray(mat)) {
        originals.meshMap.set(obj, mat.slice());
        mat.forEach(m => m && originals.matSet.add(m));
      } else if (mat && mat.color) {
        originals.meshMap.set(obj, mat);
        originals.matSet.add(mat);
      }
    });
  }

  /* Pick a wireframe hue from a source material */
  function pickWireColor(mat) {
    if (mat.color) {
      const c = mat.color;
      const max = Math.max(c.r, c.g, c.b);
      const min = Math.min(c.r, c.g, c.b);
      const sat = max < 0.001 ? 0 : (max - min) / max;

      if (sat > 0.20) {
        const hsl = { h: 0, s: 0, l: 0 };
        c.getHSL(hsl);
        return new THREE.Color().setHSL(hsl.h, Math.min(1, hsl.s * 1.25), 0.62);
      }
      if (typeof mat.metalness === 'number') {
        if (mat.metalness > 0.70) return new THREE.Color(0x38bdf8);
        if (mat.metalness > 0.35) return new THREE.Color(0x22c55e);
      }
      return new THREE.Color(0x94a3b8);
    }
    return new THREE.Color(0x38bdf8);
  }

  function makeWireMaterial(mat) {
    if (wireCache.has(mat.uuid)) return wireCache.get(mat.uuid);
    const wm = new THREE.MeshBasicMaterial({
      color: pickWireColor(mat),
      wireframe: true,
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
      depthTest: true,
      fog: true
    });
    wireCache.set(mat.uuid, wm);
    return wm;
  }

  function makeXrayMaterial(mat) {
    if (xrayCache.has(mat.uuid)) return xrayCache.get(mat.uuid);
    let xm;
    try { xm = mat.clone(); }
    catch (_) { xm = new THREE.MeshBasicMaterial({ color: 0x94a3b8 }); }
    xm.transparent = true;
    xm.opacity = 0.24;
    xm.depthWrite = false;
    xm.side = mat.side || THREE.FrontSide;
    if ('emissiveIntensity' in xm) xm.emissiveIntensity = 0;
    xrayCache.set(mat.uuid, xm);
    return xm;
  }

  /* Core material swap — re-scans scene each time, so meshes added
     by the module after buildScene() are picked up automatically. */
  function applyMaterials() {
    /* 1. Restore every tracked mesh to its original material */
    originals.meshMap.forEach((orig, mesh) => {
      if (Array.isArray(orig)) mesh.material = orig.slice();
      else                     mesh.material = orig;
    });

    /* 2. Pick up any new meshes added since last toggle */
    collectNewMeshes();

    /* 3. Bail if both modes are off */
    const { wireframe, xray } = state;
    if (!wireframe && !xray) return;

    /* 4. Apply the current mode */
    originals.meshMap.forEach((orig, mesh) => {
      if (Array.isArray(orig)) {
        if (wireframe) mesh.material = orig.map(m => makeWireMaterial(m));
        else if (xray) mesh.material = orig.map(m => makeXrayMaterial(m));
      } else {
        if (wireframe) mesh.material = makeWireMaterial(orig);
        else if (xray) mesh.material = makeXrayMaterial(orig);
      }
    });
  }

  function applyTheme() {
    const isLight = state.theme === 'light';

    if (scene.background && scene.background.isColor) {
      scene.background.setHex(isLight ? LIGHT_BG : DARK_BG);
    }
    if (scene.fog && scene.fog.color) {
      scene.fog.color.setHex(isLight ? LIGHT_BG : DARK_BG);
    }
    if (originals.hemi) {
      originals.hemi.intensity = isLight
        ? originals.hemiIntensity * 1.55
        : originals.hemiIntensity;
    }
    if (originals.floor) {
      originals.floor.color.copy(originals.floorColor);
      if (isLight) originals.floor.color.lerp(new THREE.Color(LIGHT_FLOOR), 0.85);
    }
    if (originals.grid && originals.grid.material) {
      if (Array.isArray(originals.grid.material)) {
        originals.grid.material.forEach(m => {
          m.opacity = isLight ? 0.35 : 1;
          m.transparent = true;
        });
      } else {
        originals.grid.material.opacity = isLight ? 0.35 : 1;
        originals.grid.material.transparent = true;
      }
    }

    /* DOM theme class — base.css handles the rest */
    document.documentElement.classList.toggle('light-theme', isLight);
    document.body.classList.toggle('light-theme', isLight);
  }

  collectStatics();

  const vm = {
    setTheme(t) {
      if (t !== 'dark' && t !== 'light') return;
      if (state.theme === t) return;
      state.theme = t;
      applyTheme();
    },
    setWireframe(v) {
      v = !!v;
      if (state.wireframe === v) return;
      state.wireframe = v;
      if (v) state.xray = false;
      applyMaterials();
    },
    setXRay(v) {
      v = !!v;
      if (state.xray === v) return;
      state.xray = v;
      if (v) state.wireframe = false;
      applyMaterials();
    },
    restore() {
      state.theme = 'dark';
      state.wireframe = false;
      state.xray = false;
      applyMaterials();
      applyTheme();
    },
    /* Modules that spawn meshes at runtime can nudge the VM */
    refresh() { applyMaterials(); },
    getState() { return { ...state }; }
  };

  window.addEventListener('message', (e) => {
    const d = e.data;
    if (!d || d.source !== 'auto-shell') return;
    if (d.type !== 'command') return;
    switch (d.action) {
      case 'setTheme':     vm.setTheme(d.value === 'light' ? 'light' : 'dark'); break;
      case 'setWireframe': vm.setWireframe(!!d.value); break;
      case 'setXRay':      vm.setXRay(!!d.value); break;
    }
  });

  return vm;
}

let _vm = null;

/* ---------- Scene bootstrap ---------- */
export function buildScene(opts = {}) {
  const wrap = document.getElementById('canvas-wrap');
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0b0e14);

  const q = detectQuality();
  const { isCoarse, isLowEnd, isMidEnd, dprCap, look } = q;

  scene.fog = new THREE.FogExp2(0x0b0e14, (opts.fogDensity ?? 0.035) * look.fogDensityMul);

  const baseFov = opts.fov ?? 42;
  const camera = new THREE.PerspectiveCamera(baseFov, 1, 0.1, 100);
  const cp = opts.camPos || [5.6, 3.7, 7.4];
  camera.position.set(cp[0], cp[1], cp[2]);

  const renderer = new THREE.WebGLRenderer({
    antialias: look.antialias,
    powerPreference: 'high-performance',
    stencil: false,
    alpha: false
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, dprCap));
  renderer.shadowMap.enabled = look.shadows;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  if (look.toneMapping) {
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = look.exposure;
  }
  wrap.appendChild(renderer.domElement);

  const controls = new OrbitControls(camera, renderer.domElement);
  const tg = opts.target || [0, 1.9, 0];
  controls.target.set(tg[0], tg[1], tg[2]);
  controls.enableDamping = true;
  controls.dampingFactor = 0.06;
  controls.minDistance = 3.5;
  controls.maxDistance = 16;
  controls.maxPolarAngle = Math.PI * 0.92;
  controls.rotateSpeed = isCoarse ? 0.6 : 0.9;
  controls.zoomSpeed   = isCoarse ? 0.7 : 1.0;

  const hemi = new THREE.HemisphereLight(0xb8d0ff, 0x1a1520, isLowEnd ? 0.7 : 0.55);
  scene.add(hemi);

  const key = new THREE.DirectionalLight(0xfff4e6, isLowEnd ? 1.0 : (isMidEnd ? 1.2 : 1.3));
  key.position.set(4, 8, 5);
  if (look.shadows) {
    key.castShadow = true;
    key.shadow.mapSize.set(look.shadowMapSize, look.shadowMapSize);
    key.shadow.camera.near = 1; key.shadow.camera.far = 25;
    key.shadow.camera.left = -6; key.shadow.camera.right = 6;
    key.shadow.camera.top = 6;   key.shadow.camera.bottom = -6;
    key.shadow.bias = -0.0005;
    key.shadow.normalBias = 0.02;
  }
  scene.add(key);

  const fill = new THREE.DirectionalLight(0x88aaff, isLowEnd ? 0.5 : 0.4);
  fill.position.set(-5, 3, -3); scene.add(fill);

  if (look.rimLight) {
    const rimBlue = new THREE.DirectionalLight(0x6ba8ff, isMidEnd ? 0.35 : 0.45);
    rimBlue.position.set(-6, 3, -6);
    scene.add(rimBlue);
    const rimAmber = new THREE.DirectionalLight(0xffaa66, isMidEnd ? 0.25 : 0.35);
    rimAmber.position.set(5, 4, -6);
    scene.add(rimAmber);
  }

  const floor = new THREE.Mesh(
    new THREE.CircleGeometry(9, look.floorSegments),
    new THREE.MeshStandardMaterial({ color:0x12161f, roughness:0.92, metalness:0.05 })
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = opts.floorY ?? -2.15;
  floor.receiveShadow = look.shadows;
  floor.userData.__isFloor = true;
  scene.add(floor);

  if (look.grid) {
    const grid = new THREE.GridHelper(10, 20, 0x1e293b, 0x151a24);
    grid.position.y = (opts.floorY ?? -2.15) + 0.01;
    grid.material.transparent = true;
    grid.material.opacity = 0.7;
    grid.userData.__isGrid = true;
    scene.add(grid);
  }

  if (!isLowEnd) {
    const envCanvas = document.createElement('canvas');
    envCanvas.width = 64; envCanvas.height = 64;
    const ctx = envCanvas.getContext('2d');
    const grd = ctx.createLinearGradient(0, 0, 0, 64);
    grd.addColorStop(0.0, '#3a4a68');
    grd.addColorStop(0.5, '#1a2030');
    grd.addColorStop(1.0, '#0a0d13');
    ctx.fillStyle = grd;
    ctx.fillRect(0, 0, 64, 64);
    const envTex = new THREE.CanvasTexture(envCanvas);
    envTex.mapping = THREE.EquirectangularReflectionMapping;
    envTex.colorSpace = THREE.SRGBColorSpace;
    scene.environment = envTex;
  }

  _vm = createViewManager(scene, renderer, camera);

  return { scene, camera, renderer, controls, wrap, isCoarse, baseFov, quality: q, viewManager: _vm };
}

/* ---------- Auto-resize ---------- */
export function attachResize(camera, renderer, wrap, baseFov = 42) {
  function resize() {
    const w = wrap.clientWidth, h = wrap.clientHeight;
    if (!w || !h) return;
    camera.aspect = w / h;
    camera.fov = camera.aspect < 1
      ? Math.min(72, baseFov / Math.max(0.58, camera.aspect))
      : baseFov;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h, false);
  }
  let raf = 0;
  const schedule = () => {
    if (raf) return;
    raf = requestAnimationFrame(() => { raf = 0; resize(); });
  };
  window.addEventListener('resize', schedule);
  window.addEventListener('orientationchange', () => setTimeout(schedule, 220));
  resize();
  return resize;
}

/* ---------- Materials ---------- */
export function createMaterials() {
  const matMetal     = new THREE.MeshStandardMaterial({ color:0x8a93a5, metalness:0.85, roughness:0.28 });
  const matMetalDark = new THREE.MeshStandardMaterial({ color:0x3d4555, metalness:0.70, roughness:0.40 });
  const matAlu       = new THREE.MeshStandardMaterial({ color:0xc5ccd6, metalness:0.75, roughness:0.32 });
  const matIron      = new THREE.MeshStandardMaterial({ color:0x4a5160, metalness:0.55, roughness:0.55 });
  const matIronDS    = matIron.clone(); matIronDS.side = THREE.DoubleSide;
  const matCut       = new THREE.MeshStandardMaterial({ color:0xc45c2a, metalness:0.15, roughness:0.70, side:THREE.DoubleSide });
  const matPiston    = new THREE.MeshStandardMaterial({ color:0xd4dbe6, metalness:0.65, roughness:0.35 });
  const matRing      = new THREE.MeshStandardMaterial({ color:0x6b7280, metalness:0.90, roughness:0.20 });
  const matValve     = new THREE.MeshStandardMaterial({ color:0xb8c0cc, metalness:0.80, roughness:0.25 });
  const matSpring    = new THREE.MeshStandardMaterial({ color:0x94a3b8, metalness:0.85, roughness:0.30 });
  const matInsulator = new THREE.MeshStandardMaterial({ color:0xf1f5f9, metalness:0.05, roughness:0.40 });
  const matPortIn    = new THREE.MeshStandardMaterial({ color:0x38bdf8, metalness:0.10, roughness:0.30, side:THREE.DoubleSide, transparent:true, opacity:0.16, depthWrite:false });
  const matPortEx    = new THREE.MeshStandardMaterial({ color:0x94a3b8, metalness:0.10, roughness:0.30, side:THREE.DoubleSide, transparent:true, opacity:0.16, depthWrite:false });
  const matGas       = new THREE.MeshStandardMaterial({ color:0x38bdf8, transparent:true, opacity:0.35, side:THREE.DoubleSide, depthWrite:false, roughness:1, metalness:0 });
  const matFlash     = new THREE.MeshBasicMaterial({ color:0xffee88, transparent:true, opacity:0 });
  const matSeat      = new THREE.MeshStandardMaterial({ color:0xb08050, metalness:0.65, roughness:0.45 });
  const matGuide     = matMetalDark.clone(); matGuide.side = THREE.DoubleSide;
  const matFlangeGlass = new THREE.MeshStandardMaterial({ color:0x8a93a5, metalness:0.30, roughness:0.40, side:THREE.DoubleSide, transparent:true, opacity:0.35, depthWrite:false });
  return { matMetal, matMetalDark, matAlu, matIron, matIronDS, matCut, matPiston, matRing, matValve, matSpring, matInsulator, matPortIn, matPortEx, matGas, matFlash, matSeat, matGuide, matFlangeGlass };
}

/* ---------- Geometry helpers ---------- */
export function makeCutFace(w, h, mat) {
  return new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
}

export function halfCylShell(rOuter, rInner, height, mats, segs = 48) {
  const m = mats || {};
  const mIron = m.matIron || m.iron || new THREE.MeshStandardMaterial({ color:0x4a5160, metalness:0.55, roughness:0.55 });
  const mMetalDark = m.matMetalDark || m.metalDark || new THREE.MeshStandardMaterial({ color:0x3d4555, metalness:0.70, roughness:0.40 });
  const mCut = m.matCut || m.cut || new THREE.MeshStandardMaterial({ color:0xc45c2a, metalness:0.15, roughness:0.70, side:THREE.DoubleSide });

  const g = new THREE.Group();
  const outer = new THREE.Mesh(
    new THREE.CylinderGeometry(rOuter, rOuter, height, segs, 1, true, Math.PI / 2, Math.PI),
    mIron
  );
  outer.castShadow = true;
  g.add(outer);

  const innerMat = mMetalDark.clone();
  innerMat.side = THREE.BackSide;
  g.add(new THREE.Mesh(
    new THREE.CylinderGeometry(rInner, rInner, height, segs, 1, true, Math.PI / 2, Math.PI),
    innerMat
  ));

  const faceW = rOuter - rInner;
  const f1 = makeCutFace(faceW, height, mCut);
  f1.position.set(-(rInner + rOuter) / 2, 0, 0);
  g.add(f1);
  const f2 = makeCutFace(faceW, height, mCut);
  f2.position.set((rInner + rOuter) / 2, 0, 0);
  g.add(f2);
  return g;
}

export function makeCoolingFins(r, count, spacing, thickness, matAlu, matCut) {
  const g = new THREE.Group();
  for (let i = 0; i < count; i++) {
    const y = (i - (count - 1) / 2) * spacing;
    const fin = new THREE.Mesh(
      new THREE.CylinderGeometry(r + 0.18, r + 0.18, thickness, 48, 1, true, Math.PI/2, Math.PI),
      matAlu
    );
    fin.position.y = y; g.add(fin);
    const fe1 = makeCutFace(0.18, thickness, matCut);
    fe1.position.set(-(r + 0.09), y, 0); g.add(fe1);
    const fe2 = makeCutFace(0.18, thickness, matCut);
    fe2.position.set(r + 0.09, y, 0); g.add(fe2);
  }
  return g;
}

export function makeHelixSpring(radius, tubeR, turns, height, mat, segs = 80) {
  const pts = [];
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    const a = t * turns * Math.PI * 2;
    pts.push(new THREE.Vector3(Math.cos(a) * radius, t * height, Math.sin(a) * radius));
  }
  return new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), segs, tubeR, 8, false), mat);
}

export function tubeBetween(p0, p1, r0, r1, mat, openEnded = true) {
  const dir = new THREE.Vector3().subVectors(p1, p0);
  const len = dir.length();
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(r1, r0, len, 24, 1, openEnded), mat);
  mesh.position.copy(p0).addScaledVector(dir, 0.5);
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0,1,0), dir.clone().normalize());
  return mesh;
}

export function makeFlange(pos, dir, r, t, mat) {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, t, 24), mat);
  m.position.copy(pos);
  m.quaternion.setFromUnitVectors(new THREE.Vector3(0,1,0), dir.clone().normalize());
  return m;
}

export function makeCog(radius, thickness, teeth, toothLen, toothWid, mat, teethMat) {
  const g = new THREE.Group();
  g.add(new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, thickness, 40), mat));
  const tm = teethMat || mat;
  const pitchR = radius + toothLen * 0.5;
  for (let i = 0; i < teeth; i++) {
    const a = (i / teeth) * Math.PI * 2;
    const t = new THREE.Mesh(new THREE.BoxGeometry(toothLen, thickness * 1.05, toothWid), tm);
    t.position.set(Math.cos(a) * pitchR, 0, Math.sin(a) * pitchR);
    t.rotation.y = -a;
    g.add(t);
  }
  return g;
}

export function createParticleTexture() {
  const cnv = document.createElement('canvas');
  cnv.width = cnv.height = 64;
  const ctx = cnv.getContext('2d');
  const grd = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  grd.addColorStop(0,   'rgba(255,255,255,1)');
  grd.addColorStop(0.4, 'rgba(255,255,255,0.5)');
  grd.addColorStop(1,   'rgba(255,255,255,0)');
  ctx.fillStyle = grd;
  ctx.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(cnv);
}

export function createLabelSystem() {
  const root = document.getElementById('labels-root') || document.body;
  const els = {};
  return {
    add(id, text) {
      const el = document.createElement('div');
      el.className = 'label3d';
      el.textContent = text;
      root.appendChild(el);
      els[id] = el;
    },
    hideAll() { for (const k in els) els[k].classList.remove('visible'); },
    hide(id) { if (els[id]) els[id].classList.remove('visible'); },
    project(id, worldVec, camera, wrap) {
      const el = els[id];
      if (!el) return;
      const w = wrap.clientWidth, h = wrap.clientHeight;
      const p = worldVec.clone().project(camera);
      if (p.z > 1) { el.classList.remove('visible'); return; }
      el.style.left = ((p.x * 0.5 + 0.5) * w) + 'px';
      el.style.top  = ((-p.y * 0.5 + 0.5) * h) + 'px';
      el.classList.add('visible');
    }
  };
}

export function createBridge(moduleId, onCommand) {
  const embedded = detectEmbed();
  function send(msg) {
    if (!embedded) return;
    try { window.parent.postMessage(Object.assign({ source: 'auto-module', moduleId }, msg), '*'); }
    catch (_) {}
  }
  window.addEventListener('message', (e) => {
    const d = e.data;
    if (!d || d.source !== 'auto-shell') return;
    if (d.moduleId && d.moduleId !== moduleId) return;
    if (typeof onCommand === 'function') onCommand(d);
  });
  return {
    embedded,
    ready() { send({ type: 'ready' }); },
    setStatus(text, color) { send({ type: 'state', status: { text, color } }); }
  };
}

export function createUIState() {
  const isCoarse = matchMedia('(pointer: coarse)').matches;
  return { playing: true, speedMul: 0.85, showLabels: true, showGas: true, isCoarse };
}

export function wireCommonUI(state, { onReset, onSpeed } = {}) {
  const btnPlay  = document.getElementById('btn-play');
  const iconPlay = document.getElementById('icon-play');
  const iconPause= document.getElementById('icon-pause');
  const btnReset = document.getElementById('btn-reset');
  const speed    = document.getElementById('speed');
  const rpmLabel = document.getElementById('rpm-label');
  const chkLabels= document.getElementById('chk-labels');
  const chkGas   = document.getElementById('chk-gas');

  function updateRpmLabel() {
    if (rpmLabel) rpmLabel.textContent = '~' + Math.round(400 + state.speedMul * 900) + ' rpm';
  }
  function updatePlayIcon() {
    if (iconPlay)  iconPlay.style.display  = state.playing ? 'none'  : 'block';
    if (iconPause) iconPause.style.display = state.playing ? 'block' : 'none';
  }

  if (btnPlay)  btnPlay.addEventListener('click', () => { state.playing = !state.playing; updatePlayIcon(); });
  if (btnReset) btnReset.addEventListener('click', () => { if (onReset) onReset(); });
  if (speed)    speed.addEventListener('input', () => {
    state.speedMul = parseFloat(speed.value);
    updateRpmLabel();
    if (onSpeed) onSpeed(state.speedMul);
  });
  if (chkLabels) chkLabels.addEventListener('change', () => { state.showLabels = chkLabels.checked; });
  if (chkGas)    chkGas.addEventListener('change',    () => { state.showGas    = chkGas.checked; });

  updateRpmLabel();
  updatePlayIcon();
  return { updatePlayIcon, updateRpmLabel, viewManager: _vm };
}

export function wirePanelToggle() {
  const eduPanel = document.getElementById('edu-panel');
  const btn = document.getElementById('panel-toggle');
  if (!eduPanel || !btn) return;
  let userSet = false;
  btn.addEventListener('click', () => {
    userSet = true;
    eduPanel.classList.toggle('collapsed');
    btn.setAttribute('aria-expanded', String(!eduPanel.classList.contains('collapsed')));
  });
  function autoState() {
    if (userSet) return;
    const small = window.innerWidth <= 720 || window.innerHeight <= 540;
    eduPanel.classList.toggle('collapsed', small);
    btn.setAttribute('aria-expanded', String(!small));
  }
  autoState();
  window.addEventListener('resize', autoState);
}