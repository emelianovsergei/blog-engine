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

export {
  reviewBlogPost,
  renderReviewMarkdown,
  DEFAULT_REVIEW_MODEL,
  DEFAULT_GATE,
} from "./review.js";
export { rewriteBlogPost, DEFAULT_REWRITE_MODEL } from "./rewrite.js";

export { claudeAdapter, createClaudeClient } from "./anthropic.js";
export { grokAdapter, createGrokClient, generateGrokImage, XaiHttpError } from "./xai.js";
export { createModelClient, createCompositeClient, isTransientError } from "./client.js";

export {
  assertTopicAligned,
  topicAlignmentIssue,
  topicLockPlannerRules,
  writerAccuracyRules,
} from "./planning.js";

export {
  EMPTY_LINK_POLICY,
  parseLinkPolicy,
  policyViolation,
  extractLinks,
  checkLink,
  checkLinks,
  citationGuidance,
} from "./links.js";
export type {
  LinkPolicy,
  LinkCheckResult,
  CheckLinkOptions,
  CheckLinksOptions,
} from "./links.js";

export { unlinkUrl, stripDeadCitations, repairContent } from "./link-repair.js";

export { fetchAutocomplete, expandSeedQueries } from "./suggest.js";
export { researchKeywords, DEFAULT_KEYWORD_MODEL } from "./keywords.js";
export { scoreDemand, toSearchQuery } from "./demand.js";

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
export type {
  AnthropicLike,
  AnthropicMessage,
  AnthropicContentBlock,
  AnthropicCreateRequest,
  ClaudeAdapterOptions,
} from "./anthropic.js";
export type {
  XaiLike,
  XaiChatRequest,
  XaiChatResponse,
  GrokAdapterOptions,
  GrokImageOptions,
} from "./xai.js";
export type { CompositeClientOptions } from "./client.js";
export type { FetchLike } from "./suggest.js";
export type { KeywordResearch, ResearchKeywordsArgs, SearchIntent } from "./keywords.js";
export type { DemandResult, ScoreDemandArgs } from "./demand.js";
export type { SeasonContext, Season } from "./season.js";
export type { RecentMix } from "./categories.js";
export type {
  ReviewResult,
  ReviewIssue,
  DimensionScore,
  ReviewDimension,
  ReviewGate,
  ReviewBlogPostArgs,
  BlogPostFrontmatter,
} from "./review.js";
export type { RewriteBlogPostArgs, RewriteResult } from "./rewrite.js";
