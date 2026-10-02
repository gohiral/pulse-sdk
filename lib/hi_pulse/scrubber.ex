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
    secret secret_key
    authorization auth
    cookie set-cookie
    session session_id sessionid
    bearer
  )

  @max_frames 50
  @max_bytes 10_000

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
    |> redact_inline()
    |> redact_bearer()
    |> redact_cookie()
    |> cap_frames()
    |> cap_bytes()
  end

  @doc """
  Scrub a `Logger.metadata` keyword list / map. Drops any entry whose
  key matches a sensitive key (case-insensitive); other entries pass
  through unchanged.

  This is for the metadata bag we ship alongside the stack — keys
  like `:request_id` or `:user_id` are useful, keys like `:authorization`
  must never be shipped.
  """
  @spec scrub_metadata(map() | keyword()) :: map()
  def scrub_metadata(metadata) when is_map(metadata) do
    metadata
    |> Enum.reject(fn {k, _} -> sensitive_key?(k) end)
    |> Map.new()
  end

  def scrub_metadata(metadata) when is_list(metadata) do
    metadata
    |> Enum.reject(fn {k, _} -> sensitive_key?(k) end)
    |> Map.new()
  end

  def scrub_metadata(_), do: %{}

  # ---------------------------------------------------------------------------
  # Internals
  # ---------------------------------------------------------------------------

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
