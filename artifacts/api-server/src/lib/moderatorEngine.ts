import crypto from "node:crypto";
import { and, eq, gt, inArray, isNull } from "drizzle-orm";
import {
  db,
  moderatorChatMessagesTable,
  moderatorTranscriptChunksTable,
  moderatorParticipantsTable,
  ontologyClassesTable,
  projectMembersTable,
  projectModeratorTable,
  projectsTable,
  propertiesTable,
  propertyAgreementsTable,
  usersTable,
  type ModeratorChatMessage,
  type ModeratorChatMessageType,
} from "@workspace/db";
import { decryptApiKey } from "./moderatorCrypto";
import { broadcastToProject } from "./wsHub";
import { logger } from "./logger";

const SILENCE_TIMEOUT_MS = 5_000;

// Falls back to this if a project's own `maxMembers` is somehow unset --
// mirrors the same fallback used by the properties routes' agreement check.
const MAX_PROJECT_MEMBERS = 3;

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
// person), so "5 seconds since the last chunk from ANYONE currently on" is
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

  await postChatMessage(projectId, {
    type: "intro",
    userId: null,
    content:
      "Hi, I'm your AI moderator. I'll speak up here whenever discussion on a class or property stalls, " +
      "and summarize the examples and counterexamples I've heard so far. To do that I need your microphone " +
      "enabled so I can listen in -- everything said will appear here as chat messages, visible to everyone " +
      "in this project.",
  });
}

// Posted right after a member successfully turns their own mic on -- see
// the PUT /projects/:id/moderator route.
export async function postRecordingStartedMessage(projectId: number, userId: number, username: string): Promise<void> {
  await postChatMessage(projectId, {
    type: "system",
    userId,
    content: `${username} enabled their microphone. Recording started -- their speech will now appear here.`,
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

// Called only after recordTranscriptChunk has confirmed a durable write for
// some active participant -- so a stale timer is never armed on the
// strength of content that was actually rejected.
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
  // Properties that have ALREADY reached full agreement (agreedByAll, same
  // definition the properties routes use: agreement count >= the project's
  // configured maxMembers) are excluded entirely -- once the group has
  // settled a property, it's no longer "under discussion" and the moderator
  // should never re-litigate it, even if someone mentions it in passing.
  const [classes, properties, project] = await Promise.all([
    db.query.ontologyClassesTable.findMany({ where: eq(ontologyClassesTable.projectId, projectId) }),
    db.query.propertiesTable.findMany({ where: eq(propertiesTable.projectId, projectId) }),
    db.query.projectsTable.findFirst({ where: eq(projectsTable.id, projectId) }),
  ]);
  const propertyIds = properties.map((p) => p.id);
  const agreements =
    propertyIds.length > 0
      ? await db.query.propertyAgreementsTable.findMany({
          where: inArray(propertyAgreementsTable.propertyId, propertyIds),
        })
      : [];
  const maxMembers = project?.maxMembers ?? MAX_PROJECT_MEMBERS;
  const agreementCountByPropertyId = new Map<number, number>();
  for (const a of agreements) {
    agreementCountByPropertyId.set(a.propertyId, (agreementCountByPropertyId.get(a.propertyId) ?? 0) + 1);
  }
  const propertyById = new Map(properties.map((p) => [p.id, p]));
  const classLabelById = new Map(classes.map((c) => [c.id, c.label]));
  const catalog: CatalogEntry[] = properties
    .filter((p) => (agreementCountByPropertyId.get(p.id) ?? 0) < maxMembers)
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
        "\n\nYou MUST only report a className/propertyName from that exact list, copied with EXACTLY the same " +
        "spelling and capitalization shown above -- never invent, paraphrase, or guess a name that isn't in the " +
        "list. If the discussion doesn't clearly and specifically match one of these listed pairs, set both " +
        "className and propertyName to null. " +
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

      const extraction = await callOpenAiJson(
        apiKey,
        config.model,
        `You are an AI moderator for a group ontology-design conversation, currently focused on ${className}.${propertyName}. ` +
          "Below is the ENTIRE transcript of everything said about this specific property so far (not just the " +
          "most recent portion). Extract every concrete EXAMPLE given in support of keeping/adding this property, " +
          "and every COUNTEREXAMPLE or objection given against it, across the whole transcript -- include " +
          "something even if it was only mentioned once early on and never repeated, but leave it out if someone " +
          "later explicitly retracted or contradicted it. For each one, note who said it. " +
          'Respond with ONLY a JSON object, no markdown fences, no prose, matching exactly this shape: ' +
          '{"examples": [{"text": string, "by": string}], "counterexamples": [{"text": string, "by": string}]}. ' +
          "Use the exact usernames as they appear as speaker labels in the transcript.",
        fullTranscript,
      );

      const examples = Array.isArray(extraction?.examples) ? extraction.examples : [];
      const counterexamples = Array.isArray(extraction?.counterexamples) ? extraction.counterexamples : [];
      const formatEntries = (entries: unknown[]) =>
        entries
          .filter(
            (e): e is { text: string; by: string } =>
              Boolean(e) && typeof e === "object" && typeof (e as any).text === "string",
          )
          .map((e) => `- ${e.text}${typeof e.by === "string" && e.by ? ` (given by ${e.by})` : ""}`)
          .join("\n");

      const examplesText = formatEntries(examples) || "(none given yet)";
      const counterexamplesText = formatEntries(counterexamples) || "(none given yet)";
      const proposer = propertyById.get(propertyId);
      const proposedByUsername = proposer ? usernameById.get(proposer.proposedByUserId) ?? "someone" : "someone";

      interventionContent =
        `Stalled discussion detected on ${className}.${propertyName}.\n\n` +
        `Examples:\n${examplesText}\n\n` +
        `Counterexamples:\n${counterexamplesText}\n\n` +
        `Originally proposed by: ${proposedByUsername}`;
    } else {
      interventionContent =
        "Stalled discussion detected, but I couldn't tell which class or property this was about. " +
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
