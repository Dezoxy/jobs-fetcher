// Draws scene3d.ts specs with Three.js. Objects persist between frames, keyed
// by element id (and, for relationships, by the placed edge), so a transition
// only moves, resizes and fades what is already there.
//
// Two cameras over the same scene: '2.5d' is an isometric orthographic view
// you can pan and zoom; '3d' is a perspective view you can also orbit.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { frameTo3D } from './scene3d.ts';
import type { Label, Scene3D, Solid, Tube } from './scene3d.ts';
import type { Frame } from './tween.ts';

export type Mode3D = '2.5d' | '3d';

// Rotated less than true isometric (45°), so wide layouts keep reading left to right.
const ISO = new THREE.Vector3(0.55, 1.2, 1).normalize();
const TILTED = new THREE.Vector3(0, 1.25, 1).normalize();

interface SolidObject { group: THREE.Group; body: THREE.Mesh[]; outline: THREE.LineSegments; label: THREE.Sprite; sig: string }
interface TubeObject { mesh: THREE.Mesh; cone: THREE.Mesh; label?: THREE.Sprite; path: THREE.CurvePath<THREE.Vector3>; current: boolean }

export class Stage3D {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.OrthographicCamera | THREE.PerspectiveCamera;
  private controls: OrbitControls;
  private solids = new Map<string, SolidObject>();
  private tubes = new Map<object, TubeObject>();
  private dot: THREE.Mesh;
  private resize = new ResizeObserver(() => this.onResize());
  private running = true;
  private lastBounds?: Scene3D['bounds'];

  constructor(host: HTMLElement, mode: Mode3D) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.setClearColor('#fafbfc');
    host.replaceChildren(this.renderer.domElement);

    this.camera = mode === '2.5d'
      ? new THREE.OrthographicCamera(-1, 1, 1, -1, -50000, 50000)
      : new THREE.PerspectiveCamera(40, 1, 10, 100000);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.screenSpacePanning = true;
    if (mode === '2.5d') {
      this.controls.enableRotate = false;
      this.controls.mouseButtons = { LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
    } else {
      this.controls.maxPolarAngle = Math.PI * 0.48; // never below the ground
    }

    this.scene.add(new THREE.HemisphereLight('#ffffff', '#c9d2de', 2.2));
    const sun = new THREE.DirectionalLight('#ffffff', 1.4);
    sun.position.set(-0.6, 1, 0.4);
    this.scene.add(sun);

    this.dot = new THREE.Mesh(new THREE.SphereGeometry(1, 20, 12), new THREE.MeshBasicMaterial({ color: '#e8590c' }));
    this.dot.visible = false;
    this.scene.add(this.dot);

    this.resize.observe(this.renderer.domElement);
    this.onResize();
    this.renderer.setAnimationLoop((t) => this.tick(t));
  }

  /** Shows a frame; `fit` moves the camera to frame it (on view changes). */
  paint(frame: Frame, step: number | undefined, fit: boolean) {
    const spec = frameTo3D(frame, step);
    this.syncSolids(spec.solids);
    this.syncTubes(spec.tubes);
    this.lastBounds = spec.bounds;
    if (fit) this.fit(spec.bounds);
  }

