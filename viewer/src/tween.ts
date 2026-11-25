// The transition between two views, as a pure function of time. An element in
// both views moves and resizes from its old place to its new one; this is how
// a software system's box grows into the frame around its containers. Elements
// only in the old view fade out, those only in the new one fade in, and the
// camera (the SVG viewBox) pans and zooms between the two layouts.

import type { Box, Placed, PlacedEdge, PlacedNode } from './layout.ts';

export interface FrameNode extends PlacedNode { opacity: number; textOpacity: number }
export interface FrameEdge extends PlacedEdge { opacity: number }
export interface Frame { viewBox: Box; nodes: FrameNode[]; edges: FrameEdge[] }

const MARGIN = 40;

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

export const easeInOutCubic = (t: number) =>
  t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;

export const viewBoxOf = (p: Placed): Box =>
  ({ x: -MARGIN, y: -MARGIN, width: p.width + 2 * MARGIN, height: p.height + 2 * MARGIN });

const lerpBox = (a: Box, b: Box, t: number): Box => ({
  x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t),
  width: lerp(a.width, b.width, t), height: lerp(a.height, b.height, t),
});

/** The still frame of a single layout. */
export const still = (to: Placed): Frame => tween(undefined, to, 1);

/** The frame at time t ∈ [0,1] of the transition from `from` to `to`. */
export function tween(from: Placed | undefined, to: Placed, t: number): Frame {
  if (!from) {
    return {
      viewBox: viewBoxOf(to),
      nodes: to.nodes.map((n) => ({ ...n, opacity: 1, textOpacity: 1 })),
      edges: to.edges.map((e) => ({ ...e, opacity: 1 })),
    };
  }
  const before = new Map(from.nodes.map((n) => [n.node.id, n]));
  const after = new Map(to.nodes.map((n) => [n.node.id, n]));
  // Three acts: the old view's own elements leave (first 30%), the shared ones
  // move alone (the zoom), then the new view's own elements arrive (last 30%),
  // once the boxes they sit in have nearly reached their size.
  const out = clamp01(1 - t / 0.3);
  const inn = clamp01((t - 0.7) / 0.3);

  const nodes: FrameNode[] = [];
  for (const a of from.nodes) {
    if (!after.has(a.node.id)) nodes.push({ ...a, opacity: out, textOpacity: 1 });
  }
  for (const b of to.nodes) {
    const a = before.get(b.node.id);
    if (!a) {
      nodes.push({ ...b, opacity: inn, textOpacity: 1 });
      continue;
    }
    // Shared: geometry glides; style and text swap at the midpoint, with the
    // text faded out around it, since it re-wraps for the new size.
    const next = t >= 0.5;
    nodes.push({
      ...(next ? b : a),
      ...lerpBox(a, b, t),
      opacity: 1,
      textOpacity: Math.abs(1 - 2 * t),
    });
  }

  // Relationships do not glide (their routes differ); old ones leave early and
  // new ones arrive late, so lines never cut across moving boxes for long.
  const edges: FrameEdge[] = [
    ...from.edges.map((e) => ({ ...e, opacity: clamp01(1 - t / 0.4) })),
    ...to.edges.map((e) => ({ ...e, opacity: clamp01((t - 0.6) / 0.4) })),
  ];

  return { viewBox: lerpBox(viewBoxOf(from), viewBoxOf(to), t), nodes, edges };
}
