import crypto from "node:crypto";
import { and, eq, gt } from "drizzle-orm";
import {
  db,
  moderatorSummariesTable,
  moderatorTranscriptChunksTable,
  moderatorParticipantsTable,
  projectMembersTable,
  projectModeratorTable,
  projectsTable,
  usersTable,
  type ModeratorSummarySegment,
} from "@workspace/db";
import { decryptApiKey } from "./moderatorCrypto";
import { broadcastToProject } from "./wsHub";
import { logger } from "./logger";

const SILENCE_TIMEOUT_MS = 5_000;

// A fresh, unguessable id minted every time a member turns their OWN
// participation on. This -- not any in-memory object identity, and not a
// timestamp -- is the durable source of truth for "which of this member's
// on-periods does this transcript chunk belong to". It's written to
// moderator_participants.activation_id and stamped onto every transcript
// chunk, so it survives a server restart and lets writes be made
// conditional on it directly in the database (see recordTranscriptChunk
// below), closing the check-then-act race a purely in-memory or pre-await
// check can't close.
export function generateActivationId(): string {
  return crypto.randomUUID();
}

// One silence timer per project, shared across every active participant --
// the AI moderator produces one running summary per project (not one per
// person), so "5 seconds since the last chunk from ANYONE currently on"
// is what triggers the next summary attempt.
const silenceTimers = new Map<number, ReturnType<typeof setTimeout>>();

export function clearModeratorSilenceTimer(projectId: number) {
  const timer = silenceTimers.get(projectId);
  if (timer) clearTimeout(timer);
  silenceTimers.delete(projectId);
}

export async function getParticipant(projectId: number, userId: number) {
  return db.query.moderatorParticipantsTable.findFirst({
    where: and(
      eq(moderatorParticipantsTable.projectId, projectId),
      eq(moderatorParticipantsTable.userId, userId),
    ),
  });
}

// Turns the AI moderator on for exactly this member -- never touches any
// other member's row. Upserts since the very first activation for a given
// (project, user) pair has no existing row yet.
export async function activateParticipant(projectId: number, userId: number, activationId: string): Promise<void> {
  const existing = await getParticipant(projectId, userId);
  if (existing) {
    await db
      .update(moderatorParticipantsTable)
      .set({ active: true, activationId, updatedAt: new Date() })
      .where(eq(moderatorParticipantsTable.id, existing.id));
  } else {
    await db.insert(moderatorParticipantsTable).values({ projectId, userId, active: true, activationId });
  }
}

export async function deactivateParticipant(projectId: number, userId: number): Promise<void> {
  await db
    .update(moderatorParticipantsTable)
    .set({ active: false, activationId: null, updatedAt: new Date() })
    .where(
      and(
        eq(moderatorParticipantsTable.projectId, projectId),
        eq(moderatorParticipantsTable.userId, userId),
      ),
    );
}

// Every audio upload re-validates against this member's own DB row as
// ground truth (never a cached in-memory flag) -- so a disable that
// happened moments ago, or a server restart, is always caught.
export async function ensureActiveParticipant(
  projectId: number,
  userId: number,
): Promise<{ activationId: string } | null> {
  const participant = await getParticipant(projectId, userId);
  if (!participant?.active || !participant.activationId) return null;
  return { activationId: participant.activationId };
}