  dispose() {
    this.running = false;
    this.renderer.setAnimationLoop(null);
    this.resize.disconnect();
    this.controls.dispose();
    disposeTree(this.scene);
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  // ── frame loop ──────────────────────────────────────────────────────────────

  private tick(ms: number) {
    if (!this.running) return;
    // The current dynamic-view step carries a dot from source to target.
    const current = [...this.tubes.values()].find((t) => t.current);
    this.dot.visible = Boolean(current);
    if (current) {
      const p = current.path.getPointAt((ms % 1400) / 1400);
      this.dot.position.copy(p);
      const r = ((current.mesh.geometry as THREE.TubeGeometry).parameters.radius) * 2.2;
      this.dot.scale.setScalar(r);
    }
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }

  private onResize() {
    const { clientWidth: w, clientHeight: h } = this.renderer.domElement;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    if (this.camera instanceof THREE.PerspectiveCamera) {
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
    }
    if (this.lastBounds) this.fit(this.lastBounds);
  }

  // ── camera ──────────────────────────────────────────────────────────────────

  private fit(b: Scene3D['bounds']) {
    const center = new THREE.Vector3(b.x + b.width / 2, b.top / 2, b.z + b.depth / 2);
    const { clientWidth: w, clientHeight: h } = this.renderer.domElement;
    const aspect = w && h ? w / h : 1.6;
    const corners = [b.x, b.x + b.width].flatMap((x) => [b.z, b.z + b.depth].flatMap((z) =>
      [0, b.top].map((y) => new THREE.Vector3(x, y, z))));

    if (this.camera instanceof THREE.OrthographicCamera) {
      this.camera.position.copy(center).addScaledVector(ISO, 10000);
      this.camera.up.set(0, 1, 0);
      this.camera.lookAt(center);
      this.camera.updateMatrixWorld();
      // Frame the bounds' corners as the camera actually sees them.
      let maxX = 0;
      let maxY = 0;
      for (const c of corners) {
        const v = c.clone().applyMatrix4(this.camera.matrixWorldInverse);
        maxX = Math.max(maxX, Math.abs(v.x));
        maxY = Math.max(maxY, Math.abs(v.y));
      }
      const half = Math.max(maxY, maxX / aspect) * 1.04;
      Object.assign(this.camera, { left: -half * aspect, right: half * aspect, top: half, bottom: -half, zoom: 1 });
      this.camera.updateProjectionMatrix();
    } else {
      // Keep the direction the user orbited to; only the distance and target change.
      const dir = this.camera.position.clone().sub(this.controls.target);
      if (dir.lengthSq() < 1) dir.copy(TILTED);
      dir.normalize();
      const halfFov = THREE.MathUtils.degToRad(this.camera.fov / 2);
      let distance = (Math.max(b.width / aspect, b.depth) / 2) / Math.tan(halfFov);
      // The near edge of a tilted plane looks bigger than the far one, so
      // refine: project the corners and rescale until they just fit.
      for (let i = 0; i < 6; i++) {
        this.camera.position.copy(center).addScaledVector(dir, distance);
        this.camera.lookAt(center);
        this.camera.updateMatrixWorld();
        const extent = Math.max(...corners.map((c) => {
          const v = c.clone().project(this.camera);
          return Math.max(Math.abs(v.x), Math.abs(v.y));
        }));
        if (!Number.isFinite(extent) || extent <= 0) break;
        distance *= Math.min(4, Math.max(0.25, extent / 0.92));
      }
    }
    this.controls.target.copy(center);
  }

  // ── solids ──────────────────────────────────────────────────────────────────

  private syncSolids(specs: Solid[]) {
    const seen = new Set<string>();
    for (const s of specs) {
      seen.add(s.id);
      // A box that becomes a frame (or whose text changes) is rebuilt.
      const sig = `${s.kind}|${s.fill}|${s.stroke}|${s.dashed}|${s.label.title.join()}|${s.label.lines.join()}`;
      let o = this.solids.get(s.id);
      if (o && o.sig !== sig) {
        this.removeSolid(s.id);
        o = undefined;
      }
      if (!o) {
        o = this.buildSolid(s, sig);
        this.solids.set(s.id, o);
      }
      this.placeSolid(o, s);
    }
    for (const id of [...this.solids.keys()]) if (!seen.has(id)) this.removeSolid(id);
  }

  private buildSolid(s: Solid, sig: string): SolidObject {
    const group = new THREE.Group();
    const material = new THREE.MeshLambertMaterial({ color: s.fill, transparent: true });
    if (s.kind === 'plate') {
      material.color.set(s.stroke);
      material.depthWrite = false;
    }
    const body: THREE.Mesh[] = [];
    // Unit-sized geometry, scaled per frame: resizing during a transition is free.
    if (s.kind === 'cylinder') {
      body.push(new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 1, 40), material));
    } else if (s.kind === 'person') {
      body.push(new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.5, 1, 32), material)); // a pawn's body
      const head = new THREE.Mesh(new THREE.SphereGeometry(0.5, 24, 16), material);
      head.name = 'head';
      body.push(head);
    } else {
      body.push(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), material));
    }
    body.forEach((m) => group.add(m));

    const edges = new THREE.EdgesGeometry(s.kind === 'cylinder' ? new THREE.CylinderGeometry(0.5, 0.5, 1, 40) : new THREE.BoxGeometry(1, 1, 1), 30);
    const outline = new THREE.LineSegments(edges, new THREE.LineBasicMaterial({ color: s.stroke, transparent: true }));
    group.add(outline);

    const label = makeLabel(s.label);
    group.add(label);
    this.scene.add(group);
    return { group, body, outline, label, sig };
  }

  private placeSolid(o: SolidObject, s: Solid) {
    const opacity = s.kind === 'plate' ? s.opacity * 0.14 : s.opacity * 0.96;
    const [main, head] = o.body;
    if (s.kind === 'person' && main && head) {
      // A slab for the body, a sphere for the head, both inside the footprint.
      const bodyH = s.height * 1.1;
      const across = Math.min(s.width, s.depth) * 0.55;
      main.scale.set(across, bodyH, across);
      main.position.set(s.x, s.base + bodyH / 2, s.z);
      const r = across * 0.32;
      head.scale.setScalar(r * 2);
      head.position.set(s.x, s.base + bodyH + r, s.z);
    } else if (main) {
      main.scale.set(s.width, s.height, s.depth);
      main.position.set(s.x, s.base + s.height / 2, s.z);
    }
    for (const m of o.body) (m.material as THREE.MeshLambertMaterial).opacity = opacity;

    // A person's outline would box the pawn in; it has none.
    o.outline.visible = s.kind !== 'person';
    o.outline.scale.set(s.width, s.height, s.depth);
    o.outline.position.set(s.x, s.base + s.height / 2, s.z);
    (o.outline.material as THREE.LineBasicMaterial).opacity = s.opacity * (s.dashed ? 0.55 : 0.9);

    const labelHeadroom = s.kind === 'person' ? s.height * 0.1 + Math.min(s.width, s.depth) * 0.36 : 0;
    placeLabel(o.label, s.label, labelHeadroom);
  }

  private removeSolid(id: string) {
    const o = this.solids.get(id);
    if (!o) return;
    disposeTree(o.group);
    this.scene.remove(o.group);
    this.solids.delete(id);
  }

  // ── relationships ───────────────────────────────────────────────────────────

  private syncTubes(specs: Tube[]) {
    const seen = new Set<object>();
    for (const t of specs) {
      seen.add(t.key);
      let o = this.tubes.get(t.key);
      if (o && (o.current !== t.current)) {
        this.removeTube(t.key);
        o = undefined;
      }
      if (!o) {
        o = this.buildTube(t);
        this.tubes.set(t.key, o);
      }
      for (const m of [o.mesh, o.cone]) (m.material as THREE.MeshBasicMaterial).opacity = t.opacity;
      if (o.label && t.label) placeLabel(o.label, t.label, 0);
    }
    for (const key of [...this.tubes.keys()]) if (!seen.has(key)) this.removeTube(key);
  }

  private buildTube(t: Tube): TubeObject {
    const pts = t.points.map((p) => new THREE.Vector3(p.x, p.y, p.z));
    const path = new THREE.CurvePath<THREE.Vector3>();
    for (let i = 1; i < pts.length; i++) path.add(new THREE.LineCurve3(pts[i - 1]!, pts[i]!));
    const material = new THREE.MeshBasicMaterial({ color: t.color, transparent: true });
    const mesh = new THREE.Mesh(new THREE.TubeGeometry(path, Math.max(8, pts.length * 12), t.radius, 8, false), material);

    // An arrowhead on the last segment, pointing at the target.
    const end = pts[pts.length - 1]!;
    const before = pts[pts.length - 2] ?? end;
    const cone = new THREE.Mesh(new THREE.ConeGeometry(t.radius * 4, t.radius * 10, 16), material);
    const dir = end.clone().sub(before).normalize();
    cone.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
    cone.position.copy(end).addScaledVector(dir, -t.radius * 5);
    this.scene.add(mesh, cone);

    let label: THREE.Sprite | undefined;
    if (t.label) {
      label = makeLabel(t.label);
      this.scene.add(label);
    }
    return { mesh, cone, label, path, current: t.current };
  }

  private removeTube(key: object) {
    const o = this.tubes.get(key);
    if (!o) return;
    for (const obj of [o.mesh, o.cone, o.label]) {
      if (!obj) continue;
      disposeTree(obj);
      this.scene.remove(obj);
    }
    this.tubes.delete(key);
  }
}

