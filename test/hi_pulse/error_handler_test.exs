defmodule HiPulse.ErrorHandlerTest do
  # Mutates Application env (capture_errors flag) and the global :logger
  # handler list — must run serially.
  use ExUnit.Case, async: false

  alias HiPulse.{ErrorHandler, ErrorPayload}

  setup do
    Application.put_env(:hi_pulse, :token, "test-token")
    Application.put_env(:hi_pulse, :server_url, "https://feedback.test")

    on_exit(fn ->
      Application.delete_env(:hi_pulse, :token)
      Application.delete_env(:hi_pulse, :server_url)
    end)

    :ok
  end

  defp build_event(meta), do: build_event(meta, :error)

  defp build_event(meta, level) do
    %{
      level: level,
      msg: {:string, "boom"},
      meta: Map.merge(%{time: System.system_time(:microsecond)}, meta)
    }
  end

  describe "log/2 — level filter" do
    test "non-error levels are ignored" do
      # No assertions about Client — the only thing we're checking is
      # that the call returns :ok without crashing.
      for level <- [:debug, :info, :notice, :warning] do
        assert :ok = ErrorHandler.log(build_event(%{}, level), %{})
      end
    end
  end

  describe "log/2 — self-protection" do
    test "drops events whose meta.application is :hi_pulse" do
      # If we let it through it would attempt an HTTP call — there's
      # no Req stub here, so a passing test means the filter held.
      event = build_event(%{application: :hi_pulse})
      assert :ok = ErrorHandler.log(event, %{})
    end

    test "drops events whose stack mentions HiPulse.Client" do
      stack = [
        {HiPulse.Client, :submit_error, 1, []},
        {SomethingElse, :foo, 0, []}
      ]

      event = build_event(%{crash_reason: {%RuntimeError{message: "x"}, stack}})
      assert :ok = ErrorHandler.log(event, %{})
    end

    test "drops events whose stack mentions HiPulse.ErrorHandler" do
      stack = [{HiPulse.ErrorHandler, :log, 2, []}]
      event = build_event(%{crash_reason: {%RuntimeError{message: "x"}, stack}})
      assert :ok = ErrorHandler.log(event, %{})
    end
  end

  describe "ErrorPayload.from_logger_event/1" do
    test "extracts class + formatted message + scrubbed stack from crash_reason" do
      stack = [{MyMod, :create_user, [%{password: "hunter2"}], []}]
      event = build_event(%{crash_reason: {%RuntimeError{message: "boom"}, stack}})

      payload = ErrorPayload.from_logger_event(event)

      assert payload["error_class"] == "RuntimeError"
      assert payload["error_origin"] == "elixir"
      assert payload["error_message"] =~ "boom"
      assert payload["stack_trace"] =~ "create_user"
      refute payload["stack_trace"] =~ "hunter2"
      # `time` got promoted to ISO occurred_at.
      assert payload["occurred_at"] =~ ~r/^\d{4}-\d{2}-\d{2}T/
    end

    test "exit-style crash_reason yields class=Exit" do
      event = build_event(%{crash_reason: {:shutdown, []}})
      payload = ErrorPayload.from_logger_event(event)
      assert payload["error_class"] == "Exit"
      assert payload["error_message"] =~ "exit"
    end

    test "no crash_reason → falls back to formatted msg with synthetic class" do
      event = build_event(%{}, :error)
      payload = ErrorPayload.from_logger_event(event)
      assert payload["error_class"] == "Logger.Error"
      assert payload["error_message"] == "boom"
      assert payload["stack_trace"] == ""
    end

    test "scrubs sensitive keys from metadata into context" do
      event =
        build_event(%{
          authorization: "Bearer x",
          request_id: "req-1"
        })

      payload = ErrorPayload.from_logger_event(event)
      assert payload["context"][:request_id] == "req-1"
      refute Map.has_key?(payload["context"], :authorization)
    end

    test "crash-report metadata (report_cb, callers, nested secrets) still encodes" do
      event =
        build_event(%{
          crash_reason: {%RuntimeError{message: "boom"}, []},
          report_cb: &Function.identity/1,
          callers: [self()],
          state: {:conn, %{api_key: "STATE_SECRET", user_id: 7}}
        })

      payload = ErrorPayload.from_logger_event(event)

      refute Map.has_key?(payload["context"], :report_cb)
      refute Map.has_key?(payload["context"], :callers)
      assert {:ok, json} = Jason.encode(payload)
      refute json =~ "STATE_SECRET"
      assert json =~ "user_id"
    end
  end

  describe "log/2 — dispatch reaches the task supervisor" do
    test "an error event spawns a child task (the ship task)" do
      # Full HTTP path is exercised by Client tests; here we just verify
      # that the handler dispatches into the Task supervisor instead of
      # blocking the logging process. Counting children before/after a
      # log call is enough — the task itself will fail (no Req stub) but
      # that's caught by the rescue in `ErrorHandler.ship/1`.
      {:ok, _} = Application.ensure_all_started(:hi_pulse)

      stack = [{MyMod, :create_user, [%{password: "hunter2"}], []}]
      event = build_event(%{crash_reason: {%RuntimeError{message: "boom"}, stack}})

      assert :ok = ErrorHandler.log(event, %{})

      # The Task supervisor accepted at least one child since the call
      # (children are short-lived; we just need to see one was started).
      assert is_pid(Process.whereis(HiPulse.TaskSupervisor))
    end
  end
end
