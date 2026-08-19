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
  DIMENSION_LABELS,
  buildVerifiedFacts,
  parseReviewResult,
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

export {
  DEFAULT_RUBRIC_CONSTRAINTS,
  RUBRIC_RULES,
  writerRubricRules,
  plannerRubricRules,
  reviewerRubric,
  checkArticleBody,
} from "./rubric.js";
export type {
  RubricConstraints,
  RubricRule,
  RubricAudience,
  RubricViolation,
} from "./rubric.js";

export {
  auditLinks,
  unlinkDeadUrls,
  auditAndRepairFile,
} from "./link-audit.js";
export type {
  LinkPolicy,
  LinkCheckResult,
  CheckLinkOptions,
  CheckLinksOptions,
  ExtractLinksOptions,
} from "./links.js";
export type { LinkAuditResult, AuditLinksOptions, FileAudit } from "./link-audit.js";

export { unlinkUrl, stripDeadCitations, repairContent } from "./link-repair.js";

export {
  fetchAutocomplete,
  fetchAutocompleteResult,
  buildSeedQueries,
  headTerm,
  isRelevantSuggestion,
  DEFAULT_SUGGESTION_DENYLIST,
  expandSeedQueries,
} from "./suggest.js";
export { researchKeywords, keywordGuidance, DEFAULT_KEYWORD_MODEL } from "./keywords.js";
export { scoreDemand, toSearchQuery } from "./demand.js";
export {
  loadGscSignal,
  fetchSearchAnalytics,
  parseServiceAccountJson,
  buildJwtAssertion,
  findOpportunities,
  mergeDemand,
} from "./gsc.js";

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
export type { FetchLike, SuggestOutcome, SeedQuery, SeedKind } from "./suggest.js";
export type {
  KeywordResearch,
  ResearchKeywordsArgs,
  SearchIntent,
  DemandSignal,
  KeywordProvenance,
} from "./keywords.js";
export type { DemandResult, ScoreDemandArgs, CandidateDemand } from "./demand.js";
export type {
  GscCredentials,
  GscQueryRow,
  GscSignal,
  GscStatus,
  OpportunityQuery,
  MergedDemand,
  LoadGscSignalArgs,
} from "./gsc.js";
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