// The moderator always runs on the project CREATOR's saved API key, not
// anything stored on the project itself -- looked up fresh every time
// (transcription, summary generation) rather than cached, so a key update
// from the creator's account takes effect on the very next request.
//
// Projects created before API keys moved to the account level may still
// have a key on their own `project_moderator` row (now deprecated). Rather
// than a schema push silently dropping that data, we lazily migrate it the
// first time it's needed: if the owner has no account key yet but their
// project still has a legacy key, adopt it onto the owner's account (the
// ciphertext is portable as-is -- same AES-256-GCM scheme, same
// SESSION_SECRET-derived key, just relocated to a different row) and clear
// the legacy columns so this only ever runs once per project. If the owner
// already has an account key, or has already adopted a different project's
// legacy key, that key wins and the newer legacy key is left untouched --
// first-migrated-wins, since there is no way to know which of an owner's
// several old per-project keys should take priority.
async function migrateLegacyProjectKeyToOwner(projectId: number, ownerId: number): Promise<void> {
  const owner = await db.query.usersTable.findFirst({ where: eq(usersTable.id, ownerId) });
  if (owner?.openaiApiKeyEncrypted) return; // Owner already has an account key -- nothing to migrate.

  const legacy = await db.query.projectModeratorTable.findFirst({
    where: eq(projectModeratorTable.projectId, projectId),
  });
  if (!legacy?.encryptedApiKey || !legacy.apiKeyIv || !legacy.apiKeyAuthTag) return;

  await db
    .update(usersTable)
    .set({
      openaiApiKeyEncrypted: legacy.encryptedApiKey,
      openaiApiKeyIv: legacy.apiKeyIv,
      openaiApiKeyAuthTag: legacy.apiKeyAuthTag,
    })
    .where(eq(usersTable.id, ownerId));
  await db
    .update(projectModeratorTable)
    .set({ encryptedApiKey: null, apiKeyIv: null, apiKeyAuthTag: null })
    .where(eq(projectModeratorTable.projectId, projectId));
  logger.info({ projectId, ownerId }, "Migrated legacy project-level API key onto owner's account");
}

// Used by the moderator status/enable checks. Takes projectId (not just
// ownerId) so it can also trigger the legacy-key migration above -- a
// project whose creator never visited the new account-key field, but whose
// project still has a legacy migrated key, is treated as configured.
export async function projectOwnerHasApiKey(projectId: number, ownerId: number): Promise<boolean> {
  await migrateLegacyProjectKeyToOwner(projectId, ownerId);
  const owner = await db.query.usersTable.findFirst({ where: eq(usersTable.id, ownerId) });
  return Boolean(owner?.openaiApiKeyEncrypted);
}

export async function getProjectOwnerApiKey(projectId: number): Promise<string | null> {
  const project = await db.query.projectsTable.findFirst({ where: eq(projectsTable.id, projectId) });
  if (!project) return null;

  await migrateLegacyProjectKeyToOwner(projectId, project.ownerId);

  const owner = await db.query.usersTable.findFirst({ where: eq(usersTable.id, project.ownerId) });
  if (!owner?.openaiApiKeyEncrypted || !owner.openaiApiKeyIv || !owner.openaiApiKeyAuthTag) return null;
  try {
    return decryptApiKey({
      encryptedApiKey: owner.openaiApiKeyEncrypted,
      apiKeyIv: owner.openaiApiKeyIv,
      apiKeyAuthTag: owner.openaiApiKeyAuthTag,
    });
  } catch {
    return null;
  }
}

// Persists a transcribed chunk IFF this member is still an active
// participant under the same activationId the caller captured before
// starting the (slow) transcription request. Runs as a single transaction
// with a row lock on this member's participant row, so a concurrent
// disable/re-enable either fully commits before this check (and we
// correctly see the new activationId and reject) or fully commits after
// (and blocks on the lock until we're done) -- there is no interleaving
// where a write can land under a stale activationId. Returns true only if
// the chunk was actually committed. Chunks from members who never turned
// their own participation on are never recorded in the first place (the
// route rejects those uploads before this is ever called), so summaries
// naturally only ever draw on speech from opted-in members.
export async function recordTranscriptChunk(
  projectId: number,
  userId: number,
  text: string,
  activationId: string,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(moderatorParticipantsTable)
      .where(
        and(
          eq(moderatorParticipantsTable.projectId, projectId),
          eq(moderatorParticipantsTable.userId, userId),
        ),
      )
      .for("update");
    if (!current || !current.active || current.activationId !== activationId) {
      return false;
    }
    await tx.insert(moderatorTranscriptChunksTable).values({ projectId, userId, text, activationId });
    return true;
  });
}

// Called only after recordTranscriptChunk has confirmed a durable write for
// some active participant -- so a stale timer is never armed on the
// strength of content that was actually rejected.
export function noteSpeechActivity(projectId: number): void {
  clearModeratorSilenceTimer(projectId);
  const timer = setTimeout(() => {
    silenceTimers.delete(projectId);
    enqueueSummary(projectId);
  }, SILENCE_TIMEOUT_MS);
  silenceTimers.set(projectId, timer);
}

