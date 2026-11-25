import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildScene } from './model.ts';
import { layoutScene } from './layout.ts';
import { emphasis } from './render.ts';
import { easeInOutCubic, still, tween, viewBoxOf } from './tween.ts';
import { fixture } from './fixture.test-data.ts';

const ws = fixture();
const context = await layoutScene(buildScene(ws, 'Context'));
const containers = await layoutScene(buildScene(ws, 'Containers'));
const node = (f: ReturnType<typeof still>, id: string) => f.nodes.find((n) => n.node.id === id);

test('the ends of a transition are the two still frames', () => {
  assert.deepEqual(tween(context, containers, 0).viewBox, viewBoxOf(context));
  const end = tween(context, containers, 1);
  assert.deepEqual(end.viewBox, viewBoxOf(containers));
  // Everything of the new view is fully there; the old view's leftovers are gone.
  const inNew = new Set(containers.nodes.map((n) => n.node.id));
  for (const n of end.nodes) assert.equal(n.opacity, inNew.has(n.node.id) ? 1 : 0, n.node.id);
  const old = end.edges.slice(0, context.edges.length);
  const fresh = end.edges.slice(context.edges.length);
  assert.ok(old.every((e) => e.opacity === 0) && fresh.every((e) => e.opacity === 1));
  assert.equal(fresh.length, containers.edges.length);
});

test('the system box grows into the frame around its containers', () => {
  const box = context.nodes.find((n) => n.node.id === '2')!;
  const frame = containers.nodes.find((n) => n.node.id === '2')!;
  const mid = node(tween(context, containers, 0.5), '2')!;
  assert.equal(mid.x, (box.x + frame.x) / 2);
  assert.equal(mid.width, (box.width + frame.width) / 2);
  assert.equal(mid.opacity, 1);
  assert.equal(mid.textOpacity, 0); // text re-wraps for the new size, unseen
  assert.equal(node(tween(context, containers, 0.49), '2')!.node.boundary, false);
  assert.equal(node(tween(context, containers, 0.5), '2')!.node.boundary, true);
});

test('elements only in one view fade out, then in, never overlapping', () => {
  // Mailer (5) is only in the context view; Web (3) only in the container view.
  for (const t of [0, 0.15, 0.3, 0.5, 0.7, 0.85, 1]) {
    const f = tween(context, containers, t);
    const leaving = node(f, '5')!.opacity;
    const entering = node(f, '3')!.opacity;
    assert.ok(leaving === 0 || entering === 0, `both visible at t=${t}`);
  }
  // In the middle act only the shared elements are on stage.
  const mid = tween(context, containers, 0.5);
  assert.equal(node(mid, '5')!.opacity, 0);
  assert.equal(node(mid, '3')!.opacity, 0);
  assert.equal(node(mid, '1')!.opacity, 1);
  assert.ok(Math.abs(node(tween(context, containers, 0.15), '5')!.opacity - 0.5) < 1e-9);
  assert.ok(Math.abs(node(tween(context, containers, 0.85), '3')!.opacity - 0.5) < 1e-9);
});

test('easing starts and ends at rest', () => {
  assert.equal(easeInOutCubic(0), 0);
  assert.equal(easeInOutCubic(0.5), 0.5);
  assert.equal(easeInOutCubic(1), 1);
});

test('playing step 2: step 1 stays, 2 stands out, 3 is a ghost; static views are untouched', () => {
  assert.deepEqual([1, 2, 3].map((s) => emphasis(s, 2)), ['normal', 'current', 'ghost']);
  assert.equal(emphasis(undefined, 2), 'normal');
  assert.equal(emphasis(3, undefined), 'normal');
});

test('a dynamic view lists its steps in order', () => {
  const flow = buildScene(ws, 'Flow');
  assert.deepEqual(flow.steps, [1, 2]);
  assert.deepEqual(flow.edges.map((e) => e.step), [1, 2]);
  assert.deepEqual(buildScene(ws, 'Containers').steps, []);
});
