import { Router, type IRouter } from "express";
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
  generateActivationId,
  getParticipant,
  getProjectOwnerApiKey,
  listChatMessages,
  postRecordingStartedMessage,
  postRecordingStoppedMessage,
  projectOwnerHasApiKey,
} from "../lib/moderatorEngine";

const router: IRouter = Router();

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

  const user = await db.query.usersTable.findFirst({ where: eq(usersTable.id, userId) });
  await postRecordingStoppedMessage(projectId, userId, user?.username ?? "A member");

  res.json({ active: false, configured: await projectOwnerHasApiKey(projectId, project.ownerId) });
});

// Transcription itself now happens server-side, over the project WebSocket
// (see wsHub's "mic_start"/"mic_stop"/binary-audio handling and
// realtimeTranscription.ts, which calls recordTranscriptChunk directly as
// OpenAI's Realtime API finalizes each utterance) -- there is no longer a
// REST endpoint for a client to submit a finalized transcript itself.

export default router;
