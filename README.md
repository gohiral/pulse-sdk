# hi_pulse

Drop-in **feedback + error-capture** SDK for hiral Phoenix LiveView apps.
Two pipelines into one place:

| | What ships | When |
|---|---|---|
| **Feedback** | annotated screenshot, ~5 min rrweb session replay, console tail, free-text form | user clicks the floating "Feedback" button |
| **Errors** | exception class + scrubbed stack + URL + reporter | automatically, on every server crash and JS runtime error |

Both routes go through `hi_pulse_server`, get content-derived
fingerprints (repeats fold into one Issue), and surface in the same
admin triage UI alongside Linear status.

This is the consumer-side library. The server lives in hiral's private
`gohiral/pulse` repo, which is also where this SDK is developed: this
repo is a read-only copy that receives one commit per release. AI agents:
read [AGENTS.md](AGENTS.md) instead.

No license is granted: all rights reserved. The bundled rrweb files keep
their own MIT license (`priv/static/vendor/LICENSE-rrweb.txt`).

## TL;DR

```bash
# 1. add to mix.exs:
#    {:hi_pulse, github: "gohiral/pulse-sdk", tag: "v0.3.1"}
mix deps.get
mix hi_pulse.install      # interactive; auto-runs mix assets.build at the end
mix hi_pulse.doctor       # static config check — should pass green
mix hi_pulse.doctor --live  # also probes the configured server + token
# Restart the server, hard-refresh the browser. (Installer prints the checklist.)
mix phx.server
```

## What you get

The feedback widget:

- A floating "Feedback" button (configurable corner, persisted in
  `localStorage`).
- A two-column form panel (screenshot on the left, fields on the right).
- A canvas annotator (rectangle, arrow, text, crop, undo).
- A rolling rrweb session-replay buffer (~2.5–5 min) compressed and shipped
  with each submission.
- A console-buffer tail captured via the rrweb console plugin.
- Multipart submission to `POST /api/v1/events` on the configured
  `hi_pulse_server`, authenticated with a per-project bearer token.

Reporter updates (on once you set `HI_PULSE_SECRET`, see "Reporter updates"
below):

- A dot on the button when one of your reports changed, and a one-line
  peek for questions from the team and for fixes that went live.
- A "Your reports" panel: each report as a timeline from received to
  fixed, with the team's messages, your replies, an emoji reaction on
  any team message, and "Works now" / "Still broken" once it's fixed.

Automatic error capture (opt-in via `--capture-errors`, defaults to `prod-only`):

- An OTP `:logger` handler that ships Elixir crashes (LiveView, GenServer,
  bare `Logger.error`) to `POST /api/v1/events/error`.
- A `window.error` / `unhandledrejection` listener that ships JS runtime
  errors via `fetch keepalive` (survives page unload).
- Stack-trace scrubber redacts `password` / `token` / `Bearer …` /
  `Cookie:` / etc. before transit, both sides.
- Self-protection guards against feedback-server-induced loops.
- See "Automatic error capture" further down for details.

## Install

### 1. Issue a token

Sign in to your `hi_pulse_server` (e.g. `https://pulse.hiral.io`), go to
**Admin → Projects → New**, create a project for your consumer app, and
copy the **plaintext token** shown exactly once on the create screen.

The token is bound to one project — leaking it lets anyone post fake
events to *that* project, but nothing else. Treat it like a publishable
key; rotate from the admin UI if something feels off.

### 2. Add the dep

```elixir
# mix.exs
def deps do
  [
    {:hi_pulse, github: "gohiral/pulse-sdk", tag: "v0.3.1"}
  ]
end
```

```bash
mix deps.get
```

### 3. Run the installer

```bash
mix hi_pulse.install
```

The task prompts for four values (skip with flags if you want):

| Prompt | Flag | Default | Meaning |
|---|---|---|---|
| `HI_PULSE_TOKEN` | `--token=hif_live_…` | (required) | The plaintext token from step 1. |
| `HI_PULSE_SERVER_URL` | `--server-url=…` | `https://pulse.hiral.io` | The `hi_pulse_server` host. |
| `HI_PULSE_SECRET` | `--secret=hif_secret_…` | (optional) | The project's reporter secret; turns on reporter updates. Press Enter to skip. |
| Capture errors | `--capture-errors=…` | `prod-only` | `prod-only` / `all` / `off` — see "Automatic error capture" below. |

It appends the env vars to `.env` (if one exists) and patches six files:

