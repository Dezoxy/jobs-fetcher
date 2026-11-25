import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildScene } from './model.ts';
import { layoutScene } from './layout.ts';
import { ACCENT } from './render.ts';
import { PLATE, frameTo3D } from './scene3d.ts';
import { still, tween } from './tween.ts';
import { fixture } from './fixture.test-data.ts';

const ws = fixture();
const lay = async (key: string) => layoutScene(buildScene(ws, key));
const solid = (s: ReturnType<typeof frameTo3D>, id: string) => s.solids.find((x) => x.id === id)!;

test('nesting becomes stacked tiers: each level stands on its parent plate', async () => {
  const s = frameTo3D(still(await lay('Deploy')));
  const [cloud, region, web] = ['20', '21', '22'].map((id) => solid(s, id));
  assert.equal(cloud!.kind, 'plate');
  assert.equal(cloud!.base, 0);
  assert.equal(region!.base, cloud!.base + PLATE);
  assert.equal(web!.base, region!.base + PLATE);
  assert.equal(web!.kind, 'box');
});

test('shapes map to solids, and the ground plane keeps the 2D layout', async () => {
  const placed = await lay('Containers');
  const s = frameTo3D(still(placed));
  assert.equal(solid(s, '1').kind, 'person');
  assert.equal(solid(s, '4').kind, 'cylinder');
  const db = placed.nodes.find((n) => n.node.id === '4')!;
  assert.equal(solid(s, '4').x, db.x + db.width / 2);
  assert.equal(solid(s, '4').z, db.y + db.height / 2);
  assert.ok(solid(s, '4').height > 0 && solid(s, '4').height < db.width);
});

test('relationships run from mid-height to mid-height along the 2D route', async () => {
  const s = frameTo3D(still(await lay('Containers')));
  const web = solid(s, '3');
  const db = solid(s, '4');
  const tube = s.tubes.find((t) => t.points.length && t.label?.lines[0] === 'Queries')!;
  assert.equal(tube.points[0]!.y, web.base + web.height / 2);
  assert.equal(tube.points.at(-1)!.y, db.base + db.height / 2);
});

test('step playback: the current step is accented, future ones are faint', async () => {
  const s = frameTo3D(still(await lay('Flow')), 1);
  const [first, second] = s.tubes;
  assert.equal(first!.current, true);
  assert.equal(first!.color, ACCENT);
  assert.equal(second!.current, false);
  assert.ok(second!.opacity < 0.2);
  assert.equal(second!.label, undefined);
});

test('a transition carries opacity through, and hides what is fully gone', async () => {
  const mid = frameTo3D(tween(await lay('Context'), await lay('Containers'), 0.5));
  assert.equal(mid.solids.some((x) => x.id === '5'), false); // Mailer has left
  assert.equal(solid(mid, '2').opacity, 1); // the system being zoomed into stays
  assert.equal(solid(mid, '2').label.opacity, 0); // its text is mid-swap
});
