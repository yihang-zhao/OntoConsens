import {
  boolean,
  integer,
  pgTable,
  serial,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { projectsTable } from "./projects";
import { usersTable } from "./users";

// One row per project, created lazily the first time the owner configures
// the moderator. The API key is stored encrypted (see lib/moderatorCrypto.ts
// in the api-server) — this table never holds the key in plaintext, and no
// route ever returns it once saved.
export const projectModeratorTable = pgTable("project_moderator", {
  id: serial("id").primaryKey(),
  projectId: integer("project_id")
    .notNull()
    .unique()
    .references(() => projectsTable.id, { onDelete: "cascade" }),
  enabled: boolean("enabled").notNull().default(false),
  // Exact model id to use for the summarization step. Configurable per
  // project rather than hardcoded, since it's the creator's own key/account
  // and they may not have access to every model id.
  model: text("model").notNull().default("gpt-5.6-luna"),
  encryptedApiKey: text("encrypted_api_key"),
  apiKeyIv: text("api_key_iv"),
  apiKeyAuthTag: text("api_key_auth_tag"),
  // Identity of the current "session" (one continuous enabled period),
  // regenerated every time the moderator is (re)enabled. This is the
  // durable source of truth for which transcript chunks/mic opt-ins belong
  // to the live session — a DB column rather than in-memory state, so a
  // server restart or a concurrent disable/re-enable can be detected and
  // guarded against even mid-request (see moderatorEngine.ts).
  activationId: text("activation_id"),
  // Durable checkpoint: chunks created at or before this timestamp for the
  // current activationId have already been folded into a summary. Persisted
  // (not just in-memory) so a restart never re-sends already-summarized
  // content, and reset to null on every fresh activation.
  lastSummarizedAt: timestamp("last_summarized_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type ProjectModerator = typeof projectModeratorTable.$inferSelect;

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
