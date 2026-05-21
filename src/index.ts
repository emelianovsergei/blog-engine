/** Public API of the blog topic-selection engine. */
export { selectWeeklyTopic } from "./orchestrator.js";

export {
  SACRAMENTO_LOCATION,
  HVAC_CATEGORIES,
  HVAC_APPLIANCE_CATEGORIES,
} from "./config.js";

export { openMeteoWeatherClient, classifyAnomaly, buildWeatherContext } from "./weather.js";
export { getSeasonContext, seasonForMonth } from "./season.js";
export { categorizeText, categorizePost, summarizeRecentCategories } from "./categories.js";

export type {
  EngineConfig,
  CategoryDef,
  GeoLocation,
  ExistingPostLike,
  SelectedTopic,
  SelectWeeklyTopicArgs,
  WeatherContext,
  WeatherAnomaly,
  WeatherClient,
  CandidateTopic,
  GeminiLike,
} from "./types.js";
export type { SeasonContext, Season } from "./season.js";
export type { RecentMix } from "./categories.js";
