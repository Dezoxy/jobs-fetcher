# Architecture viewer

An interactive presentation of the Structurizr workspace in
`docs/architecture/`. The DSL stays the single source of truth for what the
system is; `docs/architecture/presentation.yaml` only sets the order to show
it in.

```sh
npm ci
npm run workspace   # exports docs/architecture/ into public/ (Docker)
npm run dev         # http://localhost:5173
```

**Presenting:** → (or Space, Page Down) moves forward, ← moves back.
- **Between views**, the transition runs in three acts. Elements only in the old view leave. Elements in both views (a person, or a software system that becomes the frame around its containers) glide to their new place. Then the new view's elements arrive.
- **In a dynamic view**, → plays one step at a time. The current step is highlighted with a dot travelling along it, earlier steps stay drawn, and later ones are faint. After the last step, → moves to the next view.
- With `prefers-reduced-motion`, views switch without animation.

**Modes:** 2D / 2.5D / 3D in the header, or the `m` key. The choice is kept in the URL (`?mode=3d`).

| Mode | Camera | Controls |
|---|---|---|
| 2D | SVG, the diagram as Structurizr draws it | browser zoom |
| 2.5D | Three.js, orthographic, a fixed angle a little short of isometric | drag pans, scroll zooms |
| 3D | Three.js, perspective | drag orbits, right-drag pans, scroll zooms |

Both 3D modes use the same scene:
- Boundaries become plates, and whatever is inside a boundary stands on its plate, so nesting reads as stacked tiers (Cloudflare › D1 › databases).
- Labels always face the camera.
- The camera flies with every view change, but keeps any angle you orbited to.
- Three.js loads only when a 3D mode is first picked.

**How it works:**

| Step | File | Does |
|---|---|---|
| Model | `src/model.ts` | Reads `workspace.json` into a scene per view: nodes (nested inside their boundaries), edges, and a dynamic view's steps. |
| Story | `src/story.ts` | Orders the views by `presentation.yaml`. Views it leaves out follow in DSL order. |
| Style | `src/style.ts` | Applies Structurizr tag styles in tag order, from Structurizr's defaults. |
| Layout | `src/layout.ts` | Places the scene with ELK. The export has no coordinates for `autoLayout` views, so the viewer computes them, using each view's direction and spacing. |
| Tween | `src/tween.ts` | The transition between two layouts, as a pure function of time. |
| Render | `src/render.ts` | Draws a frame as SVG; text goes in through `textContent` only. |
| 3D | `src/scene3d.ts`, `src/render3d.ts` | Lifts a frame into 3D specs (pure, tested), then draws and updates them with Three.js. |

`public/workspace.json` and `public/presentation.yaml` are generated and
git-ignored. `npm run workspace` regenerates them from `docs/architecture/`.
The viewer is not part of the refresh image or the Worker: `.dockerignore` and
the Worker's `public/` assets do not include it, and no release workflow
watches `viewer/`.

**Not yet:**
- narration per view;
- the shapes beyond box, rounded box, cylinder, person and hexagon;
- hosting.