| File | What changes |
|---|---|
| `config/runtime.exs` | `config :hi_pulse` block. For Dotenvy-using apps it emits `Dotenvy.env!` for dev/test + `System.fetch_env!` for prod. Adds the capture-errors gate when applicable. |
| `lib/<app>_web/components/layouts/root.html.heex` | Renders `<HiPulse.Components.pulse_widget />` before `</body>`, gated on `:current_user`. |
| `lib/<app>_web/endpoint.ex` | New `Plug.Static at: "/assets/vendor/hi_pulse"` inserted **above** the catch-all (order matters — see "How it can go wrong" below). |
| `assets/js/app.js` | Imports `PulseWidgetHook`, registers it on the LiveSocket's `hooks:` map (creates the key if it doesn't exist). |
| `assets/css/app.css` | `@import "../../deps/hi_pulse/priv/static/css/pulse-widget.css";` inserted in the leading-imports block. |
| `config/config.exs` | Extends the esbuild `args` with `--alias:hi_pulse=…`. |

The task is **idempotent** — re-running prints "already patched" for
each file. Patch by patch: if the installer can't find an anchor in
your file (heavily-customized apps), it prints the manual snippet and
proceeds to the next file.

### 4. Verify

```bash
mix hi_pulse.doctor
```

Static check — reads files, doesn't boot the server. Each of 10 wires
is reported as `OK` / `WARN` / `FAIL` with a one-line fix hint. Exit
status non-zero on any FAIL so it composes into CI.

### 5. Run the three-step ritual

Three things have to happen, **in this order**, before the widget shows
up. Skip any one and you'll spend an hour debugging:

1. **Restart your dev server** — `Ctrl-C` twice in the phx.server
   terminal, then `mix phx.server`. Endpoint plug pipeline is compiled
   at boot; Phoenix's code reloader does NOT pick up the new
   `Plug.Static` mount.

2. **Rebuild your assets** — `mix assets.build`. The CSS `@import` the
   installer added only lands in the Tailwind/esbuild bundle after the
   next build. Phoenix's asset watcher in dev usually does this for
   you on save; force it explicitly to be safe.

3. **Hard-refresh the browser** — `Cmd-Shift-R` (mac) / `Ctrl-Shift-R`
   (Win/Linux). Without this the browser keeps loading the pre-install
   CSS/JS from cache and the widget renders unstyled.

Open a page where `@current_user` is in assigns and click the floating
button.

## How it can go wrong (and how to detect each)

| Symptom | Likely cause | Fix |
|---|---|---|
| Widget renders unstyled / fonts wrong | Step 5.2 or 5.3 skipped | `mix assets.build` + hard refresh |
| No floating button visible | `@current_user` not in assigns for the current page | Tighten the `enabled?` gate, or override per "Customize who sees the widget" below |
| Replay never captured (no `replays/<slug>/…` in S3) | rrweb script tag 404s — endpoint mount ordered wrong | `mix hi_pulse.doctor` will flag it; re-run installer or move the SDK `Plug.Static` mount above the catch-all manually |
| Browser console: `CORS policy blocked … /projects/me/config` | The server's CORS preflight is missing — old server build | Redeploy `hi_pulse_server` ≥ `0d4db61` |
| `Replay failed to load: rrweb-player.min.js failed to load` | Server image excludes vendored player assets | Server-side fix — confirm Dockerfile / `.dockerignore` doesn't strip `priv/static/assets/vendor/` |
| `mix hi_pulse.install` says "anchor not found" | Heavily-customized `app.js` / `endpoint.ex` / `config.exs` | Paste the printed snippet manually; the rest of the installer continues |

## Customize the type / priority dropdowns

Admins curate `Event types` and `Priorities` per project in the
feedback admin UI (`/admin/projects/:slug` → "Tags" section). The SDK
widget fetches them via `GET /api/v1/projects/me/config` on mount and
populates its dropdowns from there. No SDK redeploy needed when you
change them.

Defaults: `bug, suggestion, question, praise` and
`low, medium, high, urgent`. Both fields accept any lowercase slug
(letters, numbers, hyphens) up to 32 chars. Unknown keys get a
titleized fallback label ("feature-request" → "Feature request"); to
override, set the `T.type` / `T.priority` map (see below).

## Customize copy

All user-facing strings live on a single exported `T` object in the
JS hook. Override individual keys before mounting LiveSocket:

```js
import { PulseWidgetHook, T } from "hi_pulse/pulse-widget";

T.fab = "Send feedback";
T.panelTitle = "Tell us what's wrong";
T.send = "Submit";
```

