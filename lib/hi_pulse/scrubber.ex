defmodule HiPulse.Scrubber do
  @moduledoc """
  Redact sensitive values out of formatted stack traces and metadata
  before they leave the process.

  Elixir's `Exception.format_stacktrace/1` includes function arguments
  for `:crash_reason` events, which means `MyMod.create_user(%{password:
  "hunter2"})` ends up in the stack as plaintext. Without scrubbing,
  that text would land in the feedback server, in the linked Linear
  issue, in screen-shares, in saved transcripts. This module is the
  one place we make sure that doesn't happen.

  Approach is conservative — we redact *values* but keep keys, so the
  scrubbed stack still tells you which fields were involved. Rules:

    * Inline `key: "value"` and `key: <atom>` get replaced with `key:
      "[REDACTED]"` for any key in `@sensitive_keys`.
    * Inline JSON-style `"key": "value"` (browsers / JS-side stacks)
      gets the same treatment.
    * Bearer / cookie / authorization header captures (e.g. `Bearer
      lin_api_xxx`, `Cookie: session=...`) are scrubbed regardless of
      surrounding format.
    * After scrubbing, the result is hard-capped to 50 frames or
      10_000 bytes, whichever comes first. Bounded payloads keep the
      ingest endpoint and Linear comments from blowing up on enormous
      stacks.

  Pure functions; safe to call from any process.
  """

  @sensitive_keys ~w(
    password password_hash passwd
    token access_token refresh_token id_token
    api_key apikey api-secret
    secret secret_key secret_key_base client_secret private_key
    authorization auth
    cookie set-cookie
    session session_id sessionid
    bearer
  )

  @max_frames 50
  @max_bytes 10_000
  @max_depth 4
  @max_items 50
  @redacted "[REDACTED]"

  @doc """
  Scrub a formatted stack-trace string.

  Returns a redacted, bounded copy of the input. Nil or empty input
  returns `""`.
  """
  @spec scrub_stack(binary() | nil) :: binary()
  def scrub_stack(nil), do: ""
  def scrub_stack(""), do: ""

  def scrub_stack(text) when is_binary(text) do
    text
    |> redact()
    |> cap_frames()
    |> cap_bytes()
  end

  @doc """
  Scrub a `Logger.metadata` keyword list / map into a JSON-encodable map.
  Top-level entries whose key matches a sensitive key (case-insensitive)
  are dropped; other entries are kept, with their values scrubbed:

    * nested maps, structs and `{key, value}` pairs (keyword lists,
      header lists) keep sensitive keys but get `"[REDACTED]"` values;
    * strings go through the same inline / Bearer / Cookie redaction
      as stacks;
    * a `Plug.Conn` is reduced to method, host, path and status;
    * tuples become lists so their contents are scrubbed too; only
      opaque terms (pids, refs, funs, ports) are `inspect`ed;
    * nesting is capped at #{@max_depth} levels and #{@max_items} items
      per map or list.

  This is for the metadata bag we ship alongside the stack — keys
  like `:request_id` or `:user_id` are useful, keys like `:authorization`
  must never be shipped. Crash metadata carries arbitrary runtime terms
  (GenServer state, last messages), so every level is scrubbed, and the
  result is always JSON-encodable so the event is never dropped.
  """
  @spec scrub_metadata(map() | keyword()) :: map()
  def scrub_metadata(metadata) when is_map(metadata) or is_list(metadata) do
    metadata
    |> Enum.reject(fn {k, _} -> sensitive_key?(k) end)
    |> Enum.take(@max_items)
    |> Map.new(fn {k, v} -> {json_key(k), json_safe(v, 1)} end)
  end

  def scrub_metadata(_), do: %{}

  # ---------------------------------------------------------------------------
  # Internals
  # ---------------------------------------------------------------------------

  defp json_safe(_value, depth) when depth > @max_depth, do: "[…]"

  defp json_safe(value, _depth) when is_binary(value) do
    if String.valid?(value), do: value |> redact() |> cap_bytes(), else: "[binary]"
  end

  defp json_safe(value, _depth) when is_number(value) or is_atom(value), do: value

  defp json_safe(%mod{} = value, _depth) when mod in [Date, Time, NaiveDateTime, DateTime],
    do: to_string(value)

  # A conn carries cookies under their own names and the endpoint's
  # secret_key_base; keep only what identifies the request.
  defp json_safe(%{__struct__: Plug.Conn} = conn, _depth),
    do: Map.take(conn, [:method, :host, :request_path, :status])

  defp json_safe(%{__exception__: true} = value, depth),
    do: value |> Exception.message() |> json_safe(depth)

  defp json_safe(%_{} = value, depth), do: value |> Map.from_struct() |> json_safe(depth)

  defp json_safe(value, depth) when is_map(value) do
    value
    |> Enum.take(@max_items)
    |> Map.new(fn {k, v} -> {json_key(k), json_safe_value(k, v, depth)} end)
  end

  defp json_safe({k, v}, depth), do: [json_safe(k, depth + 1), json_safe_value(k, v, depth)]

  defp json_safe(value, depth) when is_tuple(value),
    do: value |> Tuple.to_list() |> json_safe(depth)

  defp json_safe(value, depth) when is_list(value) do
    if proper_list?(value),
      do: value |> Enum.take(@max_items) |> Enum.map(&json_safe(&1, depth + 1)),
      else: "[improper list]"
  end

  # Pids, references, functions, ports.
  defp json_safe(value, _depth), do: inspect(value)

  defp json_safe_value(key, value, depth) do
    if sensitive_key?(key), do: @redacted, else: json_safe(value, depth + 1)
  end

  defp json_key(key) when is_atom(key), do: key

  defp json_key(key) when is_binary(key) do
    if String.valid?(key), do: key, else: "[binary]"
  end

  defp json_key(key), do: key |> inspect() |> redact()

  defp proper_list?([]), do: true
  defp proper_list?([_ | tail]), do: proper_list?(tail)
  defp proper_list?(_), do: false

  defp redact(text), do: text |> redact_inline() |> redact_bearer() |> redact_cookie()

  # Build one regex per call rather than at compile time so the union of
  # sensitive keys can grow without juggling module attrs.
  defp redact_inline(text) do
    keys_alt =
      @sensitive_keys
      |> Enum.map(&Regex.escape/1)
      |> Enum.join("|")

    # Matches:
    #   - Elixir map/struct/keyword:  key: "..."  /  key: '...'  /  key: <atom>
    #   - JSON / JS object:           "key": "..."  /  "key": '...'
    #
    # Captures the key portion in group 1 and replaces the whole match
    # with `<key>: "[REDACTED]"`.
    pattern = ~r/(?<key>"?(?:#{keys_alt})"?)\s*[:=]\s*(?:"[^"]*"|'[^']*'|:[A-Za-z0-9_]+)/i

    Regex.replace(pattern, text, fn _, key -> "#{key}: \"[REDACTED]\"" end)
  end

  defp redact_bearer(text) do
    Regex.replace(~r/Bearer\s+[A-Za-z0-9._\-+\/=]+/i, text, "Bearer [REDACTED]")
  end

  defp redact_cookie(text) do
    # Cookie / Set-Cookie header values (and anything quoted that follows
    # one). Conservative: only the value portion until the next space or
    # newline is redacted, so we don't over-redact surrounding context.
    Regex.replace(~r/(Cookie|Set-Cookie)\s*:\s*[^\r\n]+/i, text, "\\1: [REDACTED]")
  end

  defp cap_frames(text) do
    text
    |> String.split("\n")
    |> Enum.take(@max_frames)
    |> Enum.join("\n")
  end

  defp cap_bytes(text) do
    case byte_size(text) do
      n when n <= @max_bytes -> text
      _ -> binary_part(text, 0, @max_bytes) <> "\n…[truncated]"
    end
  end

  defp sensitive_key?(k) when is_atom(k), do: sensitive_key?(Atom.to_string(k))

  defp sensitive_key?(k) when is_binary(k) do
    lower = String.downcase(k)
    Enum.any?(@sensitive_keys, &(&1 == lower))
  end

  defp sensitive_key?(_), do: false
end
