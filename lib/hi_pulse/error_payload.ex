defmodule HiPulse.ErrorPayload do
  @moduledoc """
  Convert an OTP `:logger` event into the JSON-shaped map the feedback
  server's `POST /api/v1/events/error` endpoint accepts.

  The conversion is pure — no I/O, no process state — so it's safe to
  call from any process (including the `:logger` handler dispatch
  callback, which runs in the logging process). The output shape:

      %{
        "error_class"   => "RuntimeError",
        "error_message" => "** (RuntimeError) boom",
        "error_origin"  => "elixir",
        "stack_trace"   => "    (myapp 1.0.0) lib/x.ex:1: X.f/0\\n…",
        "context"       => %{ scrubbed Logger.metadata },
        "occurred_at"   => "2026-05-09T22:14:01.234Z"
      }

  Stack and metadata both go through `HiPulse.Scrubber` so values
  for keys like `password`, `token`, `authorization` never leave the
  process.
  """

  alias HiPulse.Scrubber

  @doc """
  Build an error payload from an OTP `:logger` event map. Returns a
  string-keyed map ready to be JSON-encoded.

  The `:logger` event map looks like:

      %{
        level: :error,
        msg: {:string, iodata} | {format, args} | {:report, map},
        meta: %{crash_reason: {exception, stacktrace}, ...},
      }

  We pull the `:crash_reason` entry (set by Phoenix / GenServer / Task
  on supervisor crashes) when present; otherwise we fall back to
  formatting `msg`. Either way the payload always carries an
  `error_class`, even if it's a synthetic `Logger.Error`.
  """
  @spec from_logger_event(map()) :: map()
  def from_logger_event(%{level: level, msg: msg, meta: meta} = _event) do
    {class, message, stack} = extract(meta, msg, level)

    %{
      "error_class" => class,
      "error_message" => message,
      "error_origin" => "elixir",
      "stack_trace" => Scrubber.scrub_stack(stack),
      "context" => meta |> drop_internal() |> Scrubber.scrub_metadata(),
      "occurred_at" => occurred_at(meta)
    }
  end

  # ---------------------------------------------------------------------------
  # Internals
  # ---------------------------------------------------------------------------

  # Crash reason is the gold standard — both an exception/exit value and
  # a real stack are available.
  defp extract(%{crash_reason: {%kind{} = exception, stacktrace}}, _msg, _level) do
    class = Atom.to_string(kind) |> String.replace_prefix("Elixir.", "")
    message = "** (#{class}) " <> Exception.message(exception)
    stack = format_stack(stacktrace)
    {class, message, stack}
  end

  defp extract(%{crash_reason: {reason, stacktrace}}, _msg, _level) do
    class = "Exit"
    message = "** (exit) " <> inspect(reason, limit: 5)
    stack = format_stack(stacktrace)
    {class, message, stack}
  end

  # No crash_reason — synthetic "Logger.Error" from a bare `Logger.error/1`.
  # We still capture the formatted message; stack will be empty, so the
  # server falls back to the message-only fingerprint path.
  defp extract(_meta, msg, level) do
    class = "Logger.#{level |> to_string() |> String.capitalize()}"
    message = format_msg(msg)
    {class, message, ""}
  end

  defp format_stack(stacktrace) when is_list(stacktrace) do
    Exception.format_stacktrace(stacktrace)
  rescue
    _ -> ""
  end

  defp format_stack(_), do: ""

  defp format_msg({:string, chardata}), do: IO.iodata_to_binary(chardata)

  defp format_msg({format, args}) when is_list(args),
    do: :io_lib.format(format, args) |> IO.iodata_to_binary()

  defp format_msg({:report, report}) when is_map(report), do: inspect(report, limit: 5)
  defp format_msg(other), do: inspect(other, limit: 5)

  # `:logger` events carry plenty of internal book-keeping in `meta`
  # (gl, pid, mfa, file, line, etc.). We strip the noisy ones before
  # the metadata becomes user-visible context. Crash reports also carry
  # `report_cb` (a function) and `callers` (pids): noise, not context.
  @internal ~w(crash_reason gl pid mfa file line module function logger_formatter time report_cb callers)a
  defp drop_internal(meta) when is_map(meta), do: Map.drop(meta, @internal)
  defp drop_internal(_), do: %{}

  defp occurred_at(%{time: t}) when is_integer(t) do
    # `:logger` `:time` is system_time in microseconds.
    DateTime.from_unix!(t, :microsecond) |> DateTime.to_iso8601()
  end

  defp occurred_at(_), do: DateTime.utc_now() |> DateTime.to_iso8601()
end
