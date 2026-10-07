defmodule HiPulse.Components do
  @moduledoc """
  Phoenix LiveView components for the feedback widget.

  Render `<HiPulse.Components.pulse_widget />` in your root layout.
  The component is a thin shell around the JS hook — it emits a single
  `<div phx-hook>` and stamps the per-request reporter/context into data
  attributes the JS reads on mount.

  ## Required JS

  The widget mounts on a `phx-hook="HiPulse"` element. Your consumer
  app's `app.js` must register the hook:

      import { PulseWidgetHook } from "hi_pulse/pulse-widget";

      const liveSocket = new LiveSocket("/live", Socket, {
        hooks: { HiPulse: PulseWidgetHook },
        // ...
      });

  See the SDK README for the matching esbuild + `static_paths/0` setup.
  """
  use Phoenix.Component

  @doc """
  Renders the floating feedback widget.

  Pass `enabled?={false}` (or omit when the assign is unset) to hide
  it entirely — the component then renders nothing, including the
  vendored rrweb scripts.

  ## Attributes

    * `enabled?` (boolean, default `false`) — whether to mount the
      widget at all. Wire this to your auth gate (e.g. `@current_user
      != nil`).
    * `reporter` (map, default `%{}`) — identity stamped into the
      submission. Supported keys: `:email`, `:id`, `:metadata`. When
      `HiPulse.secret/0` is set, the email and id are also signed into
      `data-reporter-token`, which turns on reporter updates.
    * `context` (map, default `%{}`) — arbitrary key/value pairs
      attached to every submission (e.g. `%{tenant_id: "abc"}`).
    * `vendor_path` (string, default `"/assets/vendor/hi_pulse"`)
      — where the consumer app serves the bundled rrweb UMD scripts.
      Override if you mount the SDK's `priv/static/vendor/` somewhere
      else.

  ## Examples

      <HiPulse.Components.pulse_widget
        enabled?={@current_user != nil}
        reporter={%{email: @current_user.email, id: @current_user.id}}
        context={%{tenant_id: @current_tenant.id}}
      />
  """
  attr(:enabled?, :boolean, default: false)
  attr(:reporter, :map, default: %{})
  attr(:context, :map, default: %{})
  attr(:vendor_path, :string, default: "/assets/vendor/hi_pulse")
  attr(:id, :string, default: "hi-pulse-widget")

  def pulse_widget(assigns) do
    assigns = assign(assigns, :data, build_data(assigns))

    ~H"""
    <%= if @enabled? do %>
      <%!-- Not phx-track-static: the host serves these from the SDK's priv,
           outside its digest manifest, so LiveView's static_changed?/1 would
           report every page as stale and show the host's reload prompt. --%>
      <script defer type="text/javascript" src={@vendor_path <> "/rrweb.min.js"}>
      </script>
      <script
        defer
        type="text/javascript"
        src={@vendor_path <> "/rrweb-plugin-console-record.min.js"}
      >
      </script>
      <div
        id={@id}
        phx-hook="HiPulse"
        phx-update="ignore"
        data-reporter={@data.reporter}
        data-context={@data.context}
        data-project-slug={HiPulse.project_slug() || ""}
        data-server-url={HiPulse.server_url()}
        data-token={HiPulse.token!()}
        data-capture-errors={to_string(HiPulse.capture_errors?())}
        data-reporter-token={@data.reporter_token}
      >
      </div>
    <% end %>
    """
  end

  defp build_data(assigns) do
    %{
      reporter: Jason.encode!(assigns[:reporter] || %{}),
      context: Jason.encode!(assigns[:context] || %{}),
      reporter_token: HiPulse.reporter_token(assigns[:reporter])
    }
  end

  @doc """
  Renders the slot the widget fills with "Includes your fix: …" when a
  release ships a fix the current user reported.

  Place it inside your app's "new version available" banner. Render it
  whenever the widget is mounted, even while the banner is hidden: the
  widget looks for the slot the moment the release arrives and shows its
  own peek when there is none. The element stays `hidden` until filled
  and is ignored by LiveView patches, so a banner re-render keeps the
  line.

  ## Attributes

    * `id` (string, default `"hi-pulse-release-note"`) — required by
      `phx-update="ignore"`; override when rendering more than one.
    * `class` — classes for the line, e.g. your banner's secondary text.

  ## Examples

      <div id="new-version-banner" hidden>
        <p>The app was updated.</p>
        <HiPulse.Components.release_note class="text-xs text-secondary" />
      </div>
  """
  attr(:id, :string, default: "hi-pulse-release-note")
  attr(:class, :any, default: nil)

  def release_note(assigns) do
    ~H"""
    <div id={@id} class={@class} phx-update="ignore" data-hi-pulse-release-note hidden></div>
    """
  end
end
