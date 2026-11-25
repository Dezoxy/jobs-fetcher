import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildScene, indexModel, listViews } from './model.ts';
import type { SceneNode } from './model.ts';
import { fixture } from './fixture.test-data.ts';

const ids = (nodes: SceneNode[]): unknown =>
  nodes.map((n) => (n.children.length ? { [n.id]: ids(n.children) } : n.id));

test('views come back in DSL order with their kind', () => {
  assert.deepEqual(listViews(fixture()).map((v) => [v.key, v.kind]), [
    ['Context', 'systemContextViews'],
    ['Containers', 'containerViews'],
    ['Flow', 'dynamicViews'],
    ['Deploy', 'deploymentViews'],
  ]);
});

test('instances borrow the name of what they deploy', () => {
  const { elements } = indexModel(fixture());
  assert.equal(elements.get('22')?.name, 'Web');
  assert.equal(elements.get('22')?.parentId, '21');
  // …and its styles: the container's tags first, then the instance's own.
  assert.deepEqual(elements.get('22')?.tags, ['Element', 'Container', 'Container Instance']);
});

test('a container view frames the containers in their software system', () => {
  const scene = buildScene(fixture(), 'Containers');
  assert.deepEqual(ids(scene.nodes), ['1', { 2: ['3', '4'] }]);
  const frame = scene.nodes.find((n) => n.id === '2');
  assert.equal(frame?.boundary, true);
  assert.equal(frame?.description, '');
  assert.equal(scene.layout.rankDirection, 'LeftRight');
  assert.equal(scene.description, 'Inside the app');
});

test('a context view shows the system itself, not a frame', () => {
  const scene = buildScene(fixture(), 'Context');
  assert.deepEqual(ids(scene.nodes), ['1', '2', '5']);
  assert.ok(scene.nodes.every((n) => !n.boundary));
});

test('deployment nodes nest by their own hierarchy', () => {
  assert.deepEqual(ids(buildScene(fixture(), 'Deploy').nodes), [{ 20: [{ 21: ['22'] }] }]);
});

test('a dynamic view numbers its steps and keeps reused relationships apart', () => {
  const scene = buildScene(fixture(), 'Flow');
  assert.deepEqual(scene.edges.map((e) => [e.id, e.label]), [
    ['11#1', '1. First read'],
    ['11#2', '2. Second read'],
  ]);
});

test('styles apply in tag order, later tags winning', () => {
  const scene = buildScene(fixture(), 'Context');
  const mailer = scene.nodes.find((n) => n.id === '5')!;
  assert.equal(mailer.style.background, '#999999'); // External after Software System
  assert.equal(mailer.style.border, 'Dashed');
  assert.equal(mailer.style.color, '#111111'); // from Element
  assert.equal(mailer.style.fontSize, 22);
  assert.equal(mailer.style.width, 450); // Structurizr default
  const db = buildScene(fixture(), 'Containers').nodes[1]!.children[1]!;
  assert.equal(db.style.shape, 'Cylinder');
});

test('relationship styles start from the Relationship tag', () => {
  const edges = buildScene(fixture(), 'Containers').edges;
  assert.deepEqual(edges.map((e) => [e.id, e.style.color, e.style.dashed]), [
    ['10', '#888888', false],
    ['11', '#00aa00', false],
  ]);
});

test('an unknown view key is an error', () => {
  assert.throws(() => buildScene(fixture(), 'Nope'), /no view with key Nope/);
});
