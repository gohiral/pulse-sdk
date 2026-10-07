defmodule HiPulse.MixProject do
  use Mix.Project

  @version "0.3.1"
  @source_url "https://github.com/gohiral/pulse-sdk"

  def project do
    [
      app: :hi_pulse,
      version: @version,
      elixir: "~> 1.15",
      elixirc_paths: elixirc_paths(Mix.env()),
      start_permanent: Mix.env() == :prod,
      deps: deps(),
      aliases: aliases(),
      description: "Drop-in feedback widget SDK for hiral apps — posts to a hi_pulse_server.",
      package: package(),
      source_url: @source_url,
      docs: [
        main: "HiPulse",
        source_url: @source_url
      ]
    ]
  end

  def application do
    [
      extra_applications: [:logger],
      mod: {HiPulse.Application, []}
    ]
  end

  def cli do
    [
      preferred_envs: [precommit: :test]
    ]
  end

  defp elixirc_paths(:test), do: ["lib", "test/support"]
  defp elixirc_paths(_), do: ["lib"]

  defp deps do
    [
      # `phoenix_live_view` is `optional: true`: the SDK ships a LiveView
      # function component, but consumer apps already pull LiveView in. Marking
      # it optional keeps non-Phoenix consumers (CLI tools, raw Plug apps) from
      # being forced to drag the LV graph in just to use `HiPulse.Client`.
      {:phoenix_live_view, "~> 1.0", optional: true},
      {:phoenix_html, "~> 4.1", optional: true},
      {:req, "~> 0.5"},
      {:jason, "~> 1.4"},
      # `plug` is a transitive dep of `phoenix_live_view`, but tests need it
      # at compile time as well to use `Plug.Conn` helpers in `Req.Test` stubs.
      {:plug, "~> 1.16"}
    ]
  end

  defp package do
    [
      files: ~w(lib priv .formatter.exs mix.exs README.md),
      maintainers: ["hiral"],
      licenses: ["UNLICENSED"],
      links: %{"GitHub" => @source_url}
    ]
  end

  defp aliases do
    [
      precommit: ["compile --warnings-as-errors", "deps.unlock --unused", "format", "test"]
    ]
  end
end
