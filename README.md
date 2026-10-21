# Battle Map Studio

Self-hosted web app that turns a plain-English description into a D&D battle map, then lets you edit any single element by clicking it and describing the change.

- Real distances: everything is in feet on a 5 ft grid. Distances you state ("30 ft east of the tower") become constraints that are solved exactly and shown in the Distances panel.
- Procedural, seeded vector art: the same scene always renders the same way, at any zoom or export size.
- Editing: click to select (outline, handles, name and size in feet), describe a change, and it applies to that element only. Drag with grid snap, Delete, Ctrl+Z / Ctrl+Y, a measure tool, layer toggles, and a box for changes to the whole map.
- Export: PNG for VTT (140 px per square), Print (300 DPI, 1 inch = 5 ft), the current screen, or VTT without the grid.
- Scenes are saved on the server; JSON download and upload also work.

## Quick start with Docker

1. `cp .env.example .env`
2. Edit `.env`: set `APP_PASSWORD` (at least 12 characters) and `ANTHROPIC_API_KEY`.
3. `docker compose up -d`
4. Open http://localhost:8080 and log in.

Scenes, the usage counters and the session secret live in the named volume `bms-data` (mounted at `/data`), so they survive restarts and rebuilds. The container runs as a non-root user and has a healthcheck on `/healthz`. To publish on another host port, set `HOST_PORT` in `.env`.

## Local setup without Docker

Needs Python 3.12 or newer. No packages to install.

```sh
python build.py                                  # bundles src/ into dist/index.html
export APP_PASSWORD='choose-a-long-password'     # required, 12+ characters
export ANTHROPIC_API_KEY='sk-ant-...'
python server.py                                 # http://localhost:8080
```

On Windows PowerShell use `$env:APP_PASSWORD = '...'` instead of `export`, and `py` instead of `python` if that is how Python is installed.

**The server refuses to start without `APP_PASSWORD`, or with one shorter than 12 characters, even on your own machine.** This is deliberate: the app spends money on your API key, so it is never left open. `server.py` does not read `.env`; set the variables in your shell (Docker Compose reads `.env` for you). Locally, data goes to `./data` unless you set `DATA_DIR`.

Run `python build.py` again after changing anything in `src/`.

## Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `APP_PASSWORD` | none (required) | Login password, at least 12 characters |
| `ANTHROPIC_API_KEY` | none | Anthropic API key. Without it the app runs, but Generate and AI edits return an error |
| `CLAUDE_MODEL` | `config.json` `model`, then `claude-sonnet-5-5` | Model for generation and edits |
| `PORT` | `8080` | Port the server listens on (fixed to 8080 inside Docker) |
| `HOST_PORT` | `8080` | Host port published by docker-compose |
| `DATA_DIR` | `./data` (`/data` in Docker) | Scenes, usage counters, usage log, session secret |
| `SESSION_SECRET` | generated into `DATA_DIR/session_secret` | Cookie signing key. Changing it logs everyone out |
| `COOKIE_SECURE` | `0` | Set to `1` when the app is served over HTTPS |
| `TRUSTED_PROXY` | `0` | Set to `1` only behind your own reverse proxy, so the login lockout uses `X-Forwarded-For` |
| `RATE_LIMIT_PER_MIN` | `20` | AI requests per minute per session |
| `DAILY_REQUEST_CAP` | `300` | AI requests per UTC day across all users; persisted across restarts |
| `MAX_BODY_BYTES` | `2097152` | Largest accepted request body |
| `LOGIN_MAX_FAILS` / `LOGIN_LOCKOUT_MIN` | `5` / `15` | Failed logins from one IP before a lockout, and its length |

Per-token prices for the usage indicator are in `config.json` (`pricing`). Every AI request's token usage is appended to `DATA_DIR/usage.log`.

## The API key, and a second safety net

1. Create a key at https://console.anthropic.com/settings/keys. Use a key just for this app.
2. Put it in `.env` (Docker) or your shell environment (local). It stays on the server: the browser never sees it, and it is never logged.
3. **Set a monthly spend limit on the Limits page of the Anthropic Console.** The app's own daily request cap and per-session rate limit protect you from runaway use inside the app; the Console limit is the hard stop if anything else goes wrong, such as a leaked key.

With the default model a generation typically costs roughly 5 to 30 US cents, depending on map size; an element edit costs about a cent. The side panel shows today's request count and estimated cost.

## Using it

1. Type a description in the top bar and press Generate (20 seconds to a few minutes).
2. Check the Distances panel: every distance you stated, collisions, map bounds, open movement lanes, and how much open ground has cover nearby.
3. Click an element, describe the change in the box that appears ("make this a covered wagon with a broken wheel"), press Apply.
4. With nothing selected, the same box changes the whole map ("make it dusk and add a campfire between the tents").
5. Save to the library, or download the JSON. Export PNGs from the bar at the bottom.

Shortcuts: V select, M measure, Delete, Ctrl+Z, Ctrl+Y, arrows nudge 5 ft (Shift 1 ft), Alt while dragging turns off snapping, Space-drag or middle-drag pans, the mouse wheel zooms.

### An example description that shows off the system

> Forest clearing at dusk, 120 by 90 ft. A shallow stream runs north to south 30 ft east of a ruined stone watchtower. A dirt road crosses the stream over a wooden bridge. Two wagons lie overturned on the road 15 ft west of the bridge, with spilled crates and barrels. Dense oaks and pines ring the clearing with brambles between them, a campfire burns 20 ft south of the tower, and tall grass grows along the stream banks.

The Distances panel should then show the stream exactly 30 ft from the tower, the wagons 15 ft from the bridge, and the campfire 20 ft from the tower.

## Adding a new element type

1. Add an entry under `x-elementTypes` in `schema.json`: `kind` (`object`, `path`, `region` or `label`), default `layer` and allowed `layers`, collision `cat`, `footprint`, `footprintScale`, `blockedBy`, `minGapFt`, realistic `sizeFt` (or `widthFt` for paths), a one-line `description`, and a `params` schema with defaults. The AI prompt is built from this entry automatically.
2. Add one file, `src/generators/<type>.js`:

   ```js
   import { h } from '../core/svg.js';
   export default {
     type: 'well',
     render(el, rng, ctx) {
       // Draw in local feet, centred on (0, 0). Use rng for variation, ctx.shadow() for the shadow.
       return h('g', {}, [/* ... */], ctx.doc);
     },
   };
   ```

3. Run `python build.py`. It regenerates `src/generators/index.js` and fails if the generator files and the schema types do not match.

`docs/CONTRACT.md` describes the scene model, the generator interface and every API in full.

## Development

- Tests: `node --test tests/*.test.mjs` and `python -m unittest discover tests`.
- Layout: `src/` is plain ES modules (no frameworks, no npm); `server.py` is Python standard library only; `prompts/` holds the system prompts; `samples/` has two hand-made scenes.