// Two silence periods can legitimately occur close together -- someone
// speaks again just as a summary request is still in flight, then goes
// quiet again before the first one finishes. Without serialization, both
// invocations would read the same `lastSummarizedAt` checkpoint, generate
// overlapping summaries, and race to advance it -- whichever commits last
// can even move it backwards, causing duplicated or dropped content.
// Chaining every summary attempt for a project onto a single promise tail
// guarantees they run one at a time, in order, so each one always reads the
// checkpoint left by the one before it.
const summaryQueues = new Map<number, Promise<void>>();

function enqueueSummary(projectId: number): void {
  const previous = summaryQueues.get(projectId) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(() => generateSummary(projectId));
  summaryQueues.set(projectId, next);
  next
    .catch((err) => {
      logger.error({ err, projectId }, "Moderator summary generation failed unexpectedly");
    })
    .finally(() => {
      // Avoid leaking a growing map entry once nothing else is queued behind us.
      if (summaryQueues.get(projectId) === next) summaryQueues.delete(projectId);
    });
}

async function generateSummary(projectId: number) {
  const config = await db.query.projectModeratorTable.findFirst({
    where: eq(projectModeratorTable.projectId, projectId),
  });
  if (!config) return;

  const apiKey = await getProjectOwnerApiKey(projectId);
  if (!apiKey) return;

  // lastSummarizedAt is a DB column (not in-memory), so this checkpoint
  // survives a restart -- chunks already folded into an earlier summary are
  // never re-sent. It's shared across every participant's chunks: one
  // running summary per project, not per person.
  const sinceClause = config.lastSummarizedAt
    ? gt(moderatorTranscriptChunksTable.createdAt, config.lastSummarizedAt)
    : undefined;

  const newChunks = await db.query.moderatorTranscriptChunksTable.findMany({
    where: and(eq(moderatorTranscriptChunksTable.projectId, projectId), sinceClause),
  });
  if (newChunks.length === 0) return; // Silence with nothing new to say — nothing to summarize.

  const users = await db.query.usersTable.findMany();
  const usernameById = new Map(users.map((u) => [u.id, u.username]));
  const userIdByUsername = new Map(users.map((u) => [u.username, u.id]));

  // Every current project member gets a gauge segment -- not just whoever
  // spoke this round -- so someone who never turned the moderator on (or
  // has gone quiet) still shows up gray rather than vanishing from the dial.
  const members = await db.query.projectMembersTable.findMany({
    where: eq(projectMembersTable.projectId, projectId),
  });

  const transcriptText = newChunks
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
    .map((chunk) => `${usernameById.get(chunk.userId) ?? `User ${chunk.userId}`}: ${chunk.text}`)
    .join("\n");

  const maxCreatedAt = newChunks.reduce(
    (max, c) => (c.createdAt > max ? c.createdAt : max),
    config.lastSummarizedAt ?? new Date(0),
  );

  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: config.model,
        messages: [
          {
            role: "system",
            content:
              "You are an AI moderator for a group ontology-design conversation. Look at the transcript below and identify the SINGLE class and property the speakers are currently discussing in terms of whether it should be retained or removed from the ontology. For every person who spoke, decide whether their stated position argues to RETAIN or to REMOVE that property, and write a short paraphrase (12 words or fewer) of their opinion in their own voice. " +
              'Respond with ONLY a JSON object, no markdown fences, no prose, matching exactly this shape: {"className": string, "propertyName": string, "opinions": [{"username": string, "stance": "retain" | "remove", "opinion": string}]}. ' +
              "Use the exact usernames as they appear as speaker labels in the transcript. Omit anyone whose stance genuinely isn't clear from what they said.",
          },
          { role: "user", content: transcriptText },
        ],
      }),
    });

    if (!response.ok) {
      const body = await response.json().catch(() => null);
      const message =
        (body && typeof body === "object" && "error" in body && (body as any).error?.message) ||
        `OpenAI request failed with status ${response.status}`;
      broadcastToProject(projectId, { type: "moderator_error", message });
      return;
    }

    const data = (await response.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const rawContent = data.choices?.[0]?.message?.content?.trim();
    if (!rawContent) {
      broadcastToProject(projectId, {
        type: "moderator_error",
        message: "OpenAI returned an empty summary.",
      });
      return;
    }

    let parsed: {
      className?: unknown;
      propertyName?: unknown;
      opinions?: unknown;
    };
    try {
      // The model is asked for raw JSON, but strip a stray ```json fence
      // defensively in case it doesn't follow that instruction exactly.
      const cleaned = rawContent.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "");
      parsed = JSON.parse(cleaned);
    } catch {
      broadcastToProject(projectId, {
        type: "moderator_error",
        message: "Could not understand the AI moderator's analysis of the discussion.",
      });
      return;
    }

    const className = typeof parsed.className === "string" ? parsed.className : null;
    const propertyName = typeof parsed.propertyName === "string" ? parsed.propertyName : null;
    const rawOpinions = Array.isArray(parsed.opinions) ? parsed.opinions : [];

    // One entry per opted-in opinion, keyed by userId so it can be merged
    // against the full member list below.
    const opinionByUserId = new Map<number, { stance: "retain" | "remove"; opinion: string }>();
    for (const entry of rawOpinions) {
      if (!entry || typeof entry !== "object") continue;
      const username = (entry as any).username;
      const stance = (entry as any).stance;
      const opinion = (entry as any).opinion;
      if (typeof username !== "string" || (stance !== "retain" && stance !== "remove") || typeof opinion !== "string") {
        continue;
      }
      const userId = userIdByUsername.get(username);
      if (userId === undefined) continue;
      opinionByUserId.set(userId, { stance, opinion });
    }

    // Every current member gets exactly one segment: a real stance if the
    // model identified one for them, otherwise "unknown" -- rendered gray
    // and to the right of the needle regardless of whether that's because
    // they stayed silent this round or never turned the moderator on.
    const segments: ModeratorSummarySegment[] = members.map((member) => {
      const opinion = opinionByUserId.get(member.userId);
      return {
        userId: member.userId,
        username: usernameById.get(member.userId) ?? `User ${member.userId}`,
        colorSlot: member.colorSlot,
        stance: opinion?.stance ?? "unknown",
        opinion: opinion?.opinion ?? null,
      };
    });

    const summaryLabel = className && propertyName ? `${className}.${propertyName}` : "Ontology discussion";

    // Commit the summary and advance the durable checkpoint atomically, and
    // only if the project's moderator config row is still the one we
    // generated this summary for.
    const committed = await db.transaction(async (tx) => {
      const [current] = await tx
        .select()
        .from(projectModeratorTable)
        .where(eq(projectModeratorTable.projectId, projectId))
        .for("update");
      if (!current) return false;
      await tx.insert(moderatorSummariesTable).values({
        projectId,
        summary: summaryLabel,
        className,
        propertyName,
        segments,
      });
      await tx
        .update(projectModeratorTable)
        .set({ lastSummarizedAt: maxCreatedAt })
        .where(eq(projectModeratorTable.projectId, projectId));
      return true;
    });

    if (!committed) return;

    broadcastToProject(projectId, {
      type: "moderator_summary",
      className,
      propertyName,
      segments,
      createdAt: new Date().toISOString(),
    });
  } catch (err) {
    logger.error({ err, projectId }, "Moderator summary request errored");
    broadcastToProject(projectId, {
      type: "moderator_error",
      message: "Could not reach OpenAI to generate a summary.",
    });
  }
}

export async function transcribeAudioChunk(
  apiKey: string,
  audioBuffer: Buffer,
  filename: string,
  mimeType: string,
): Promise<string> {
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(audioBuffer)], { type: mimeType }), filename);
  form.append("model", "whisper-1");

  const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });

  if (!response.ok) {
    const body = await response.json().catch(() => null);
    const message =
      (body && typeof body === "object" && "error" in body && (body as any).error?.message) ||
      `Transcription failed with status ${response.status}`;
    throw new Error(message);
  }

  const data = (await response.json()) as { text?: string };
  return (data.text ?? "").trim();
}
