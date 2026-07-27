---
type: "module"
title: "Weather Client"
description: "Fetches regional weather data and detects anomalies like heat waves or cold snaps."
tags: ["weather", "api-client", "anomalies"]
timestamp: "2026-07-27"
sources: ["src/weather.ts"]
source_hash: "ff00740637d506e4"
---
# Weather Client

Open-Meteo weather client. Both endpoints are free and need no API key. On any failure the client returns an `available: false` context so the engine degrades gracefully to seasonal guidance — it never fails the run.

**Source File**: [src/weather.ts](file:///home/jaysonlee/Projects/blog-engine/src/weather.ts)

## Related

- [[modules/types]]

## API Interface

### `classifyAnomaly`
Classifies the week's weather into a single headline anomaly. When several apply, the most editorially notable one wins (smoke > heat > cold > storm).

### `buildWeatherContext`
Builds a `WeatherContext` from already-fetched series — pure, unit-testable.

### `openMeteoWeatherClient`
Live Open-Meteo weather client (the engine default).

## Custom Notes

*Add any developer notes, usage examples, or design decisions here. They will be preserved across ingestion runs.*
