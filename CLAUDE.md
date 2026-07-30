# claude-code-feedback

In-page visual feedback for local web apps, fed into Claude Code over MCP. The repo is
both the source project and the Claude Code plugin/marketplace that ships it.

## Layout

| Path | What it is |
|---|---|
| `src/bridge.ts`, `src/store.ts` | MCP server + HTTP intake for the widget |
| `src/widget/widget.ts` | The in-page widget |
| `.claude-plugin/marketplace.json` | Marketplace `claude-code-feedback`, one plugin sourced from `./plugin` |
| `plugin/` | The installed plugin: manifest, `.mcp.json`, skills, **and prebuilt artifacts** |
| `example/`, `test/loop.mjs` | Demo app and a manual end-to-end loop |

`plugin/.mcp.json` runs `node ${CLAUDE_PLUGIN_ROOT}/dist/bridge.js` — that is
`plugin/dist/bridge.js`, **not** the repo-root `dist/`.

## The one rule: built artifacts are committed

A marketplace install is a plain `git clone` of this repo — there is no install step, no
CI, and no git hook that builds anything. So the plugin only works if these three files
are committed and current:

- `plugin/dist/bridge.js`
- `plugin/public/widget.js`
- `plugin/public/demo.html`

They are gitignored by the broad `dist/` and `public/widget.js` rules and deliberately
re-included in `.gitignore`. Editing `src/` and merging without rebuilding ships new
source with the old runtime — silently. That failure has already happened once
(`7989baa`, "Fix plugin MCP bridge crash").

## Preparing a release on a feature branch (before merging to `main`)

Run this on the feature branch, as the last commits before the merge:

**1. Rebuild the plugin artifacts.**

```bash
pnpm install
pnpm run build:plugin
```

`build:plugin` builds `public/widget.js` + `dist/bridge.js`, wipes `plugin/dist` and
`plugin/public`, and copies the fresh artifacts in. Always use this script — never
`pnpm run build` alone, which updates the repo-root copies only and leaves the plugin
stale.

**2. Confirm the artifacts actually changed as expected.**

```bash
git status --short
```

Touched `src/widget/widget.ts` → expect `plugin/public/widget.js` to move. Touched
`src/bridge.ts` or `src/store.ts` → expect `plugin/dist/bridge.js` to move. Nothing
changed after a source edit means the build did not pick it up. Conversely, if you
changed no source, the tree should come back clean — the artifacts are reproducible.

**3. Bump the version in both manifests, keeping them equal. This is mandatory, not
cosmetic.**

- `plugin/.claude-plugin/plugin.json` → `version`
- `package.json` → `version`

Claude Code installs the plugin into a **version-keyed cache**:

```
~/.claude/plugins/cache/claude-code-feedback/web-feedback/<version>/
```

That directory is what `${CLAUDE_PLUGIN_ROOT}` in `plugin/.mcp.json` resolves to, so it is
the tree that actually runs. **The version is the cache key.** Ship a behaviour change
without bumping it and the cache is never invalidated: `/plugin marketplace update` pulls
the new commits into the marketplace clone, `/plugin` still reports the same version, and
every machine that already installed that version keeps running the old build — no matter
how many times the user updates or restarts. The failure is completely silent.

This has already happened: `78c8af8` (keyboard trigger) and `6f1622f` (frozen snapshot)
both merged to `main` under `0.1.2` with no bump, and were unreachable on any machine that
had installed `0.1.2` earlier.

Any change to `src/`, the artifacts, or the skills needs a bump — the two manifests are at
the same number today and must stay in lockstep.

**4. Commit source and artifacts together**, in the same commit, so no revision of `main`
ever has mismatched source and runtime.

**5. Smoke-test before merging.**

```bash
pnpm run example              # demo app
node dist/bridge.js           # bridge on :7878 (CLAUDE_FEEDBACK_PORT to override)
```

Then install the plugin from your local checkout and restart Claude Code:

```
/plugin marketplace add /path/to/claude-code-feedback
/plugin install web-feedback@claude-code-feedback
```

Check `/mcp` shows `web-feedback` connected and leave one real comment end to end. Hard-
refresh the browser after any bridge restart — the widget is served by the bridge and the
old bundle caches.

**6. After merging**, tag the release commit on `main` as `vX.Y.Z` (matching the manifest
version — the existing tags are `v0.1.0`, `v0.1.1`, `v0.1.2`) and push the tag.

## Consuming an update in a local session

The marketplace clone *is* the plugin source, so:

```
/plugin marketplace update claude-code-feedback
```

then **restart Claude Code**. Skills, `plugin/.mcp.json`, and the bridge process are all
read at startup; a running session keeps the old `bridge.js` in memory.

This only works if the release bumped the version (see step 3) — the update lands in the
marketplace clone, but the plugin runs from the version-keyed cache.

### When an update appears to do nothing

Check what the bridge is actually serving, then where it came from:

```bash
curl -s http://localhost:7878/widget.js | grep -c 'Page frozen'   # marker from 6f1622f
find ~/.claude/plugins -name widget.js -exec grep -c 'Page frozen' {} +
```

- Marketplace clone `1`, cache `0` → **stale version-keyed cache**. The release forgot the
  version bump. Fix the release, or locally
  `rm -rf ~/.claude/plugins/cache/claude-code-feedback/web-feedback/<version>` and restart.
- Both `1` but `curl` says `0` → another process owns port 7878 and is serving its own
  copy. `src/bridge.ts` deliberately survives `EADDRINUSE`, so the losing bridge stays
  MCP-connected and looks healthy. `lsof -i :7878`.
- `curl` says `1` but the page behaves old → browser cache. `serveWidget` sets no
  `Cache-Control`, so hard-refresh.

`serveWidget` re-reads from disk per request, so widget changes need no bridge restart —
only `bridge.js` changes do. If the file on disk is new but `curl` is old, it is another
process, not a stale read.
