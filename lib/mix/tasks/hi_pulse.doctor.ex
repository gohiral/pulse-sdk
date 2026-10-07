defmodule Mix.Tasks.HiPulse.Doctor do
  @shortdoc "Diagnoses whether the hi_pulse widget will actually work in this app."

  @moduledoc """
  Static health check for a consumer app that installed `hi_pulse`. Run
  it after `mix hi_pulse.install` (or any time the widget is misbehaving)
  to confirm every wire is connected.

      $ mix hi_pulse.doctor              # static checks only
      $ mix hi_pulse.doctor --live       # + probes the configured server
      $ mix hi_pulse.doctor --verbose    # + appends the file each check read

  The task reads files (no server boot required) and reports each check
  as `OK`, `WARN`, or `FAIL` with a one-line "to fix" hint when something's
  off. Exit status is non-zero if any check fails, so it composes into
  CI gates.

  ## Checks

    1. **Dep present** — `:hi_pulse` is in `mix.exs` and resolved in
       `deps/hi_pulse/`.
    2. **Env vars** — `HI_PULSE_TOKEN` is set (in `.env` or the OS env);
       `HI_PULSE_SERVER_URL` is set or falls back to the default.
    3. **Endpoint mount** — `endpoint.ex` declares the SDK's
       `Plug.Static at: "/assets/vendor/hi_pulse"` AND it appears
       BEFORE the catch-all `Plug.Static at: "/"` (Phoenix runs plugs
       top-to-bottom, so order matters).
    4. **CSS import** — `assets/css/app.css` has the pulse-widget
       `@import` AND it sits in the leading-imports block (per CSS
       spec, `@import` after non-import rules is silently dropped by
       PostCSS / Tailwind).
    5. **JS hook** — `assets/js/app.js` imports `PulseWidgetHook`
       and registers it on the LiveSocket `hooks` map.
    6. **Esbuild alias** — `config/config.exs` extends the esbuild
       `args` with `--alias:hi_pulse=…` so the JS hook import resolves.
    7. **Runtime config** — `config/runtime.exs` reads `HI_PULSE_TOKEN`
       (the right way for the consumer's env-loader: `Dotenvy.env!`
       for Dotenvy-using apps, `System.fetch_env!` otherwise).
    8. **Root layout** — the root layout template renders
       `<HiPulse.Components.pulse_widget>` (gated on `:current_user`
       by default).
    9. **Reporter secret** — `HI_PULSE_SECRET` is set. WARN only:
       without it the widget works but reporter updates are off.
    10. **Esbuild NODE_PATH** — the esbuild config puts `deps` on
        `NODE_PATH`, so the widget's `import { Socket } from "phoenix"`
        resolves. WARN only, since asset pipelines vary.

  With `--live`, two more checks run:

    11. **Server reachable** — HEAD on `<HI_PULSE_SERVER_URL>/login`
        returns a 2xx/3xx. Catches "no DNS / cert / TLS / wrong host".
    12. **Token round-trips** — GET on `/api/v1/projects/me/config`
        with the token in `.env` returns 200 + a JSON body. Catches
        "stale token / wrong project / server not redeployed".

  `--live` reads `HI_PULSE_TOKEN` + `HI_PULSE_SERVER_URL` from the
  consumer's `.env` file directly (it doesn't boot the app).
  """
  use Mix.Task

  @impl Mix.Task
  def run(args) do
    {opts, _, _} =
      OptionParser.parse(args, strict: [verbose: :boolean, live: :boolean])

    verbose? = Keyword.get(opts, :verbose, false)
    live? = Keyword.get(opts, :live, false)

    app = Mix.Project.config()[:app] || Mix.raise("couldn't read app name from mix.exs")

    Mix.shell().info("[hi_pulse.doctor] checking #{app}...\n")

    static_checks = [
      &check_dep/1,
      &check_env/1,
      &check_endpoint/1,
      &check_app_css/1,
      &check_app_js/1,
      &check_config_exs/1,
      &check_runtime_exs/1,
      &check_root_layout/1,
      &check_secret/1,
      &check_node_path/1
    ]

    static_results =
      Enum.map(static_checks, fn check ->
        result = check.(app)
        print_result(result, verbose?)
        result
      end)

    live_results =
      if live? do
        Application.ensure_all_started(:inets)
        Application.ensure_all_started(:ssl)

        for check <- [&check_server_reachable/1, &check_token_round_trip/1] do
          result = check.(env_from_dotenv())
          print_result(result, verbose?)
          result
        end
      else
        []
      end

    summary(static_results ++ live_results)
  end

  # ---------------------------------------------------------------------------
  # Checks
  # ---------------------------------------------------------------------------

  @doc false
  def check_dep(_app) do
    cond do
      not File.exists?("mix.exs") ->
        fail("Dep", "no mix.exs in cwd — run from your app's root", "mix.exs")

      not (File.read!("mix.exs") =~ ~r/[\{:]hi_pulse[,:]/) ->
        fail("Dep", "mix.exs doesn't list `:hi_pulse` — add it and run `mix deps.get`", "mix.exs")

      not File.exists?("deps/hi_pulse/mix.exs") ->
        fail("Dep", "deps/hi_pulse/ missing — run `mix deps.get`", "deps/hi_pulse/")

      true ->
        ok("Dep", "deps/hi_pulse/ resolved", "mix.exs")
    end
  end

  @doc false
  def check_env(_app) do
    env_contents =
      case File.read(".env") do
        {:ok, body} -> body
        {:error, _} -> ""
      end

    has_token? =
      String.contains?(env_contents, "HI_PULSE_TOKEN") or System.get_env("HI_PULSE_TOKEN") != nil

    placeholder? = String.contains?(env_contents, "PLACEHOLDER_REPLACE")

    cond do
      not has_token? ->
        fail(
          "Env",
          "`HI_PULSE_TOKEN` not set — issue one at <server>/admin/projects/<your-slug> and add it to .env",
          ".env"
        )

      placeholder? ->
        warn(
          "Env",
          "HI_PULSE_TOKEN still has the install-time placeholder — replace with a real token from the admin UI",
          ".env"
        )

      true ->
        ok("Env", "HI_PULSE_TOKEN is set", ".env")
    end
  end

  @doc false
  def check_endpoint(app) do
    path = "lib/#{app}_web/endpoint.ex"

    case File.read(path) do
      {:error, _} ->
        fail("Endpoint", "#{path} missing — is this a Phoenix LiveView app?", path)

      {:ok, body} ->
        sdk_mount? = body =~ ~r/at:\s*"\/assets\/vendor\/hi_pulse"/
        sdk_idx = byte_index(body, ~s|at: "/assets/vendor/hi_pulse"|)
        catchall_idx = byte_index(body, ~s|at: "/",|)

        cond do
          not sdk_mount? ->
            fail(
              "Endpoint",
              "`Plug.Static at: \"/assets/vendor/hi_pulse\"` mount is missing from #{path}. Re-run `mix hi_pulse.install`.",
              path
            )

          sdk_idx && catchall_idx && sdk_idx > catchall_idx ->
            fail(
              "Endpoint",
              "SDK vendor mount lands AFTER the catch-all `Plug.Static at: \"/\"` — Phoenix halts 404 on /assets/vendor/* first. Move it above the catch-all.",
              path
            )

          true ->
            ok("Endpoint", "SDK vendor mount is present and ordered before the catch-all", path)
        end
    end
  end

  @doc false
  def check_app_css(_app) do
    path = "assets/css/app.css"

    case File.read(path) do
      {:error, _} ->
        fail("CSS @import", "#{path} missing", path)

      {:ok, body} ->
        has_import? = body =~ "pulse-widget.css"
        right_path? = body =~ "deps/hi_pulse/priv/static/css/pulse-widget.css"

        lines = String.split(body, "\n")
        pulse_line_idx = Enum.find_index(lines, &String.contains?(&1, "pulse-widget.css"))
        first_rule_idx = Enum.find_index(lines, &style_rule_line?/1)

        cond do
          not has_import? ->
            fail(
              "CSS @import",
              "no `@import \"…pulse-widget.css\"` in #{path} — re-run installer",
              path
            )

          not right_path? ->
            fail(
              "CSS @import",
              "@import path doesn't point at `deps/hi_pulse/priv/static/css/pulse-widget.css` — fix the line by hand (the installer won't rewrite an existing import).",
              path
            )

          first_rule_idx && pulse_line_idx && pulse_line_idx > first_rule_idx ->
            fail(
              "CSS @import",
              "@import is below a non-import rule — CSS spec drops it silently. Move it into the leading @import block.",
              path
            )

          true ->
            ok("CSS @import", "in the leading import block with the correct path", path)
        end
    end
  end

  # A "style rule" line — i.e. anything that breaks the leading-imports
  # block per CSS spec. The leading block legitimately contains:
  #
  #   * `@import` — what we care about ordering against
  #   * `@charset`
  #   * `@tailwind base/components/utilities` — Tailwind v3 directive form
  #   * `@use` / `@forward` — Sass module system
  #   * `@layer NAME;` (declaration form — no body)
  #   * comments + blank lines
  #
  # Anything else — a selector (`.foo`, `:root`), a style at-rule
  # (`@media`, `@layer NAME { ... }` with body, `@keyframes`, …) — counts
  # as the first non-import rule, and a `pulse-widget.css` @import below
  # it will get silently dropped by PostCSS/Tailwind.
  defp style_rule_line?(line) do
    trimmed = String.trim(line)

    cond do
      trimmed == "" -> false
      String.starts_with?(trimmed, ["/*", "*", "//"]) -> false
      String.starts_with?(trimmed, "@") -> not import_block_at_rule?(trimmed)
      true -> true
    end
  end

  @import_block_at_rules ~w(@import @charset @tailwind @use @forward)

  defp import_block_at_rule?(trimmed) do
    Enum.any?(@import_block_at_rules, &String.starts_with?(trimmed, &1)) or
      layer_declaration?(trimmed)
  end

  # `@layer NAME;` (declaration form, no block) is import-block-safe;
  # `@layer NAME { ... }` (definition form, has block) is not.
  defp layer_declaration?(trimmed) do
    String.starts_with?(trimmed, "@layer") and
      String.ends_with?(trimmed, ";") and
      not String.contains?(trimmed, "{")
  end

  @doc false
  def check_app_js(_app) do
    path = "assets/js/app.js"

    case File.read(path) do
      {:error, _} ->
        fail("JS hook", "#{path} missing", path)

      {:ok, body} ->
        has_import? = body =~ "PulseWidgetHook"
        has_registration? = body =~ ~r/hooks:\s*\{[^}]*HiPulse/s

        cond do
          not has_import? ->
            fail("JS hook", "no `import {PulseWidgetHook}` in #{path} — re-run installer", path)

          not has_registration? ->
            fail(
              "JS hook",
              "`HiPulse: PulseWidgetHook` not registered on the LiveSocket `hooks:` key — re-run installer",
              path
            )

          true ->
            ok("JS hook", "PulseWidgetHook imported and registered on LiveSocket", path)
        end
    end
  end

  @doc false
  def check_config_exs(_app) do
    path = "config/config.exs"

    case File.read(path) do
      {:error, _} ->
        fail("Esbuild alias", "#{path} missing", path)

      {:ok, body} ->
        if body =~ "alias:hi_pulse" do
          ok(
            "Esbuild alias",
            "config/config.exs extends esbuild args with `--alias:hi_pulse=…`",
            path
          )
        else
          fail(
            "Esbuild alias",
            "no `--alias:hi_pulse=` in esbuild config — `import \"hi_pulse/pulse-widget\"` won't resolve. Re-run installer.",
            path
          )
        end
    end
  end

  @doc false
  def check_runtime_exs(_app) do
    path = "config/runtime.exs"

    case File.read(path) do
      {:error, _} ->
        fail("Runtime config", "#{path} missing", path)

      {:ok, body} ->
        has_block? = body =~ "config :hi_pulse"

        uses_dotenvy_token? =
          body =~ ~r/Dotenvy\.env!?\(\s*"HI_PULSE_TOKEN"/

        uses_system_token? =
          body =~ ~r/System\.(?:fetch_env!|get_env)\(\s*"HI_PULSE_TOKEN"/

        dotenvy_app? = body =~ "Dotenvy."

        cond do
          not has_block? ->
            fail(
              "Runtime config",
              "no `config :hi_pulse` block in #{path} — re-run installer",
              path
            )

          dotenvy_app? and not uses_dotenvy_token? ->
            fail(
              "Runtime config",
              "app uses Dotenvy but `HI_PULSE_TOKEN` is fetched via `System.fetch_env!` — will raise at boot. Re-run installer to emit Dotenvy.env! for dev/test.",
              path
            )

          not (uses_dotenvy_token? or uses_system_token?) ->
            fail("Runtime config", "no reader for `HI_PULSE_TOKEN` — re-run installer", path)

          true ->
            ok("Runtime config", "HI_PULSE_TOKEN reader looks right for this app shape", path)
        end
    end
  end

  @doc false
  def check_root_layout(app) do
    path = "lib/#{app}_web/components/layouts/root.html.heex"

    case File.read(path) do
      {:error, _} ->
        fail("Root layout", "#{path} missing — is this a Phoenix 1.7+ app?", path)

      {:ok, body} ->
        if body =~ "HiPulse.Components.pulse_widget" do
          ok("Root layout", "`<HiPulse.Components.pulse_widget>` rendered", path)
        else
          fail("Root layout", "widget component not in root layout — re-run installer", path)
        end
    end
  end

  @doc false
  def check_secret(_app) do
    in_dotenv? =
      case File.read(".env") do
        {:ok, body} -> body =~ ~r/^\s*(?:export\s+)?HI_PULSE_SECRET=["']?[^"'\s]/m
        {:error, _} -> false
      end

    read_by_config? =
      case File.read("config/runtime.exs") do
        {:ok, body} -> body =~ "HI_PULSE_SECRET"
        {:error, _} -> false
      end

    cond do
      not (in_dotenv? or System.get_env("HI_PULSE_SECRET", "") != "") ->
        warn(
          "Reporter secret",
          "`HI_PULSE_SECRET` not set — reporter updates disabled. Rotate the project's reporter secret in pulse and add it to .env and your deployment.",
          ".env"
        )

      not read_by_config? ->
        warn(
          "Reporter secret",
          ~s|HI_PULSE_SECRET is set but config/runtime.exs doesn't read it — reporter updates disabled. Add `secret: System.get_env("HI_PULSE_SECRET")` to the `config :hi_pulse` block.|,
          "config/runtime.exs"
        )

      true ->
        ok("Reporter secret", "HI_PULSE_SECRET is set and read; reporter updates are on", ".env")
    end
  end

  # The widget imports `Socket` from the `phoenix` package for reporter
  # updates. esbuild resolves that bare import through NODE_PATH, which
  # stock `phx.new` apps point at `deps/` in the esbuild `env`.
  @doc false
  def check_node_path(_app) do
    path = "config/config.exs"

    case File.read(path) do
      {:error, _} ->
        warn("Esbuild NODE_PATH", "#{path} missing — can't check NODE_PATH", path)

      {:ok, body} ->
        if body =~ ~r/NODE_PATH.{0,200}deps/s do
          ok("Esbuild NODE_PATH", "esbuild resolves `phoenix` from deps/", path)
        else
          warn(
            "Esbuild NODE_PATH",
            ~s|no NODE_PATH with deps/ in the esbuild env — the widget's `import { Socket } from "phoenix"` may not resolve. Add `env: %{"NODE_PATH" => Path.expand("../deps", __DIR__)}` to the esbuild profile.|,
            path
          )
        end
    end
  end

  # ---------------------------------------------------------------------------
  # Output
  # ---------------------------------------------------------------------------

  # `path` is the file the check consulted; rendered after the message
  # in `--verbose` mode so the operator can jump straight to it.
  defp ok(name, msg, path), do: {:ok, name, msg, path}
  defp warn(name, msg, path), do: {:warn, name, msg, path}
  defp fail(name, msg, path), do: {:fail, name, msg, path}

  defp print_result({status, name, msg, path}, verbose?) do
    {tag, marker} =
      case status do
        :ok -> {[:green, "OK  "], "✓"}
        :warn -> {[:yellow, "WARN"], "!"}
        :fail -> {[:red, "FAIL"], "✗"}
      end

    suffix =
      if verbose? and is_binary(path) do
        [:faint, "  (#{path})", :reset]
      else
        []
      end

    line =
      tag ++
        [" #{marker} #{String.pad_trailing(name, 16)} ", :reset, msg] ++ suffix

    Mix.shell().info(IO.ANSI.format(line) |> IO.iodata_to_binary())
  end

  defp summary(results) do
    fails = Enum.count(results, &(elem(&1, 0) == :fail))
    warns = Enum.count(results, &(elem(&1, 0) == :warn))

    Mix.shell().info("")

    cond do
      fails > 0 ->
        Mix.shell().info("[hi_pulse.doctor] #{fails} failing — fix the items above and re-run.")
        exit({:shutdown, 1})

      warns > 0 ->
        Mix.shell().info("[hi_pulse.doctor] all checks passed, #{warns} warning(s).")

      true ->
        Mix.shell().info("[hi_pulse.doctor] all checks passed — widget should work.")
    end
  end

  # Byte offset of `needle` in `body`, or nil if not found. Used by the
  # endpoint check to compare the SDK mount's position to the catch-all's.
  defp byte_index(body, needle) do
    case :binary.match(body, needle) do
      {start, _} -> start
      :nomatch -> nil
    end
  end

  # ---------------------------------------------------------------------------
  # Live checks (--live only)
  # ---------------------------------------------------------------------------

  # Read `HI_PULSE_TOKEN` + `HI_PULSE_SERVER_URL` directly from .env
  # without booting the consumer app. Dotenvy-using apps don't push
  # the .env into `System.get_env`, so a runtime read wouldn't work.
  defp env_from_dotenv do
    contents =
      case File.read(".env") do
        {:ok, body} -> body
        {:error, _} -> ""
      end

    %{
      token: extract_env_value(contents, "HI_PULSE_TOKEN") || System.get_env("HI_PULSE_TOKEN"),
      server_url:
        extract_env_value(contents, "HI_PULSE_SERVER_URL") ||
          System.get_env("HI_PULSE_SERVER_URL") ||
          "https://pulse.hiral.io"
    }
  end

  defp extract_env_value(contents, key) do
    case Regex.run(~r/^#{Regex.escape(key)}=["']?([^"'\n]+)["']?$/m, contents) do
      [_, value] -> value
      _ -> nil
    end
  end

  defp check_server_reachable(%{server_url: url}) do
    case http_request(:head, url <> "/login") do
      {:ok, status} when status in 200..399 ->
        ok("Server", "#{url} responds (#{status})", url)

      {:ok, status} ->
        warn(
          "Server",
          "#{url}/login returned #{status} — server up but not responding as expected",
          url
        )

      {:error, reason} ->
        fail(
          "Server",
          "couldn't reach #{url}: #{inspect(reason)} — check DNS, TLS, and HI_PULSE_SERVER_URL",
          url
        )
    end
  end

  defp check_token_round_trip(%{token: nil}) do
    fail("Token round-trip", "no HI_PULSE_TOKEN in .env — can't probe the server", ".env")
  end

  defp check_token_round_trip(%{server_url: url, token: token}) do
    headers = [{~c"authorization", to_charlist("Bearer " <> token)}]

    case http_request(:get, url <> "/api/v1/projects/me/config", headers) do
      {:ok, 200} ->
        ok(
          "Token round-trip",
          "GET /api/v1/projects/me/config → 200; project resolves on the server",
          url
        )

      {:ok, 401} ->
        fail(
          "Token round-trip",
          "401 — HI_PULSE_TOKEN doesn't resolve on the server. Rotate it in the admin UI.",
          ".env"
        )

      {:ok, status} ->
        warn(
          "Token round-trip",
          "GET /api/v1/projects/me/config → #{status}; expected 200",
          url
        )

      {:error, reason} ->
        fail("Token round-trip", "request failed: #{inspect(reason)}", url)
    end
  end

  defp http_request(method, url, headers \\ []) do
    request =
      case method do
        :head -> {to_charlist(url), headers}
        :get -> {to_charlist(url), headers}
      end

    case :httpc.request(method, request, [{:timeout, 5_000}], []) do
      {:ok, {{_, status, _}, _, _}} -> {:ok, status}
      {:error, reason} -> {:error, reason}
    end
  end
end
