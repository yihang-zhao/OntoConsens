import crypto from "node:crypto";
import { and, desc, eq, gt, inArray, isNull } from "drizzle-orm";
import {
  db,
  moderatorChatMessagesTable,
  moderatorInterventionPointsTable,
  moderatorTranscriptChunksTable,
  moderatorParticipantsTable,
  ontologyClassesTable,
  projectMembersTable,
  projectModeratorTable,
  projectsTable,
  propertiesTable,
  usersTable,
  type ModeratorChatMessage,
  type ModeratorChatMessageType,
  type ModeratorInterventionEntry,
  type ModeratorInterventionPoint,
} from "@workspace/db";
import { decryptApiKey } from "./moderatorCrypto";
import { broadcastToProject } from "./wsHub";
import { logger } from "./logger";

// "Silence" means no one currently has new text filling into their live
// caption box -- not just "no finalized message yet" (see noteSpeechActivity
// below, which now fires on every non-empty live caption update, not only
// on a finalized transcript POST). 5 continuous seconds of that is treated
// as the group having stalled.
const SILENCE_TIMEOUT_MS = 5_000;

// Minimum spacing between two AI moderator interventions (i.e. two
// "stalled discussion" chat messages actually posted to the group, whether
// they resolved to a real class/property or just a "focus on the
// workspace" reminder) -- keeps the moderator from interrupting
// back-to-back even if the group keeps pausing and resuming within a few
// seconds of each other. The next eligible silence-check only starts being
// honored INTERVENTION_COOLDOWN_MS after the last one actually posted.
const INTERVENTION_COOLDOWN_MS = 15_000;
const lastInterventionAt = new Map<number, number>();

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
// the AI moderator produces one running discussion per project (not one per
// person), so "60 seconds since the last chunk from ANYONE currently on" is
// what triggers the next intervention attempt.
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

// ---------------------------------------------------------------------
// Chat message log: the moderator's entire visible presence is this one
// persisted, ordered log per project (see moderator.ts schema doc for the
// meaning of each type). Every place a message is created also broadcasts
// it live, and serializes it the same way the fetch-all-history endpoint
// does, so a freshly-posted message and a rejoin/reload always render
// identically.
// ---------------------------------------------------------------------

export interface SerializedChatMessage {
  id: number;
  type: ModeratorChatMessageType;
  userId: number | null;
  username: string | null;
  colorSlot: number | null;
  content: string;
  matched: boolean | null;
  className: string | null;
  propertyName: string | null;
  classId: number | null;
  propertyId: number | null;
  examples: ModeratorInterventionEntry[] | null;
  counterexamples: ModeratorInterventionEntry[] | null;
  createdAt: string;
}

