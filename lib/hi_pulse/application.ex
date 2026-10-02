defmodule HiPulse.Application do
  @moduledoc """
  OTP application callback for the SDK.

  Always starts a Task supervisor (used by `ErrorHandler` to spawn
  fire-and-forget ship tasks). When `config :hi_pulse,
  capture_errors: true`, also registers `HiPulse.ErrorHandler` as
  an OTP `:logger` handler so error-level events flow to the feedback
  server.

  The recommended config (written by `mix hi_pulse.install`) gates
  the flag on `config_env() == :prod` so dev / staging environments
  don't ship every local crash upstream:

      # config/runtime.exs
      if config_env() == :prod do
        config :hi_pulse, capture_errors: true
      end

  `config_env/0` is runtime.exs-safe (works in releases — `Mix.env/0`
  doesn't), so the gate evaluates correctly when the application
  boots inside a packaged release.
  """
  use Application

  require Logger

  @handler_id :hi_pulse_error
  @level :error

  # Bounded so a hot crash loop in the consumer (LiveView reconnect storm,
  # GenServer restart loop) can't fill the BEAM with in-flight ship tasks
  # while the network is slow / down. Over-budget calls return
  # `{:error, :max_children}` and are silently dropped by `ErrorHandler.ship/1`
  # — lost telemetry beats OOMing the host app.
  @max_in_flight_ship_tasks 50

  @impl true
  def start(_type, _args) do
    children = [
      {Task.Supervisor, name: HiPulse.TaskSupervisor, max_children: @max_in_flight_ship_tasks}
    ]

    opts = [strategy: :one_for_one, name: HiPulse.Supervisor]

    case Supervisor.start_link(children, opts) do
      {:ok, pid} ->
        maybe_install_logger_handler()
        {:ok, pid}

      other ->
        other
    end
  end

  @impl true
  def stop(_state) do
    _ = :logger.remove_handler(@handler_id)
    :ok
  end

  defp maybe_install_logger_handler do
    if Application.get_env(:hi_pulse, :capture_errors, false) do
      install_logger_handler()
    else
      :ok
    end
  end

  defp install_logger_handler do
    config = %{level: @level, config: %{}}

    case :logger.add_handler(@handler_id, HiPulse.ErrorHandler, config) do
      :ok ->
        :ok

      {:error, {:already_exists, _}} ->
        :ok

      {:error, reason} ->
        Logger.warning("[hi-pulse] could not install error handler: #{inspect(reason)}")
        :ok
    end
  end
end
