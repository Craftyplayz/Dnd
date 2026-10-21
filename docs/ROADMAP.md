# Battle Map Studio: Roadmap

Status key: [ ] planned, [~] in progress, [x] done

## Phase 0: Contract (in progress)
- [x] schema.json: scene schema, 20 element types, size ranges, collision rules
- [x] src/schema.js: normalize + hand-written validator
- [x] src/core/: rng, bus, svg helpers, geometry, patch, store (undo/redo)
- [~] samples/: forest-road-ambush, riverside-ruin (distance constraints not yet exact)
- [ ] tests/: schema and patch test cases shared by JS and Python
- [ ] docs/CONTRACT.md

## Phase 1: Parallel build
### Renderer and terrain (src/render/)
- [ ] Scene composition and layer order
- [ ] Terrain textures (grass, dirt, stone, water) and edge blending
- [ ] Paths and regions, grid overlay, lighting and soft shadows
- [ ] Pan and zoom
### Object generators (src/generators/)
- [ ] tree, bush, boulder, rock cluster, wagon, crate, barrel, tent, campfire
- [ ] building, bridge, road, stream, ruined wall, fence, cliff edge
- [ ] pond, tall grass, rubble, ground, label
- [ ] Seeded variation, painted style, shared light direction
### Editor (src/editor/)
- [ ] Click to select: outline, handles, name, size in feet
- [ ] "Describe the change" popover for the selection
- [ ] Drag with grid snap, Delete key, undo/redo (Ctrl+Z / Ctrl+Y)
- [ ] Measure tool, layer panel, properties panel
- [ ] Whole-map change box, scene list UI
### Backend and AI (server.py, prompts/, src/layout/)
- [ ] POST /api/generate, POST /api/edit (JSON Patch output)
- [ ] Validation, one retry, clear errors
- [ ] Auth: password, signed session cookie, IP lockout
- [ ] Rate limit, daily cap, usage log, cost indicator
- [ ] Scene storage: /api/scenes CRUD with safe ids
- [ ] Layout engine: collisions, spacing, exact stated distances, distance report
### Export, persistence, packaging
- [ ] PNG exports: VTT (140 px/sq), Print (300 DPI), Screen, No grid
- [ ] Tiled rendering above 8192 px
- [ ] JSON download/upload, localStorage draft autosave
- [ ] build.py (single dist/index.html), Dockerfile, docker-compose.yml, .env.example

## Phase 2: Integration
- [ ] src/main.js and index.html wiring
- [ ] Resolve contract issues reported by agents

## Phase 3: Verification
- [ ] QA: Playwright run on samples plus 3 generated scenes, all exports, edit loop
- [ ] Docker build/run/restart check (Docker is not installed on this machine)
- [ ] Review: distances, API key exposure, invalid LLM output, auth, limits, path traversal
- [ ] Fix findings, re-run QA

## Phase 4: Docs and release
- [ ] README: local setup, Docker, env vars, API key, monthly spend limit, adding an element type, example description
- [ ] Commit in logical chunks and push

## Future: Live session maps (optional)
- [ ] Find out how NoteCat exposes transcripts (API, webhook, or live file)
- [ ] Bridge program: read the transcript feed
- [ ] Filter table talk from scene descriptions (cheap Haiku 5.5 pass)
- [ ] Batch 30-60 s of description per AI call
- [ ] Bridge auth (API token instead of a login cookie)
- [ ] Live map refresh in the browser (polling)
- [ ] Fallback: Discord bot reading a transcript channel
- [ ] Check daily cap and cost against a full session
