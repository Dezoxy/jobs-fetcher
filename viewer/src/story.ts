// The presentation order: docs/architecture/presentation.yaml lists view keys,
// and every view it does not list follows in DSL order, so adding a view to
// the DSL never hides it from the presentation.

import { parse } from 'yaml';
import type { ViewRef } from './model.ts';

export interface Story {
  views: ViewRef[];
  /** Keys in presentation.yaml that match no view: typos or renamed views. */
  unknown: string[];
}

export function storyOrder(views: ViewRef[], yamlText: string | undefined): Story {
  const listed = parseStory(yamlText);
  const byKey = new Map(views.map((v) => [v.key, v]));
  const first = [...new Set(listed)].flatMap((k) => byKey.get(k) ?? []);
  const shown = new Set(first.map((v) => v.key));
  return {
    views: [...first, ...views.filter((v) => !shown.has(v.key))],
    unknown: listed.filter((k) => !byKey.has(k)),
  };
}

function parseStory(text: string | undefined): string[] {
  if (!text) return [];
  const doc: unknown = parse(text);
  const story = (doc as { story?: unknown } | null)?.story;
  if (!Array.isArray(story) || !story.every((k) => typeof k === 'string')) {
    throw new Error('presentation.yaml: `story` must be a list of view keys');
  }
  return story;
}
