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

    test "non-map input returns empty map" do
      assert Scrubber.scrub_metadata(nil) == %{}
      assert Scrubber.scrub_metadata("nope") == %{}
    end
  end
end
