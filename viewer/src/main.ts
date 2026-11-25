import { buildScene, listViews } from './model.ts';
import type { RawWorkspace } from './model.ts';
import { layoutScene } from './layout.ts';
import { renderScene } from './render.ts';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const stage = $<HTMLDivElement>('stage');
const picker = $<HTMLSelectElement>('view');
const title = $<HTMLHeadingElement>('title');
const subtitle = $<HTMLParagraphElement>('subtitle');

async function main() {
  const res = await fetch('workspace.json');
  if (!res.ok) throw new Error(`workspace.json: HTTP ${res.status} (run \`npm run workspace\` first)`);
  const ws = (await res.json()) as RawWorkspace;
  const views = listViews(ws);
  if (views.length === 0) throw new Error('the workspace has no views');

  for (const v of views) picker.add(new Option(v.title, v.key));

  let rendering = 0;
  const show = async (key: string) => {
    const ticket = ++rendering;
    const scene = buildScene(ws, key);
    const placed = await layoutScene(scene);
    if (ticket !== rendering) return; // a newer view was picked while ELK ran
    picker.value = key;
    title.textContent = scene.title;
    subtitle.textContent = scene.description;
    stage.replaceChildren(renderScene(placed));
    if (location.hash.slice(1) !== key) history.replaceState(null, '', `#${encodeURIComponent(key)}`);
  };

  const step = (delta: number) => {
    const i = views.findIndex((v) => v.key === picker.value);
    const next = views[Math.min(views.length - 1, Math.max(0, i + delta))];
    if (next) void show(next.key);
  };

  picker.addEventListener('change', () => void show(picker.value));
  $<HTMLButtonElement>('prev').addEventListener('click', () => step(-1));
  $<HTMLButtonElement>('next').addEventListener('click', () => step(1));
  document.addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLSelectElement) return;
    if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ') step(1);
    if (e.key === 'ArrowLeft' || e.key === 'PageUp') step(-1);
  });

  const wanted = decodeURIComponent(location.hash.slice(1));
  await show(views.some((v) => v.key === wanted) ? wanted : views[0]!.key);
}

main().catch((err: unknown) => {
  stage.textContent = err instanceof Error ? err.message : String(err);
});
