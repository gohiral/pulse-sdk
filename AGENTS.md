# hi_pulse — install instructions for AI agents

Terse, command-first install steps for the `hi_pulse` SDK in a
Phoenix LiveView consumer app. Read this *before* the README. Humans
should read [README.md](README.md) instead.

## Preconditions

- Target is a Phoenix LiveView app generated with `mix phx.new`
  (Tailwind v3 + esbuild). Heavily-customized asset pipelines may
  need manual patching — the installer prints fallbacks on miss.
- A `hi_pulse_server` instance is reachable (default
  `https://pulse.hiral.io`).
- **The user must issue a project token before you run the installer.**
  They go to `<server>/admin/projects` → New Project → copy the
  plaintext token shown exactly once. **Don't make up tokens.** If
  the user hasn't issued one yet, stop and ask.
  - With an admin PAT for the `pulse` CLI, create the project
    yourself instead, keeping the token out of your output:
    `pulse projects create <slug> --name "<App name>" --token-out <file>`
    (writes the token to `<file>` with mode 0600). Pass it on with
    `--token="$(cat <file>)"` and delete the file afterwards. Set
    Linear routing with `pulse projects linear <slug> …` (see
    `docs/http-api.md` § PAT API).

## Install (3 commands)

```bash
# 1. Add the dep — append to the deps/0 list in mix.exs:
#     {:hi_pulse, github: "gohiral/pulse-sdk", tag: "v0.2.1"}

# 2. Pull
mix deps.get

# 3. Run the installer. Pass flags to skip prompts:
mix hi_pulse.install \
  --token=hif_live_<...> \
  --server-url=https://pulse.hiral.io \
  --capture-errors=prod-only \
  --secret=hif_secret_<...>    # optional: reporter updates
```

The task patches **6 files**, idempotent (re-runs print `already patched`):

| File | What's added |
|------|--------------|
| `config/runtime.exs` | `config :hi_pulse` block. Detects Dotenvy and emits `Dotenvy.env!` for dev/test + `System.fetch_env!` for prod. Vanilla apps get plain `System.fetch_env!`. Reads the optional `HI_PULSE_SECRET` too. |
| `lib/<app>_web/components/layouts/root.html.heex` | `<HiPulse.Components.pulse_widget />` before `</body>`, gated on `:current_user` |
| `lib/<app>_web/endpoint.ex` | `Plug.Static at: "/assets/vendor/hi_pulse"` inserted **above** the catch-all `Plug.Static at: "/"` — order is mandatory |
| `assets/js/app.js` | `import {PulseWidgetHook}` + register on LiveSocket's `hooks:` (creates the key if missing) |
| `assets/css/app.css` | `@import "../../deps/hi_pulse/priv/static/css/pulse-widget.css";` inserted in the **leading-imports block** (CSS spec requires `@import` to precede non-import rules) |
| `config/config.exs` | `--alias:hi_pulse=…` appended to esbuild args |

Also appends `HI_PULSE_TOKEN`, `HI_PULSE_SERVER_URL` and (when given)
`HI_PULSE_SECRET` to `.env` if it exists; otherwise prints `export …`
lines. Re-running with `--secret` adds the secret to an existing install.

`HI_PULSE_SECRET` is the project's reporter secret (shown once when
rotated in pulse). Like the token, ask the user for it; **don't make it
up**. Without it the widget works but reporter updates stay off.

## Verify

```bash
mix hi_pulse.doctor
```

Static check, 10 wires. Each FAIL prints a fix hint. Exit non-zero on
failure (CI-composable). The reporter-secret and esbuild `NODE_PATH`
checks only WARN. Run this BEFORE handing back to the user —
don't claim "installed" if doctor isn't green.

## The three-step ritual after install

The widget will NOT show up until all three happen, in this order:

1. **Restart the dev server** — `Ctrl-C` twice, then `mix phx.server`.
   Endpoint plug pipeline compiles at boot; code-reloading doesn't
   pick up the new `Plug.Static` mount.
2. **Rebuild assets** — `mix assets.build` (the watcher usually does
   this on save; force it explicitly to be safe).
3. **Hard-refresh the browser** — Cmd-Shift-R / Ctrl-Shift-R.

Tell the user this verbatim. The installer's `print_done` message
covers it but humans skim.

## Common failure modes

