defmodule HiPulse.ClientTest do
  use ExUnit.Case, async: false

  alias HiPulse.Client

  setup do
    Application.put_env(:hi_pulse, :token, "test-token-abc123")
    Application.put_env(:hi_pulse, :server_url, "https://feedback.test")

    Application.put_env(:hi_pulse, :req_options,
      plug: {Req.Test, HiPulse.Client},
      retry: false
    )

    on_exit(fn ->
      Application.delete_env(:hi_pulse, :token)
      Application.delete_env(:hi_pulse, :server_url)
      Application.delete_env(:hi_pulse, :req_options)
    end)

    :ok
  end

  describe "submit/1" do
    test "happy path — 201 with linear_url" do
      Req.Test.stub(HiPulse.Client, fn conn ->
        # Auth header is forwarded.
        assert ["Bearer test-token-abc123"] = Plug.Conn.get_req_header(conn, "authorization")
        assert conn.method == "POST"
        assert conn.request_path == "/api/v1/events"
        # Request is a multipart form.
        [content_type] = Plug.Conn.get_req_header(conn, "content-type")
        assert content_type =~ "multipart/form-data"

        json_resp(conn, 201, %{
          event_id: "evt-1",
          issue_id: "iss-1",
          linear_url: "https://linear.app/hiral/issue/HI-42"
        })
      end)

      assert {:ok, result} =
               Client.submit(%{
                 title: "Save button broken",
                 description: "Click does nothing",
                 type: "bug",
                 priority: "high",
                 url: "https://app.example.com/x",
                 viewport: %{width: 1440, height: 900},
                 user_agent: "Mozilla/5.0",
                 reporter: %{email: "alice@example.com"}
               })

      assert result.event_id == "evt-1"
      assert result.issue_id == "iss-1"
      assert result.linear_url == "https://linear.app/hiral/issue/HI-42"
    end

    @tag :tmp_dir
    test "sends payload, screenshot and replay as named multipart parts", %{tmp_dir: tmp_dir} do
      replay_path = Path.join(tmp_dir, "session.json.gz")
      File.write!(replay_path, :zlib.gzip("[]"))
      test_pid = self()

      Req.Test.stub(HiPulse.Client, fn conn ->
        send(test_pid, {:params, conn.body_params})
        json_resp(conn, 201, %{event_id: "evt-1", issue_id: "iss-1", linear_url: nil})
      end)

      assert {:ok, _} =
               Client.submit(%{
                 title: "With attachments",
                 type: "bug",
                 screenshot: %{data: "PNGDATA", filename: "shot.png", content_type: "image/png"},
                 replay: {:file, replay_path}
               })

      assert_received {:params, params}
      assert %{"title" => "With attachments"} = Jason.decode!(params["payload"])

      assert %Plug.Upload{filename: "shot.png", content_type: "image/png", path: shot} =
               params["screenshot"]

      assert File.read!(shot) == "PNGDATA"

      assert %Plug.Upload{filename: "session.json.gz", content_type: "application/gzip"} =
               params["replay"]
    end

    test "happy path — 201 with linear_url null is mapped to nil" do
      Req.Test.stub(HiPulse.Client, fn conn ->
        json_resp(conn, 201, %{event_id: "evt-2", issue_id: "iss-2", linear_url: nil})
      end)

      assert {:ok, %{linear_url: nil, event_id: "evt-2"}} =
               Client.submit(%{title: "x", type: "bug"})
    end

    test "401 — bad token" do
      Req.Test.stub(HiPulse.Client, fn conn ->
        json_resp(conn, 401, %{error: "unauthorized"})
      end)

      assert {:error, :unauthorized} = Client.submit(%{title: "x", type: "bug"})
    end

    test "413 — payload too large" do
      Req.Test.stub(HiPulse.Client, fn conn ->
        Plug.Conn.send_resp(conn, 413, "")
      end)

      assert {:error, :payload_too_large} = Client.submit(%{title: "x", type: "bug"})
    end

    test "422 — validation failed surfaces details" do
      Req.Test.stub(HiPulse.Client, fn conn ->
        json_resp(conn, 422, %{
          error: "validation_failed",
          details: %{"title" => ["can't be blank"]}
        })
      end)

      assert {:error, {:validation_failed, %{"title" => ["can't be blank"]}}} =
               Client.submit(%{title: "", type: "bug"})
    end

    test "500 — server error returns status" do
      Req.Test.stub(HiPulse.Client, fn conn ->
        Plug.Conn.send_resp(conn, 500, "boom")
      end)

      assert {:error, {:server_error, 500}} = Client.submit(%{title: "x", type: "bug"})
    end

    test "scrubs nil values before sending" do
      Req.Test.stub(HiPulse.Client, fn conn ->
        {:ok, body, conn} = Plug.Conn.read_body(conn, length: 1_000_000)

        # The multipart body carries a part named `payload` with JSON inside.
        # Find it heuristically — look for the JSON object opening brace.
        assert body =~ ~s("title":"x")
        # `description: nil` should have been stripped, not sent as null.
        refute body =~ ~s("description":null)
        json_resp(conn, 201, %{event_id: "e", issue_id: "i"})
      end)

      assert {:ok, _} = Client.submit(%{title: "x", description: nil, type: "bug"})
    end
  end

  defp json_resp(conn, status, body) do
    conn
    |> Plug.Conn.put_resp_content_type("application/json")
    |> Plug.Conn.send_resp(status, Jason.encode!(body))
  end

  describe "config" do
    test "raises clearly when token is missing" do
      Application.delete_env(:hi_pulse, :token)
      assert_raise RuntimeError, ~r/missing :token config/, fn -> HiPulse.token!() end
    end

    test "server_url defaults to production hosted instance" do
      Application.delete_env(:hi_pulse, :server_url)
      assert HiPulse.server_url() == "https://pulse.hiral.io"
    end
  end
end
