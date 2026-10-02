defmodule HiPulse do
  @moduledoc """
  Drop-in feedback widget SDK for Hiral apps.

  ## Overview

  This library is consumed by other Hiral Phoenix apps so their users can
  click a floating "Feedback" button, fill out a form, optionally annotate a
  screenshot, and submit a bug / suggestion / question / praise to a
  `hi_pulse_server` instance.

  The library bundles three pieces:

    * `HiPulse.Components` — a `<HiPulse.Components.pulse_widget />`
      LiveView function component you mount once in your root layout.
    * `HiPulse.Client` — the Elixir-side HTTP client that posts events
      to `hi_pulse_server`'s `POST /api/v1/events` endpoint. Most apps
      do not call this directly; the JS hook submits straight from the
      browser. Exposed for testing and for server-to-server submissions.
    * Bundled JS at `priv/static/js/` (`pulse-widget.js`,
      `annotator.js`, `replay_recorder.js`) and `priv/static/vendor/`
      (vendored rrweb UMD bundles).

  ## Configuration

  Required runtime config in your consumer app:

      config :hi_pulse,
        # The hi_pulse_server URL. Default is the production hosted instance.
        server_url: System.get_env("HI_PULSE_SERVER_URL", "https://pulse.hiral.io"),
        # Per-project token issued from the feedback admin UI.
        token: System.fetch_env!("HI_PULSE_TOKEN"),
        # Optional: project slug, used purely for "View in feedback" links.
        project_slug: System.get_env("HI_PULSE_PROJECT_SLUG")

  ## Integration

  Run `mix hi_pulse.install` in your consumer app — it patches every
  file the widget needs (root layout, endpoint, app.js, app.css, esbuild
  config). The component renders whenever `:current_user` is in
  `assigns`, so you don't need to wire an `on_mount` hook.
  """

  @doc """
  Returns the configured `hi_pulse_server` base URL. Defaults to the
  production hosted instance when not set.
  """
  @spec server_url() :: String.t()
  def server_url do
    Application.get_env(:hi_pulse, :server_url, "https://pulse.hiral.io")
  end

  @doc """
  Returns the configured project token. Raises if missing — without a
  token the SDK can't authenticate with `hi_pulse_server`.
  """
  @spec token!() :: String.t()
  def token! do
    case Application.fetch_env(:hi_pulse, :token) do
      {:ok, value} when is_binary(value) and value != "" ->
        value

      _ ->
        raise """
        [hi-pulse] missing :token config.

        Set it in your runtime.exs:

            config :hi_pulse, token: System.fetch_env!("HI_PULSE_TOKEN")
        """
    end
  end

  @doc """
  Returns the configured project slug, or `nil` if not set. Used for the
  "View in feedback" deep link in admin UIs.
  """
  @spec project_slug() :: String.t() | nil
  def project_slug do
    Application.get_env(:hi_pulse, :project_slug)
  end

  @doc """
  Whether automatic error capture is enabled. Drives both the
  Elixir-side `:logger` handler installation (in `HiPulse.Application`)
  and the JS-side `data-capture-errors` attribute on the widget div
  (in `HiPulse.Components`). Default `false` — opt-in only, recommended
  to gate on `config_env() == :prod` in `runtime.exs`.
  """
  @spec capture_errors?() :: boolean()
  def capture_errors? do
    Application.get_env(:hi_pulse, :capture_errors, false) == true
  end
end
