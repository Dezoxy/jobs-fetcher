// Lifts a 2D frame into 3D specs: what render3d.ts should draw, with no Three.js
// in sight, so the geometry is testable without WebGL. The layout's (x, y)
// becomes the ground plane (x, z) and y points up. Boundaries become plates,
// and what sits inside a boundary stands on its plate, so nesting reads as
// stacked tiers: Cloudflare › D1 › the databases.

import { edgeLabelLines, wrapClamped } from './layout.ts';
import { ACCENT, emphasis } from './render.ts';
import type { Frame } from './tween.ts';

/** Thickness of a boundary plate; one tier per nesting level. */
export const PLATE = 20;
/** An element block is this fraction of its smaller footprint side tall. */
const BLOCK_HEIGHT = 0.4;

export type SolidKind = 'plate' | 'box' | 'cylinder' | 'person';
export type Vec3 = { x: number; y: number; z: number };

export interface Label {
  /** Bold first line, then the caption and description lines. */
  title: string[];
  lines: string[];
  color: string;
  /** World-space width the label is drawn at. */
  width: number;
  at: Vec3;
  opacity: number;
}

export interface Solid {
  id: string;
  kind: SolidKind;
  /** Centre of the footprint, and the height the solid stands on. */
  x: number; z: number; base: number;
  /** Footprint (x by z) and height (y). */
  width: number; depth: number; height: number;
  fill: string; stroke: string; dashed: boolean;
  opacity: number;
  label: Label;
}

export interface Tube {
  /** Stable while the same placed edge is on screen (see render3d.ts). */
  key: object;
  points: Vec3[];
  color: string;
  radius: number;
  opacity: number;
  current: boolean;
  label?: Label;
}

export interface Scene3D {
  solids: Solid[];
  tubes: Tube[];
  /** Ground-plane bounds the camera should frame. */
  bounds: { x: number; z: number; width: number; depth: number; top: number };
}

const SHAPES: Record<string, SolidKind> = { Cylinder: 'cylinder', Person: 'person' };

export function frameTo3D(frame: Frame, step?: number): Scene3D {
  const solids: Solid[] = frame.nodes.filter((n) => n.opacity > 0).map((n) => {
    const s = n.node.style;
    const kind: SolidKind = n.node.boundary ? 'plate' : SHAPES[s.shape] ?? 'box';
    const base = n.depth * PLATE;
    const height = kind === 'plate' ? PLATE : Math.min(n.width, n.height) * BLOCK_HEIGHT;
    const label: Label = kind === 'plate'
      ? {
        // A boundary is named at its front-left corner, as in 2D.
        title: [n.node.name], lines: [n.node.caption], color: s.stroke, width: Math.min(n.width * 0.5, 600),
        at: { x: n.x + Math.min(n.width * 0.25, 300) + 20, y: base + PLATE + 30, z: n.y + n.height - 40 },
        opacity: n.opacity * n.textOpacity,
      }
      : {
        title: [n.node.name],
        lines: [n.node.caption, ...wrapClamped(n.node.description, 46, 3)],
        color: s.color, width: n.width,
        at: { x: n.x + n.width / 2, y: base + height + 20, z: n.y + n.height / 2 },
        opacity: n.opacity * n.textOpacity,
      };
    return {
      id: n.node.id, kind,
      x: n.x + n.width / 2, z: n.y + n.height / 2, base,
      width: n.width, depth: n.height, height,
      fill: s.background, stroke: s.stroke, dashed: n.node.boundary || s.border !== 'Solid',
      opacity: n.opacity, label,
    };
  });

  // A relationship leaves its source and reaches its target at mid-height.
  const byId = new Map(solids.map((s) => [s.id, s]));
  const midHeight = (id: string) => {
    const s = byId.get(id);
    return s ? s.base + s.height / 2 : 0;
  };

  const tubes: Tube[] = [];
  for (const e of frame.edges) {
    const how = emphasis(e.edge.step, step);
    const opacity = how === 'ghost' ? e.opacity * 0.12 : e.opacity;
    if (opacity <= 0) continue;
    const y0 = midHeight(e.edge.sourceId);
    const y1 = midHeight(e.edge.targetId);
    const lengths = cumulative(e.points);
    const total = lengths[lengths.length - 1] || 1;
    const points = e.points.map((p, i) => ({ x: p.x, y: y0 + (y1 - y0) * (lengths[i]! / total), z: p.y }));
    const current = how === 'current';
    tubes.push({
      key: e.points,
      points,
      color: current ? ACCENT : e.edge.style.color,
      radius: e.edge.style.thickness * (current ? 3 : 1.5),
      opacity,
      current,
      label: e.label && how !== 'ghost'
        ? {
          title: [], lines: edgeLabelLines(e.edge), color: current ? ACCENT : e.edge.style.color,
          width: e.label.width + 20,
          at: { x: e.label.x + e.label.width / 2, y: Math.max(y0, y1) + 40, z: e.label.y + e.label.height / 2 },
          opacity,
        }
        : undefined,
    });
  }

  const vb = frame.viewBox;
  const top = Math.max(0, ...solids.map((s) => s.base + s.height));
  return { solids, tubes, bounds: { x: vb.x, z: vb.y, width: vb.width, depth: vb.height, top } };
}

function cumulative(points: { x: number; y: number }[]): number[] {
  const out = [0];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    out.push(out[i - 1]! + Math.hypot(b.x - a.x, b.y - a.y));
  }
  return out;
}