async function serializeChatMessage(row: ModeratorChatMessage): Promise<SerializedChatMessage> {
  let username: string | null = null;
  let colorSlot: number | null = null;
  if (row.userId !== null) {
    const [user, membership] = await Promise.all([
      db.query.usersTable.findFirst({ where: eq(usersTable.id, row.userId) }),
      db.query.projectMembersTable.findFirst({
        where: and(
          eq(projectMembersTable.projectId, row.projectId),
          eq(projectMembersTable.userId, row.userId),
        ),
      }),
    ]);
    username = user?.username ?? "unknown";
    colorSlot = membership?.colorSlot ?? 0;
  }
  return {
    id: row.id,
    type: row.type,
    userId: row.userId,
    username,
    colorSlot,
    content: row.content,
    matched: row.matched,
    className: row.className,
    propertyName: row.propertyName,
    classId: row.classId,
    propertyId: row.propertyId,
    examples: row.examples ?? null,
    counterexamples: row.counterexamples ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function listChatMessages(projectId: number): Promise<SerializedChatMessage[]> {
  const rows = await db.query.moderatorChatMessagesTable.findMany({
    where: eq(moderatorChatMessagesTable.projectId, projectId),
    orderBy: (table, { asc }) => [asc(table.createdAt), asc(table.id)],
  });
  return Promise.all(rows.map(serializeChatMessage));
}

async function postChatMessage(
  projectId: number,
  fields: {
    type: ModeratorChatMessageType;
    userId?: number | null;
    content: string;
    matched?: boolean | null;
    className?: string | null;
    propertyName?: string | null;
    classId?: number | null;
    propertyId?: number | null;
    examples?: ModeratorInterventionEntry[] | null;
    counterexamples?: ModeratorInterventionEntry[] | null;
  },
): Promise<void> {
  const [row] = await db
    .insert(moderatorChatMessagesTable)
    .values({ projectId, userId: fields.userId ?? null, ...fields })
    .returning();
  if (!row) return;
  const message = await serializeChatMessage(row);
  broadcastToProject(projectId, { type: "moderator_chat_message", message });
}

// Posted exactly once per project, the moment the shared space opens (every
// expected member has marked ready) -- called from the ready route. A
// no-op on every subsequent call for the same project.
export async function ensureModeratorIntroMessage(projectId: number): Promise<void> {
  const existing = await db.query.moderatorChatMessagesTable.findFirst({
    where: and(
      eq(moderatorChatMessagesTable.projectId, projectId),
      eq(moderatorChatMessagesTable.type, "intro"),
    ),
  });
  if (existing) return;

  const introMessages = [
    "Hi, I'm the AI moderator for this discussion session. Feel free to talk with your peers about any properties you haven't yet agreed to keep or remove.",
    "I'll keep track of your discussion and step in to help whenever things stall.",
    "In order for me to do that, please turn on the microphone below.",
  ];
  for (const content of introMessages) {
    await postChatMessage(projectId, { type: "intro", userId: null, content });
  }
}

// Posted right after a member successfully turns their own mic on -- see
// the PUT /projects/:id/moderator route.
export async function postRecordingStartedMessage(projectId: number, userId: number, username: string): Promise<void> {
  await postChatMessage(projectId, {
    type: "system",
    userId,
    content: `${username} turned on their microphone.`,
  });
}

// Posted right after a member turns their own mic off -- see the
// POST /projects/:id/moderator/disable route. Every member should see when
// someone stops being heard by the moderator, not just when they start.
export async function postRecordingStoppedMessage(projectId: number, userId: number, username: string): Promise<void> {
  await postChatMessage(projectId, {
    type: "system",
    userId,
    content: `${username} turned off their microphone.`,
  });
}

// Mirrors a transcribed chunk into the shared chat log the moment it's
// recorded, so every member sees it live regardless of their own mic state.
async function postTranscriptMessage(projectId: number, userId: number, text: string): Promise<void> {
  await postChatMessage(projectId, { type: "transcript", userId, content: text });
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
// route rejects those uploads before this is ever called), so the
// moderator naturally only ever draws on speech from opted-in members.
export async function recordTranscriptChunk(
  projectId: number,
  userId: number,
  text: string,
  activationId: string,
): Promise<boolean> {
  const committed = await db.transaction(async (tx) => {
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
  if (committed) {
    // Broadcasting the chat message is independent of the transcript-chunk
    // transaction above (it doesn't need to be atomic with it -- worst case
    // a chat message shows up a moment after the row that backs it).
    await postTranscriptMessage(projectId, userId, text);
  }
  return committed;
}

// Fires an intervention attempt after the usual silence timeout, but never
// sooner than INTERVENTION_COOLDOWN_MS after the last one actually posted
// to the group -- if the cooldown hasn't elapsed yet, it reschedules itself
// for the remainder rather than firing immediately or dropping the
// attempt. Content isn't lost either way: generateIntervention always
// re-analyzes everything accumulated since the last checkpoint (plus, for a
// matched property, its ENTIRE prior history -- see generateIntervention),
// whenever it does run.
function fireWhenCooldownElapsed(projectId: number): void {
  const last = lastInterventionAt.get(projectId) ?? 0;
  const remaining = INTERVENTION_COOLDOWN_MS - (Date.now() - last);
  if (remaining <= 0) {
    enqueueIntervention(projectId);
    return;
  }
  setTimeout(() => fireWhenCooldownElapsed(projectId), remaining);
}

// Called both after recordTranscriptChunk confirms a durable write for a
// finalized utterance, AND on every non-empty live caption update (see
// wsHub's "caption" message handling) -- the latter is what makes "silence"
// mean "no one has new text filling into their live box right now" rather
// than "no one has finished a whole utterance yet". A member who's mid-
// sentence, still being recognized, must keep resetting this clock even
// though nothing has been persisted as a real message yet.
export function noteSpeechActivity(projectId: number): void {
  clearModeratorSilenceTimer(projectId);
  const timer = setTimeout(() => {
    silenceTimers.delete(projectId);
    fireWhenCooldownElapsed(projectId);
  }, SILENCE_TIMEOUT_MS);
  silenceTimers.set(projectId, timer);
}

// Two silence periods can legitimately occur close together -- someone
// speaks again just as an intervention request is still in flight, then
// goes quiet again before the first one finishes. Without serialization,
// both invocations would read the same `lastSummarizedAt` checkpoint,
// generate overlapping interventions, and race to advance it -- whichever
// commits last can even move it backwards, causing duplicated or dropped
// content. Chaining every attempt for a project onto a single promise tail
// guarantees they run one at a time, in order, so each one always reads the
// checkpoint left by the one before it.
const interventionQueues = new Map<number, Promise<void>>();

function enqueueIntervention(projectId: number): void {
  const previous = interventionQueues.get(projectId) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(() => generateIntervention(projectId));
  interventionQueues.set(projectId, next);
  next
    .catch((err) => {
      logger.error({ err, projectId }, "Moderator intervention generation failed unexpectedly");
    })
    .finally(() => {
      // Avoid leaking a growing map entry once nothing else is queued behind us.
      if (interventionQueues.get(projectId) === next) interventionQueues.delete(projectId);
    });
}

interface CatalogEntry {
  classId: number;
  propertyId: number;
  className: string;
  propertyName: string;
}

async function callOpenAiJson(apiKey: string, model: string, systemPrompt: string, userContent: string): Promise<any | null> {
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userContent },
      ],
    }),
  });

  if (!response.ok) {
    const body = await response.json().catch(() => null);
    const message =
      (body && typeof body === "object" && "error" in body && (body as any).error?.message) ||
      `OpenAI request failed with status ${response.status}`;
    throw new Error(message);
  }

  const data = (await response.json()) as { choices?: { message?: { content?: string } }[] };
  const rawContent = data.choices?.[0]?.message?.content?.trim();
  if (!rawContent) throw new Error("OpenAI returned an empty response.");

  try {
    const cleaned = rawContent.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "");
    return JSON.parse(cleaned);
  } catch {
    throw new Error("Could not understand the AI moderator's analysis of the discussion.");
  }
}

