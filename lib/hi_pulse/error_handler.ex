defmodule HiPulse.ErrorHandler do
  @moduledoc """
  OTP `:logger` handler that ships error-level events to a
  `hi_pulse_server`.

  Installed by `HiPulse.Application` when `:capture_errors` is true.
  This module is the exit point for the Elixir-side capture pipeline:

    1. `:logger` calls `log/2` on every log event.
    2. We filter to error / critical levels with a `:crash_reason`
       metadata key (LiveView crashes, GenServer terminations, Task
       failures all set this), or any plain `Logger.error/1` call.
    3. **Self-protection** — events originating from the SDK itself
       are dropped so a transport failure can't trigger another error
       which the handler picks up and re-submits in a loop.
    4. Surviving events are converted via `ErrorPayload`, scrubbed via
       `Scrubber`, and shipped via `Client.submit_error/1` in a
       supervised, fire-and-forget Task.

  The ship is `:noop` if `Client.submit_error/1` raises — we never let
  the logging pipeline error out, no matter what. To make sure
  misconfigured tokens / unreachable servers don't go unnoticed
  forever, the FIRST failure surfaces a `Logger.warning/1` with the
  error reason and the consumer-app `:application` metadata flag set
  so the warning itself doesn't loop back through this handler.
  """

  require Logger

  alias HiPulse.{Client, ErrorPayload}

  @doc false
  # OTP `:logger` handler callback. Called synchronously from the
  # logging process — so we MUST return quickly. The actual HTTP work
  # happens in a spawned Task.
  def log(event, _config) do
    cond do
      not capture_level?(event) -> :ok
      from_self?(event) -> :ok
      true -> dispatch(event)
    end
  rescue
    # Logger handlers must never raise — that would blow up the entire
    # logging pipeline for the host application.
    _ -> :ok
  catch
    _, _ -> :ok
  end

  # ---------------------------------------------------------------------------
  # Filters
  # ---------------------------------------------------------------------------

  defp capture_level?(%{level: level}) when level in [:error, :critical], do: true
  defp capture_level?(_), do: false

  # Drop any event that originated from the SDK itself. Without this,
  # a transport failure ("can't reach pulse.hiral.io") would trigger
  # `Logger.error/1` from `Client.submit_error`, which would land back
  # in this handler, which would try to ship it… forever.
  defp from_self?(%{meta: %{application: :hi_pulse}}), do: true

  defp from_self?(%{meta: %{crash_reason: {_, stack}}}) when is_list(stack) do
    Enum.any?(stack, fn
      {HiPulse.Client, _, _, _} -> true
      {HiPulse.ErrorHandler, _, _, _} -> true
      {HiPulse, _, _, _} -> true
      _ -> false
    end)
  end

  defp from_self?(_), do: false

  # ---------------------------------------------------------------------------
  # Dispatch
  # ---------------------------------------------------------------------------

  defp dispatch(event) do
    payload = ErrorPayload.from_logger_event(event)
    Task.Supervisor.start_child(HiPulse.TaskSupervisor, fn -> ship(payload) end)
    :ok
  end

  # Module attribute used as a one-shot flag (per BEAM start) so a
  # misconfigured token or unreachable server gets surfaced ONCE
  # rather than going silent forever.
  defp ship(payload) do
    case Client.submit_error(payload) do
      {:ok, _} ->
        :ok

      {:error, reason} ->
        warn_once(reason)
        :ok
    end
  rescue
    # Already noted in the moduledoc — never propagate from the ship
    # task. If something inside Client.submit_error raises, the error
    # is lost. That's the right trade: lost telemetry is fine,
    # cascading failures in the host app are not.
    e ->
      warn_once(Exception.message(e))
      :ok
  catch
    kind, reason ->
      warn_once({kind, reason})
      :ok
  end

  # `:persistent_term` is the cheapest atomic flag in OTP — read in
  # nanoseconds, written once. We never clear it, so the warning fires
  # exactly once per BEAM lifetime regardless of how many ship failures
  # follow.
  defp warn_once(reason) do
    case :persistent_term.get({__MODULE__, :warned}, false) do
      true ->
        :ok

      false ->
        :persistent_term.put({__MODULE__, :warned}, true)
        # `Logger.warning/1` is below the `:error` / `:critical` filter
        # in `capture_level?/1`, so this line can't loop back through
        # the handler. No `application:` override needed.
        Logger.warning(
          "[hi-pulse] error capture is dropping events: #{inspect(reason)}. " <>
            "Check HI_PULSE_TOKEN and HI_PULSE_SERVER_URL."
        )
    end
  end
end
