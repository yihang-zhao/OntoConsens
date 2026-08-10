import {
  boolean,
  integer,
  pgTable,
  serial,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";
import { projectsTable } from "./projects";
import { usersTable } from "./users";

// One row per project: project-wide moderator settings/checkpoint. The
// OpenAI API key used to run it belongs to the project's CREATOR account
// (see users.ts / lib/moderatorCrypto.ts in the api-server), not this table.
// Whether the moderator is actually capturing anyone right now is tracked
// per-user in moderatorParticipantsTable below -- each member turns their
// own participation on/off independently; this row just holds the shared
// model choice and the shared summarization checkpoint.
export const projectModeratorTable = pgTable("project_moderator", {
  id: serial("id").primaryKey(),
  projectId: integer("project_id")
    .notNull()
    .unique()
    .references(() => projectsTable.id, { onDelete: "cascade" }),
  // Exact model id to use for the summarization step. Configurable per
  // project rather than hardcoded, since it's the creator's own key/account
  // and they may not have access to every model id.
  model: text("model").notNull().default("gpt-5.6-luna"),
  // DEPRECATED — legacy per-project key, from before API keys moved to the
  // account level. No longer written by new code. Kept only so existing
  // rows created before this migration keep working: the api-server reads
  // this as a one-time fallback and copies it onto the project owner's
  // account (users.openaiApiKey*) the first time it's needed, so production
  // data is never silently dropped by a schema push. Safe to remove in a
  // future migration once no rows have these columns populated.
  encryptedApiKey: text("encrypted_api_key"),
  apiKeyIv: text("api_key_iv"),
  apiKeyAuthTag: text("api_key_auth_tag"),
  // Durable checkpoint: chunks created at or before this timestamp have
  // already been folded into a summary. Persisted (not just in-memory) so a
  // restart never re-sends already-summarized content. Shared across all
  // participants' chunks -- one running summary per project, not per user.
  lastSummarizedAt: timestamp("last_summarized_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type ProjectModerator = typeof projectModeratorTable.$inferSelect;

// Per-user opt-in state: each member turns the AI moderator on/off for
// THEMSELVES only, independent of every other member -- there is no
// project-wide on/off anymore. "On" means both "listen to my mic" and
// "include my speech in summaries" at once; there is no separate mic-consent
// step in this app, since the browser's own microphone permission prompt
// already handles first-time consent, and re-prompts if the user revokes it.
export const moderatorParticipantsTable = pgTable(
  "moderator_participants",
  {
    id: serial("id").primaryKey(),
    projectId: integer("project_id")
      .notNull()
      .references(() => projectsTable.id, { onDelete: "cascade" }),
    userId: integer("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    active: boolean("active").notNull().default(false),
    // Regenerated every time this user turns their own participation on.
    // Guards recordTranscriptChunk against a race where this user quickly
    // toggles off then on again while a transcription request for the
    // earlier "on" period is still in flight -- that chunk must not land
    // under the new period.
    activationId: text("activation_id"),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [unique().on(table.projectId, table.userId)],
);

export type ModeratorParticipant =
  typeof moderatorParticipantsTable.$inferSelect;

// Raw speech-to-text chunks, tagged by speaker, accumulated between
// summaries. Never shown verbatim to users — only fed into the periodic AI
// summary — but kept as rows (rather than an in-memory buffer) so a server
// restart mid-conversation doesn't silently drop unsummarized speech.
export const moderatorTranscriptChunksTable = pgTable(
  "moderator_transcript_chunks",
  {
    id: serial("id").primaryKey(),
    projectId: integer("project_id")
      .notNull()
      .references(() => projectsTable.id, { onDelete: "cascade" }),
    userId: integer("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    text: text("text").notNull(),
    // Which activation (see projectModeratorTable.activationId) this chunk
    // was recorded under. Lets summary generation scope its query to
    // exactly the current session instead of relying on timestamps, and
    // lets a conditional write reject a chunk whose session ended mid
    // transcription.
    activationId: text("activation_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
);

export type ModeratorTranscriptChunk =
  typeof moderatorTranscriptChunksTable.$inferSelect;

export const moderatorSummariesTable = pgTable("moderator_summaries", {
  id: serial("id").primaryKey(),
  projectId: integer("project_id")
    .notNull()
    .references(() => projectsTable.id, { onDelete: "cascade" }),
  summary: text("summary").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type ModeratorSummary = typeof moderatorSummariesTable.$inferSelect;
