// Places a Scene with ELK's layered algorithm. Structurizr exports
// autoLayout views with every element at (0,0): the layout is computed by
// whoever renders, so this is ours. The view's automaticLayout settings
// (direction and spacing) map onto ELK's options.

import ELK from 'elkjs/lib/elk.bundled.js';
import type { ElkExtendedEdge, ElkNode } from 'elkjs/lib/elk-api.js';
import type { Scene, SceneEdge, SceneNode } from './model.ts';

export interface Box { x: number; y: number; width: number; height: number }

export interface PlacedNode extends Box { node: SceneNode; depth: number }

export interface PlacedEdge {
  edge: SceneEdge;
  points: { x: number; y: number }[];
  label?: Box & { lines: string[] };
}

export interface Placed { width: number; height: number; nodes: PlacedNode[]; edges: PlacedEdge[] }

const ELK_DIRECTION: Record<string, string> = {
  TopBottom: 'DOWN', BottomTop: 'UP', LeftRight: 'RIGHT', RightLeft: 'LEFT',
};

/** Space reserved for a boundary's name and caption, under its children. */
export const BOUNDARY_LABEL = 110;
const BOUNDARY_PAD = 60;
const LABEL_CHARS = 34;

/** Greedy word wrap at roughly `max` characters per line. */
export function wrap(text: string, max: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (line && line.length + 1 + word.length > max) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/** Wraps, then cuts to `maxLines`, marking a cut with an ellipsis. */
export function wrapClamped(text: string, max: number, maxLines: number): string[] {
  const lines = wrap(text, max);
  if (lines.length <= maxLines) return lines;
  const kept = lines.slice(0, maxLines);
  kept[maxLines - 1] = `${kept[maxLines - 1]!.replace(/[\s,.;:]*$/, '')}…`;
  return kept;
}

/** Text width estimate; good enough to reserve label space without a DOM. */
const textWidth = (s: string, fontSize: number) => s.length * fontSize * 0.56;

export function edgeLabelLines(edge: SceneEdge): string[] {
  const lines = wrap(edge.label, LABEL_CHARS);
  if (edge.technology) lines.push(`[${edge.technology}]`);
  return lines;
}

function toElk(node: SceneNode): ElkNode {
  if (!node.boundary) return { id: node.id, width: node.style.width, height: node.style.height };
  return {
    id: node.id,
    layoutOptions: {
      'elk.padding': `[top=${BOUNDARY_PAD},left=${BOUNDARY_PAD},bottom=${BOUNDARY_PAD + BOUNDARY_LABEL},right=${BOUNDARY_PAD}]`,
    },
    children: node.children.map(toElk),
  };
}

export async function layoutScene(scene: Scene): Promise<Placed> {
  const { rankDirection, rankSeparation, nodeSeparation, edgeSeparation } = scene.layout;

  const edges: ElkExtendedEdge[] = scene.edges.map((edge) => {
    const lines = edgeLabelLines(edge);
    const fs = edge.style.fontSize;
    return {
      id: edge.id,
      sources: [edge.sourceId],
      targets: [edge.targetId],
      labels: [{
        id: `${edge.id}:label`,
        text: lines.join('\n'),
        width: Math.max(...lines.map((l) => textWidth(l, fs))),
        height: lines.length * fs * 1.25,
      }],
    };
  });

  const graph: ElkNode = {
    id: '__root__',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': ELK_DIRECTION[rankDirection] ?? 'DOWN',
      'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
      'elk.edgeRouting': 'ORTHOGONAL',
      'elk.edgeLabels.placement': 'CENTER',
      'elk.layered.spacing.nodeNodeBetweenLayers': String(rankSeparation / 2),
      'elk.spacing.nodeNode': String(nodeSeparation / 2),
      'elk.spacing.edgeEdge': String(edgeSeparation),
      'elk.spacing.edgeNode': String(edgeSeparation),
      'elk.spacing.edgeLabel': '10',
      // Absolute coordinates for everything, whatever the nesting.
      'elk.json.shapeCoords': 'ROOT',
      'elk.json.edgeCoords': 'ROOT',
    },
    children: scene.nodes.map(toElk),
    edges,
  };

  const out = await new ELK().layout(graph);

  const byId = new Map<string, SceneNode>();
  const index = (n: SceneNode) => { byId.set(n.id, n); n.children.forEach(index); };
  scene.nodes.forEach(index);

  const nodes: PlacedNode[] = [];
  const collect = (n: ElkNode, depth: number) => {
    const node = byId.get(n.id);
    if (node) nodes.push({ node, depth, x: n.x ?? 0, y: n.y ?? 0, width: n.width ?? 0, height: n.height ?? 0 });
    for (const c of n.children ?? []) collect(c, depth + 1);
  };
  for (const c of out.children ?? []) collect(c, 0);

  const sceneEdges = new Map(scene.edges.map((e) => [e.id, e]));
  // With INCLUDE_CHILDREN, ELK may move an edge into the lowest common
  // ancestor, so gather edges from every level of the result.
  const placedEdges: PlacedEdge[] = [];
  const collectEdges = (n: ElkNode) => {
    for (const e of n.edges ?? []) {
      const edge = sceneEdges.get(e.id);
      const section = e.sections?.[0];
      if (!edge || !section) continue;
      const label = e.labels?.[0];
      placedEdges.push({
        edge,
        points: [section.startPoint, ...(section.bendPoints ?? []), section.endPoint],
        label: label && label.x !== undefined && label.y !== undefined
          ? { x: label.x, y: label.y, width: label.width ?? 0, height: label.height ?? 0, lines: edgeLabelLines(edge) }
          : undefined,
      });
    }
    for (const c of n.children ?? []) collectEdges(c);
  };
  collectEdges(out);

  return { width: out.width ?? 0, height: out.height ?? 0, nodes, edges: placedEdges };
}
