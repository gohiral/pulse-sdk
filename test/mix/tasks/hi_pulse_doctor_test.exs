defmodule Mix.Tasks.HiPulse.DoctorTest do
  # Each test cd's into a tmp_dir fixture and runs the doctor against
  # it. ExUnit's `tmp_dir: true` allocates a unique dir per test.
  use ExUnit.Case, async: true

  @moduletag :tmp_dir

  alias Mix.Tasks.HiPulse.Doctor

  # ---------------------------------------------------------------------------
  # Helpers
  # ---------------------------------------------------------------------------

  defp write!(tmp_dir, relative, body) do
    abs = Path.join(tmp_dir, relative)
    File.mkdir_p!(Path.dirname(abs))
    File.write!(abs, body)
  end

  defp run_check(check_fn, tmp_dir, app \\ :my_app) do
    File.cd!(tmp_dir, fn -> check_fn.(app) end)
  end

  # ---------------------------------------------------------------------------
  # CSS @import — the trickiest check; covers each of the four classes
  # of CSS file shape we expect to see in real consumer apps.
  # ---------------------------------------------------------------------------

  describe "check_app_css/1" do
    test "OK — @import in leading-imports block (Tailwind v3 @import style)",
         %{tmp_dir: tmp} do
      write!(tmp, "assets/css/app.css", """
      @import "tailwindcss/base";
      @import "tailwindcss/components";
      @import "tailwindcss/utilities";
      @import "../../deps/hi_pulse/priv/static/css/pulse-widget.css";

      :root { --brand: red; }
      """)

      {status, _, msg, _} = run_check(&Doctor.check_app_css/1, tmp)
      assert status == :ok, "got #{status}: #{msg}"
    end

    test "OK — @tailwind directive form (Tailwind v3 / vanilla phx.new) doesn't break the check",
         %{tmp_dir: tmp} do
      # This is the case that caught us in review: a `@tailwind base;`
      # directive line at the top is NOT a "first non-import rule" for
      # our purposes — PostCSS / Tailwind treats the leading-imports
      # block as extending across these directives.
      write!(tmp, "assets/css/app.css", """
      @tailwind base;
      @tailwind components;
      @tailwind utilities;
      @import "../../deps/hi_pulse/priv/static/css/pulse-widget.css";

      :root { --brand: red; }
      """)

      {status, _, msg, _} = run_check(&Doctor.check_app_css/1, tmp)
      assert status == :ok, "got #{status}: #{msg}"
    end

    test "FAIL — @import below a non-import style rule (CSS spec drops it)",
         %{tmp_dir: tmp} do
      write!(tmp, "assets/css/app.css", """
      @import "tailwindcss/base";

      :root { --brand: red; }

      @import "../../deps/hi_pulse/priv/static/css/pulse-widget.css";
      """)

      {status, _, msg, _} = run_check(&Doctor.check_app_css/1, tmp)
      assert status == :fail
      assert msg =~ "below a non-import rule"
    end

    test "FAIL — wrong @import path (old sparse-checkout `sdk/` prefix)", %{tmp_dir: tmp} do
      write!(tmp, "assets/css/app.css", """
      @import "tailwindcss/base";
      @import "../../deps/hi_pulse/sdk/priv/static/css/pulse-widget.css";
      """)

      {status, _, msg, _} = run_check(&Doctor.check_app_css/1, tmp)
      assert status == :fail
      assert msg =~ "doesn't point at"
    end

    test "FAIL — @import missing entirely", %{tmp_dir: tmp} do
      write!(tmp, "assets/css/app.css", ~s|@import "tailwindcss/base";\n|)

      {status, _, msg, _} = run_check(&Doctor.check_app_css/1, tmp)
      assert status == :fail
      assert msg =~ "no `@import"
    end

    test "FAIL — app.css missing entirely", %{tmp_dir: tmp} do
      {status, _, msg, _} = run_check(&Doctor.check_app_css/1, tmp)
      assert status == :fail
      assert msg =~ "missing"
    end
  end

  # ---------------------------------------------------------------------------
  # Endpoint mount — order matters: SDK above catch-all
  # ---------------------------------------------------------------------------

  describe "check_endpoint/1" do
    test "OK — SDK mount above catch-all", %{tmp_dir: tmp} do
      write!(tmp, "lib/my_app_web/endpoint.ex", """
      defmodule MyAppWeb.Endpoint do
        plug Plug.Static,
          at: "/assets/vendor/hi_pulse",
          from: {:hi_pulse, "priv/static/vendor"}

        plug Plug.Static,
          at: "/",
          from: :my_app
      end
      """)

      {status, _, _, _} = run_check(&Doctor.check_endpoint/1, tmp)
      assert status == :ok
    end

    test "FAIL — SDK mount below catch-all (Phoenix 404s on /assets/vendor/* first)",
         %{tmp_dir: tmp} do
      write!(tmp, "lib/my_app_web/endpoint.ex", """
      defmodule MyAppWeb.Endpoint do
        plug Plug.Static,
          at: "/",
          from: :my_app

        plug Plug.Static,
          at: "/assets/vendor/hi_pulse",
          from: {:hi_pulse, "priv/static/vendor"}
      end
      """)

      {status, _, msg, _} = run_check(&Doctor.check_endpoint/1, tmp)
      assert status == :fail
      assert msg =~ "AFTER the catch-all"
    end

    test "FAIL — SDK mount missing entirely", %{tmp_dir: tmp} do
      write!(tmp, "lib/my_app_web/endpoint.ex", """
      defmodule MyAppWeb.Endpoint do
        plug Plug.Static, at: "/", from: :my_app
      end
      """)

      {status, _, msg, _} = run_check(&Doctor.check_endpoint/1, tmp)
      assert status == :fail
      assert msg =~ "missing"
    end
  end

  # ---------------------------------------------------------------------------
  # Runtime config — Dotenvy detection
  # ---------------------------------------------------------------------------

  describe "check_runtime_exs/1" do
    test "OK — vanilla System.fetch_env! in non-Dotenvy app", %{tmp_dir: tmp} do
      write!(tmp, "config/runtime.exs", """
      import Config

      config :hi_pulse,
        server_url: System.get_env("HI_PULSE_SERVER_URL") || "https://pulse.hiral.io",
        token: System.fetch_env!("HI_PULSE_TOKEN")
      """)

      {status, _, _, _} = run_check(&Doctor.check_runtime_exs/1, tmp)
      assert status == :ok
    end

    test "FAIL — Dotenvy-using app but installer emitted plain System.fetch_env!",
         %{tmp_dir: tmp} do
      # This is the bug a previous installer release shipped: top-level
      # `System.fetch_env!("HI_PULSE_TOKEN")` raises at boot because
      # Dotenvy hasn't loaded .env into the OS env yet.
      write!(tmp, "config/runtime.exs", """
      import Config

      Dotenvy.source!([".env"])

      config :hi_pulse,
        token: System.fetch_env!("HI_PULSE_TOKEN")
      """)

      {status, _, msg, _} = run_check(&Doctor.check_runtime_exs/1, tmp)
      assert status == :fail
      assert msg =~ "uses Dotenvy"
    end

    test "OK — Dotenvy app with Dotenvy.env! reader", %{tmp_dir: tmp} do
      write!(tmp, "config/runtime.exs", """
      import Config

      Dotenvy.source!([".env"])

      if config_env() in [:dev, :test] do
        config :hi_pulse, token: Dotenvy.env!("HI_PULSE_TOKEN", :string!)
      end

      if config_env() == :prod do
        config :hi_pulse, token: System.fetch_env!("HI_PULSE_TOKEN")
      end
      """)

      {status, _, _, _} = run_check(&Doctor.check_runtime_exs/1, tmp)
      assert status == :ok
    end

    test "FAIL — no config :hi_pulse block", %{tmp_dir: tmp} do
      write!(tmp, "config/runtime.exs", "import Config\n")

      {status, _, msg, _} = run_check(&Doctor.check_runtime_exs/1, tmp)
      assert status == :fail
      assert msg =~ "no `config :hi_pulse`"
    end
  end

  # ---------------------------------------------------------------------------
  # JS hook — three patterns + missing-key path that 1ea672a introduced
  # ---------------------------------------------------------------------------

  describe "check_app_js/1" do
    test "OK — colocated hooks shorthand", %{tmp_dir: tmp} do
      write!(tmp, "assets/js/app.js", """
      import { PulseWidgetHook } from "hi_pulse/pulse-widget"

      const liveSocket = new LiveSocket("/live", Socket, {
        hooks: { ...colocatedHooks, HiPulse: PulseWidgetHook },
      })
      """)

      {status, _, _, _} = run_check(&Doctor.check_app_js/1, tmp)
      assert status == :ok
    end

    test "FAIL — hook imported but never registered on LiveSocket", %{tmp_dir: tmp} do
      write!(tmp, "assets/js/app.js", """
      import { PulseWidgetHook } from "hi_pulse/pulse-widget"

      const liveSocket = new LiveSocket("/live", Socket, {})
      """)

      {status, _, msg, _} = run_check(&Doctor.check_app_js/1, tmp)
      assert status == :fail
      assert msg =~ "not registered"
    end

    test "FAIL — no hook import at all", %{tmp_dir: tmp} do
      write!(tmp, "assets/js/app.js", "// just imports phoenix\n")

      {status, _, msg, _} = run_check(&Doctor.check_app_js/1, tmp)
      assert status == :fail
      assert msg =~ "no `import"
    end
  end

  # ---------------------------------------------------------------------------
  # Env vars — token presence + placeholder warning
  # ---------------------------------------------------------------------------

  describe "check_env/1" do
    test "FAIL — no .env, no OS HI_PULSE_TOKEN", %{tmp_dir: tmp} do
      System.delete_env("HI_PULSE_TOKEN")
      {status, _, msg, _} = run_check(&Doctor.check_env/1, tmp)
      assert status == :fail
      assert msg =~ "not set"
    end

    test "WARN — token is the install-time placeholder", %{tmp_dir: tmp} do
      write!(tmp, ".env", ~s|HI_PULSE_TOKEN="hif_live_PLACEHOLDER_REPLACE_AFTER_PULSE_DEPLOY"\n|)

      {status, _, msg, _} = run_check(&Doctor.check_env/1, tmp)
      assert status == :warn
      assert msg =~ "placeholder"
    end

    test "OK — real-looking token in .env", %{tmp_dir: tmp} do
      write!(tmp, ".env", ~s|HI_PULSE_TOKEN="hif_live_realtokenhereabc123"\n|)

      {status, _, _, _} = run_check(&Doctor.check_env/1, tmp)
      assert status == :ok
    end
  end

  # ---------------------------------------------------------------------------
  # Other checks — single-shape OK paths (broader matrix would be redundant)
  # ---------------------------------------------------------------------------

  describe "smaller checks" do
    test "check_root_layout/1 — OK when component is rendered", %{tmp_dir: tmp} do
      write!(tmp, "lib/my_app_web/components/layouts/root.html.heex", """
      <html>
        <body>
          <HiPulse.Components.pulse_widget enabled?={@current_user != nil} />
        </body>
      </html>
      """)

      {status, _, _, _} = run_check(&Doctor.check_root_layout/1, tmp)
      assert status == :ok
    end

    test "check_config_exs/1 — OK when esbuild alias is present", %{tmp_dir: tmp} do
      write!(tmp, "config/config.exs", """
      config :esbuild,
        my_app: [
          args: ~w(js/app.js --bundle --alias:hi_pulse=...)
        ]
      """)

      {status, _, _, _} = run_check(&Doctor.check_config_exs/1, tmp)
      assert status == :ok
    end
  end
end