The default copy is English; ship your own translations the same way.

## Add a topic picker

Off by default. When `T.topic` has entries, the panel shows them as a
segmented control above the title, and the reporter must pick one before
sending. The chosen key ships as `topic`; when the project sends the issue
to Linear, the server attaches the workspace label with that name (if one
exists).

```js
T.fieldTopic = "What is it about?";
T.topicMissing = "Please pick a topic";
T.topic = {
  "funnel-generator": { label: "Funnel generator", sub: "Generated copy, order, images" },
  app: { label: "App", sub: "Editor, controls, block design" },
};
```

`sub` is optional.

## Customize who sees the widget

The component renders whenever `:current_user` is in `assigns`. To
gate it differently — e.g. role-based — pass an explicit `enabled?`
prop. The installer's default snippet looks like:

```heex
<HiPulse.Components.pulse_widget
  enabled?={assigns[:current_user] != nil}
  reporter={
    case assigns[:current_user] do
      %{email: email, id: id} = user -> %{email: email, id: id, name: Map.get(user, :name)}
      _ -> %{}
    end
  }
/>
```

`name` is optional: the user's display name (e.g. from the Microsoft
sign-in). pulse shows it instead of the email ("Sandra replied"), in
Linear and on its issue page. Pass whatever field your user has.

Tighten the gate as needed:

```heex
<HiPulse.Components.pulse_widget
  enabled?={
    case assigns[:current_user] do
      %{role: "admin"} -> true
      _ -> false
    end
  }
  ...
/>
```

## Reporter updates

Reporters see what happened to their feedback inside your app: status
changes from Linear, notes and questions from the team, and the moment
the fix is live. They answer questions and confirm the fix ("Works now" /
"Still broken") from the same panel; both land on the Linear issue as
comments. A smiley on each team message puts an emoji on it (👍 🙌 🎉 🙏
👀), and the team's reactions show on the reporter's own messages. A
new team reaction also shows on the floating button for 5 seconds,
instead of a dot. Reactions only show in the widget and in pulse. After "Works now" the fix step keeps a "Still broken after
all? Reopen" link, so a fix that breaks again can still be reopened. Feedback only: automatically captured errors have no reporter.

### Turn it on

