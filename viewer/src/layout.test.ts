import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { buildScene, listViews } from './model.ts';
import type { RawWorkspace } from './model.ts';
import { layoutScene, wrap, wrapClamped } from './layout.ts';
import type { Placed } from './layout.ts';
import { fixture } from './fixture.test-data.ts';

test('wrap breaks at word boundaries and keeps long words whole', () => {
  assert.deepEqual(wrap('one two three four', 9), ['one two', 'three', 'four']);
  assert.deepEqual(wrap('supercalifragilistic word', 5), ['supercalifragilistic', 'word']);
  assert.deepEqual(wrap('  ', 10), []);
});

test('wrapClamped marks a cut with an ellipsis, and only a cut', () => {
  assert.deepEqual(wrapClamped('one two three four', 9, 2), ['one two', 'three…']);
  assert.deepEqual(wrapClamped('one, two, three', 5, 2), ['one,', 'two…']);
  assert.deepEqual(wrapClamped('one two', 9, 2), ['one two']);
});

function assertSane(placed: Placed, edgeCount: number) {
  for (const n of placed.nodes) {
    for (const v of [n.x, n.y, n.width, n.height]) assert.ok(Number.isFinite(v), `${n.node.id} has ${v}`);
    assert.ok(n.width > 0 && n.height > 0, `${n.node.id} has no size`);
  }
  // Children sit inside their frame, which only holds if coordinates are absolute.
  const byId = new Map(placed.nodes.map((n) => [n.node.id, n]));
  for (const frame of placed.nodes.filter((n) => n.node.boundary)) {
    for (const child of frame.node.children) {
      const c = byId.get(child.id)!;
      assert.ok(c.x >= frame.x && c.y >= frame.y, `${child.id} starts outside ${frame.node.id}`);
      assert.ok(c.x + c.width <= frame.x + frame.width && c.y + c.height <= frame.y + frame.height,
        `${child.id} ends outside ${frame.node.id}`);
    }
  }
  assert.equal(placed.edges.length, edgeCount);
  for (const e of placed.edges) assert.ok(e.points.length >= 2 && e.label, `${e.edge.id} has no route or label`);
}

test('the fixture views lay out with frames around their children', async () => {
  const ws = fixture();
  for (const view of listViews(ws)) {
    const scene = buildScene(ws, view.key);
    assertSane(await layoutScene(scene), scene.edges.length);
  }
});

const exported = new URL('../public/workspace.json', import.meta.url);

test('every view of the real workspace lays out', { skip: !existsSync(exported) && 'run `npm run workspace` first' }, async () => {
  const ws = JSON.parse(readFileSync(exported, 'utf8')) as RawWorkspace;
  const views = listViews(ws);
  assert.ok(views.length > 0);
  for (const view of views) {
    const scene = buildScene(ws, view.key);
    assertSane(await layoutScene(scene), scene.edges.length);
  }
});
