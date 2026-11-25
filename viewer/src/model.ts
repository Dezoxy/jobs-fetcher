// Reads a Structurizr workspace.json (as `structurizr export -f json` writes it)
// into a layout-free scene: the nodes and edges one view shows. Nothing here
// knows about pixels; layout.ts places the scene and render.ts draws it.

import { elementStyle, relationshipStyle } from './style.ts';
import type { ElementStyle, RelationshipStyle, StyleSheet } from './style.ts';

interface RawRelationship {
  id: string;
  sourceId: string;
  destinationId: string;
  description?: string;
  technology?: string;
  tags?: string;
}

interface RawElement {
  id: string;
  name?: string;
  description?: string;
  technology?: string;
  tags?: string;
  relationships?: RawRelationship[];
  containers?: RawElement[];
  components?: RawElement[];
  children?: RawElement[];
  infrastructureNodes?: RawElement[];
  containerInstances?: (RawElement & { containerId: string })[];
  softwareSystemInstances?: (RawElement & { softwareSystemId: string })[];
}

interface RawView {
  key: string;
  name?: string;
  title?: string;
  description?: string;
  order?: number;
  softwareSystemId?: string;
  containerId?: string;
  elementId?: string;
  automaticLayout?: {
    rankDirection?: string;
    rankSeparation?: number;
    nodeSeparation?: number;
    edgeSeparation?: number;
  };
  elements?: { id: string }[];
  relationships?: { id: string; order?: string; description?: string }[];
}

export interface RawWorkspace {
  name?: string;
  model: {
    people?: RawElement[];
    softwareSystems?: RawElement[];
    deploymentNodes?: RawElement[];
  };
  views: Record<string, unknown> & {
    configuration?: { styles?: Partial<StyleSheet> };
  };
}

/** One element of the model, with its kind and parent resolved. */
export interface ModelElement {
  id: string;
  kind: string;
  name: string;
  description: string;
  technology: string;
  tags: string[];
  parentId?: string;
}

export interface SceneNode {
  id: string;
  name: string;
  /** "[Container: Node.js]" style caption under the name. */
  caption: string;
  description: string;
  style: ElementStyle;
  /** A boundary is a group frame (software system, container) drawn around children. */
  boundary: boolean;
  children: SceneNode[];
}

export interface SceneEdge {
  id: string;
  sourceId: string;
  targetId: string;
  /** The description, numbered in dynamic views ("3. Collects …"). */
  label: string;
  technology: string;
  style: RelationshipStyle;
  /** The dynamic-view step this edge belongs to. */
  step?: number;
}

export interface Scene {
  key: string;
  kind: ViewKind;
  title: string;
  description: string;
  layout: Required<NonNullable<RawView['automaticLayout']>>;
  nodes: SceneNode[];
  edges: SceneEdge[];
  /** A dynamic view's steps, ascending; empty for static views. */
  steps: number[];
}

export const VIEW_KINDS = [
  'systemLandscapeViews',
  'systemContextViews',
  'containerViews',
  'componentViews',
  'dynamicViews',
  'deploymentViews',
] as const;
export type ViewKind = (typeof VIEW_KINDS)[number];

export interface ViewRef {
  key: string;
  kind: ViewKind;
  order: number;
  title: string;
}

const splitTags = (tags?: string): string[] =>
  (tags ?? '').split(',').map((t) => t.trim()).filter(Boolean);

/** Flattens the model tree into id → element and id → relationship maps. */
export function indexModel(ws: RawWorkspace) {
  const elements = new Map<string, ModelElement>();
  const relationships = new Map<string, RawRelationship>();

  const add = (raw: RawElement, kind: string, parentId?: string, ref?: ModelElement) => {
    elements.set(raw.id, {
      id: raw.id,
      kind,
      // Instances carry no name of their own; they show the element they deploy.
      name: raw.name ?? ref?.name ?? raw.id,
      description: raw.description ?? ref?.description ?? '',
      technology: raw.technology ?? ref?.technology ?? '',
      // An instance is styled as what it deploys, then by its own tags.
      tags: [...(ref?.tags ?? []), ...splitTags(raw.tags)],
      parentId,
    });
    for (const r of raw.relationships ?? []) relationships.set(r.id, r);
  };

  for (const p of ws.model.people ?? []) add(p, 'Person');
  for (const s of ws.model.softwareSystems ?? []) {
    add(s, 'Software System');
    for (const c of s.containers ?? []) {
      add(c, 'Container', s.id);
      for (const k of c.components ?? []) add(k, 'Component', c.id);
    }
  }
  // Deployment nodes nest; instances point back at the container/system they run.
  const walk = (n: RawElement, parentId?: string) => {
    add(n, 'Deployment Node', parentId);
    for (const i of n.infrastructureNodes ?? []) add(i, 'Infrastructure Node', n.id);
    for (const i of n.containerInstances ?? []) add(i, 'Container', n.id, elements.get(i.containerId));
    for (const i of n.softwareSystemInstances ?? [])
      add(i, 'Software System', n.id, elements.get(i.softwareSystemId));
    for (const c of n.children ?? []) walk(c, n.id);
  };
  for (const n of ws.model.deploymentNodes ?? []) walk(n);

  return { elements, relationships };
}

