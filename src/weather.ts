/**
 * Open-Meteo weather client. Both endpoints are free and need no API key.
 * On any failure the client returns an `available: false` context so the
 * engine degrades gracefully to seasonal guidance — it never fails the run.
 */
import type { GeoLocation, WeatherAnomaly, WeatherClient, WeatherContext } from "./types.js";

const FORECAST_URL = "https://api.open-meteo.com/v1/forecast";
const AIR_QUALITY_URL = "https://air-quality-api.open-meteo.com/v1/air-quality";

// Sacramento-tuned anomaly thresholds.
const HEAT_WAVE_F = 100;
const COLD_SNAP_F = 35;
const SMOKE_AQI = 100;
const STORM_PRECIP_MM = 25; // ~1 inch of rain in a day

interface ForecastResponse {
  daily?: {
    temperature_2m_max?: Array<number | null>;
    temperature_2m_min?: Array<number | null>;
    precipitation_sum?: Array<number | null>;
  };
}

interface AirQualityResponse {
  hourly?: { us_aqi?: Array<number | null> };
}

/**
 * Classifies the week's weather into a single headline anomaly. When several
 * apply, the most editorially notable one wins (smoke > heat > cold > storm).
 */
export function classifyAnomaly(
  maxes: number[],
  mins: number[],
  precip: number[],
  maxAqi: number | null,
): WeatherAnomaly {
  if (maxAqi !== null && maxAqi >= SMOKE_AQI) return "wildfire-smoke";
  if (maxes.filter((t) => t >= HEAT_WAVE_F).length >= 2) return "heat-wave";
  if (mins.filter((t) => t <= COLD_SNAP_F).length >= 2) return "cold-snap";
  if (precip.some((p) => p >= STORM_PRECIP_MM)) return "storm";
  return "none";
}

const ANOMALY_NOTE: Record<WeatherAnomaly, string> = {
  "wildfire-smoke":
    "Wildfire smoke is degrading air quality this week — indoor air quality, " +
    "filtration, and keeping smoke out of the home are timely concerns.",
  "heat-wave":
    "A heat wave is in the forecast — cooling performance, system strain, and " +
    "staying comfortable through extreme heat are timely concerns.",
  "cold-snap":
    "A cold snap is in the forecast — heating performance, system strain in the " +
    "cold, and avoiding no-heat emergencies are timely concerns.",
  storm:
    "A significant storm is in the forecast — weather-related system protection " +
    "and post-storm checks are timely concerns.",
  none: "No notable weather extremes this week — follow seasonal guidance.",
};

function numbersOnly(values: Array<number | null> | undefined): number[] {
  return (values ?? []).filter((n): n is number => typeof n === "number");
}

async function getJson<T>(url: string, timeoutMs = 8000): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

/** Builds a `WeatherContext` from already-fetched series — pure, unit-testable. */
export function buildWeatherContext(
  maxes: number[],
  mins: number[],
  precip: number[],
  aqiValues: number[],
): WeatherContext {
  const maxTempF = maxes.length ? Math.round(Math.max(...maxes)) : null;
  const minTempF = mins.length ? Math.round(Math.min(...mins)) : null;
  const maxAqi = aqiValues.length ? Math.round(Math.max(...aqiValues)) : null;
  const anomaly = classifyAnomaly(maxes, mins, precip, maxAqi);

  const parts = [
    maxTempF !== null ? `7-day high ${maxTempF}°F` : null,
    minTempF !== null ? `low ${minTempF}°F` : null,
    maxAqi !== null ? `peak AQI ${maxAqi}` : null,
  ].filter(Boolean);

  return {
    anomaly,
    summary: `${parts.length ? `${parts.join(", ")}. ` : ""}${ANOMALY_NOTE[anomaly]}`,
    maxTempF,
    minTempF,
    maxAqi,
    available: true,
  };
}

const UNAVAILABLE: WeatherContext = {
  anomaly: "none",
  summary: "Live weather data was unavailable; rely on seasonal context.",
  maxTempF: null,
  minTempF: null,
  maxAqi: null,
  available: false,
};

/** Live Open-Meteo weather client (the engine default). */
export const openMeteoWeatherClient: WeatherClient = {
  async fetchWeather(location: GeoLocation): Promise<WeatherContext> {
    const { latitude, longitude, timezone } = location;
    const base = `latitude=${latitude}&longitude=${longitude}&timezone=${encodeURIComponent(
      timezone,
    )}`;
    try {
      const [forecast, air] = await Promise.all([
        getJson<ForecastResponse>(
          `${FORECAST_URL}?${base}` +
            "&daily=temperature_2m_max,temperature_2m_min,precipitation_sum" +
            "&temperature_unit=fahrenheit&forecast_days=7",
        ),
        // Air quality is best-effort — a smoke signal is nice-to-have, not required.
        getJson<AirQualityResponse>(
          `${AIR_QUALITY_URL}?${base}&hourly=us_aqi&forecast_days=3`,
        ).catch(() => ({ hourly: {} }) as AirQualityResponse),
      ]);

      return buildWeatherContext(
        numbersOnly(forecast.daily?.temperature_2m_max),
        numbersOnly(forecast.daily?.temperature_2m_min),
        numbersOnly(forecast.daily?.precipitation_sum),
        numbersOnly(air.hourly?.us_aqi),
      );
    } catch {
      return UNAVAILABLE;
    }
  },
};
