defmodule HiPulse.Client do
  @moduledoc """
  HTTP client that posts events to a `hi_pulse_server` instance.

  Most consumers don't call this directly — the bundled JS hook submits
  straight from the browser. This module exists for:

    * Server-to-server feedback submission (rare, but supported).
    * Test-mode stubbing via `Req.Test`.
    * A small surface that's easy to introspect from `iex -S mix`.

  ## Wire contract

  See `docs/http-api.md` in the feedback project. In short: a multipart
  POST with three parts (`payload` JSON, optional `screenshot` png,
  optional `replay` gzipped json), authenticated with a bearer token.

  Wire format is **snake_case end-to-end** — the server does not accept
  camelCase fallbacks.

  ## Example

      HiPulse.Client.submit(%{
        title: "Save button does nothing",
        description: "On the funnel editor, ...",
        type: "bug",
        priority: "high",
        url: "https://app.example.com/funnels/42",
        viewport: %{width: 1440, height: 900},
        user_agent: "Mozilla/5.0 ...",
        reporter: %{email: "alice@example.com"},
        context: %{tenant_id: "abc123"}
      })
      #=> {:ok, %{event_id: "...", issue_id: "...", linear_url: nil}}

  Errors:

    * `{:error, :unauthorized}` — bad/missing project token (HTTP 401)
    * `{:error, :payload_too_large}` — multipart body over server limit (HTTP 413)
    * `{:error, {:validation_failed, details}}` — payload schema invalid (HTTP 422)
    * `{:error, {:server_error, status}}` — anything else (HTTP 5xx, etc.)
    * `{:error, exception}` — transport-level error from `Req`

  ## Test stubbing

  In `test_helper.exs`:

      Req.Test.start()
      Application.put_env(:hi_pulse, :token, "test-token")
      Application.put_env(:hi_pulse, :req_options, plug: {Req.Test, HiPulse.Client})

  Then in tests:

      Req.Test.stub(HiPulse.Client, fn conn -> Plug.Conn.send_resp(conn, 201, "...") end)
  """

  require Logger

  @type submission :: %{
          required(:title) => String.t(),
          required(:type) => String.t(),
          optional(:description) => String.t() | nil,
          optional(:priority) => String.t() | nil,
          optional(:url) => String.t() | nil,
          optional(:viewport) => map(),
          optional(:user_agent) => String.t() | nil,
          optional(:console_buffer) => list(map()),
          optional(:context) => map(),
          optional(:reporter) => map(),
          optional(:replay_duration_ms) => integer() | nil,
          optional(:screenshot) => attachment() | nil,
          optional(:replay) => attachment() | nil
        }

  @type attachment ::
          %{
            required(:data) => binary(),
            required(:filename) => String.t(),
            required(:content_type) => String.t()
          }
          | {:file, Path.t()}

  @doc """
  Posts a feedback submission to the configured `hi_pulse_server`.

  See the moduledoc for the supported keys and return shape.
  """
  @spec submit(submission()) ::
          {:ok, %{event_id: String.t(), issue_id: String.t(), linear_url: String.t() | nil}}
          | {:error,
             :unauthorized
             | :payload_too_large
             | {:validation_failed, map()}
             | {:server_error, integer()}
             | Exception.t()}
  def submit(submission) when is_map(submission) do
    {screenshot, submission} = Map.pop(submission, :screenshot)
    {replay, submission} = Map.pop(submission, :replay)

    payload_json = Jason.encode!(scrub(submission))

    # Atom part names and `{name, {value, opts}}` file parts: the one shape
    # every Req version in our `~> 0.5` range accepts (0.6.x rejects
    # string names).
    multipart =
      [payload: payload_json]
      |> append_attachment(:screenshot, screenshot, "screenshot.png", "image/png")
      |> append_attachment(:replay, replay, "replay.json.gz", "application/gzip")

    request_options =
      [
        method: :post,
        url: "/api/v1/events",
        base_url: HiPulse.server_url(),
        headers: [
          {"authorization", "Bearer " <> HiPulse.token!()},
          {"user-agent", "hi_pulse/#{Application.spec(:hi_pulse, :vsn) || "0.0.0"} (elixir)"}
        ],
        form_multipart: multipart,
        compressed: true,
        receive_timeout: 30_000,
        retry: false
      ]
      |> Keyword.merge(Application.get_env(:hi_pulse, :req_options, []))

    request_options
    |> Req.new()
    |> Req.request()
    |> handle_response()
  end

  @doc """
  v2 — submit a single error event to `POST /api/v1/events/error`.

  Used by `HiPulse.ErrorHandler` for Elixir-side `Logger.error` /
  crash dispatch and by integration code that wants to manually report
  an exception. Wraps the entry in a length-1 batch and returns the
  first per-entry result so callers can correlate to the resulting
  event/issue.

  Returns `{:ok, %{accepted: 1, event_id: ..., issue_id: ...}}` on
  success — `event_id`/`issue_id` may be `nil` if the entry was
  rejected by per-entry validation; check `accepted` to distinguish.
  Other errors match `submit/1`.
  """
  @spec submit_error(map()) ::
          {:ok,
           %{
             accepted: non_neg_integer(),
             event_id: String.t() | nil,
             issue_id: String.t() | nil
           }}
          | {:error, term()}
  def submit_error(error_event) when is_map(error_event) do
    case submit_errors([error_event]) do
      {:ok, %{accepted: accepted, results: results}} ->
        first = List.first(results) || %{}

        {:ok,
         %{
           accepted: accepted,
           event_id: first["event_id"],
           issue_id: first["issue_id"]
         }}

      other ->
        other
    end
  end

  @doc """
  v2 — submit a batch of error events. The JS hook bulk-flushes here
  via `navigator.sendBeacon`. Server caps the batch at 100 entries;
  callers that need more should chunk before calling.

  Returns `{:ok, %{accepted, rejected, results}}` mirroring the
  per-entry results from the server.
  """
  @spec submit_errors([map()]) ::
          {:ok,
           %{
             accepted: non_neg_integer(),
             rejected: non_neg_integer(),
             results: [map()]
           }}
          | {:error, term()}
  def submit_errors(error_events) when is_list(error_events) do
    body = %{events: Enum.map(error_events, &scrub/1)}

    request_options =
      [
        method: :post,
        url: "/api/v1/events/error",
        base_url: HiPulse.server_url(),
        headers: [
          {"authorization", "Bearer " <> HiPulse.token!()},
          {"content-type", "application/json"},
          {"user-agent", "hi_pulse/#{Application.spec(:hi_pulse, :vsn) || "0.0.0"} (elixir)"}
        ],
        json: body,
        compressed: true,
        receive_timeout: 30_000,
        retry: false
      ]
      |> Keyword.merge(Application.get_env(:hi_pulse, :req_options, []))

    request_options
    |> Req.new()
    |> Req.request()
    |> handle_error_response()
  end

  defp handle_error_response({:ok, %Req.Response{status: status, body: body}})
       when status in 200..299 do
    {:ok,
     %{
       accepted: Map.get(body, "accepted", 0),
       rejected: Map.get(body, "rejected", 0),
       results: Map.get(body, "results", [])
     }}
  end

  defp handle_error_response(response), do: handle_response(response)

  defp append_attachment(parts, _key, nil, _filename, _content_type), do: parts

  defp append_attachment(
         parts,
         key,
         %{data: data, filename: filename, content_type: ctype},
         _f,
         _c
       )
       when is_binary(data) do
    parts ++ [{key, {data, filename: filename, content_type: ctype}}]
  end

  defp append_attachment(parts, key, {:file, path}, default_filename, default_content_type) do
    case File.read(path) do
      {:ok, data} ->
        parts ++
          [
            {key,
             {data,
              filename: Path.basename(path) || default_filename,
              content_type: default_content_type}}
          ]

      {:error, reason} ->
        Logger.error("[hi-pulse] could not read #{key} file at #{path}: #{inspect(reason)}")
        parts
    end
  end

  defp handle_response({:ok, %Req.Response{status: status, body: body}})
       when status in 200..299 do
    {:ok,
     %{
       event_id: Map.get(body, "event_id"),
       issue_id: Map.get(body, "issue_id"),
       linear_url: Map.get(body, "linear_url")
     }}
  end

  defp handle_response({:ok, %Req.Response{status: 401}}), do: {:error, :unauthorized}
  defp handle_response({:ok, %Req.Response{status: 413}}), do: {:error, :payload_too_large}

  defp handle_response({:ok, %Req.Response{status: 422, body: body}}) do
    details =
      case body do
        %{"details" => details} when is_map(details) -> details
        _ -> %{}
      end

    {:error, {:validation_failed, details}}
  end

  defp handle_response({:ok, %Req.Response{status: status}}) do
    Logger.error("[hi-pulse] server returned status #{status}")
    {:error, {:server_error, status}}
  end

  defp handle_response({:error, exception}) do
    Logger.error("[hi-pulse] transport error: #{inspect(exception)}")
    {:error, exception}
  end

  # Drop nil values so the wire payload stays compact and we don't ship
  # bogus `null` fields that trip up server-side validation.
  defp scrub(map) when is_map(map) do
    map
    |> Enum.reject(fn {_k, v} -> v == nil end)
    |> Enum.into(%{})
  end
end
