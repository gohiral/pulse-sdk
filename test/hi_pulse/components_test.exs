defmodule HiPulse.ComponentsTest do
  use ExUnit.Case, async: false

  import Phoenix.LiveViewTest, only: [render_component: 2]

  alias HiPulse.Components

  setup do
    Application.put_env(:hi_pulse, :token, "test-token")
    Application.put_env(:hi_pulse, :server_url, "https://feedback.test")
    Application.put_env(:hi_pulse, :project_slug, "demo-app")

    on_exit(fn ->
      Application.delete_env(:hi_pulse, :token)
      Application.delete_env(:hi_pulse, :server_url)
      Application.delete_env(:hi_pulse, :project_slug)
    end)

    :ok
  end

  describe "pulse_widget/1" do
    test "renders nothing when disabled" do
      html = render_component(&Components.pulse_widget/1, enabled?: false)
      refute html =~ "phx-hook"
      refute html =~ "rrweb"
    end

    test "renders the hook + vendor scripts when enabled" do
      html =
        render_component(&Components.pulse_widget/1,
          enabled?: true,
          reporter: %{email: "alice@example.com"},
          context: %{tenant_id: "abc123"}
        )

      assert html =~ ~s(phx-hook="HiPulse")
      assert html =~ ~s(id="hi-pulse-widget")
      assert html =~ "/assets/vendor/hi_pulse/rrweb.min.js"
      assert html =~ "/assets/vendor/hi_pulse/rrweb-plugin-console-record.min.js"

      # Reporter and context are JSON-encoded into data attributes so the
      # JS hook can `JSON.parse(...)` them on mount.
      assert html =~ ~s(data-reporter="{&quot;email&quot;:&quot;alice@example.com&quot;}")
      assert html =~ ~s(data-context="{&quot;tenant_id&quot;:&quot;abc123&quot;}")
      assert html =~ ~s(data-server-url="https://feedback.test")
      assert html =~ ~s(data-project-slug="demo-app")
      assert html =~ ~s(data-token="test-token")
    end

    test "supports overriding the vendor path" do
      html =
        render_component(&Components.pulse_widget/1,
          enabled?: true,
          vendor_path: "/static/vendor"
        )

      assert html =~ "/static/vendor/rrweb.min.js"
      refute html =~ "/assets/vendor/hi_pulse/rrweb.min.js"
    end

    test "supports overriding the dom id" do
      html =
        render_component(&Components.pulse_widget/1,
          enabled?: true,
          id: "custom-feedback"
        )

      assert html =~ ~s(id="custom-feedback")
    end
  end
end