// ── labels ────────────────────────────────────────────────────────────────────

/** A camera-facing text sprite: readable from any angle. */
function makeLabel(l: Label): THREE.Sprite {
  const scale = 2; // canvas pixels per world unit, for crisp text
  const titlePx = 34 * scale;
  const linePx = 22 * scale;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d')!;
  canvas.width = Math.ceil(l.width * scale);
  canvas.height = Math.ceil((l.title.length * titlePx + l.lines.length * linePx) * 1.3 + 16);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.fillStyle = l.color;
  let y = 8;
  for (const line of l.title) {
    ctx.font = `bold ${titlePx}px system-ui, sans-serif`;
    ctx.fillText(line, canvas.width / 2, y, canvas.width - 8);
    y += titlePx * 1.3;
  }
  ctx.font = `${linePx}px system-ui, sans-serif`;
  for (const line of l.lines) {
    ctx.fillText(line, canvas.width / 2, y, canvas.width - 8);
    y += linePx * 1.3;
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  // Labels draw over the geometry, so a block never hides its own name.
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false }));
  sprite.renderOrder = 10;
  sprite.userData.size = { w: canvas.width / scale, h: canvas.height / scale };
  return sprite;
}

function placeLabel(sprite: THREE.Sprite, l: Label, headroom: number) {
  const { w, h } = sprite.userData.size as { w: number; h: number };
  sprite.scale.set(w, h, 1);
  sprite.center.set(0.5, 0); // anchored at its bottom edge
  sprite.position.set(l.at.x, l.at.y + headroom, l.at.z);
  sprite.material.opacity = l.opacity;
  sprite.visible = l.opacity > 0.02;
}

function disposeTree(root: THREE.Object3D) {
  root.traverse((o) => {
    if (o instanceof THREE.Mesh || o instanceof THREE.LineSegments || o instanceof THREE.Sprite) {
      // Every sprite shares one geometry inside Three.js; only its material is its own.
      if (!(o instanceof THREE.Sprite)) o.geometry.dispose();
      const m = o.material as THREE.Material & { map?: THREE.Texture | null };
      m.map?.dispose();
      m.dispose();
    }
  });
}
