import { buildScene, listViews } from './model.ts';
import type { RawWorkspace, Scene } from './model.ts';
import { layoutScene } from './layout.ts';
import type { Placed } from './layout.ts';
import { renderFrame } from './render.ts';
import { storyOrder } from './story.ts';
import { easeInOutCubic, still, tween } from './tween.ts';
import type { Frame } from './tween.ts';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const stage = $<HTMLDivElement>('stage');
const picker = $<HTMLSelectElement>('view');
const title = $<HTMLHeadingElement>('title');
const subtitle = $<HTMLParagraphElement>('subtitle');
const stepInfo = $<HTMLSpanElement>('step');

const DURATION = matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 900;

// How the stage is drawn: SVG, or Three.js with an isometric or orbiting camera.
const MODES = ['2d', '2.5d', '3d'] as const;
type Mode = (typeof MODES)[number];

interface Painter {
  /** `fit` frames the camera on this frame (3D only; the SVG always fits). */
  paint(frame: Frame, step: number | undefined, fit: boolean): void;
  dispose(): void;
}

const svgPainter = (): Painter => ({
  paint: (frame, step) => stage.replaceChildren(renderFrame(frame, step)),
  dispose: () => stage.replaceChildren(),
});

async function makePainter(mode: Mode): Promise<Painter> {
  if (mode === '2d') return svgPainter();
  // Three.js loads only when a 3D mode is first picked.
  const { Stage3D } = await import('./render3d.ts');
  return new Stage3D(stage, mode);
}

const modeFromUrl = (): Mode => {
  const m = new URLSearchParams(location.search).get('mode');
  return (MODES as readonly string[]).includes(m ?? '') ? (m as Mode) : '2d';
};

async function fetchText(url: string, optional = false): Promise<string | undefined> {
  const res = await fetch(url);
  if (res.ok) return res.text();
  if (optional && res.status === 404) return undefined;
  throw new Error(`${url}: HTTP ${res.status} (run \`npm run workspace\` first)`);
}

async function main() {
  const ws = JSON.parse((await fetchText('workspace.json'))!) as RawWorkspace;
  const story = storyOrder(listViews(ws), await fetchText('presentation.yaml', true));
  if (story.unknown.length) console.warn('presentation.yaml lists unknown views:', story.unknown);
  const views = story.views;
  if (views.length === 0) throw new Error('the workspace has no views');
  for (const v of views) picker.add(new Option(v.title, v.key));

  // Layouts are deterministic, so each view is laid out once.
  const layouts = new Map<string, Promise<{ scene: Scene; placed: Placed }>>();
  const load = (key: string) => {
    let p = layouts.get(key);
    if (!p) {
      const scene = buildScene(ws, key);
      p = layoutScene(scene).then((placed) => ({ scene, placed }));
      layouts.set(key, p);
    }
    return p;
  };

  // Where the presentation is: a view and, in a dynamic view, a step index.
  let index = -1;
  let stepIndex = 0;
  let shown: { scene: Scene; placed: Placed } | undefined;
  let ticket = 0;
  let mode = modeFromUrl();
  let painter = await makePainter(mode);

  const currentStep = () => shown?.scene.steps[stepIndex];

  const paintStill = (fit: boolean) => {
    if (!shown) return;
    const steps = shown.scene.steps;
    stepInfo.textContent = steps.length ? `step ${stepIndex + 1} / ${steps.length}` : '';
    painter.paint(still(shown.placed), currentStep(), fit);
  };

  const buttons = [...document.querySelectorAll<HTMLButtonElement>('#modes button')];
  const setMode = async (next: Mode) => {
    if (next === mode) return;
    painter.dispose();
    mode = next;
    try {
      painter = await makePainter(next);
    } catch (err) {
      console.error(err); // no WebGL, typically
      mode = '2d';
      painter = svgPainter();
    }
    const url = new URL(location.href);
    if (mode === '2d') url.searchParams.delete('mode'); else url.searchParams.set('mode', mode);
    history.replaceState(null, '', url);
    buttons.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === mode)));
    paintStill(true);
  };
  buttons.forEach((b) => {
    b.setAttribute('aria-pressed', String(b.dataset.mode === mode));
    b.addEventListener('click', () => void setMode(b.dataset.mode as Mode));
  });

  const goTo = async (to: number, atStep: 'first' | 'last') => {
    const ref = views[to];
    if (!ref) return;
    const mine = ++ticket;
    const next = await load(ref.key);
    if (mine !== ticket) return; // a newer move started while ELK ran
    const from = shown?.placed;
    index = to;
    shown = next;
    stepIndex = atStep === 'last' ? Math.max(0, next.scene.steps.length - 1) : 0;
    picker.value = ref.key;
    title.textContent = next.scene.title;
    subtitle.textContent = next.scene.description;
    if (location.hash.slice(1) !== ref.key) history.replaceState(null, '', `#${encodeURIComponent(ref.key)}`);

    if (!from || DURATION === 0) return paintStill(true);
    stepInfo.textContent = '';
    const start = performance.now();
    const frame = (now: number) => {
      if (mine !== ticket) return;
      const t = Math.min(1, (now - start) / DURATION);
      if (t < 1) {
        // The camera follows the frame, so in 3D a view change is a fly-over.
        painter.paint(tween(from, next.placed, easeInOutCubic(t)), undefined, true);
        requestAnimationFrame(frame);
      } else {
        paintStill(true);
      }
    };
    requestAnimationFrame(frame);
  };

  // → plays the next step of a dynamic view, then moves on; ← mirrors it.
  const forward = () => {
    if (shown && stepIndex < shown.scene.steps.length - 1) {
      stepIndex++;
      paintStill(false);
    } else if (index < views.length - 1) {
      void goTo(index + 1, 'first');
    }
  };
  const back = () => {
    if (shown && stepIndex > 0) {
      stepIndex--;
      paintStill(false);
    } else if (index > 0) {
      void goTo(index - 1, 'last');
    }
  };

  picker.addEventListener('change', () => void goTo(views.findIndex((v) => v.key === picker.value), 'first'));
  $<HTMLButtonElement>('prev').addEventListener('click', back);
  $<HTMLButtonElement>('next').addEventListener('click', forward);
  document.addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLSelectElement) return;
    if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ') { e.preventDefault(); forward(); }
    if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); back(); }
    if (e.key === 'm') void setMode(MODES[(MODES.indexOf(mode) + 1) % MODES.length]!);
  });

  const wanted = views.findIndex((v) => v.key === decodeURIComponent(location.hash.slice(1)));
  await goTo(Math.max(0, wanted), 'first');
}

main().catch((err: unknown) => {
  stage.textContent = err instanceof Error ? err.message : String(err);
});
