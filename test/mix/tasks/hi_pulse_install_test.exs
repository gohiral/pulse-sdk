defmodule Mix.Tasks.HiPulse.InstallTest do
  use ExUnit.Case, async: true

  alias Mix.Tasks.HiPulse.Install

  # ---------------------------------------------------------------------------
  # patch_runtime_exs/2 — base behaviour
  # ---------------------------------------------------------------------------

  describe "patch_runtime_exs/2 — vanilla phx.new" do
    test "appends `config :hi_pulse` with System.fetch_env! when Dotenvy isn't used" do
      original = """
      import Config

      if System.get_env("PHX_SERVER") do
        config :my_app, MyAppWeb.Endpoint, server: true
      end
      """

      assert {:ok, patched} = Install.patch_runtime_exs(original)
      assert patched =~ "config :hi_pulse"
      assert patched =~ ~s|System.fetch_env!("HI_PULSE_TOKEN")|
      assert patched =~ ~s|System.get_env("HI_PULSE_SERVER_URL")|
      refute patched =~ "Dotenvy.env!"
      refute patched =~ "if config_env() in [:dev, :test]"
    end

    test "is idempotent — re-running on already-patched content is a no-op" do
      original = """
      import Config

      config :hi_pulse, server_url: "https://x", token: "t"
      """

      assert {:ok, ^original} = Install.patch_runtime_exs(original)
    end
  end

  # ---------------------------------------------------------------------------
  # patch_runtime_exs/2 — Dotenvy detection (new behaviour)
  # ---------------------------------------------------------------------------

  describe "patch_runtime_exs/2 — Dotenvy-using app" do
    setup do
      original = """
      import Config

      if config_env() in [:dev, :test] and is_nil(System.get_env("CI")) do
        Dotenvy.source!([".env", ".env.\#{config_env()}"])

        config :my_app, :api_token, Dotenvy.env!("MY_API_TOKEN", :string!)
      end
      """

      %{original: original}
    end

    test "emits a dev/test block using Dotenvy.env!", %{original: original} do
      assert {:ok, patched} = Install.patch_runtime_exs(original)
      assert patched =~ "if config_env() in [:dev, :test]"

      # Token is required — `:string!` raises when missing.
      assert patched =~ ~s|Dotenvy.env!("HI_PULSE_TOKEN", :string!)|

      # server_url + project_slug are optional — pass an explicit
      # default to the 3-arg form so a missing var doesn't raise
      # (Dotenvy.env!/2 raises on missing keys regardless of type).
      assert patched =~
               ~s|Dotenvy.env!("HI_PULSE_SERVER_URL", :string, "https://pulse.hiral.io")|

      assert patched =~
               ~s|Dotenvy.env!("HI_PULSE_PROJECT_SLUG", :string, nil)|
    end

    test "also emits a prod-only block using System.fetch_env!", %{original: original} do
      assert {:ok, patched} = Install.patch_runtime_exs(original)
      assert patched =~ "if config_env() == :prod"
      assert patched =~ ~s|System.fetch_env!("HI_PULSE_TOKEN")|
    end

    test "doesn't double-up the simple System.fetch_env! block at top level",
         %{original: original} do
      assert {:ok, patched} = Install.patch_runtime_exs(original)
      # The single top-level `System.fetch_env!("HI_PULSE_TOKEN")` is
      # wrong for Dotenvy apps because it fires before Dotenvy loads.
      # Only count occurrences inside the prod block.
      occurrences =
        Regex.scan(~r/System\.fetch_env!\("HI_PULSE_TOKEN"\)/, patched)
        |> length()

      assert occurrences == 1
    end

    test "with capture-errors=prod-only still appends the gate block", %{original: original} do
      assert {:ok, patched} = Install.patch_runtime_exs(original, "prod-only")
      assert patched =~ "config :hi_pulse, capture_errors: true"
      assert patched =~ "if config_env() == :prod do"
    end
  end

  # ---------------------------------------------------------------------------
  # patch_app_js/1 — existing behaviour (regression cover)
  # ---------------------------------------------------------------------------

  describe "patch_app_js/1 — colocated hooks shorthand" do
    test "merges into `hooks: {...colocatedHooks}` without losing existing hooks" do
      original = """
      import "phoenix_html"
      import {Socket} from "phoenix"
      import {LiveSocket} from "phoenix_live_view"
      import {hooks as colocatedHooks} from "phoenix-colocated/my_app"

      const liveSocket = new LiveSocket("/live", Socket, {
        params: {_csrf_token: csrfToken},
        hooks: {...colocatedHooks},
      })
      """

      assert {:ok, patched} = Install.patch_app_js(original)
      assert patched =~ "import {PulseWidgetHook} from \"hi_pulse/pulse-widget\""
      assert patched =~ "hooks: {...colocatedHooks, HiPulse: PulseWidgetHook}"
    end
  end

  describe "patch_app_js/1 — empty hooks object" do
    test "fills in `hooks: {}` with the new hook" do
      original = """
      import {Socket} from "phoenix"
      import {LiveSocket} from "phoenix_live_view"

      const liveSocket = new LiveSocket("/live", Socket, {
        hooks: {},
      })
      """

      assert {:ok, patched} = Install.patch_app_js(original)
      assert patched =~ "hooks: {HiPulse: PulseWidgetHook}"
    end
  end

  # ---------------------------------------------------------------------------
  # patch_app_js/1 — no `hooks` key at all (new behaviour)
  # ---------------------------------------------------------------------------

  describe "patch_app_js/1 — LiveSocket without a hooks key" do
    test "inserts a fresh `hooks: { HiPulse: PulseWidgetHook }` entry" do
      original = """
      import {Socket} from "phoenix"
      import {LiveSocket} from "phoenix_live_view"

      const liveSocket = new LiveSocket("/live", Socket, {
        params: {_csrf_token: csrfToken},
      })
      """

      assert {:ok, patched} = Install.patch_app_js(original)
      assert patched =~ "import {PulseWidgetHook} from \"hi_pulse/pulse-widget\""
      assert patched =~ "hooks: {HiPulse: PulseWidgetHook}"
      # Must be inside the LiveSocket constructor, not floating somewhere else.
      assert patched =~ ~r/new\s+LiveSocket\([^)]*hooks:\s*\{HiPulse:/s
    end

    test "re-running is a no-op (`PulseWidgetHook` already present)" do
      patched_once = """
      import {PulseWidgetHook} from "hi_pulse/pulse-widget"
      import {LiveSocket} from "phoenix_live_view"

      const liveSocket = new LiveSocket("/live", Socket, {
        hooks: {HiPulse: PulseWidgetHook},
      })
      """

      assert {:ok, ^patched_once} = Install.patch_app_js(patched_once)
    end
  end

  describe "patch_app_js/1 — non-LiveView app.js bails cleanly" do
    test "returns an :error when phoenix_live_view isn't imported" do
      original = """
      import "phoenix_html"
      import {Socket} from "phoenix"
      """

      assert {:error, _} = Install.patch_app_js(original)
    end
  end

  # ---------------------------------------------------------------------------
  # patch_app_css/1 — import path points into the dep checkout
  # ---------------------------------------------------------------------------

  describe "patch_app_css/1" do
    test "appends an @import that resolves under deps/hi_pulse/" do
      original = ~s|@import "tailwindcss/base";\n|

      assert {:ok, patched} = Install.patch_app_css(original)

      # PostCSS resolves the import against the source filesystem.
      # A wrong path 404s and the widget renders unstyled.
      assert patched =~
               ~s|@import "../../deps/hi_pulse/priv/static/css/pulse-widget.css";|
    end

    test "inserts the @import in the leading @import block, not after non-import rules" do
      # Per CSS spec, `@import` must precede all other rules — anything
      # after the first regular rule is silently dropped by PostCSS /
      # Tailwind. Real-world Phoenix app.css has 3 leading tailwindcss
      # imports + lots of body rules below.
      original = """
      @import "tailwindcss/base";
      @import "tailwindcss/components";
      @import "tailwindcss/utilities";

      :root {
        --brand-color: #4f46e5;
      }

      .text-brand { color: var(--brand-color); }
      """

      assert {:ok, patched} = Install.patch_app_css(original)

      lines = String.split(patched, "\n")

      pulse_idx =
        Enum.find_index(lines, &String.contains?(&1, "pulse-widget.css"))

      first_rule_idx =
        Enum.find_index(lines, &String.contains?(&1, ":root {"))

      assert pulse_idx, "pulse-widget.css @import should be present"
      assert first_rule_idx, "fixture should still contain :root rule"

      assert pulse_idx < first_rule_idx,
             "pulse @import must precede the first non-import rule, " <>
               "otherwise PostCSS / Tailwind silently drop it"
    end

    test "prepends when there are no leading @import lines" do
      original = """
      :root { --brand: red; }
      """

      assert {:ok, patched} = Install.patch_app_css(original)
      assert String.starts_with?(patched, ~s|@import "../../deps/hi_pulse/|)
    end

    test "is idempotent" do
      patched_once = """
      @import "tailwindcss/base";
      @import "../../deps/hi_pulse/priv/static/css/pulse-widget.css";
      """

      assert {:ok, ^patched_once} = Install.patch_app_css(patched_once)
    end
  end

  # ---------------------------------------------------------------------------
  # patch_endpoint/2 — vendor mount must precede the catch-all Plug.Static
  # ---------------------------------------------------------------------------

  describe "patch_endpoint/2" do
    setup do
      original = """
      defmodule MyAppWeb.Endpoint do
        use Phoenix.Endpoint, otp_app: :my_app

        # Serve at "/" the static files from "priv/static" directory.
        plug Plug.Static,
          at: "/",
          from: :my_app,
          gzip: false,
          only: MyAppWeb.static_paths()

        plug Plug.Telemetry, event_prefix: [:phoenix, :endpoint]
      end
      """

      %{original: original}
    end

    test "inserts the SDK mount ABOVE the catch-all Plug.Static",
         %{original: original} do
      assert {:ok, patched} = Install.patch_endpoint(original, :my_app)

      lines = String.split(patched, "\n")

      sdk_mount_idx =
        Enum.find_index(lines, &String.contains?(&1, ~s|at: "/assets/vendor/hi_pulse"|))

      # Match the catch-all by its literal `at: "/",` — the trailing
      # `",` distinguishes it from `at: "/assets/..."` which would
      # otherwise prefix-match.
      catchall_idx = Enum.find_index(lines, &String.contains?(&1, ~s|at: "/",|))

      assert sdk_mount_idx, "SDK vendor mount line should be present"
      assert catchall_idx, "fixture should still contain the catch-all"

      # Plug pipeline runs top-to-bottom. The catch-all `Plug.Static at:
      # "/"` halts with 404 on /assets/* paths the consumer doesn't have,
      # so any mount placed after it never serves a request.
      assert sdk_mount_idx < catchall_idx,
             "SDK vendor mount must come BEFORE the catch-all `Plug.Static at: \"/\"`, " <>
               "otherwise rrweb 404s and replay capture is silently broken"
    end

    test "is idempotent (re-running on already-patched content is a no-op)",
         %{original: original} do
      {:ok, patched_once} = Install.patch_endpoint(original, :my_app)
      assert {:ok, ^patched_once} = Install.patch_endpoint(patched_once, :my_app)
    end

    test "errors cleanly when there's no Plug.Static to anchor on" do
      bare = """
      defmodule MyAppWeb.Endpoint do
        use Phoenix.Endpoint, otp_app: :my_app
        plug Plug.Telemetry, event_prefix: [:phoenix, :endpoint]
      end
      """

      assert {:error, _} = Install.patch_endpoint(bare, :my_app)
    end
  end
end
