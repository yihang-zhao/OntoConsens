import {
  boolean,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";
import { ontologyClassesTable } from "./ontology";
import { propertiesTable } from "./properties";
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

// One row per project member, for every summary round: the raw material
// for the retain/remove gauge. Members who spoke and took a clear position
// carry stance "retain"/"remove" plus a short paraphrase of what they said;
// everyone else (silent this round, or the AI moderator isn't on for them
// at all) carries stance "unknown" with a null opinion, which the UI always
// renders as a gray segment on the "disagree" side of the needle.
export interface ModeratorSummarySegment {
  userId: number;
  username: string;
  colorSlot: number;
  stance: "retain" | "remove" | "unknown";
  opinion: string | null;
}

export const moderatorSummariesTable = pgTable("moderator_summaries", {
  id: serial("id").primaryKey(),
  projectId: integer("project_id")
    .notNull()
    .references(() => projectsTable.id, { onDelete: "cascade" }),
  // Short human-readable label for this round (e.g. "Person.hasEmail") --
  // kept mainly for admin/debug visibility; the UI renders the structured
  // fields below rather than this string.
  summary: text("summary").notNull(),
  // The class and property the AI determined the transcript was actually
  // discussing this round, in terms of whether to retain or remove it.
  // These are always the CANONICAL label/name of a class/property that
  // genuinely exists in this project's shared workspace right now -- never
  // raw, unverified model output. Null (with `matched` false) whenever the
  // model couldn't confidently tie the discussion to one specific
  // class+property actually present in the workspace; in that case the UI
  // shows a text reminder instead of a visualization.
  className: text("class_name"),
  propertyName: text("property_name"),
  classId: integer("class_id").references(() => ontologyClassesTable.id, {
    onDelete: "set null",
  }),
  propertyId: integer("property_id").references(() => propertiesTable.id, {
    onDelete: "set null",
  }),
  matched: boolean("matched").notNull().default(false),
  segments: jsonb("segments").$type<ModeratorSummarySegment[]>(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type ModeratorSummary = typeof moderatorSummariesTable.$inferSelect;
