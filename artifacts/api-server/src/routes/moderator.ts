import { Router, type IRouter } from "express";
import multer from "multer";
import { and, eq } from "drizzle-orm";
import {
  db,
  projectModeratorTable,
  projectsTable,
  projectMembersTable,
  usersTable,
} from "@workspace/db";
import { requireAuth } from "../lib/auth";
import { broadcastToProject } from "../lib/wsHub";
import {
  activateParticipant,
  deactivateParticipant,
  ensureActiveParticipant,
  generateActivationId,
  getParticipant,
  getProjectOwnerApiKey,
  listChatMessages,
  postRecordingStartedMessage,
  projectOwnerHasApiKey,
  recordTranscriptChunk,
  noteSpeechActivity,
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

// Every member decides for THEMSELVES whether the AI moderator listens to
// them -- there is no project-wide on/off anymore. This endpoint always
// reports the CURRENT user's own participation state, never anyone else's.
router.get("/projects/:id/moderator", async (req, res) => {
  const userId = req.userId!;
  const projectId = Number(req.params.id);

  const membership = await getMembership(projectId, userId);
  if (!membership) {
    res.status(403).json({ error: "You are not a member of this project" });
    return;
  }

  const project = await db.query.projectsTable.findFirst({ where: eq(projectsTable.id, projectId) });
  const participant = await getParticipant(projectId, userId);
  res.json({
    active: participant?.active ?? false,
    configured: project ? await projectOwnerHasApiKey(projectId, project.ownerId) : false,
  });
});

router.put("/projects/:id/moderator", async (req, res) => {
  const userId = req.userId!;
  const projectId = Number(req.params.id);
  const model = typeof req.body?.model === "string" && req.body.model.trim() ? req.body.model.trim() : undefined;

  const membership = await getMembership(projectId, userId);
  if (!membership) {
    res.status(403).json({ error: "You are not a member of this project" });
    return;
  }

  const project = await db.query.projectsTable.findFirst({ where: eq(projectsTable.id, projectId) });
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  if (!(await projectOwnerHasApiKey(projectId, project.ownerId))) {
    res.status(400).json({
      error: "The project creator hasn't saved an OpenAI API key yet. Ask them to add one from the dashboard.",
    });
    return;
  }

  // A shared row holds the project's model choice/summary checkpoint; it's
  // created lazily the first time ANYONE on the project turns their own
  // participation on.
  const existingConfig = await db.query.projectModeratorTable.findFirst({
    where: eq(projectModeratorTable.projectId, projectId),
  });
  if (!existingConfig) {
    await db.insert(projectModeratorTable).values({ projectId, ...(model ? { model } : {}) });
  } else if (model) {
    await db
      .update(projectModeratorTable)
      .set({ model, updatedAt: new Date() })
      .where(eq(projectModeratorTable.projectId, projectId));
  }

  // A fresh activationId is this member's own durable session identity --
  // it guards recordTranscriptChunk against a race where they toggle off
  // then on again while an earlier transcription request is still in
  // flight, but it never affects any other member's on/off state.
  const activationId = generateActivationId();
  await activateParticipant(projectId, userId, activationId);

  const user = await db.query.usersTable.findFirst({ where: eq(usersTable.id, userId) });
  await postRecordingStartedMessage(projectId, userId, user?.username ?? "A member");

  res.json({ active: true, configured: true });
});

// Full persisted chat history for this project -- visible to every
// member regardless of their own mic state, so a reload/rejoin renders the
// exact same transcript/intervention/system messages already broadcast
// live over the socket.
router.get("/projects/:id/moderator/messages", async (req, res) => {
  const userId = req.userId!;
  const projectId = Number(req.params.id);

  const membership = await getMembership(projectId, userId);
  if (!membership) {
    res.status(403).json({ error: "You are not a member of this project" });
    return;
  }

  const messages = await listChatMessages(projectId);
  res.json({ messages });
});

router.post("/projects/:id/moderator/disable", async (req, res) => {
  const userId = req.userId!;
  const projectId = Number(req.params.id);

  const membership = await getMembership(projectId, userId);
  if (!membership) {
    res.status(403).json({ error: "You are not a member of this project" });
    return;
  }

  const project = await db.query.projectsTable.findFirst({ where: eq(projectsTable.id, projectId) });
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  await deactivateParticipant(projectId, userId);
  res.json({ active: false, configured: await projectOwnerHasApiKey(projectId, project.ownerId) });
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

  // ensureActiveParticipant re-validates against the DB row every time
  // (not a cached in-memory flag), so a disable that happened while this
  // upload was still in flight (or a server restart) is always caught.
  const active = await ensureActiveParticipant(projectId, userId);
  if (!active) {
    res.status(403).json({ error: "You have not turned on the AI moderator for yourself" });
    return;
  }

  const apiKey = await getProjectOwnerApiKey(projectId);
  if (!apiKey) {
    res.status(400).json({ error: "The project creator hasn't saved an OpenAI API key" });
    return;
  }

  try {
    const text = await transcribeAudioChunk(apiKey, file.buffer, file.originalname || "chunk.webm", file.mimetype);
    if (!text) {
      res.status(204).end();
      return;
    }

    // recordTranscriptChunk performs the "is this member's participation
    // still current" check and the insert as one row-locked transaction, so
    // a disable that happened while we were waiting on OpenAI can't land
    // this recording under a period this member never consented to.
    const committed = await recordTranscriptChunk(projectId, userId, text, active.activationId);
    if (!committed) {
      res.status(409).json({ error: "Your AI moderator session changed while transcribing; please try again." });
      return;
    }

    // Only armed once we know the chunk actually landed -- never on the
    // strength of a write that was rejected.
    noteSpeechActivity(projectId);
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
