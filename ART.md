# Art

| File | Used by | Source | Licence |
| --- | --- | --- | --- |
| `public/img/trash_atlas.webp` | `empty_trash` minigame | Kenney "Food Kit" 3D models (www.kenney.nl), rendered to 2D sprites with three.js | CC0 (credit appreciated, not required) |
| `public/wires.png` | `wires` minigame | Project's own | - |

## trash_atlas.webp

20 sprites, each up to 96 px, packed 5 × 4 in a 500 × 400 atlas (54 KB WebP).
The frame rectangles are listed in `FRAMES` at the top of the script in `public/empty_trash.html`.

Models used: soda-can-crushed, soda-can, can-open, fish-bones, apple-half, banana, bag-flat,
candy-bar-wrapper, chocolate-wrapper, styrofoam, fries-empty, carton-small, cup-coffee, soda-bottle,
plate-broken, popsicle-stick, egg-half, chinese, bottle-ketchup, sausage-half.

Render settings: orthographic camera, model rotated (0.55, 0.7, 0.1) rad, hemisphere light plus two
directional lights, transparent background, 256 px, then trimmed and scaled to 96 px.
