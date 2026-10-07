defmodule HiPulseTest do
  # Mutates :hi_pulse app env, shared with the component tests.
  use ExUnit.Case, async: false

  @secret "hif_secret_test_0123456789abcdef0123456789abcdef"
  @salt "hi_pulse reporter v1"

  setup do
    on_exit(fn -> Application.delete_env(:hi_pulse, :secret) end)
  end

  describe "secret/0" do
    test "returns the configured secret" do
      Application.put_env(:hi_pulse, :secret, @secret)
      assert HiPulse.secret() == @secret
    end

    test "is nil when unset or blank" do
      assert HiPulse.secret() == nil

      Application.put_env(:hi_pulse, :secret, "  ")
      assert HiPulse.secret() == nil

      Application.put_env(:hi_pulse, :secret, nil)
      assert HiPulse.secret() == nil
    end
  end

  describe "reporter_token/1" do
    setup do
      Application.put_env(:hi_pulse, :secret, @secret)
      :ok
    end

    test "signs email and id so the server can verify them with the same secret" do
      token = HiPulse.reporter_token(%{email: "sandra@example.com", id: "user-42"})

      assert {:ok, %{"e" => "sandra@example.com", "i" => "user-42"}} =
               Phoenix.Token.verify(@secret, @salt, token, max_age: 30 * 86_400)
    end

    test "accepts string keys" do
      token = HiPulse.reporter_token(%{"email" => "sandra@example.com", "id" => "user-42"})

      assert {:ok, %{"e" => "sandra@example.com", "i" => "user-42"}} =
               Phoenix.Token.verify(@secret, @salt, token)
    end

    test "signs integer ids as strings" do
      token = HiPulse.reporter_token(%{id: 42})
      assert {:ok, %{"e" => nil, "i" => "42"}} = Phoenix.Token.verify(@secret, @salt, token)
    end

    test "signs an email-only reporter" do
      token = HiPulse.reporter_token(%{email: "sandra@example.com"})

      assert {:ok, %{"e" => "sandra@example.com", "i" => nil}} =
               Phoenix.Token.verify(@secret, @salt, token)
    end

    test "fails verification under another secret" do
      token = HiPulse.reporter_token(%{email: "sandra@example.com"})

      assert {:error, :invalid} =
               Phoenix.Token.verify("hif_secret_other_secret_value_000000000000", @salt, token)
    end

    test "is nil without an email or id" do
      assert HiPulse.reporter_token(%{}) == nil
      assert HiPulse.reporter_token(%{email: "", id: nil}) == nil
      assert HiPulse.reporter_token(%{metadata: %{role: "admin"}}) == nil
      assert HiPulse.reporter_token(nil) == nil
    end

    test "is nil without a secret" do
      Application.delete_env(:hi_pulse, :secret)
      assert HiPulse.reporter_token(%{email: "sandra@example.com"}) == nil
    end
  end
end
