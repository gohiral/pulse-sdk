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
      Application.delete_env(:hi_pulse, :secret)
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
      # Tracked statics outside the host's digest manifest make LiveView's
      # static_changed?/1 true on every mount (host apps show a reload prompt).
      refute html =~ "phx-track-static"

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

    test "stamps a verifiable reporter token when a secret is configured" do
      secret = "hif_secret_component_test_0123456789abcdef"
      Application.put_env(:hi_pulse, :secret, secret)

      html =
        render_component(&Components.pulse_widget/1,
          enabled?: true,
          reporter: %{email: "alice@example.com", id: 7}
        )

      [_, token] = Regex.run(~r/data-reporter-token="([^"]+)"/, html)

      assert {:ok, %{"e" => "alice@example.com", "i" => "7"}} =
               Phoenix.Token.verify(secret, "hi_pulse reporter v1", token)
    end

    test "omits the reporter token without a secret or a reporter identity" do
      html =
        render_component(&Components.pulse_widget/1,
          enabled?: true,
          reporter: %{email: "alice@example.com"}
        )

      refute html =~ "data-reporter-token"

      Application.put_env(:hi_pulse, :secret, "hif_secret_component_test_0123456789abcdef")
      html = render_component(&Components.pulse_widget/1, enabled?: true, reporter: %{})
      refute html =~ "data-reporter-token"
    end
  end

  describe "release_note/1" do
    test "renders a hidden slot LiveView leaves alone" do
      html = render_component(&Components.release_note/1, %{})

      assert html =~ "data-hi-pulse-release-note"
      assert html =~ ~s(id="hi-pulse-release-note")
      assert html =~ ~s(phx-update="ignore")
      assert html =~ "hidden"
    end

    test "accepts a class and a custom id" do
      html =
        render_component(&Components.release_note/1,
          class: "text-xs text-secondary",
          id: "banner-fix-line"
        )

      assert html =~ ~s(class="text-xs text-secondary")
      assert html =~ ~s(id="banner-fix-line")
    end
  end
end
