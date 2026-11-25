// Draws a placed scene as SVG. Text is set with textContent only, never parsed
// as markup, so names and descriptions from the workspace cannot inject HTML.

import { BOUNDARY_LABEL, wrap, wrapClamped } from './layout.ts';
import type { PlacedNode } from './layout.ts';
import type { Frame, FrameEdge, FrameNode } from './tween.ts';

const NS = 'http://www.w3.org/2000/svg';

function el<K extends keyof SVGElementTagNameMap>(
  tag: K, attrs: Record<string, string | number>, parent?: Element,
): SVGElementTagNameMap[K] {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  parent?.appendChild(e);
  return e;
}

function text(parent: Element, lines: string[], x: number, y: number, size: number, attrs: Record<string, string | number> = {}) {
  const t = el('text', { x, y, 'font-size': size, 'text-anchor': 'middle', ...attrs }, parent);
  lines.forEach((line, i) => {
    const span = el('tspan', { x, dy: i === 0 ? 0 : size * 1.25 }, t);
    span.textContent = line;
  });
  return t;
}

const dash = (border: string, w: number) =>
  border === 'Dashed' ? `${w * 6} ${w * 4}` : border === 'Dotted' ? `${w} ${w * 3}` : 'none';

function shape(g: SVGGElement, p: PlacedNode) {
  const { x, y, width: w, height: h } = p;
  const s = p.node.style;
  const paint = {
    fill: p.node.boundary ? 'none' : s.background,
    stroke: s.stroke,
    'stroke-width': s.strokeWidth,
    'stroke-dasharray': dash(p.node.boundary ? 'Dashed' : s.border, s.strokeWidth),
  };
  switch (p.node.boundary ? 'Boundary' : s.shape) {
    case 'Cylinder': {
      const ry = Math.min(30, h / 8);
      el('path', {
        d: `M${x},${y + ry} a${w / 2},${ry} 0 0,0 ${w},0 a${w / 2},${ry} 0 0,0 ${-w},0 v${h - 2 * ry} a${w / 2},${ry} 0 0,0 ${w},0 v${-(h - 2 * ry)}`,
        ...paint,
      }, g);
      break;
    }
    case 'Person': {
      const r = h * 0.2;
      el('circle', { cx: x + w / 2, cy: y + r, r, ...paint }, g);
      el('rect', { x, y: y + r * 1.7, width: w, height: h - r * 1.7, rx: r * 0.8, ...paint }, g);
      break;
    }
    case 'Hexagon': {
      const d = w * 0.12;
      el('polygon', {
        points: [[x + d, y], [x + w - d, y], [x + w, y + h / 2], [x + w - d, y + h], [x + d, y + h], [x, y + h / 2]]
          .map((pt) => pt.join(',')).join(' '),
        ...paint,
      }, g);
      break;
    }
    case 'Box':
    case 'Boundary':
      el('rect', { x, y, width: w, height: h, ...paint }, g);
      break;
    default: // RoundedBox and the shapes this spike does not draw yet
      el('rect', { x, y, width: w, height: h, rx: 20, ...paint }, g);
  }
}

function drawNode(layer: SVGGElement, p: FrameNode) {
  if (p.opacity <= 0) return;
  const g = el('g', { class: p.node.boundary ? 'boundary' : 'element', 'data-id': p.node.id, opacity: p.opacity }, layer);
  shape(g, p);
  if (p.textOpacity <= 0.05) return;
  const label = el('g', { opacity: p.textOpacity }, g);
  const s = p.node.style;
  const fs = s.fontSize;
  if (p.node.boundary) {
    // Structurizr puts a boundary's name in its bottom-left corner.
    const tx = p.x + 30;
    const ty = p.y + p.height - BOUNDARY_LABEL + fs;
    text(label, [p.node.name], tx, ty, fs, { 'font-weight': 'bold', fill: s.stroke, 'text-anchor': 'start' });
    text(label, [p.node.caption], tx, ty + fs * 1.4, fs * 0.75, { fill: s.stroke, 'text-anchor': 'start' });
    return;
  }
  const cx = p.x + p.width / 2;
  const chars = Math.floor(p.width / (fs * 0.62));
  const name = wrap(p.node.name, chars);
  const desc = wrapClamped(p.node.description, Math.floor(p.width / (fs * 0.85 * 0.56)), 4);
  const top = s.shape === 'Person' ? p.y + p.height * 0.45 : p.y + p.height * 0.28;
  text(label, name, cx, top, fs, { 'font-weight': 'bold', fill: s.color });
  const capY = top + name.length * fs * 1.25;
  text(label, [p.node.caption], cx, capY, fs * 0.7, { fill: s.color, opacity: 0.75 });
  text(label, desc, cx, capY + fs * 1.4, fs * 0.85, { fill: s.color });
}

