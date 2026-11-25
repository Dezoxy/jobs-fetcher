# Architecture viewer

A web renderer for the Structurizr workspace in `docs/architecture/`. It is
the first step towards an interactive architecture presentation: the DSL
stays the single source of truth, and this app decides how to show it.

```sh
npm ci
npm run workspace   # exports docs/architecture/ to public/workspace.json (Docker)
npm run dev         # http://localhost:5173, ←/→ step through the views
```

**How it works:**

| Step | File | Does |
|---|---|---|
| Model | `src/model.ts` | Reads `workspace.json` into a scene per view: nodes (nested inside their boundaries) and edges. Dynamic-view steps are numbered. |
| Style | `src/style.ts` | Applies Structurizr tag styles in tag order, from Structurizr's defaults. |
| Layout | `src/layout.ts` | Places the scene with ELK. The export has no coordinates for `autoLayout` views, so the viewer computes them, using each view's direction and spacing. |
| Render | `src/render.ts` | Draws SVG; text goes in through `textContent` only. |

Views appear in the DSL's order, which is the presentation order for now.

`public/workspace.json` is generated and git-ignored; it is regenerated from
the DSL whenever you run `npm run workspace`. The viewer is not part of the
refresh image or the Worker: `.dockerignore` and the Worker's `public/` assets
do not include it, and no release workflow watches `viewer/`.

**Not yet:** animated transitions between views, step-by-step playback of
dynamic views, the shapes beyond box, rounded box, cylinder, person and
hexagon, and hosting.
