import { z } from "zod";

export const eras = ["1970s", "1980s", "1990s", "2000s"] as const;
export const categories = ["news", "storytelling", "novel", "opera"] as const;
export const sourceKinds = ["archive_original", "modern_performance", "ai_reconstruction"] as const;
export const programStatuses = ["draft", "in_review", "published", "offline"] as const;
export const mediaStatuses = ["processing", "ready", "failed"] as const;
export const eventNames = [
  "session_open", "content_impression", "play_attempt", "play_started", "play_blocked",
  "play_error", "play_progress", "play_end", "channel_change", "like_click", "like_set",
  "feedback_impression", "feedback_submit", "share_click", "share_copy", "share_landing"
] as const;

export const eraSchema = z.enum(eras);
export const categorySchema = z.enum(categories);
export const filterEraSchema = z.union([eraSchema, z.literal("all")]);
export const filterCategorySchema = z.union([categorySchema, z.literal("all")]);
export const sourceKindSchema = z.enum(sourceKinds);
export const eventNameSchema = z.enum(eventNames);
export const idSchema = z.string().uuid();
export const requestIdSchema = z.string().min(8).max(128);

export type Era = z.infer<typeof eraSchema>;
export type Category = z.infer<typeof categorySchema>;
export type FilterEra = z.infer<typeof filterEraSchema>;
export type FilterCategory = z.infer<typeof filterCategorySchema>;
export type SourceKind = z.infer<typeof sourceKindSchema>;
export type EventName = z.infer<typeof eventNameSchema>;

export const preferencesSchema = z.object({
  era: filterEraSchema.default("all"),
  category: filterCategorySchema.default("all"),
  tuning_sound_enabled: z.boolean().default(false),
  analytics_enabled: z.boolean().default(false)
});

export const queueCreateSchema = z.object({
  session_id: idSchema,
  request_id: requestIdSchema,
  mode: z.enum(["today", "era"]),
  era: filterEraSchema,
  category: filterCategorySchema
});

export const playbackProgressSchema = z.object({
  seq: z.number().int().min(1),
  cumulative_listen_ms: z.number().int().min(0),
  observed_wall_ms: z.number().int().min(0),
  position_ms: z.number().int().min(0),
  state: z.enum(["playing", "paused", "buffering", "ended"]),
  sampled_at: z.string().datetime()
});

export const eventInputSchema = z.object({
  event_id: idSchema,
  session_id: idSchema,
  playback_id: idSchema.optional(),
  attempt_id: idSchema.optional(),
  name: eventNameSchema,
  client_at: z.string().datetime(),
  payload: z.record(z.string(), z.unknown()).default({})
});

export const apiErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    retryable: z.boolean()
  }),
  request_id: z.string()
});

export const featureFlagsSchema = z.object({
  wechatEnabled: z.boolean(),
  wechatSdkEnabled: z.boolean(),
  tuningSoundEnabled: z.boolean()
});

export type Preferences = z.infer<typeof preferencesSchema>;
export type FeatureFlags = z.infer<typeof featureFlagsSchema>;