function formatChunksAsTranscript(
  chunks: { userId: number; text: string; createdAt: Date }[],
  usernameById: Map<number, string>,
): string {
  return chunks
    .slice()
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
    .map((chunk) => `${usernameById.get(chunk.userId) ?? `User ${chunk.userId}`}: ${chunk.text}`)
    .join("\n");
}

// Two-pass design, run every time the group has gone quiet:
//   Pass 1 (topic detection) looks ONLY at what's new since the last
//   checkpoint -- "what are they discussing right now" is inherently a
//   question about the most recent stretch of conversation.
//   Pass 2 (full-history extraction) runs ONLY once pass 1 resolves to a
//   real class+property in the workspace, and re-reads EVERY transcript
//   chunk ever tied to that same class+property (chunks are retroactively
//   tagged the first time they're attributed to a property, and that tag
//   is never overwritten) -- not just what's new -- so an example given
//   several rounds ago and never repeated since is never silently dropped,
//   and the summary always reflects the complete, current state of the
//   discussion rather than an incremental delta.
async function generateIntervention(projectId: number): Promise<void> {
  const config = await db.query.projectModeratorTable.findFirst({
    where: eq(projectModeratorTable.projectId, projectId),
  });
  if (!config) return;

  const apiKey = await getProjectOwnerApiKey(projectId);
  if (!apiKey) return;

  // lastSummarizedAt is a DB column (not in-memory), so this checkpoint
  // survives a restart -- chunks already folded into an earlier
  // intervention are never re-sent as "new". It's shared across every
  // participant's chunks: one running discussion per project, not per
  // person.
  const sinceClause = config.lastSummarizedAt
    ? gt(moderatorTranscriptChunksTable.createdAt, config.lastSummarizedAt)
    : undefined;

  const newChunks = await db.query.moderatorTranscriptChunksTable.findMany({
    where: and(eq(moderatorTranscriptChunksTable.projectId, projectId), sinceClause),
  });
  if (newChunks.length === 0) return; // Silence with nothing new to say — nothing to summarize.

  const users = await db.query.usersTable.findMany();
  const usernameById = new Map(users.map((u) => [u.id, u.username]));

  // The model must only ever report a class/property that genuinely exists
  // in THIS project's shared workspace right now, using the exact same
  // spelling shown here -- never invent or paraphrase a name. This catalog
  // is also used below to verify/resolve the model's answer against real
  // rows (classId/propertyId), rather than trusting its free-form text.
  //
  // Every property in the workspace is eligible here, INCLUDING ones that
  // already reached full agreement -- a group can reopen discussion on a
  // settled property at any point (e.g. reconsidering it later), and when
  // they do, the moderator must recognize that and pick back up from the
  // property's existing examples/counterexamples (persisted durably in
  // moderatorInterventionPointsTable, keyed by class+property, independent
  // of agreement state) rather than silently ignoring the conversation.
  // This is safe from "re-litigating" an untouched property on a passing
  // mention alone: an intervention only ever fires after real accumulated
  // speech followed by silence (see fireWhenCooldownElapsed/
  // noteSpeechActivity above), never from topic-detection matching by
  // itself.
  const [classes, properties] = await Promise.all([
    db.query.ontologyClassesTable.findMany({ where: eq(ontologyClassesTable.projectId, projectId) }),
    db.query.propertiesTable.findMany({ where: eq(propertiesTable.projectId, projectId) }),
  ]);
  const propertyById = new Map(properties.map((p) => [p.id, p]));
  const classLabelById = new Map(classes.map((c) => [c.id, c.label]));
  const catalog: CatalogEntry[] = properties
    .map((p) => ({
      classId: p.classId,
      propertyId: p.id,
      className: classLabelById.get(p.classId) ?? null,
      propertyName: p.name,
    }))
    .filter((entry): entry is CatalogEntry => entry.className !== null);

  const newChunksTranscript = formatChunksAsTranscript(newChunks, usernameById);
  const maxCreatedAt = newChunks.reduce(
    (max, c) => (c.createdAt > max ? c.createdAt : max),
    config.lastSummarizedAt ?? new Date(0),
  );

  const catalogText =
    catalog.length > 0
      ? catalog.map((entry) => `- ${entry.className}.${entry.propertyName}`).join("\n")
      : "(the workspace has no classes/properties yet)";

  let matchedEntry: CatalogEntry | undefined;
  let interventionContent: string;
  let matched: boolean;
  let interventionExamples: ModeratorInterventionEntry[] | null = null;
  let interventionCounterexamples: ModeratorInterventionEntry[] | null = null;

  // What the previous round resolved to, if anything -- lets pass 1 infer
  // that an unlabeled continuation ("yeah I agree", "what about when it's
  // empty?") is still about the same property, instead of only ever
  // matching an explicit re-statement of its name.
  const previousTopic =
    config.lastTopicClassId !== null && config.lastTopicPropertyId !== null
      ? catalog.find(
          (entry) => entry.classId === config.lastTopicClassId && entry.propertyId === config.lastTopicPropertyId,
        )
      : undefined;
  const previousTopicText = previousTopic ? `${previousTopic.className}.${previousTopic.propertyName}` : "(nothing yet)";

  try {
    // --- Pass 1: what is the group discussing right now? ---
    const topicResult = await callOpenAiJson(
      apiKey,
      config.model,
      "You are an AI moderator for a group ontology-design conversation. Look at the transcript below and " +
        "identify the SINGLE class and property the speakers are currently discussing (whether it should be " +
        "retained, removed, or how it should be defined). " +
        "The shared workspace CURRENTLY contains only the following class.property pairs:\n" +
        catalogText +
        `\n\nImmediately before this transcript, the group was discussing: ${previousTopicText}. Conversation ` +
        "commonly continues about the same property without re-stating its name -- via pronouns (\"it\", " +
        "\"that\"), direct replies/agreement/disagreement, or follow-up refinements. If this transcript reads as " +
        "a natural continuation of that same discussion, report that SAME className/propertyName again even " +
        "though it isn't explicitly named here. Only report a DIFFERENT property if the transcript clearly and " +
        "specifically names or unambiguously describes a different one. Only report null/null if the transcript " +
        "has moved on to something unrelated to any listed property entirely (small talk, a topic outside the " +
        "catalog, etc). " +
        "\n\nYou MUST only report a className/propertyName from that exact list, copied with EXACTLY the same " +
        "spelling and capitalization shown above -- never invent, paraphrase, or guess a name that isn't in the " +
        "list. " +
        'Respond with ONLY a JSON object, no markdown fences, no prose, matching exactly this shape: ' +
        '{"className": string | null, "propertyName": string | null}.',
      newChunksTranscript,
    );

    const normalize = (s: string) => s.trim().toLowerCase();
    const rawClassName = typeof topicResult?.className === "string" ? topicResult.className : null;
    const rawPropertyName = typeof topicResult?.propertyName === "string" ? topicResult.propertyName : null;
    matchedEntry =
      rawClassName && rawPropertyName
        ? catalog.find(
            (entry) =>
              normalize(entry.className) === normalize(rawClassName) &&
              normalize(entry.propertyName) === normalize(rawPropertyName),
          )
        : undefined;
    matched = matchedEntry !== undefined;

    // Persist whatever pass 1 resolved to (continuing, switched, or none)
    // as the new continuity anchor for the round after this one -- done
    // regardless of whether pass 2 below succeeds, since this is purely
    // about "what topic is live right now", not about the intervention
    // content itself.
    await db
      .update(projectModeratorTable)
      .set({
        lastTopicClassId: matchedEntry?.classId ?? null,
        lastTopicPropertyId: matchedEntry?.propertyId ?? null,
      })
      .where(eq(projectModeratorTable.id, config.id));

    if (matched && matchedEntry) {
      const { classId, propertyId, className, propertyName } = matchedEntry;

      // Retroactively tag this round's chunks with the matched property --
      // only ones not already tagged under some earlier topic, so an
      // attribution is never overwritten once made.
      const newChunkIds = newChunks.filter((c) => c.classId === null && c.propertyId === null).map((c) => c.id);
      if (newChunkIds.length > 0) {
        await db
          .update(moderatorTranscriptChunksTable)
          .set({ classId, propertyId })
          .where(
            and(
              inArray(moderatorTranscriptChunksTable.id, newChunkIds),
              isNull(moderatorTranscriptChunksTable.classId),
            ),
          );
      }

      // --- Pass 2: re-analyze the COMPLETE history tied to this property. ---
      const historicalChunks = await db.query.moderatorTranscriptChunksTable.findMany({
        where: and(
          eq(moderatorTranscriptChunksTable.projectId, projectId),
          eq(moderatorTranscriptChunksTable.classId, classId),
          eq(moderatorTranscriptChunksTable.propertyId, propertyId),
        ),
      });
      const fullTranscript = formatChunksAsTranscript(historicalChunks, usernameById);

      // Load the durable, already-established points for this property so
      // the extraction prompt can be told to leave their wording alone --
      // see moderatorInterventionPointsTable's doc comment for why this
      // must also be enforced in code below, not just requested here.
      const existingPoints = await db.query.moderatorInterventionPointsTable.findMany({
        where: and(
          eq(moderatorInterventionPointsTable.projectId, projectId),
          eq(moderatorInterventionPointsTable.classId, classId),
          eq(moderatorInterventionPointsTable.propertyId, propertyId),
        ),
        orderBy: (table, { asc }) => [asc(table.createdAt), asc(table.id)],
      });
      const existingExamplePoints = existingPoints.filter((p) => p.tone === "example");
      const existingCounterexamplePoints = existingPoints.filter((p) => p.tone === "counterexample");
      const describeExisting = (points: ModeratorInterventionPoint[]) =>
        points.length === 0
          ? "(none yet)"
          : points.map((p) => `- id ${p.id}: "${p.text}" (currently credited to: ${p.by.join(", ") || "no one"})`).join("\n");

      const extraction = await callOpenAiJson(
        apiKey,
        config.model,
        `You are an AI moderator for a group ontology-design conversation, currently focused on ${className}.${propertyName}. ` +
          "Below is the ENTIRE transcript of everything said about this specific property so far (not just the " +
          "most recent portion). Extract every concrete EXAMPLE given in support of keeping/adding this property, " +
          "and every COUNTEREXAMPLE or objection given against it, across the whole transcript -- include " +
          "something even if it was only mentioned once early on and never repeated, but leave it out if someone " +
          "later explicitly retracted or contradicted it. For each one, note who said it. " +
          "If the SAME underlying point was made more than once -- whether by the same person repeating " +
          "themselves, or by different people independently making an equivalent point -- merge it into a " +
          "single entry rather than listing it twice, and list every person who made that point (in the order " +
          "they first raised it, no duplicate names even if someone repeated themselves). Only merge points " +
          "that are genuinely the same underlying reason; keep distinct reasons as separate entries even if " +
          "they're about the same property.\n\n" +
          "These points were ALREADY ESTABLISHED in a previous round -- you MUST treat their wording as frozen, " +
          "and each current supporter's agreement is assumed to STILL STAND unless the transcript shows " +
          "otherwise:\n" +
          `Examples:\n${describeExisting(existingExamplePoints)}\n\n` +
          `Counterexamples:\n${describeExisting(existingCounterexamplePoints)}\n\n` +
          "For each one: if the transcript still supports it (repeated or not), return it with its EXACT SAME id " +
          "and EXACT SAME text (copy the text verbatim, do not rephrase it even slightly). ONLY change an " +
          "existing id's text if a member EXPLICITLY asks to reword, correct, or replace that specific existing " +
          "point in the transcript (e.g. \"can we change that example to say X instead\") -- in that case set " +
          "\"revise\": true and put the new wording in \"text\". Never reword an existing point just because you " +
          "found a slightly different way to phrase it; if you're not certain a member explicitly asked for a " +
          "reword, leave the text untouched. " +
          "List in \"by\" any NEW people (not already credited above) who now also back this point. List in " +
          "\"remove\" any of the CURRENTLY credited people (from the list above) who explicitly changed their " +
          "mind and now disagree with or retract this specific point (e.g. \"actually I don't think that's true " +
          "anymore\", \"I take that back\", \"I disagree with that now\") -- only ever put someone in \"remove\" " +
          "if the transcript shows them doing this explicitly; silence, or simply not repeating the point again, " +
          "is NOT disagreement and must NOT put them in \"remove\". " +
          "Any genuinely new point not covered by an existing id above should be returned with NO \"id\" field -- " +
          "BUT merge fairly liberally: before treating something as a brand-new point, check whether it's " +
          "broadly the same underlying idea as one of the existing points listed above, just phrased " +
          "differently (not necessarily word-for-word identical, close enough in meaning is enough). If so, " +
          "don't create a new point -- instead set \"mergeWithId\" to that existing point's id and put the new " +
          "speaker(s) in \"by\"; the merged-in wording is discarded and the existing point's frozen text wins. " +
          "This also applies to two of the EXISTING points above if you notice they're actually the same " +
          "underlying idea (this can happen from earlier rounds before this rule) -- return the newer/less-" +
          "supported one with its own \"id\" and \"mergeWithId\" set to the other's id, and its supporters will " +
          "be folded into that other point automatically; when merging two existing points this way, prefer " +
          "keeping (as the mergeWithId target) whichever one is more clearly and completely worded. " +
          "Do NOT copy the speaker's original sentence verbatim for a brand-new point -- condense it down to its " +
          "core point in your own words, as short and punchy as possible (aim for well under 10 words, phrased as " +
          "a plain statement, no filler like \"they said\" or \"because\"). " +
          'Respond with ONLY a JSON object, no markdown fences, no prose, matching exactly this shape: ' +
          '{"examples": [{"id": number | undefined, "text": string, "by": string[], "remove": string[] | undefined, "revise": boolean | undefined, "mergeWithId": number | undefined}], ' +
          '"counterexamples": [{"id": number | undefined, "text": string, "by": string[], "remove": string[] | undefined, "revise": boolean | undefined, "mergeWithId": number | undefined}]}. ' +
          "Use the exact usernames as they appear as speaker labels in the transcript.",
        fullTranscript,
      );

      const rawExamples = Array.isArray(extraction?.examples) ? extraction.examples : [];
      const rawCounterexamples = Array.isArray(extraction?.counterexamples) ? extraction.counterexamples : [];

      interface ParsedResponseEntry {
        id: number | null;
        text: string;
        by: string[];
        remove: string[];
        revise: boolean;
        mergeWithId: number | null;
      }
      const toResponseEntries = (entries: unknown[]): ParsedResponseEntry[] =>
        entries
          .filter(
            (e): e is { id?: unknown; text: string; by: unknown; remove?: unknown; revise?: unknown; mergeWithId?: unknown } =>
              Boolean(e) && typeof e === "object" && typeof (e as any).text === "string",
          )
          .map((e) => {
            const text = e.text.trim().replace(/[.\s]+$/, "");
            const normalizeNames = (raw: unknown) => {
              const rawNames = Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : [];
              return Array.from(
                new Set(rawNames.filter((n): n is string => typeof n === "string" && n.trim().length > 0)),
              );
            };
            const by = normalizeNames(e.by);
            const remove = normalizeNames(e.remove);
            const id = typeof e.id === "number" && Number.isFinite(e.id) ? e.id : null;
            const mergeWithId =
              typeof e.mergeWithId === "number" && Number.isFinite(e.mergeWithId) ? e.mergeWithId : null;
            return { id, text, by, remove, revise: e.revise === true, mergeWithId };
          })
          .filter((e) => e.text.length > 0);

      // Reconcile the model's response against the durable canonical points
      // for this tone, enforcing in code -- not just by asking the model --
      // that an existing point's wording can only change via an explicit
      // "revise" flag, and that a supporter is only ever dropped via an
      // explicit "remove" flag naming them. Anything else about an existing
      // id (silent rewording, or simply not being repeated this round) is
      // ignored: absence of evidence is never treated as disagreement, so a
      // user's prior position is retained by default. A point that loses
      // its last supporter this way is deleted outright -- see the caller's
      // doc comment on "all users disagree" behavior.
      async function reconcile(
        tone: "example" | "counterexample",
        existing: ModeratorInterventionPoint[],
        responseEntries: ParsedResponseEntry[],
      ): Promise<ModeratorInterventionEntry[]> {
        const byId = new Map(existing.map((p) => [p.id, p]));

        // --- Fold merges first, before doing anything else. ---
        // A response entry with a valid mergeWithId (pointing at a
        // DIFFERENT existing point) never becomes its own row: its
        // supporters are folded into the target id's aggregated extra
        // by/remove instead, whether the entry itself was a brand-new idea
        // (no own id) or an existing point the model recognized as a
        // duplicate of another one (own id present -- that row gets
        // deleted below, its accumulated supporters carried over).
        const mergedAwayIds = new Set<number>();
        const extraById = new Map<number, { by: Set<string>; remove: Set<string> }>();
        const addExtra = (targetId: number, by: string[], remove: string[]) => {
          const extra = extraById.get(targetId) ?? { by: new Set<string>(), remove: new Set<string>() };
          for (const n of by) extra.by.add(n);
          for (const n of remove) extra.remove.add(n);
          extraById.set(targetId, extra);
        };
        const normalResponses: ParsedResponseEntry[] = [];
        for (const response of responseEntries) {
          if (response.mergeWithId !== null && byId.has(response.mergeWithId) && response.mergeWithId !== response.id) {
            if (response.id !== null && byId.has(response.id)) {
              // Two previously-separate existing points turned out to be
              // the same idea -- carry the losing point's own supporters
              // (its stored `by`, not just this round's new names) into the
              // survivor, then drop the losing row entirely.
              const losing = byId.get(response.id)!;
              addExtra(response.mergeWithId, [...losing.by, ...response.by], response.remove);
              mergedAwayIds.add(response.id);
            } else {
              addExtra(response.mergeWithId, response.by, response.remove);
            }
            continue;
          }
          normalResponses.push(response);
        }

        const result: ModeratorInterventionEntry[] = [];

        // Existing points first, in their original stable order, so the
        // card's row order never reshuffles between interventions.
        for (const point of existing) {
          if (mergedAwayIds.has(point.id)) {
            await db.delete(moderatorInterventionPointsTable).where(eq(moderatorInterventionPointsTable.id, point.id));
            continue;
          }
          const response = normalResponses.find((r) => r.id === point.id);
          const extra = extraById.get(point.id);
          let text = point.text;
          let by = point.by;
          if (response || extra) {
            const removeSet = new Set([...(response?.remove ?? []), ...(extra?.remove ?? [])].map((n) => n.toLowerCase()));
            by = Array.from(new Set([...point.by, ...(response?.by ?? []), ...(extra?.by ?? [])])).filter(
              (n) => !removeSet.has(n.toLowerCase()),
            );
            if (response?.revise && response.text.length > 0) {
              text = response.text;
            }
          }
          if (by.length === 0) {
            // Every current supporter explicitly disagreed -- the point no
            // longer has anyone standing behind it, so it's dropped rather
            // than shown as an orphaned, unsupported row.
            await db.delete(moderatorInterventionPointsTable).where(eq(moderatorInterventionPointsTable.id, point.id));
            continue;
          }
          if (text !== point.text || by.length !== point.by.length || by.some((n, i) => n !== point.by[i])) {
            await db
              .update(moderatorInterventionPointsTable)
              .set({ text, by, updatedAt: new Date() })
              .where(eq(moderatorInterventionPointsTable.id, point.id));
          }
          result.push({ text, by });
        }

        // Anything the model returned with no id (or an id that doesn't
        // match any existing point, e.g. a stale id from a previous prompt)
        // is a brand-new point -- insert it as a new canonical row.
        for (const response of normalResponses) {
          if (response.id !== null && byId.has(response.id)) continue;
          if (response.by.length === 0) continue;
          const [inserted] = await db
            .insert(moderatorInterventionPointsTable)
            .values({ projectId, classId, propertyId, tone, text: response.text, by: response.by })
            .returning();
          if (inserted) result.push({ text: inserted.text, by: inserted.by });
        }

        return result;
      }

      const exampleEntries = await reconcile("example", existingExamplePoints, toResponseEntries(rawExamples));
      const counterexampleEntries = await reconcile(
        "counterexample",
        existingCounterexamplePoints,
        toResponseEntries(rawCounterexamples),
      );

      const formatEntriesText = (entries: ModeratorInterventionEntry[]) =>
        entries.map((e) => `${e.text}. — ${e.by.length > 0 ? e.by.join(", ") : "someone"}`).join("\n") ||
        "(none given yet)";

      // Fixed template: title/header lives in the client (always "AI
      // moderator"), so the content itself only carries the stalled-property
      // line, the two condensed pro/con lists, and the standing prompt to
      // keep discussing or move to a vote -- no extra framing or attribution
      // line, per the exact wording the moderator is expected to use.
      interventionContent =
        `Discussion stalled — ${className}.${propertyName}\n\n` +
        `I noticed the discussion has stalled on this property. Here's where things stand:\n\n` +
        `For keeping it:\n\n${formatEntriesText(exampleEntries)}\n\n` +
        `For removing it:\n\n${formatEntriesText(counterexampleEntries)}\n\n` +
        `Would you like to continue discussing, or move to a vote?`;
      interventionExamples = exampleEntries;
      interventionCounterexamples = counterexampleEntries;
    } else {
      interventionContent =
        "I noticed the discussion has stalled, but couldn't tell which class or property this was about. " +
        "Try focusing the discussion on properties already in this shared workspace.";
    }
  } catch (err) {
    logger.error({ err, projectId }, "Moderator intervention generation errored");
    broadcastToProject(projectId, {
      type: "moderator_error",
      message: err instanceof Error ? err.message : "Could not reach OpenAI to generate a summary.",
    });
    return;
  }

  // Commit the intervention and advance the durable checkpoint atomically,
  // and only if the project's moderator config row is still the one we
  // generated this intervention for.
  const [insertedRow, committed] = await db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(projectModeratorTable)
      .where(eq(projectModeratorTable.projectId, projectId))
      .for("update");
    if (!current) return [undefined, false] as const;

    // Never post the exact same intervention text back-to-back -- e.g. the
    // group falls silent again without adding anything new, and pass 1/2
    // land on the identical "still stalled on the same property, same
    // examples" wording, or two consecutive rounds both fall through to the
    // same generic "couldn't tell what this was about" reminder. Either way
    // showing it again adds nothing and just reads as the moderator
    // repeating itself. The checkpoint still advances (these chunks WERE
    // considered) so the group doesn't get stuck being re-summarized
    // forever; only the redundant chat message is suppressed.
    const [previousIntervention] = await tx
      .select({ content: moderatorChatMessagesTable.content })
      .from(moderatorChatMessagesTable)
      .where(and(eq(moderatorChatMessagesTable.projectId, projectId), eq(moderatorChatMessagesTable.type, "intervention")))
      .orderBy(desc(moderatorChatMessagesTable.createdAt), desc(moderatorChatMessagesTable.id))
      .limit(1);
    if (previousIntervention && previousIntervention.content === interventionContent) {
      await tx
        .update(projectModeratorTable)
        .set({ lastSummarizedAt: maxCreatedAt })
        .where(eq(projectModeratorTable.projectId, projectId));
      return [undefined, false] as const;
    }

    const [row] = await tx
      .insert(moderatorChatMessagesTable)
      .values({
        projectId,
        type: "intervention",
        userId: null,
        content: interventionContent,
        matched,
        className: matchedEntry?.className ?? null,
        propertyName: matchedEntry?.propertyName ?? null,
        classId: matchedEntry?.classId ?? null,
        propertyId: matchedEntry?.propertyId ?? null,
        examples: interventionExamples,
        counterexamples: interventionCounterexamples,
      })
      .returning();
    await tx
      .update(projectModeratorTable)
      .set({ lastSummarizedAt: maxCreatedAt })
      .where(eq(projectModeratorTable.projectId, projectId));
    return [row, true] as const;
  });

  if (!committed || !insertedRow) return;

  // Marks this as the most recent intervention shown to the group -- gates
  // fireWhenCooldownElapsed for the NEXT one, whether or not this round
  // matched a real class/property (a "focus on the workspace" reminder is
  // still an intervention the group just saw).
  lastInterventionAt.set(projectId, Date.now());

  const message = await serializeChatMessage(insertedRow);
  broadcastToProject(projectId, { type: "moderator_chat_message", message });
}
