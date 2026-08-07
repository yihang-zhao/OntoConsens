import crypto from "node:crypto";
import { and, eq, gt } from "drizzle-orm";
import {
  db,
  moderatorSummariesTable,
  moderatorTranscriptChunksTable,
  projectModeratorTable,
  projectsTable,
  usersTable,
} from "@workspace/db";
import { decryptApiKey } from "./moderatorCrypto";
import { broadcastToProject } from "./wsHub";
import { logger } from "./logger";

const SILENCE_TIMEOUT_MS = 5_000;

// A fresh, unguessable id minted every time the moderator is (re)enabled.
// This — not any in-memory object identity, and not a timestamp — is the
// durable source of truth for "which session does this content belong to".
// It's written to project_moderator.activation_id and stamped onto every
// transcript chunk, so it survives a server restart and lets writes be made
// conditional on it directly in the database (see recordTranscriptChunk /
// commitSummary below), closing the check-then-act race a purely in-memory
// or pre-await check can't close.
export function generateActivationId(): string {
  return crypto.randomUUID();
}

// Local mirror of the mic opt-ins for the CURRENT activation, kept in memory
// purely as a fast pre-check (avoids a DB round trip on every opt-in check).
// It is never itself the authority for whether content gets persisted —
// every write that matters re-validates against project_moderator.activation_id
// in the database at write time.
interface ModeratorSession {
  activationId: string;
  silenceTimer: ReturnType<typeof setTimeout> | null;
  micOptedInUserIds: Set<number>;
}

const sessions = new Map<number, ModeratorSession>();

function createSession(activationId: string): ModeratorSession {
  return { activationId, silenceTimer: null, micOptedInUserIds: new Set() };
}

// Called synchronously (no `await` in between) right after the DB write that
// turns the moderator on with a fresh activationId, replacing any prior
// session outright.
export function activateModeratorSession(projectId: number, activationId: string) {
  const prev = sessions.get(projectId);
  if (prev?.silenceTimer) clearTimeout(prev.silenceTimer);
  sessions.set(projectId, createSession(activationId));
}

// Called when the moderator is turned off (or the project is deleted) so a
// stale timer doesn't fire a summary for a session nobody is in anymore.
export function clearModeratorSession(projectId: number) {
  const session = sessions.get(projectId);
  if (session?.silenceTimer) clearTimeout(session.silenceTimer);
  sessions.delete(projectId);
}

// Every request that needs "the active session" goes through here. It always
// reads the DB's activationId and treats that as ground truth: if there's no
// in-memory session yet (first request since a restart) or the in-memory one
// is for a stale activationId (a disable/re-enable happened since we last
// looked), it (re)creates the in-memory mirror with an EMPTY opt-in set —
// consent never carries across an activation boundary, whether that boundary
// was crossed by an explicit reconfigure or by a restart.
export async function ensureActiveSession(
  projectId: number,
): Promise<{ session: ModeratorSession; activationId: string } | null> {
  const config = await db.query.projectModeratorTable.findFirst({
    where: eq(projectModeratorTable.projectId, projectId),
  });
  if (!config?.enabled || !config.activationId) return null;

  const existing = sessions.get(projectId);
  if (existing && existing.activationId === config.activationId) {
    return { session: existing, activationId: config.activationId };
  }

  const session = createSession(config.activationId);
  sessions.set(projectId, session);
  return { session, activationId: config.activationId };
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
// project still has last migrated key, is treated as configured.
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

export function recordMicOptIn(session: ModeratorSession, userId: number) {
  session.micOptedInUserIds.add(userId);
}

export function hasMicOptIn(session: ModeratorSession, userId: number): boolean {
  return session.micOptedInUserIds.has(userId);
}

// Persists a transcribed chunk IFF the moderator is still enabled under the
// same activationId the caller captured before starting the (slow)
// transcription request. This runs as a single transaction with a row lock
// on the config row, so a concurrent disable/re-enable either fully commits
// before this check (and we correctly see the new activationId and reject)
// or fully commits after (and blocks on the lock until we're done) — there
// is no interleaving where a write can land under a stale activationId.
// Returns true only if the chunk was actually committed.
export async function recordTranscriptChunk(
  projectId: number,
  userId: number,
  text: string,
  activationId: string,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(projectModeratorTable)
      .where(eq(projectModeratorTable.projectId, projectId))
      .for("update");
    if (!current || !current.enabled || current.activationId !== activationId) {
      return false;
    }
    await tx.insert(moderatorTranscriptChunksTable).values({ projectId, userId, text, activationId });
    return true;
  });
}