/** The step being played: drawn in the accent colour, with a travelling dot. */
export const ACCENT = '#e8590c';
type Emphasis = 'normal' | 'current' | 'ghost';

/** Past steps stay drawn, the current one stands out, future ones are ghosts. */
export function emphasis(edgeStep: number | undefined, step: number | undefined): Emphasis {
  if (step === undefined || edgeStep === undefined || edgeStep < step) return 'normal';
  return edgeStep === step ? 'current' : 'ghost';
}

function drawEdge(layer: SVGGElement, p: FrameEdge, how: Emphasis, markerFor: (color: string) => string) {
  const opacity = how === 'ghost' ? p.opacity * 0.12 : p.opacity;
  if (opacity <= 0) return;
  const s = p.edge.style;
  const color = how === 'current' ? ACCENT : s.color;
  const width = how === 'current' ? s.thickness * 2.5 : s.thickness;
  const g = el('g', { class: `relationship ${how}`, 'data-id': p.edge.id, opacity }, layer);
  const points = p.points.map((pt) => `${pt.x},${pt.y}`).join(' ');
  el('polyline', {
    points,
    fill: 'none',
    stroke: color,
    'stroke-width': width,
    'stroke-dasharray': s.dashed && how !== 'current' ? `${width * 6} ${width * 4}` : 'none',
    'marker-end': `url(#${markerFor(color)})`,
  }, g);
  if (how === 'current') {
    // A request travelling along the relationship, source to destination.
    const dot = el('circle', { r: width * 3, fill: ACCENT }, g);
    el('animateMotion', {
      dur: '1.4s', repeatCount: 'indefinite', path: `M${points.replaceAll(' ', ' L')}`,
    }, dot);
  }
  if (p.label && how !== 'ghost') {
    const fs = s.fontSize;
    el('rect', { x: p.label.x - 6, y: p.label.y - 4, width: p.label.width + 12, height: p.label.height + 8, fill: '#ffffff', opacity: 0.9 }, g);
    text(g, p.label.lines, p.label.x + p.label.width / 2, p.label.y + fs, fs, {
      fill: color, 'font-weight': how === 'current' ? 'bold' : 'normal',
    });
  }
}

/** Draws one frame; `step` is the dynamic-view step being played, if any. */
export function renderFrame(frame: Frame, step?: number): SVGSVGElement {
  const svg = document.createElementNS(NS, 'svg');
  const vb = frame.viewBox;
  svg.setAttribute('viewBox', `${vb.x} ${vb.y} ${vb.width} ${vb.height}`);
  svg.setAttribute('font-family', 'system-ui, sans-serif');

  // One arrowhead per colour (marker fill cannot follow the line colour in
  // every browser yet).
  const defs = el('defs', {}, svg);
  const markers = new Map<string, string>();
  const markerFor = (color: string) => {
    let id = markers.get(color);
    if (!id) {
      id = `arrow-${markers.size}`;
      markers.set(color, id);
      const marker = el('marker', {
        id, viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 6, markerHeight: 6, orient: 'auto-start-reverse',
      }, defs);
      el('path', { d: 'M0,0 L10,5 L0,10 z', fill: color }, marker);
    }
    return id;
  };

  // Boundaries first (outermost first), then elements, then relationships on
  // top, with the step being played last of all.
  const frames = el('g', { class: 'frames' }, svg);
  const shapes = el('g', { class: 'shapes' }, svg);
  const lines = el('g', { class: 'lines' }, svg);
  [...frame.nodes].sort((a, b) => a.depth - b.depth)
    .forEach((p) => drawNode(p.node.boundary ? frames : shapes, p));
  const rank: Record<Emphasis, number> = { ghost: 0, normal: 1, current: 2 };
  frame.edges
    .map((p) => ({ p, how: emphasis(p.edge.step, step) }))
    .sort((a, b) => rank[a.how] - rank[b.how])
    .forEach(({ p, how }) => drawEdge(lines, p, how, markerFor));
  return svg;
}