1. **Set `HI_PULSE_SECRET`.** Rotate the project's reporter secret in
   pulse (it's shown once) and add it to `.env` and your deployment. The
   runtime config reads it:

   ```elixir
   config :hi_pulse,
     # …
     secret: System.get_env("HI_PULSE_SECRET")
   ```

   New installs get this line; for older ones add it by hand (or run
   `mix hi_pulse.install --secret=…`, which adds the env var to `.env`).
   The secret stays on your server. The widget component uses it to sign
   the current user's email and id (`HiPulse.reporter_token/1`) into
   `data-reporter-token`; pulse verifies the signature and only shows
   that person's reports. Without a secret the attribute is left out and
   the widget behaves as before.

2. **Pass an email or id as `reporter`.** The installer's snippet already
   does (`%{email: email, id: id, name: …}`). The id should be stable for the
   user, since pulse matches reports by id first and by email otherwise. The
   optional `name` only labels the reporter in pulse and Linear.

3. **Let esbuild resolve `phoenix`.** The widget connects with
   `import { Socket } from "phoenix"`, resolved from your `deps/`
   through esbuild's `NODE_PATH`. Apps generated by `mix phx.new` already
   set it; check your esbuild profile in `config/config.exs`:

   ```elixir
   config :esbuild,
     my_app: [
       # …
       env: %{"NODE_PATH" => [Path.expand("../deps", __DIR__), Mix.Project.build_path()]}
     ]
   ```

   Without it the asset build fails with `Could not resolve "phoenix"`.
   `mix hi_pulse.doctor` warns about both a missing secret and a missing
   `NODE_PATH`.

### Show the fix in your reload banner

When a release ships a fix someone reported, the widget writes
"Includes your fix: <title>" into a slot in your "new version available"
banner, instead of popping up its own card next to it:

```heex
<div id="new-version-banner" hidden>
  <p>The app was updated.</p>
  <HiPulse.Components.release_note class="text-xs text-secondary" />
  <%!-- your Reload button --%>
</div>
```

Render the slot whenever the widget is mounted, even while the banner is
hidden: the widget looks for it the moment the release arrives and falls
back to its own peek when it can't find one. The slot is
`phx-update="ignore"`, so banner re-renders keep the line.

### Report releases

Linear's "Done" usually means merged, not live. To mark reports fixed
when the fix reaches production, post each production release's Linear
identifiers to pulse from your deploy pipeline, authenticated with the
same secret:

```bash
curl -fsS -X POST "$HI_PULSE_SERVER_URL/api/v1/projects/my-app/releases" \
  -H "Authorization: Bearer $HI_PULSE_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"version": "2026.10.07-1", "issues": ["HI-412", "HI-418"]}'
```

`issues` lists the Linear identifiers of the commits the release shipped,
e.g. `git log --format=%B "$PREVIOUS_SHA..$SHA" | grep -oE '\bHI-[0-9]+\b' | sort -u`.
A report turns "Fixed" once its issue is both shipped and done in
Linear, whichever comes last. Projects that never report releases fall
back to "Fixed" at Linear's "Done".

### Deep links

`?hi-pulse-report=<issue id>` in a page URL (or the older
`#hi-pulse-report=<issue id>`) opens that report's timeline once the
widget connects, then leaves the address. A report that isn't the
signed-in reporter's opens the list instead. pulse's reminder emails link
back to the page the report was sent from this way; the query survives a
sign-in redirect, as long as the app keeps the query in its return path.

### Copy

The new strings live on `T` with the rest (see "Customize copy"):
`T.status`, `T.stepHint`, `T.peekFixed`, `T.releaseNote`, `T.time` and
friends; reactions add `T.react`, `T.reactions`, `T.yourReaction`,
`T.reactedBy`, `T.team`, `T.reactFailed` and `T.fabReaction` (0.3.0). `{title}`, `{count}`,
`{n}`, `{date}`, `{emoji}` and `{name}` are filled in at runtime; keep them
when translating. `T.locale` (default `"en-GB"`)
formats dates like "2 Oct".

## Automatic error capture

Opt-in. When enabled, the SDK ships **server-side Elixir crashes**
(LiveView crashes, GenServer terminations, `Logger.error` calls) and
**browser-side JS errors** (`window.onerror`, unhandled promise
rejections) to `POST /api/v1/events/error`. Same fingerprint upsert
as user feedback — 50,000 occurrences of one crash become one Linear
issue with `event_count: 50_000`.

### Enable

The installer writes the recommended `prod`-only gate:

```elixir
# config/runtime.exs
if config_env() == :prod do
  config :hi_pulse, capture_errors: true
end
```

`config_env/0` is runtime.exs-safe (works in releases — `Mix.env/0`
doesn't), so the gate evaluates correctly when the app boots inside
a packaged release. Drop the conditional or set `capture_errors:
true` unconditionally to capture in dev / staging too.

### What's captured

**Elixir side** — the SDK installs an OTP `:logger` handler when
`:capture_errors` is `true`. Events with `level in [:error, :critical]`
that carry a `:crash_reason` metadata key (set by Phoenix /
GenServer / Task on supervisor crashes) get a real stack and an
exception class. Bare `Logger.error/1` calls land too — without a
stack but with the formatted message.

**Browser side** — the widget's JS hook auto-installs
`window.error` and `unhandledrejection` listeners (gated by the same
flag, exposed to the JS via a `data-capture-errors` attribute). Events
queue with a 1s debounce / 100-event cap and ship via `fetch
keepalive` so they survive page unload.

### Privacy — what leaves the process

Stack traces from Elixir's `:crash_reason` include function arguments
verbatim, which means `MyMod.create_user(%{password: "hunter2"})`
ends up in the formatted stack. Before any error leaves the process,
`HiPulse.Scrubber` redacts values for sensitive keys:

  - `password`, `passwd`, `password_hash`
  - `token`, `access_token`, `refresh_token`, `id_token`
  - `api_key`, `apikey`, `secret`, `secret_key`
  - `authorization`, `auth`, `bearer`
  - `cookie`, `set-cookie`
  - `session`, `session_id`, `sessionid`

Plus `Bearer …` and `Cookie:` header captures regardless of
surrounding format. Stacks are also capped at 50 frames / 10 kB to
bound payload size. The same scrubber logic runs in the JS bundle for
browser-side stacks.

### Self-protection

A transport failure (e.g. the feedback server is down) would itself
log an error — without a guard, that error would loop right back
through the handler and re-submit indefinitely. The handler drops
events whose `metadata[:application] == :hi_pulse` or whose stack
mentions `HiPulse.Client` / `.ErrorHandler`; the JS side drops
events whose stack mentions `error_capture.js` /
`pulse-widget.js`. Lost telemetry on failure is the right trade
vs. cascading failures in the host app.

### Disable / opt out

Either remove the `config :hi_pulse, capture_errors: true` line
from `runtime.exs`, or set it to `false` explicitly. The handler
checks the flag at boot — restart your app to unhook the listeners.

## Server-to-server submission

The same wire contract is callable from Elixir without a browser:

```elixir
HiPulse.Client.submit(%{
  title: "Webhook delivery failed",
  description: "...",
  type: "bug",
  priority: "high",
  reporter: %{email: "ops@example.com"},
  context: %{job_id: "abc-123"}
})
#=> {:ok, %{event_id: "...", issue_id: "...", linear_url: nil}}
```

Useful for backend errors that should land in the same triage funnel.

## Testing

Stub the HTTP client with `Req.Test`:

```elixir
# test_helper.exs
Application.put_env(:hi_pulse, :token, "test-token")
Application.put_env(:hi_pulse, :req_options, plug: {Req.Test, HiPulse.Client})

# in a test
test "logs feedback when something fails" do
  Req.Test.stub(HiPulse.Client, fn conn ->
    conn
    |> Plug.Conn.put_resp_content_type("application/json")
    |> Plug.Conn.send_resp(201, Jason.encode!(%{event_id: "x", issue_id: "y"}))
  end)

  assert {:ok, _} = MyApp.Errors.report(...)
end
```

## Troubleshooting

**Start with the doctor.** `mix hi_pulse.doctor` runs 10 static checks
(file presence, plug ordering, CSS import position, env vars, etc.) and
explains what to fix for each FAIL. Most of the symptoms below are
already detected there.

**The FAB doesn't appear.** Check that `:current_user` is set in the
LiveView's assigns on the page you're testing. The installer's default
snippet only renders the widget when that assign is present. Override
the gate (see "Customize who sees the widget" above) if you want it
on a public page.

**Widget renders without styling.** Either step 5.2 (`mix assets.build`)
or step 5.3 (hard refresh) was skipped — the @import the installer
added isn't in the bundle yet, or the browser is serving the
pre-install CSS from cache.

**Replay never appears in the admin UI.** Two possible causes:

  - *Capture-side* — the rrweb script tag 404s in the consumer app.
    The installer adds a `Plug.Static at: "/assets/vendor/hi_pulse"`
    mount, but it must run BEFORE the catch-all `Plug.Static at: "/"`.
    `mix hi_pulse.doctor` flags wrong order explicitly. Endpoint plug
    pipeline is compiled at boot — restart your server after fixing.
  - *Playback-side* — `hi_pulse_server`'s admin UI loads
    `/assets/vendor/rrweb-player.min.js`; a stale image without those
    vendored assets returns 404. Server-side fix, not SDK.

**Browser console: `CORS policy blocked … /projects/me/config`.** The
server's CORS preflight on the project-config endpoint is missing.
Redeploy `hi_pulse_server` from `main` (the fix landed in `0d4db61`).
Submission still works in the meantime (uses `/api/v1/events`,
which has its own CORS route); just the type/priority dropdowns fall
back to defaults.

**`mix hi_pulse.install` says "anchor not found".** The task patches
files using anchored text replacements that assume a stock `mix phx.new`
layout. If you've reorganised your `app.js`, `endpoint.ex`, or
`config.exs` significantly, the task prints the snippet it tried to
inject — paste it manually and re-run; subsequent files patch as normal.

**The token is in the browser DOM. Is that bad?** It's the SDK's auth.
The token is bound to one project — leaking it lets anyone send fake
events to *that* project but nothing else. Treat it like a public
publishable key. Rotate via the admin UI if you suspect abuse.

**Widget styles look broken (but ARE applied).** The widget CSS uses
11 design-system tokens (`--color-ink`, `--color-canvas`, etc.). The
SDK's stylesheet ships fallback values at zero specificity, so a
vanilla Tailwind/daisyUI app renders correctly. If you've defined those
tokens differently in your own design system, the widget picks up your
values. Override individual tokens at the `:root` level to remix.

## Wire format

See `docs/http-api.md` in the private `gohiral/pulse` repo for the
full schema. Snake_case end-to-end:

```json
{
  "title": "string",
  "description": "string | null",
  "type": "bug | suggestion | question | praise",
  "priority": "low | medium | high | urgent",
  "url": "string",
  "viewport": { "width": 1440, "height": 900 },
  "user_agent": "string",
  "console_buffer": [...],
  "context": {...},
  "reporter": { "email": "...", "id": "...", "name": "...", "metadata": {...} },
  "replay_duration_ms": 0
}
```
