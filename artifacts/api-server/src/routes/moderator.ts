import { Router, type IRouter } from "express";
import multer from "multer";
import { and, eq } from "drizzle-orm";
import {
  db,
  projectModeratorTable,
  projectsTable,
  projectMembersTable,
} from "@workspace/db";
import { requireAuth } from "../lib/auth";
import { encryptApiKey, decryptApiKey } from "../lib/moderatorCrypto";
import { broadcastToProject } from "../lib/wsHub";
import {
  activateModeratorSession,
  clearModeratorSession,
  ensureActiveSession,
  generateActivationId,
  hasMicOptIn,
  noteSpeechActivity,
  recordMicOptIn,
  recordTranscriptChunk,
  transcribeAudioChunk,
} from "../lib/moderatorEngine";

const router: IRouter = Router();
const upload = multer({ limits: { fileSize: 10 * 1024 * 1024 } });

router.use(requireAuth);

async function getMembership(projectId: number, userId: number) {
  return db.query.projectMembersTable.findFirst({
    where: and(
      eq(projectMembersTable.projectId, projectId),
      eq(projectMembersTable.userId, userId),
    ),
  });
}

router.get("/projects/:id/moderator", async (req, res) => {
  const userId = req.userId!;
  const projectId = Number(req.params.id);

  const membership = await getMembership(projectId, userId);
  if (!membership) {
    res.status(403).json({ error: "You are not a member of this project" });
    return;
  }

  const config = await db.query.projectModeratorTable.findFirst({
    where: eq(projectModeratorTable.projectId, projectId),
  });
  res.json({
    enabled: config?.enabled ?? false,
    configured: Boolean(config?.encryptedApiKey),
  });
});

router.put("/projects/:id/moderator", async (req, res) => {
  const userId = req.userId!;
  const projectId = Number(req.params.id);
  const apiKey = typeof req.body.apiKey === "string" ? req.body.apiKey.trim() : "";
  const model = typeof req.body.model === "string" && req.body.model.trim() ? req.body.model.trim() : undefined;

  const project = await db.query.projectsTable.findFirst({ where: eq(projectsTable.id, projectId) });
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  if (project.ownerId !== userId) {
    res.status(403).json({ error: "Only the project creator can configure the AI moderator" });
    return;
  }
  if (!apiKey) {
    res.status(400).json({ error: "An OpenAI API key is required" });
    return;
  }

  const encrypted = encryptApiKey(apiKey);
  const existing = await db.query.projectModeratorTable.findFirst({
    where: eq(projectModeratorTable.projectId, projectId),
  });

  // A fresh activationId is the durable (DB-persisted) identity of this
  // session. Every later write (opt-in tracking, transcript chunks,
  // summaries) is checked against it, so a disable/re-enable — or a server
  // restart that later recreates the in-memory mirror — can never let stale
  // content or consent leak into whatever activation is live at write time.
  const activationId = generateActivationId();
  const activatedAt = new Date();
  if (existing) {
    await db
      .update(projectModeratorTable)
      .set({
        enabled: true,
        ...encrypted,
        ...(model ? { model } : {}),
        activationId,
        lastSummarizedAt: null,
        updatedAt: activatedAt,
      })
      .where(eq(projectModeratorTable.projectId, projectId));
  } else {
    await db.insert(projectModeratorTable).values({
      projectId,
      enabled: true,
      ...encrypted,
      ...(model ? { model } : {}),
      activationId,
      updatedAt: activatedAt,
    });
  }

  // Replace any prior in-memory session (including mic opt-ins) synchronously
  // so consent from a previous or pre-activation session can never carry
  // over into this one — opting in only ever means "yes, for the session
  // that's live right now".
  activateModeratorSession(projectId, activationId);
  broadcastToProject(projectId, { type: "moderator_activated" });
  res.json({ enabled: true, configured: true });
});

