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
      submission. Supported keys: `:email`, `:id`, `:metadata`.
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
      >
      </div>
    <% end %>
    """
  end

  defp build_data(assigns) do
    %{
      reporter: Jason.encode!(assigns[:reporter] || %{}),
      context: Jason.encode!(assigns[:context] || %{})
    }
  end
end
