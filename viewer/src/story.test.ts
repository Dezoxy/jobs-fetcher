import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { listViews } from './model.ts';
import type { RawWorkspace } from './model.ts';
import { storyOrder } from './story.ts';
import { fixture } from './fixture.test-data.ts';

const keys = (yaml: string | undefined) => storyOrder(listViews(fixture()), yaml).views.map((v) => v.key);

test('without a story the DSL order stands', () => {
  assert.deepEqual(keys(undefined), ['Context', 'Containers', 'Flow', 'Deploy']);
});

test('listed views come first, the rest follow in DSL order', () => {
  assert.deepEqual(keys('story: [Flow, Context]'), ['Flow', 'Context', 'Containers', 'Deploy']);
});

test('unknown and repeated keys are reported, never shown twice', () => {
  const story = storyOrder(listViews(fixture()), 'story:\n  - Deploy\n  - Typo\n  - Deploy\n');
  assert.deepEqual(story.views.map((v) => v.key), ['Deploy', 'Context', 'Containers', 'Flow']);
  assert.deepEqual(story.unknown, ['Typo']);
});

test('a malformed story is an error, not a silent reorder', () => {
  assert.throws(() => keys('story: Flow'), /must be a list of view keys/);
  assert.throws(() => keys('story: [1, 2]'), /must be a list of view keys/);
});

const ws = new URL('../public/workspace.json', import.meta.url);
const yaml = new URL('../../docs/architecture/presentation.yaml', import.meta.url);

test('presentation.yaml names only views the workspace has', { skip: !existsSync(ws) && 'run `npm run workspace` first' }, () => {
  const story = storyOrder(listViews(JSON.parse(readFileSync(ws, 'utf8')) as RawWorkspace), readFileSync(yaml, 'utf8'));
  assert.deepEqual(story.unknown, []);
});
