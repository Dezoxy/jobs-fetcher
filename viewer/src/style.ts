// Structurizr styles are keyed by tag. An element gets every style whose tag
// it carries, applied in the order of the element's tags, so a later tag
// ("External") overrides an earlier one ("Software System").

export interface ElementStyle {
  background: string;
  stroke: string;
  color: string;
  shape: string;
  border: 'Solid' | 'Dashed' | 'Dotted';
  strokeWidth: number;
  fontSize: number;
  width: number;
  height: number;
}

export interface RelationshipStyle {
  color: string;
  dashed: boolean;
  thickness: number;
  fontSize: number;
}

type Tagged<T> = Partial<T> & { tag: string };

export interface StyleSheet {
  elements: Tagged<ElementStyle>[];
  relationships: Tagged<RelationshipStyle>[];
}

// Structurizr's own defaults (450×300 boxes, 24px text), so a workspace that
// tunes sizes and fonts for Structurizr looks the same here.
export const DEFAULT_ELEMENT: ElementStyle = {
  background: '#dddddd',
  stroke: '#9a9a9a',
  color: '#000000',
  shape: 'Box',
  border: 'Solid',
  strokeWidth: 2,
  fontSize: 24,
  width: 450,
  height: 300,
};

export const DEFAULT_RELATIONSHIP: RelationshipStyle = {
  color: '#707070',
  dashed: true,
  thickness: 2,
  fontSize: 24,
};

function merge<T extends object>(base: T, rules: Tagged<T>[], tags: string[]): T {
  const out = { ...base };
  for (const tag of tags) {
    for (const rule of rules) {
      if (rule.tag !== tag) continue;
      for (const [k, v] of Object.entries(rule)) {
        if (k !== 'tag' && k in base && v !== undefined) (out as Record<string, unknown>)[k] = v;
      }
    }
  }
  return out;
}

export const elementStyle = (sheet: StyleSheet, tags: string[]): ElementStyle =>
  merge(DEFAULT_ELEMENT, sheet.elements, tags);

export const relationshipStyle = (sheet: StyleSheet, tags: string[]): RelationshipStyle =>
  merge(DEFAULT_RELATIONSHIP, sheet.relationships, ['Relationship', ...tags.filter((t) => t !== 'Relationship')]);
