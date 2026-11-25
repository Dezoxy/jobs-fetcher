import { buildScene, listViews } from './model.ts';
import type { RawWorkspace, Scene } from './model.ts';
import { layoutScene } from './layout.ts';
import type { Placed } from './layout.ts';
import { renderFrame } from './render.ts';
import { storyOrder } from './story.ts';
import { easeInOutCubic, still, tween } from './tween.ts';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const stage = $<HTMLDivElement>('stage');
const picker = $<HTMLSelectElement>('view');
const title = $<HTMLHeadingElement>('title');
const subtitle = $<HTMLParagraphElement>('subtitle');
const stepInfo = $<HTMLSpanElement>('step');

const DURATION = matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 900;

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

  const currentStep = () => shown?.scene.steps[stepIndex];

  const paintStill = () => {
    if (!shown) return;
    const steps = shown.scene.steps;
    stepInfo.textContent = steps.length ? `step ${stepIndex + 1} / ${steps.length}` : '';
    stage.replaceChildren(renderFrame(still(shown.placed), currentStep()));
  };

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

    if (!from || DURATION === 0) return paintStill();
    stepInfo.textContent = '';
    const start = performance.now();
    const frame = (now: number) => {
      if (mine !== ticket) return;
      const t = Math.min(1, (now - start) / DURATION);
      if (t < 1) {
        stage.replaceChildren(renderFrame(tween(from, next.placed, easeInOutCubic(t))));
        requestAnimationFrame(frame);
      } else {
        paintStill();
      }
    };
    requestAnimationFrame(frame);
  };

  // → plays the next step of a dynamic view, then moves on; ← mirrors it.
  const forward = () => {
    if (shown && stepIndex < shown.scene.steps.length - 1) {
      stepIndex++;
      paintStill();
    } else if (index < views.length - 1) {
      void goTo(index + 1, 'first');
    }
  };
  const back = () => {
    if (shown && stepIndex > 0) {
      stepIndex--;
      paintStill();
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
  });

  const wanted = views.findIndex((v) => v.key === decodeURIComponent(location.hash.slice(1)));
  await goTo(Math.max(0, wanted), 'first');
}

main().catch((err: unknown) => {
  stage.textContent = err instanceof Error ? err.message : String(err);
});
