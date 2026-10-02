defmodule HiPulse.ScrubberTest do
  use ExUnit.Case, async: true

  alias HiPulse.Scrubber

  describe "scrub_stack/1" do
    test "redacts elixir-style sensitive keyword args" do
      stack = """
          (myapp 1.0.0) lib/users.ex:42: MyApp.Users.create(%{password: "hunter2", email: "alice@example.com"})
      """

      out = Scrubber.scrub_stack(stack)
      refute out =~ "hunter2"
      assert out =~ ~s(password: "[REDACTED]")
      assert out =~ "alice@example.com"
    end

    test "redacts JSON-style sensitive keys (JS / browser stacks)" do
      stack = ~s|some.js:1: error {"token": "abc.def.ghi", "user_id": 42}|
      out = Scrubber.scrub_stack(stack)
      refute out =~ "abc.def.ghi"
      assert out =~ ~s("token": "[REDACTED]")
      assert out =~ "42"
    end

    test "redacts Bearer tokens regardless of surrounding format" do
      stack = "headers: Authorization: Bearer lin_api_xxxxxxxxxxxx_yyyy and stuff"
      out = Scrubber.scrub_stack(stack)
      refute out =~ "lin_api_xxxxxxxxxxxx_yyyy"
      assert out =~ "Bearer [REDACTED]"
    end

    test "redacts Cookie / Set-Cookie header values" do
      stack = "Cookie: session=abc123; csrf=xyz\nnext frame here"
      out = Scrubber.scrub_stack(stack)
      refute out =~ "abc123"
      refute out =~ "xyz"
      assert out =~ "Cookie: [REDACTED]"
      # Surrounding context preserved.
      assert out =~ "next frame here"
    end

    test "leaves non-sensitive args untouched" do
      stack = "lib/x.ex:1: A.b(%{user_id: 42, build: \"abc123\"})"
      assert Scrubber.scrub_stack(stack) == stack
    end

    test "caps frames to 50" do
      stack = Enum.map(1..200, fn i -> "frame #{i}" end) |> Enum.join("\n")
      out = Scrubber.scrub_stack(stack)
      assert length(String.split(out, "\n")) == 50
    end

    test "caps total bytes around 10kB" do
      stack = String.duplicate("a", 30_000)
      out = Scrubber.scrub_stack(stack)
      assert byte_size(out) <= 10_000 + 20
      assert out =~ "[truncated]"
    end

    test "nil/empty input returns empty string" do
      assert Scrubber.scrub_stack(nil) == ""
      assert Scrubber.scrub_stack("") == ""
    end
  end

  describe "scrub_metadata/1" do
    test "drops sensitive keys, keeps the rest" do
      out = Scrubber.scrub_metadata(%{request_id: "abc", password: "x", user_id: 7})
      assert out == %{request_id: "abc", user_id: 7}
    end

    test "case-insensitive key matching" do
      out = Scrubber.scrub_metadata(%{"Authorization" => "Bearer x", "trace_id" => "y"})
      assert out == %{"trace_id" => "y"}
    end

    test "accepts keyword lists" do
      out = Scrubber.scrub_metadata(token: "x", role: "admin")
      assert out == %{role: "admin"}
    end

    test "redacts sensitive keys at every level, keeps their names" do
      out =
        Scrubber.scrub_metadata(%{
          request: %{user_id: 7, api_key: "NESTED_SECRET", inner: %{"Token" => "DEEP_SECRET"}},
          headers: [{"authorization", "HEADER_SECRET"}, {"accept", "text/html"}],
          opts: [password: "KEYWORD_SECRET", retries: 3]
        })

      assert out.request.user_id == 7
      assert out.request.api_key == "[REDACTED]"
      assert out.request.inner == %{"Token" => "[REDACTED]"}
      assert out.headers == [["authorization", "[REDACTED]"], ["accept", "text/html"]]
      assert out.opts == [[:password, "[REDACTED]"], [:retries, 3]]
    end

    test "tuples and structs are scrubbed, not inspected" do
      out =
        Scrubber.scrub_metadata(%{
          request: {:credentials, %{token: "TUPLE_SECRET"}},
          error: %RuntimeError{message: "oops token: \"EXC_SECRET\""},
          uri: URI.parse("https://example.com/path")
        })

      assert out.request == [:credentials, %{token: "[REDACTED]"}]
      assert out.error == ~s(oops token: "[REDACTED]")
      assert out.uri.host == "example.com"
    end

    test "a Plug.Conn is reduced to what identifies the request" do
      conn = %{
        __struct__: Plug.Conn,
        method: "GET",
        host: "example.com",
        request_path: "/x",
        status: 500,
        req_cookies: %{"_app_key" => "COOKIE_SECRET"},
        secret_key_base: "SKB_SECRET"
      }

      out = Scrubber.scrub_metadata(%{conn: conn})

      assert out.conn == %{method: "GET", host: "example.com", request_path: "/x", status: 500}
    end

    test "strings get the stack scrubber's text redaction" do
      out =
        Scrubber.scrub_metadata(%{last_message: "call with Bearer abc.def and token: \"STR\""})

      assert out.last_message =~ "Bearer [REDACTED]"
      refute out.last_message =~ "abc.def"
      refute out.last_message =~ "STR"
    end

    test "output is JSON-encodable for opaque runtime terms" do
      out =
        Scrubber.scrub_metadata(%{
          {:tuple, :key} => 1,
          pid: self(),
          ref: make_ref(),
          fun: fn -> :ok end,
          at: ~U[2026-10-02 12:00:00Z],
          raw: <<255, 0>>,
          improper: [1 | 2]
        })

      assert {:ok, _} = Jason.encode(out)
      assert out.pid =~ "#PID<"
      assert out.at == "2026-10-02 12:00:00Z"
      assert out.raw == "[binary]"
      assert out.improper == "[improper list]"
    end

    test "caps nesting depth and collection size" do
      deep = Enum.reduce(1..10, "leaf", fn _, acc -> %{n: acc} end)
      out = Scrubber.scrub_metadata(%{deep: deep, long: Enum.to_list(1..100)})

      refute inspect(out) =~ "leaf"
      assert length(out.long) == 50
    end

    test "non-map input returns empty map" do
      assert Scrubber.scrub_metadata(nil) == %{}
      assert Scrubber.scrub_metadata("nope") == %{}
    end
  end
end
