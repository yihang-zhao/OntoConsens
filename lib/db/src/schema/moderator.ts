import {
  boolean,
  integer,
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
// interventions. Never shown verbatim on their own -- each one is also
// mirrored into moderatorChatMessagesTable (type "transcript") the moment
// it's recorded, which is what the chat panel actually renders -- but kept
// as rows here (rather than an in-memory buffer) so a server restart
// mid-conversation doesn't silently drop unsummarized speech, and so the
// full-history summarizer below has something durable to re-query.
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
    // Retroactively stamped once a round of the moderator's topic-detection
    // step ties this chunk (among others in that round's window) to a real
    // class+property -- null until then. This is what lets a LATER
    // intervention on the SAME property re-analyze every chunk ever tied to
    // it (old and new) instead of only what's arrived since the last
    // checkpoint: see generateSummary's two-pass design in
    // moderatorEngine.ts. Only ever set once per chunk (never overwritten),
    // so a chunk that happened to get tagged under one property keeps that
    // attribution even if a later round's window drifts to a different one.
    classId: integer("class_id").references(() => ontologyClassesTable.id, {
      onDelete: "set null",
    }),
    propertyId: integer("property_id").references(() => propertiesTable.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
);

export type ModeratorTranscriptChunk =
  typeof moderatorTranscriptChunksTable.$inferSelect;

// The AI moderator's entire visible presence is one ordered log of chat
// messages per project, persisted here so it survives a reload or a member
// rejoining (rather than living only in the WebSocket stream / React
// state):
//   - "intro": the one-time message posted the moment the shared space
//     opens, explaining what the moderator does and that it needs mic
//     access. `userId` is null (it's from the moderator, not a member).
//   - "system": a short first-person-plural announcement about a member's
//     own participation, e.g. "<username> enabled their microphone.
//     Recording started." `userId` identifies that member (for color
//     attribution in the UI).
//   - "transcript": one member's transcribed speech, attributed via
//     `userId`. Visible to every member regardless of their own mic state.
//   - "intervention": a stalled-discussion message. `matched` false means
//     it's a plain reminder that no class/property could be confidently
//     identified; `matched` true means `content` carries the full
//     examples/counterexamples/proposed-by summary, and `classId`/
//     `propertyId`/`className`/`propertyName` identify what it was about.
// A user's own "reject the mic" reminder is deliberately NOT a row here --
// it's a purely local, ephemeral nudge to that one member, not part of the
// shared discussion record.
export type ModeratorChatMessageType =
  | "intro"
  | "system"
  | "transcript"
  | "intervention";

export const moderatorChatMessagesTable = pgTable("moderator_chat_messages", {
  id: serial("id").primaryKey(),
  projectId: integer("project_id")
    .notNull()
    .references(() => projectsTable.id, { onDelete: "cascade" }),
  type: text("type").notNull().$type<ModeratorChatMessageType>(),
  userId: integer("user_id").references(() => usersTable.id, {
    onDelete: "set null",
  }),
  content: text("content").notNull(),
  // Only meaningful for type "intervention" -- see the type-level doc above.
  matched: boolean("matched"),
  className: text("class_name"),
  propertyName: text("property_name"),
  classId: integer("class_id").references(() => ontologyClassesTable.id, {
    onDelete: "set null",
  }),
  propertyId: integer("property_id").references(() => propertiesTable.id, {
    onDelete: "set null",
  }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type ModeratorChatMessage =
  typeof moderatorChatMessagesTable.$inferSelect;
