---
type: "module"
title: "Weather Client"
description: "Fetches regional weather data and detects anomalies like heat waves or cold snaps."
tags: ["weather", "api-client", "anomalies"]
timestamp: "2026-07-05"
sources: ["src/weather.ts"]
---
# Weather Client

Open-Meteo weather client. Both endpoints are free and need no API key. On any failure the client returns an `available: false` context so the engine degrades gracefully to seasonal guidance — it never fails the run.

**Source File**: [weather.ts](file:///home/jaysonlee/Projects/blog-engine/src/weather.ts)

## API Interface

### `classifyAnomaly` (function)
Classifies the week's weather into a single headline anomaly. When several apply, the most editorially notable one wins (smoke > heat > cold > storm).

### `buildWeatherContext` (function)
Builds a `WeatherContext` from already-fetched series — pure, unit-testable. */

### `openMeteoWeatherClient` (const)
Live Open-Meteo weather client (the engine default). */

## Custom Notes

*Add any developer notes, usage examples, or design decisions here. They will be preserved across ingestion runs.*
