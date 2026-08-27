import { Router, type IRouter } from "express";
import { db, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { RegisterBody, LoginBody, UpdateApiKeyBody, UpdateSttLanguageBody } from "@workspace/api-zod";
import {
  hashPassword,
  verifyPassword,
  createSessionToken,
  destroySessionToken,
  requireAuth,
} from "../lib/auth";
import { encryptApiKey } from "../lib/moderatorCrypto";

const router: IRouter = Router();

function hasApiKey(user: { openaiApiKeyEncrypted: string | null }): boolean {
  return Boolean(user.openaiApiKeyEncrypted);
}

// Must stay in sync with RECOGNITION_LANGUAGES in
// ModeratorChatPanel.tsx -- that's the exact set of languages the picker
// ever sends here.
const ALLOWED_STT_LANGUAGES = [
  "en-US",
  "zh-CN",
  "es-ES",
  "fr-FR",
  "de-DE",
  "ja-JP",
  "ko-KR",
  "hi-IN",
  "pt-BR",
  "ru-RU",
];

router.post("/auth/register", async (req, res) => {
  const parsed = RegisterBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input", details: parsed.error.issues });
    return;
  }
  const { username, password } = parsed.data;
  const apiKey = parsed.data.apiKey.trim();
  if (!apiKey) {
    res.status(400).json({ error: "An OpenAI API key is required" });
    return;
  }

  const existing = await db.query.usersTable.findFirst({
    where: eq(usersTable.username, username),
  });
  if (existing) {
    res.status(409).json({ error: "Username already taken" });
    return;
  }

  const passwordHash = await hashPassword(password);
  const encrypted = encryptApiKey(apiKey);
  const [user] = await db
    .insert(usersTable)
    .values({
      username,
      passwordHash,
      openaiApiKeyEncrypted: encrypted.encryptedApiKey,
      openaiApiKeyIv: encrypted.apiKeyIv,
      openaiApiKeyAuthTag: encrypted.apiKeyAuthTag,
    })
    .returning();

  if (!user) {
    res.status(500).json({ error: "Failed to create user" });
    return;
  }

  const token = createSessionToken(user.id);
  res.status(201).json({
    id: user.id,
    username: user.username,
    token,
    apiKeyConfigured: true,
    sttLanguage: user.sttLanguage,
  });
});

router.post("/auth/login", async (req, res) => {
  const parsed = LoginBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input", details: parsed.error.issues });
    return;
  }
  const { username, password } = parsed.data;

  const user = await db.query.usersTable.findFirst({
    where: eq(usersTable.username, username),
  });
  if (!user || !(await verifyPassword(password, user.passwordHash))) {
    res.status(401).json({ error: "Invalid username or password" });
    return;
  }

  const token = createSessionToken(user.id);
  res.json({
    id: user.id,
    username: user.username,
    token,
    apiKeyConfigured: hasApiKey(user),
    sttLanguage: user.sttLanguage,
  });
});

router.post("/auth/logout", (req, res) => {
  const header = req.headers.authorization;
  if (header?.startsWith("Bearer ")) {
    destroySessionToken(header.slice("Bearer ".length).trim());
  }
  res.status(204).end();
});

router.get("/auth/me", requireAuth, async (req, res) => {
  const user = await db.query.usersTable.findFirst({
    where: eq(usersTable.id, req.userId!),
  });
  if (!user) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }
  res.json({
    id: user.id,
    username: user.username,
    apiKeyConfigured: hasApiKey(user),
    sttLanguage: user.sttLanguage,
  });
});

// Lets a signed-in user view/replace the OpenAI API key on their own
// account. Every project they create uses this key for its AI moderator, so
// this is the one place that key is ever entered after registration.
router.put("/auth/api-key", requireAuth, async (req, res) => {
  const parsed = UpdateApiKeyBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input", details: parsed.error.issues });
    return;
  }
  const apiKey = parsed.data.apiKey.trim();
  if (!apiKey) {
    res.status(400).json({ error: "An OpenAI API key is required" });
    return;
  }

  const encrypted = encryptApiKey(apiKey);
  const [user] = await db
    .update(usersTable)
    .set({
      openaiApiKeyEncrypted: encrypted.encryptedApiKey,
      openaiApiKeyIv: encrypted.apiKeyIv,
      openaiApiKeyAuthTag: encrypted.apiKeyAuthTag,
    })
    .where(eq(usersTable.id, req.userId!))
    .returning();

  if (!user) {
    res.status(500).json({ error: "Failed to update API key" });
    return;
  }
  res.json({
    id: user.id,
    username: user.username,
    apiKeyConfigured: true,
    sttLanguage: user.sttLanguage,
  });
});

// Lets a signed-in user persist which language their own speech-to-text
// recognizer is currently set to. When this account owns a project, the AI
// moderator translates its intervention messages into this language (see
// moderatorEngine.ts).
router.put("/auth/stt-language", requireAuth, async (req, res) => {
  const parsed = UpdateSttLanguageBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input", details: parsed.error.issues });
    return;
  }
  const language = parsed.data.language.trim();
  if (!ALLOWED_STT_LANGUAGES.includes(language)) {
    res.status(400).json({ error: "Unsupported language" });
    return;
  }

  const [user] = await db
    .update(usersTable)
    .set({ sttLanguage: language })
    .where(eq(usersTable.id, req.userId!))
    .returning();

  if (!user) {
    res.status(500).json({ error: "Failed to update language" });
    return;
  }
  res.json({
    id: user.id,
    username: user.username,
    apiKeyConfigured: hasApiKey(user),
    sttLanguage: user.sttLanguage,
  });
});

export default router;