// Called only after recordTranscriptChunk has confirmed a durable write
// under the still-current activation — so a stale session's timer is never
// armed on the strength of content that was actually rejected.
export function noteSpeechActivity(projectId: number, session: ModeratorSession) {
  if (session.silenceTimer) clearTimeout(session.silenceTimer);
  session.silenceTimer = setTimeout(() => {
    session.silenceTimer = null;
    enqueueSummary(projectId, session.activationId);
  }, SILENCE_TIMEOUT_MS);
}

// Two silence periods can legitimately occur close together — someone speaks
// again just as a summary request is still in flight, then goes quiet again
// before the first one finishes. Without serialization, both invocations
// would read the same `lastSummarizedAt` checkpoint, generate overlapping
// summaries, and race to advance it — whichever commits last can even move
// it backwards, causing duplicated or dropped content. Chaining every
// summary attempt for a project onto a single promise tail guarantees they
// run one at a time, in order, so each one always reads the checkpoint left
// by the one before it.
const summaryQueues = new Map<number, Promise<void>>();

function enqueueSummary(projectId: number, activationId: string): void {
  const previous = summaryQueues.get(projectId) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(() => generateSummary(projectId, activationId));
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

async function generateSummary(projectId: number, activationId: string) {
  const config = await db.query.projectModeratorTable.findFirst({
    where: eq(projectModeratorTable.projectId, projectId),
  });
  if (!config || !config.enabled || config.activationId !== activationId) {
    return;
  }

  const apiKey = await getProjectOwnerApiKey(projectId);
  if (!apiKey) return;

  // lastSummarizedAt is a DB column (not in-memory), so this checkpoint
  // survives a restart — chunks already folded into an earlier summary in
  // this same activation are never re-sent.
  const sinceClause = config.lastSummarizedAt
    ? gt(moderatorTranscriptChunksTable.createdAt, config.lastSummarizedAt)
    : undefined;

  const newChunks = await db.query.moderatorTranscriptChunksTable.findMany({
    where: and(
      eq(moderatorTranscriptChunksTable.projectId, projectId),
      eq(moderatorTranscriptChunksTable.activationId, activationId),
      sinceClause,
    ),
  });
  if (newChunks.length === 0) return; // Silence with nothing new to say — nothing to summarize.

  const users = await db.query.usersTable.findMany();
  const usernameById = new Map(users.map((u) => [u.id, u.username]));

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
              "You are an AI moderator for a group ontology-design conversation. Summarize what has been said so far, organized clearly by speaker (use their names as headings or labels). Be concise but capture each person's key points and any decisions or disagreements.",
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
    const summaryText = data.choices?.[0]?.message?.content?.trim();
    if (!summaryText) {
      broadcastToProject(projectId, {
        type: "moderator_error",
        message: "OpenAI returned an empty summary.",
      });
      return;
    }

    // Commit the summary and advance the durable checkpoint atomically, and
    // only if the activation is still the one we generated this summary
    // for — a disable/re-enable that happened while we were waiting on
    // OpenAI must not let this summary (or its checkpoint advance) apply to
    // a different session.
    const committed = await db.transaction(async (tx) => {
      const [current] = await tx
        .select()
        .from(projectModeratorTable)
        .where(eq(projectModeratorTable.projectId, projectId))
        .for("update");
      if (!current || !current.enabled || current.activationId !== activationId) {
        return false;
      }
      await tx.insert(moderatorSummariesTable).values({ projectId, summary: summaryText });
      await tx
        .update(projectModeratorTable)
        .set({ lastSummarizedAt: maxCreatedAt })
        .where(eq(projectModeratorTable.projectId, projectId));
      return true;
    });

    if (!committed) return;

    broadcastToProject(projectId, {
      type: "moderator_summary",
      text: summaryText,
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
