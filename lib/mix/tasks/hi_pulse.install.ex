defmodule Mix.Tasks.HiPulse.Install do
  @shortdoc "Wires the hi_pulse widget into your Phoenix LiveView app."

  @moduledoc """
  Patches a Phoenix LiveView consumer app to render the floating
  feedback widget. Run after adding `{:hi_pulse, ...}` to your
  `mix.exs` and running `mix deps.get`.

      $ mix hi_pulse.install

  Optionally pass the env vars on the command line so the task doesn't
  prompt:

      $ mix hi_pulse.install --token=hif_live_... --server-url=https://pulse.hiral.io --capture-errors=prod-only

  `--secret=hif_secret_...` sets the project's reporter secret, which
  turns on reporter updates. It's optional and never prompted for; add
  `HI_PULSE_SECRET` later by re-running with `--secret`.

  `--capture-errors` accepts `prod-only` (default), `all`, or `off` —
  see the prompt below for what each means.

  ## What it does

  1. Prompts for `HI_PULSE_TOKEN`, `HI_PULSE_SERVER_URL` and the
     optional `HI_PULSE_SECRET` and appends them to `.env` (when present).
  2. Idempotently patches six files:
     * `config/runtime.exs` — appends the `config :hi_pulse` block.
     * `lib/<app>_web/components/layouts/root.html.heex` — drops the
       `<HiPulse.Components.pulse_widget />` component before
       `</body>`. The widget renders whenever `:current_user` is in
       assigns; no `on_mount` hook needed.
     * `lib/<app>_web/endpoint.ex` — adds a second `Plug.Static` to
       serve the SDK's vendored rrweb scripts.
     * `assets/js/app.js` — imports the JS hook and registers it with
       LiveSocket.
     * `assets/css/app.css` — `@import`s the widget stylesheet.
     * `config/config.exs` — extends the esbuild `args` with the
       `--alias:hi_pulse=…` mapping.

  Re-running is safe — every patch checks if it's already in place
  before editing.
  """
  use Mix.Task

  @impl Mix.Task
  def run(args) do
    app = Mix.Project.config()[:app]

    if app == nil do
      Mix.raise("[hi_pulse] couldn't read app name from mix.exs")
    end

    {opts, _, _} =
      OptionParser.parse(args,
        strict: [
          token: :string,
          server_url: :string,
          secret: :string,
          capture_errors: :string,
          build_assets: :boolean
        ]
      )

    Mix.shell().info("[hi_pulse] installing into #{app}...")

    env = collect_env(opts)
    maybe_update_dotenv(env)

    files = [
      {"config/runtime.exs", &patch_runtime_exs/2, [env.capture_errors]},
      {"lib/#{app}_web/components/layouts/root.html.heex", &patch_root_layout/1},
      {"lib/#{app}_web/endpoint.ex", &patch_endpoint/2, [app]},
      {"assets/js/app.js", &patch_app_js/1},
      {"assets/css/app.css", &patch_app_css/1},
      {"config/config.exs", &patch_config_exs/2, [app]}
    ]

    Enum.each(files, &apply_patch/1)

    built? = maybe_build_assets(opts)

    Mix.shell().info("")
    print_done(env, built?)
  end

  # The widget CSS only lands in the bundle after Tailwind/esbuild
  # re-run, so unless explicitly disabled we trigger `assets.build`
  # right after patching. Drops one step from the post-install ritual.
  # It runs in a fresh `mix` process: this VM loaded config/config.exs
  # before we added the esbuild alias, so an in-process build can't
  # resolve `hi_pulse/pulse-widget`.
  defp maybe_build_assets(opts) do
    if Keyword.get(opts, :build_assets, true) do
      if Mix.Project.config()[:aliases][:"assets.build"] do
        Mix.shell().info("\n[hi_pulse] running `mix assets.build`...")

        case System.cmd("mix", ["assets.build"], into: IO.stream(), stderr_to_stdout: true) do
          {_, 0} ->
            Mix.shell().info("  ✓ assets rebuilt")
            true

          {_, status} ->
            Mix.shell().info("  ! assets.build failed (exit #{status}) — run it manually")
            false
        end
      else
        Mix.shell().info(
          "  ? no `assets.build` alias defined — re-run your usual asset pipeline manually"
        )

        false
      end
    else
      false
    end
  end

  # ---------------------------------------------------------------------------
  # Env collection
  # ---------------------------------------------------------------------------

  defp collect_env(opts) do
    token =
      opts[:token] ||
        prompt("  HI_PULSE_TOKEN  (issue one in your project's admin page; required):")

    server_url =
      opts[:server_url] ||
        prompt_with_default(
          "  HI_PULSE_SERVER_URL  [https://pulse.hiral.io]:",
          "https://pulse.hiral.io"
        )

    # Optional and never prompted, so scripted installs that predate it
    # keep running unattended.
    secret = opts[:secret] || ""

    capture_errors = opts[:capture_errors] || prompt_capture_errors()

    %{
      token: String.trim(token),
      server_url: String.trim(server_url),
      secret: String.trim(secret),
      capture_errors: normalize_capture_errors(capture_errors)
    }
  end

  defp prompt_capture_errors do
    Mix.shell().info("""

      Enable automatic error capture? Captures Elixir crashes (LiveView /
      GenServer / Logger.error) and JS runtime errors and ships them to
      the feedback server, grouped by stack-trace fingerprint. Stack
      values are scrubbed before transit.

        prod-only  (recommended) — capture only when MIX_ENV=prod
        all                      — capture in dev / staging / prod
        off                      — no automatic capture
    """)

    prompt_with_default("  Capture errors  [prod-only]:", "prod-only")
  end

  defp normalize_capture_errors(value) do
    case value |> to_string() |> String.downcase() |> String.trim() do
      v when v in ["prod-only", "prod_only", "prod", ""] -> "prod-only"
      v when v in ["all", "all-envs", "all_envs"] -> "all"
      v when v in ["off", "no", "false", "n"] -> "off"
      # Unknown input — fall back to prod-only rather than silently
      # disabling, so the recommendation is the safe default.
      _ -> "prod-only"
    end
  end

  defp prompt(question) do
    Mix.shell().prompt(question) |> String.trim()
  end

  defp prompt_with_default(question, default) do
    case prompt(question) do
      "" -> default
      val -> val
    end
  end

  defp maybe_update_dotenv(%{token: ""}), do: :ok

  defp maybe_update_dotenv(env) do
    case File.read(".env") do
      {:ok, contents} ->
        case patch_dotenv(contents, env) do
          {^contents, []} ->
            Mix.shell().info("  · .env already mentions the hi_pulse vars — leaving it alone")

          {patched, keys} ->
            File.write!(".env", patched)
            Mix.shell().info("  ✓ .env — appended #{Enum.join(keys, " + ")}")
        end

      {:error, :enoent} ->
        exports =
          env
          |> dotenv_vars()
          |> Enum.map_join("\n", fn {key, value} -> ~s(    export #{key}="#{value}") end)

        Mix.shell().info("""

        [hi_pulse] No .env file found — set these in your environment:

        #{exports}
        """)
    end
  end

  # Appends the hi_pulse vars `.env` doesn't mention yet. The token and
  # server URL travel together (keyed on HI_PULSE_TOKEN, as before); the
  # secret has its own marker so re-running the installer with
  # `--secret` adds it to an existing install. Returns the new contents
  # and the appended keys.
  @doc false
  def patch_dotenv(contents, env) do
    vars =
      env
      |> dotenv_vars()
      |> Enum.reject(fn {key, _} ->
        marker = if key == "HI_PULSE_SERVER_URL", do: "HI_PULSE_TOKEN", else: key
        String.contains?(contents, marker)
      end)

    case vars do
      [] ->
        {contents, []}

      vars ->
        lines = Enum.map_join(vars, "\n", fn {key, value} -> ~s(#{key}="#{value}") end)
        block = "\n\n# hi_pulse widget\n" <> lines <> "\n"
        {String.trim_trailing(contents) <> block, Enum.map(vars, &elem(&1, 0))}
    end
  end

  defp dotenv_vars(env) do
    [
      {"HI_PULSE_TOKEN", env.token},
      {"HI_PULSE_SERVER_URL", env.server_url},
      {"HI_PULSE_SECRET", env.secret}
    ]
    |> Enum.reject(fn {_key, value} -> value == "" end)
  end

  defp print_done(%{token: ""}, built?) do
    Mix.shell().info("""

    [hi_pulse] done — but no token was provided.
    Issue one in your project's admin page and set HI_PULSE_TOKEN
    before booting your server, otherwise the SDK will raise on first
    submit.

    #{checklist(built?)}
    """)
  end

  defp print_done(env, built?) do
    Mix.shell().info("""

    [hi_pulse] done.

    #{checklist(built?)}

    Then click the floating "Feedback" button — first submission round-trips
    in seconds. If anything's off, run `mix hi_pulse.doctor`.
    #{secret_hint(env)}
    """)
  end

  defp secret_hint(%{secret: ""}) do
    """

    Reporter updates stay off until HI_PULSE_SECRET is set: rotate the
    project's reporter secret in pulse and add it to your environment.
    """
  end

  defp secret_hint(_env), do: ""

  # The remaining manual steps after install. If we successfully ran
  # `assets.build`, drop the rebuild step — but the server restart and
  # hard refresh are unavoidable:
  #
  #   * `endpoint.ex` is part of the compiled plug pipeline — Phoenix's
  #     code reloader does NOT pick up the new `Plug.Static at:
  #     "/assets/vendor/hi_pulse"` mount; a full `mix phx.server`
  #     restart is required.
  #   * The browser caches the pre-install CSS/JS from the page that
  #     triggered the install; a hard refresh forces a fresh fetch.
  defp checklist(true = _built?) do
    """
    Two manual steps left, in this order:

      1. Restart your dev server (Ctrl-C twice, then `mix phx.server`).
         Endpoint plugs are compiled at boot — code reloading won't pick
         up the new `Plug.Static` mount for the vendored rrweb scripts.

      2. Hard refresh the browser tab (Cmd-Shift-R / Ctrl-Shift-R).
         Without this you'll keep loading the pre-install CSS/JS from
         cache and the widget will look unstyled.
    """
  end

  defp checklist(false = _built?) do
    """
    Three things have to happen before the widget shows up. In this order:

      1. Restart your dev server (Ctrl-C twice, then `mix phx.server`).
         Endpoint plugs are compiled at boot — code reloading won't pick
         up the new `Plug.Static` mount for the vendored rrweb scripts.

      2. Rebuild your assets (`mix assets.build`). The CSS @import the
         installer added to `assets/css/app.css` only lands in the
         bundle after Tailwind / esbuild re-run.

      3. Hard refresh the browser tab (Cmd-Shift-R / Ctrl-Shift-R).
         Without this you'll keep loading the pre-install CSS/JS from
         cache and the widget will look unstyled.
    """
  end

  # ---------------------------------------------------------------------------
  # Patch dispatcher
  # ---------------------------------------------------------------------------

  defp apply_patch({path, patcher}), do: apply_patch({path, patcher, []})

  defp apply_patch({path, patcher, extra}) do
    case File.read(path) do
      {:ok, contents} ->
        case apply(patcher, [contents | extra]) do
          {:ok, ^contents} ->
            Mix.shell().info("  · #{path} — already patched")

          {:ok, new} ->
            File.write!(path, new)
            Mix.shell().info("  ✓ #{path} — patched")

          {:error, reason} ->
            Mix.shell().info("  ! #{path} — #{reason}, paste manually:")
            Mix.shell().info(indent(manual_snippet(path), "      "))
        end

      {:error, :enoent} ->
        Mix.shell().info("  ? #{path} — not found, skipping")

      {:error, reason} ->
        Mix.shell().error("  ✗ #{path} — read error: #{inspect(reason)}")
    end
  end

  # ---------------------------------------------------------------------------
  # Patches
  # ---------------------------------------------------------------------------

  @doc false
  def patch_runtime_exs(contents, capture_errors \\ "off") do
    cond do
      String.contains?(contents, "config :hi_pulse") ->
        {:ok, contents}

      # Apps that load `.env` via Dotenvy don't have the values in
      # `System.get_env/1` until they call `Dotenvy.env!/2`. Top-level
      # `System.fetch_env!` raises at boot. Emit a Dotenvy-aware block.
      String.contains?(contents, "Dotenvy.") ->
        block = dotenvy_runtime_block()
        capture = capture_errors_block(capture_errors)
        {:ok, String.trim_trailing(contents) <> block <> capture}

      # Default: vanilla phx.new layout — `System.fetch_env!` works at
      # top level because env vars are real OS env vars.
      true ->
        block = simple_runtime_block()
        capture = capture_errors_block(capture_errors)
        {:ok, String.trim_trailing(contents) <> block <> capture}
    end
  end

  defp simple_runtime_block do
    """


    # hi_pulse widget — server URL + per-project bearer token
    config :hi_pulse,
      server_url:
        System.get_env("HI_PULSE_SERVER_URL") || "https://pulse.hiral.io",
      token: System.fetch_env!("HI_PULSE_TOKEN"),
      project_slug: System.get_env("HI_PULSE_PROJECT_SLUG"),
      # Reporter secret — optional, enables reporter updates.
      secret: System.get_env("HI_PULSE_SECRET")
    """
  end

  # Two blocks gated by `config_env/0`:
  #   * dev / test: read via `Dotenvy.env!` — the .env file is loaded
  #     into Dotenvy's private dict, never into `System.get_env`.
  #   * prod: real OS env vars (Coolify / k8s / Fly secret store) —
  #     fall back to `System.fetch_env!`.
  defp dotenvy_runtime_block do
    """


    # hi_pulse widget — server URL + per-project bearer token. Dotenvy
    # loads dev/test values from `.env` into a private dict, so we use
    # `Dotenvy.env!` there. In prod the values come from real OS env
    # vars set by the deployment platform.
    if config_env() in [:dev, :test] do
      config :hi_pulse,
        server_url:
          Dotenvy.env!("HI_PULSE_SERVER_URL", :string, "https://pulse.hiral.io"),
        token: Dotenvy.env!("HI_PULSE_TOKEN", :string!),
        project_slug: Dotenvy.env!("HI_PULSE_PROJECT_SLUG", :string, nil),
        secret: Dotenvy.env!("HI_PULSE_SECRET", :string, nil)
    end

    if config_env() == :prod do
      config :hi_pulse,
        server_url:
          System.get_env("HI_PULSE_SERVER_URL") || "https://pulse.hiral.io",
        token: System.fetch_env!("HI_PULSE_TOKEN"),
        project_slug: System.get_env("HI_PULSE_PROJECT_SLUG"),
        secret: System.get_env("HI_PULSE_SECRET")
    end
    """
  end

  # Three flavors of the capture-errors gate:
  #
  #   * "prod-only" — `if config_env() == :prod do …` (recommended).
  #     `config_env/0` is runtime.exs-safe, including in releases.
  #   * "all"       — unconditional `capture_errors: true`.
  #   * "off"       — no extra block; defaults to `false`.
  defp capture_errors_block("prod-only") do
    """

    # Automatic error capture — opt-in, prod-only by default. Captures
    # Elixir crashes + JS runtime errors via the SDK's :logger handler
    # and `window.onerror` hook. Stack-trace values are scrubbed before
    # transit. To enable in dev / staging too, drop the conditional.
    if config_env() == :prod do
      config :hi_pulse, capture_errors: true
    end
    """
  end

  defp capture_errors_block("all") do
    """

    # Automatic error capture — enabled in all environments. Stack-trace
    # values are scrubbed before transit; see HiPulse.Scrubber.
    config :hi_pulse, capture_errors: true
    """
  end

  defp capture_errors_block(_), do: ""

  @doc false
  def patch_root_layout(contents) do
    cond do
      String.contains?(contents, "HiPulse.Components.pulse_widget") ->
        {:ok, contents}

      not String.contains?(contents, "</body>") ->
        {:error, "no </body> tag found"}

      true ->
        snippet = """
        <HiPulse.Components.pulse_widget
          enabled?={assigns[:current_user] != nil}
          reporter={
            case assigns[:current_user] do
              %{email: email, id: id} = user -> %{email: email, id: id, name: Map.get(user, :name)}
              _ -> %{}
            end
          }
        />
        """

        replaced =
          String.replace(
            contents,
            "</body>",
            indent(String.trim_trailing(snippet), "    ") <> "\n  </body>",
            global: false
          )

        {:ok, replaced}
    end
  end

  @doc false
  def patch_endpoint(contents, _app) do
    cond do
      String.contains?(contents, ~s({:hi_pulse,)) ->
        {:ok, contents}

      not Regex.match?(~r/plug Plug.Static,\s*\n/, contents) ->
        {:error, "no `plug Plug.Static` to anchor to"}

      true ->
        # The vendor mount must run BEFORE the catch-all `Plug.Static
        # at: "/"`. Phoenix's stock catch-all matches /assets/* and
        # halts on a 404 when the file doesn't exist in the consumer's
        # priv/static, so a mount placed AFTER it never gets a chance
        # to serve the SDK's vendor files. Anchor on the FIRST
        # `plug Plug.Static,` (the catch-all) and insert above it.
        anchor = "plug Plug.Static,"

        insert = """
        # Vendored rrweb scripts shipped by the hi_pulse SDK. Must
        # come before the catch-all `Plug.Static at: "/"` below so
        # Phoenix doesn't halt with a 404 on these paths first.
        plug Plug.Static,
          at: "/assets/vendor/hi_pulse",
          from: {:hi_pulse, "priv/static/vendor"},
          gzip: false,
          only: ~w(rrweb.min.js rrweb-plugin-console-record.min.js)

        """

        {:ok, String.replace(contents, anchor, insert <> anchor, global: false)}
    end
  end

  @doc false
  def patch_app_js(contents) do
    cond do
      String.contains?(contents, "PulseWidgetHook") ->
        {:ok, contents}

      not String.contains?(contents, "phoenix_live_view") ->
        {:error, "doesn't look like a Phoenix LiveView app.js"}

      true ->
        contents
        |> insert_app_js_import()
        |> insert_app_js_hook()
    end
  end

  defp insert_app_js_import(contents) do
    import_line = ~s|import {PulseWidgetHook} from "hi_pulse/pulse-widget"|

    # Drop in after the last existing `import ...` line.
    case Regex.run(~r/^(import .*\n)(?!.*^import )/sm, contents,
           return: :index,
           capture: :all_but_first
         ) do
      [{start, len}] ->
        before = String.slice(contents, 0, start + len)
        after_ = String.slice(contents, (start + len)..-1//1)
        {:cont, before <> import_line <> "\n" <> after_}

      _ ->
        # No imports found at all — bail.
        {:halt, {:error, "no `import` statements to anchor after"}}
    end
  end

  defp insert_app_js_hook({:halt, err}), do: err

  defp insert_app_js_hook({:cont, contents}) do
    # Try common patterns:
    #   hooks: {...colocatedHooks}
    #   hooks: {}
    #   hooks: { Foo, Bar }
    # If none match, the LiveSocket config has no `hooks` key at all
    # (vanilla phx.new without colocated hooks); insert one.
    cond do
      String.contains?(contents, "hooks: {...colocatedHooks}") ->
        {:ok,
         String.replace(
           contents,
           "hooks: {...colocatedHooks}",
           "hooks: {...colocatedHooks, HiPulse: PulseWidgetHook}",
           global: false
         )}

      String.contains?(contents, "hooks: {}") ->
        {:ok,
         String.replace(
           contents,
           "hooks: {}",
           "hooks: {HiPulse: PulseWidgetHook}",
           global: false
         )}

      Regex.match?(~r/hooks:\s*\{/, contents) ->
        {:ok,
         Regex.replace(
           ~r/hooks:\s*\{/,
           contents,
           "hooks: {HiPulse: PulseWidgetHook, ",
           global: false
         )}

      Regex.match?(~r/new\s+LiveSocket\s*\(/, contents) ->
        # No `hooks: {…}` key at all. Insert one as the second arg's
        # leading entry. Anchor: `new LiveSocket("/live", Socket, {`
        # → `new LiveSocket("/live", Socket, {\n  hooks: {…},`.
        case Regex.run(
               ~r/new\s+LiveSocket\s*\([^,]+,\s*[^,]+,\s*\{/,
               contents,
               return: :index
             ) do
          [{start, len}] ->
            anchor = String.slice(contents, start, len)
            replacement = anchor <> "\n  hooks: {HiPulse: PulseWidgetHook},"
            {:ok, String.replace(contents, anchor, replacement, global: false)}

          _ ->
            {:error, "couldn't anchor inside the LiveSocket constructor"}
        end

      true ->
        {:error, "couldn't find `hooks: {…}` in LiveSocket config"}
    end
  end

  @doc false
  def patch_app_css(contents) do
    if String.contains?(contents, "pulse-widget.css") do
      {:ok, contents}
    else
      # PostCSS resolves `@import` against the source filesystem,
      # not via OTP-app priv lookup, so point straight into the
      # dep checkout under `deps/hi_pulse/`.
      line =
        ~s|@import "../../deps/hi_pulse/priv/static/css/pulse-widget.css";|

      # Per CSS spec, `@import` rules must precede all non-import rules
      # in a stylesheet — Tailwind / PostCSS silently drops `@import`
      # lines that come after a regular rule. Insert ours at the end
      # of the leading `@import` block so it stacks with any existing
      # tailwindcss imports. If the file has no leading imports, prepend.
      case Regex.run(~r/\A(?:@import[^;]*;[ \t]*\n)+/, contents, return: :index) do
        [{0, len}] when len > 0 ->
          before = String.slice(contents, 0, len)
          after_ = String.slice(contents, len..-1//1)
          {:ok, before <> line <> "\n" <> after_}

        _ ->
          {:ok, line <> "\n" <> contents}
      end
    end
  end

  @doc false
  def patch_config_exs(contents, app) do
    cond do
      String.contains?(contents, "alias:hi_pulse") ->
        {:ok, contents}

      not String.contains?(contents, "config :esbuild") ->
        {:error, "no esbuild config to extend"}

      true ->
        # Insert a `hi_pulse_js = …` binding before the config block,
        # then weave `--alias:hi_pulse=#{hi_pulse_js}` into the args.
        binding =
          "hi_pulse_js =\n" <>
            ~s|  Path.expand("../_build/#{"#"}{config_env()}/lib/hi_pulse/priv/static/js", __DIR__)\n\n|

        # Pattern: `args: ~w(js/app.js --bundle ...)` (single or multi-line)
        case Regex.run(~r/(args:\s*\n?\s*~w\([^)]+)\)/s, contents,
               return: :index,
               capture: :all_but_first
             ) do
          [{start, len}] ->
            before = String.slice(contents, 0, start + len)
            after_ = String.slice(contents, (start + len)..-1//1)

            spliced =
              before <>
                ~s| --alias:hi_pulse=#{"#"}{hi_pulse_js}| <>
                ")" <> String.slice(after_, 1..-1//1)

            # Now insert the binding before `config :esbuild,`.
            {:ok,
             String.replace(spliced, "config :esbuild,", binding <> "config :esbuild,",
               global: false
             )}

          _ ->
            {:error, "couldn't find esbuild `args: ~w(...)` to extend"}
        end
        |> tap(fn _ -> _ = app end)
    end
  end

  # ---------------------------------------------------------------------------
  # Helpers
  # ---------------------------------------------------------------------------

  defp manual_snippet(path) do
    cond do
      path == "config/runtime.exs" ->
        ~s|config :hi_pulse,\n  server_url: …, token: …, project_slug: …, secret: …|

      String.ends_with?(path, "/components/layouts/root.html.heex") ->
        "<HiPulse.Components.pulse_widget enabled?={…} … />"

      String.ends_with?(path, "/endpoint.ex") ->
        ~s|plug Plug.Static, at: "/assets/vendor/hi_pulse", from: {:hi_pulse, "priv/static/vendor"}, …|

      path == "assets/js/app.js" ->
        ~s|import {PulseWidgetHook} from "hi_pulse/pulse-widget"\n// + register on LiveSocket hooks|

      path == "assets/css/app.css" ->
        ~s|@import "../../deps/hi_pulse/priv/static/css/pulse-widget.css";|

      path == "config/config.exs" ->
        ~s|--alias:hi_pulse=…/_build/<env>/lib/hi_pulse/priv/static/js|

      true ->
        "see SDK README"
    end
  end

  defp indent(text, prefix) do
    text
    |> String.split("\n")
    |> Enum.map_join("\n", &(prefix <> &1))
  end
end