router.post("/projects/:id/moderator/disable", async (req, res) => {
  const userId = req.userId!;
  const projectId = Number(req.params.id);

  const project = await db.query.projectsTable.findFirst({ where: eq(projectsTable.id, projectId) });
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  if (project.ownerId !== userId) {
    res.status(403).json({ error: "Only the project creator can configure the AI moderator" });
    return;
  }

  // Clearing the stored key (not just flipping enabled off) means re-enabling
  // always asks for the key again — there's no separate "rotate key" screen,
  // so this is the one point where a stale/no-longer-wanted key stops being
  // retained at all.
  await db
    .update(projectModeratorTable)
    .set({
      enabled: false,
      encryptedApiKey: null,
      apiKeyIv: null,
      apiKeyAuthTag: null,
      activationId: null,
      lastSummarizedAt: null,
      updatedAt: new Date(),
    })
    .where(eq(projectModeratorTable.projectId, projectId));

  clearModeratorSession(projectId);
  broadcastToProject(projectId, { type: "moderator_deactivated" });
  res.json({ enabled: false, configured: false });
});

router.post("/projects/:id/moderator/mic-opt-in", async (req, res) => {
  const userId = req.userId!;
  const projectId = Number(req.params.id);

  const membership = await getMembership(projectId, userId);
  if (!membership) {
    res.status(403).json({ error: "You are not a member of this project" });
    return;
  }

  // ensureActiveSession lazily recreates the session after a server restart
  // (still requiring a fresh opt-in) instead of leaving an enabled project
  // stuck with no way to opt in until the owner reconfigures it.
  const active = await ensureActiveSession(projectId);
  if (!active) {
    res.status(400).json({ error: "The AI moderator is not active for this project" });
    return;
  }

  recordMicOptIn(active.session, userId);
  res.status(204).end();
});

router.post("/projects/:id/moderator/audio", upload.single("audio"), async (req, res) => {
  const userId = req.userId!;
  const projectId = Number(req.params.id);
  const file = req.file;

  const membership = await getMembership(projectId, userId);
  if (!membership) {
    res.status(403).json({ error: "You are not a member of this project" });
    return;
  }
  if (!file) {
    res.status(400).json({ error: "Audio file is required" });
    return;
  }

  const active = await ensureActiveSession(projectId);
  if (!active) {
    res.status(400).json({ error: "The AI moderator is not active for this project" });
    return;
  }
  const { session, activationId } = active;
  if (!hasMicOptIn(session, userId)) {
    res.status(403).json({ error: "You have not enabled your microphone for the AI moderator" });
    return;
  }

  const config = await db.query.projectModeratorTable.findFirst({
    where: eq(projectModeratorTable.projectId, projectId),
  });
  if (
    !config ||
    !config.enabled ||
    config.activationId !== activationId ||
    !config.encryptedApiKey ||
    !config.apiKeyIv ||
    !config.apiKeyAuthTag
  ) {
    res.status(400).json({ error: "The AI moderator is not active for this project" });
    return;
  }

  let apiKey: string;
  try {
    apiKey = decryptApiKey({
      encryptedApiKey: config.encryptedApiKey,
      apiKeyIv: config.apiKeyIv,
      apiKeyAuthTag: config.apiKeyAuthTag,
    });
  } catch {
    res.status(500).json({ error: "Could not read the stored API key" });
    return;
  }

  try {
    const text = await transcribeAudioChunk(apiKey, file.buffer, file.originalname || "chunk.webm", file.mimetype);
    if (!text) {
      res.status(204).end();
      return;
    }

    // The transcription call can take a while; recordTranscriptChunk
    // performs the "is this activation still current" check and the insert
    // as one row-locked database transaction, so a disable/re-enable that
    // happened while we were waiting on OpenAI can't land this recording in
    // (or alongside) a session it was never actually consented to — the
    // write itself is conditional on the activation in the database, not
    // just a pre-await in-memory check.
    const committed = await recordTranscriptChunk(projectId, userId, text, activationId);
    if (!committed) {
      res.status(409).json({ error: "The AI moderator session changed while transcribing; please try again." });
      return;
    }

    // Only armed once we know the chunk actually landed under this
    // activation — never on the strength of a write that was rejected.
    noteSpeechActivity(projectId, session);
    res.status(204).end();
  } catch (err) {
    broadcastToProject(projectId, {
      type: "moderator_error",
      message: err instanceof Error ? err.message : "Transcription failed",
    });
    res.status(502).json({ error: "Transcription failed" });
  }
});

export default router;
