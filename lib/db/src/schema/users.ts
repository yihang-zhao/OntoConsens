import { pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const usersTable = pgTable("users", {
  id: serial("id").primaryKey(),
  username: text("username").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  // The account's own OpenAI API key, stored encrypted (see
  // lib/moderatorCrypto.ts in the api-server) — required at registration
  // going forward, but nullable here so pre-existing rows remain valid.
  // Every project this user creates uses this key for its AI moderator,
  // regardless of which member actually turns the moderator on/off.
  openaiApiKeyEncrypted: text("openai_api_key_encrypted"),
  openaiApiKeyIv: text("openai_api_key_iv"),
  openaiApiKeyAuthTag: text("openai_api_key_auth_tag"),
  // BCP-47 tag for the language this account currently has selected for its
  // own speech-to-text transcription (see RECOGNITION_LANGUAGES in
  // ModeratorChatPanel.tsx -- kept in sync with that same list). Used for
  // more than just running the recognizer client-side: when THIS account
  // owns a project, the AI moderator posts its intervention messages
  // translated into this language (class/property names always stay
  // untranslated -- see moderatorEngine.ts).
  sttLanguage: text("stt_language").notNull().default("en-US"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const insertUserSchema = createInsertSchema(usersTable).omit({
  id: true,
  createdAt: true,
});
export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof usersTable.$inferSelect;