| Symptom | Cause | Fix |
|---------|-------|-----|
| `! <file> — anchor not found` | Customized layout / asset pipeline | Paste the printed snippet manually; the rest of the installer continues. |
| `mix hi_pulse.doctor` FAIL on "Endpoint" | SDK vendor mount placed after the catch-all | Move it above; or delete the block and re-run installer. |
| `mix hi_pulse.doctor` FAIL on "CSS @import" with "below a non-import rule" | The import landed at file end (older installer bug); CSS spec drops it silently | Move the line into the leading @import block manually, or delete + re-run installer (which now inserts correctly). |
| `mix hi_pulse.doctor` FAIL on "Runtime config" with "Dotenvy" hint | App uses Dotenvy but installer emitted top-level `System.fetch_env!` (older installer bug) | Delete the `config :hi_pulse` block from `runtime.exs` and re-run installer. |
| FAB doesn't render after the three-step ritual | `:current_user` not in assigns on this page | Set the assign upstream, or pass an explicit `enabled?` to the component. |
| Widget submission 401s | `HI_PULSE_TOKEN` empty / wrong / for another project | Rotate in the admin UI; restart the consumer's BEAM. |
| Browser console: CORS blocked on `/projects/me/config` | Server build pre-dates `0d4db61` | Redeploy `hi_pulse_server`. Widget still works (falls back to default types/priorities); only dropdowns are stale. |
| Replay never reaches bucket | rrweb script tag 404s in the consumer | `mix hi_pulse.doctor` flags this — fix endpoint mount order, restart server. |
| esbuild: `Could not resolve "phoenix"` | esbuild profile has no `NODE_PATH` with `deps/` | Add `env: %{"NODE_PATH" => Path.expand("../deps", __DIR__)}` to the esbuild profile (see README "Reporter updates"). |
| No dot, no "Your reports" despite replies in pulse | `HI_PULSE_SECRET` unset, not read in `runtime.exs`, or the `reporter` map has neither email nor id | `mix hi_pulse.doctor`; check the widget div carries `data-reporter-token`. |
| Widget styles broken (with CSS loaded) | Consumer app's design system overrides `--color-ink` / `--color-canvas` etc. | Either accept the host's tokens or override the widget's CSS variables explicitly at `:root`. |

## Uninstall

The installer is patches-only — no migrations, no seed data, no
generated modules. To remove:

```bash
git diff HEAD~1 HEAD -- mix.exs config/ lib/ assets/   # find the patch commits
git revert <each>
mix deps.unlock --unused
```

Plus remove `HI_PULSE_TOKEN` / `HI_PULSE_SERVER_URL` / `HI_PULSE_SECRET` from `.env`.

## Don't do

- **Don't** add an `on_mount` hook for the widget. The component
  self-gates from `:current_user`. (Earlier versions of this SDK
  required one — that's gone.)
- **Don't** hardcode the token in `runtime.exs`. The installer's
  config block reads from `HI_PULSE_TOKEN`; commit the config but
  not the value.
- **Don't** put `HI_PULSE_SECRET` anywhere the browser sees it. Unlike
  the token, it's a server-side secret: it signs reporter identities and
  authorises release reports.
- **Don't** re-implement the widget UI inside the consumer app. The
  SDK ships the JS, CSS, and component. If you need different copy,
  override `T.fab` etc. (see README "Customize copy").
- **Don't** call `HiPulse.on_mount/4`. The function was removed —
  if you import it from an old example, that's stale code.

## Wire format

`POST <server_url>/api/v1/events` — `multipart/form-data` with:

| Part | Required | Type | Purpose |
|------|----------|------|---------|
| `payload` | yes | JSON string | Event metadata (see below) |
| `screenshot` | no | image/png | Annotated PNG |
| `replay` | no | application/gzip | Gzipped rrweb event stream |

`Authorization: Bearer <project_token>` is required.

Payload schema (snake_case, no camelCase fallbacks):

```json
{
  "title": "string",
  "description": "string | null",
  "type": "<one of project's allowed_event_types>",
  "priority": "<one of project's allowed_event_priorities>",
  "url": "current page",
  "viewport": { "width": 1440, "height": 900 },
  "user_agent": "string",
  "console_buffer": [{ "level": "log|warn|error", "message": "string", "timestamp": 0 }],
  "context": { /* arbitrary, opaque to server */ },
  "reporter": { "email": "string|null", "id": "string|null", "metadata": { /* opaque */ } },
  "replay_duration_ms": 0
}
```

Response: `201 Created` with `{event_id, issue_id, linear_url: null}`
on success. Status codes: `401` (bad token), `413` (oversize),
`422` (validation), `500` (server error). The full HTTP contract is in
`docs/http-api.md` of the private `gohiral/pulse` repo.