function rawViews(ws: RawWorkspace): { kind: ViewKind; view: RawView }[] {
  return VIEW_KINDS.flatMap((kind) =>
    ((ws.views[kind] as RawView[] | undefined) ?? []).map((view) => ({ kind, view })),
  );
}

/** Every renderable view, in the order the DSL declares them. */
export function listViews(ws: RawWorkspace): ViewRef[] {
  return rawViews(ws)
    .map(({ kind, view }) => ({
      key: view.key,
      kind,
      order: view.order ?? Number.MAX_SAFE_INTEGER,
      title: view.title ?? view.name ?? view.key,
    }))
    .sort((a, b) => a.order - b.order);
}

const DIRECTIONS: Record<string, string> = {
  TopBottom: 'TopBottom', BottomTop: 'BottomTop', LeftRight: 'LeftRight', RightLeft: 'RightLeft',
};

export function buildScene(ws: RawWorkspace, key: string): Scene {
  const found = rawViews(ws).find(({ view }) => view.key === key);
  if (!found) throw new Error(`no view with key ${key}`);
  const { kind, view } = found;
  const { elements, relationships } = indexModel(ws);
  const sheet: StyleSheet = {
    elements: ws.views.configuration?.styles?.elements ?? [],
    relationships: ws.views.configuration?.styles?.relationships ?? [],
  };

  const inView = new Set((view.elements ?? []).map((e) => e.id));
  // Container and component views draw the element they zoom into as a frame;
  // a dynamic view does the same for the element it is scoped to.
  const boundaryId = view.softwareSystemId ?? view.containerId ?? view.elementId;
  const drawBoundary =
    boundaryId !== undefined && !inView.has(boundaryId) && kind !== 'systemContextViews' && kind !== 'deploymentViews';

  const nodes = new Map<string, SceneNode>();
  const toNode = (el: ModelElement, boundary: boolean): SceneNode => ({
    id: el.id,
    name: el.name,
    caption: `[${el.kind}${el.technology ? `: ${el.technology}` : ''}]`,
    description: boundary ? '' : el.description,
    style: elementStyle(sheet, el.tags),
    boundary,
    children: [],
  });

  for (const id of inView) {
    const el = elements.get(id);
    if (el) nodes.set(id, toNode(el, false));
  }
  if (drawBoundary) {
    const el = elements.get(boundaryId);
    if (el) nodes.set(boundaryId, toNode(el, true));
  }

  // Each node hangs under its nearest ancestor that this view also shows.
  const roots: SceneNode[] = [];
  for (const node of nodes.values()) {
    let parentId = elements.get(node.id)?.parentId;
    while (parentId !== undefined && !nodes.has(parentId)) parentId = elements.get(parentId)?.parentId;
    const parent = parentId === undefined ? undefined : nodes.get(parentId);
    if (parent) {
      parent.children.push(node);
      parent.boundary = true;
      parent.description = '';
    } else {
      roots.push(node);
    }
  }

  const edges: SceneEdge[] = [];
  for (const ref of view.relationships ?? []) {
    const rel = relationships.get(ref.id);
    if (!rel || !nodes.has(rel.sourceId) || !nodes.has(rel.destinationId)) continue;
    const text = ref.description ?? rel.description ?? '';
    edges.push({
      // A dynamic view may reuse one relationship at several steps.
      id: ref.order ? `${rel.id}#${ref.order}` : rel.id,
      sourceId: rel.sourceId,
      targetId: rel.destinationId,
      label: ref.order ? `${ref.order}. ${text}` : text,
      technology: rel.technology ?? '',
      style: relationshipStyle(sheet, splitTags(rel.tags)),
      step: ref.order && Number.isFinite(Number(ref.order)) ? Number(ref.order) : undefined,
    });
  }
  const steps = [...new Set(edges.flatMap((e) => (e.step === undefined ? [] : [e.step])))].sort((a, b) => a - b);

  const auto = view.automaticLayout ?? {};
  return {
    key: view.key,
    kind,
    title: view.title ?? view.name ?? view.key,
    description: view.description ?? '',
    layout: {
      rankDirection: DIRECTIONS[auto.rankDirection ?? ''] ?? 'TopBottom',
      rankSeparation: auto.rankSeparation ?? 300,
      nodeSeparation: auto.nodeSeparation ?? 300,
      edgeSeparation: auto.edgeSeparation ?? 50,
    },
    nodes: roots,
    edges,
    steps,
  };
}
