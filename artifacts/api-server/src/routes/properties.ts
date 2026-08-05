import { Router, type IRouter } from "express";
import { and, eq } from "drizzle-orm";
import {
  db,
  ontologyClassesTable,
  projectMembersTable,
  propertiesTable,
  propertyAgreementsTable,
  usersTable,
} from "@workspace/db";
import { CreatePropertyBody, UpdatePropertyBody } from "@workspace/api-zod";
import { requireAuth } from "../lib/auth";
import { broadcastToProject } from "../lib/wsHub";

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

function normalizeName(name: string): string {
  return name.trim().toLowerCase();
}

// If another property with the same name already exists in the same class,
// proposing that name again counts as agreeing with it rather than creating
// a duplicate — this is how independently-proposed properties merge into a
// single agreed item once the board comes together.
async function findMatchingProperty(
  projectId: number,
  classId: number,
  name: string,
  excludePropertyId?: number,
) {
  const normalized = normalizeName(name);
  const candidates = await db.query.propertiesTable.findMany({
    where: and(eq(propertiesTable.projectId, projectId), eq(propertiesTable.classId, classId)),
  });
  return candidates.find(
    (p) => p.id !== excludePropertyId && normalizeName(p.name) === normalized,
  );
}

async function serializeProperty(
  property: typeof propertiesTable.$inferSelect,
  totalMembers: number,
) {
  const agreements = await db.query.propertyAgreementsTable.findMany({
    where: eq(propertyAgreementsTable.propertyId, property.id),
  });
  const users = await db.query.usersTable.findMany();
  const members = await db.query.projectMembersTable.findMany({
    where: eq(projectMembersTable.projectId, property.projectId),
  });
  const usersById = new Map(users.map((u) => [u.id, u]));
  const membersByUserId = new Map(members.map((m) => [m.userId, m]));

  const proposer = usersById.get(property.proposedByUserId);
  const proposerMembership = membersByUserId.get(property.proposedByUserId);

  return {
    id: property.id,
    classId: property.classId,
    name: property.name,
    proposedByUserId: property.proposedByUserId,
    proposedByUsername: proposer?.username ?? "unknown",
    proposedByColorSlot: proposerMembership?.colorSlot ?? 0,
    createdAt: property.createdAt.toISOString(),
    agreements: agreements.map((a) => ({
      userId: a.userId,
      username: usersById.get(a.userId)?.username ?? "unknown",
      colorSlot: membersByUserId.get(a.userId)?.colorSlot ?? 0,
    })),
    agreedByAll: agreements.length >= totalMembers,
  };
}

router.get("/projects/:id/properties", async (req, res) => {
  const userId = req.userId!;
  const projectId = Number(req.params.id);

  const membership = await getMembership(projectId, userId);
  if (!membership) {
    res.status(403).json({ error: "You are not a member of this project" });
    return;
  }

  const members = await db.query.projectMembersTable.findMany({
    where: eq(projectMembersTable.projectId, projectId),
  });
  // The shared consensus space only appears once every member has marked
  // themselves ready — until then everyone only sees their own proposals.
  const allReady = members.length > 0 && members.every((m) => m.ready);

  const allProperties = await db.query.propertiesTable.findMany({
    where: eq(propertiesTable.projectId, projectId),
  });
  // A property proposed by someone else can still be "yours" if your own
  // proposal merged into it (same name, same class) — you should keep seeing
  // it even before everyone is ready, since it reflects your own action.
  const myAgreements = await db.query.propertyAgreementsTable.findMany({
    where: eq(propertyAgreementsTable.userId, userId),
  });
  const myAgreedPropertyIds = new Set(myAgreements.map((a) => a.propertyId));
  const visible = allProperties.filter(
    (p) => p.proposedByUserId === userId || myAgreedPropertyIds.has(p.id) || allReady,
  );

  const serialized = await Promise.all(
    visible.map((p) => serializeProperty(p, members.length)),
  );
  res.json(serialized);
});

router.post("/projects/:id/properties", async (req, res) => {
  const userId = req.userId!;
  const projectId = Number(req.params.id);

  const membership = await getMembership(projectId, userId);
  if (!membership) {
    res.status(403).json({ error: "You are not a member of this project" });
    return;
  }

  const parsed = CreatePropertyBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input" });
    return;
  }

  const cls = await db.query.ontologyClassesTable.findFirst({
    where: and(
      eq(ontologyClassesTable.id, parsed.data.classId),
      eq(ontologyClassesTable.projectId, projectId),
    ),
  });
  if (!cls) {
    res.status(400).json({ error: "Class not found in this project" });
    return;
  }

  const trimmedName = parsed.data.name.trim();
  const members = await db.query.projectMembersTable.findMany({
    where: eq(projectMembersTable.projectId, projectId),
  });

  const existingMatch = await findMatchingProperty(projectId, parsed.data.classId, trimmedName);
  if (existingMatch) {
    // Someone else already proposed this exact property name for this class:
    // merge by recording the new proposer's agreement instead of duplicating.
    const alreadyAgreed = await db.query.propertyAgreementsTable.findFirst({
      where: and(
        eq(propertyAgreementsTable.propertyId, existingMatch.id),
        eq(propertyAgreementsTable.userId, userId),
      ),
    });
    if (!alreadyAgreed) {
      await db.insert(propertyAgreementsTable).values({ propertyId: existingMatch.id, userId });
    }

    const result = await serializeProperty(existingMatch, members.length);
    broadcastToProject(projectId, { type: "agreement_changed" });
    res.status(200).json(result);
    return;
  }

  const [property] = await db
    .insert(propertiesTable)
    .values({
      projectId,
      classId: parsed.data.classId,
      name: trimmedName,
      proposedByUserId: userId,
    })
    .returning();
  if (!property) {
    res.status(500).json({ error: "Failed to create property" });
    return;
  }

  await db
    .insert(propertyAgreementsTable)
    .values({ propertyId: property.id, userId });

  const result = await serializeProperty(property, members.length);

  broadcastToProject(projectId, { type: "property_created" });

  res.status(201).json(result);
});

router.patch("/projects/:id/properties/:propertyId", async (req, res) => {
  const userId = req.userId!;
  const projectId = Number(req.params.id);
  const propertyId = Number(req.params.propertyId);

  const membership = await getMembership(projectId, userId);
  if (!membership) {
    res.status(403).json({ error: "You are not a member of this project" });
    return;
  }

  const parsed = UpdatePropertyBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input" });
    return;
  }

  const property = await db.query.propertiesTable.findFirst({
    where: and(eq(propertiesTable.id, propertyId), eq(propertiesTable.projectId, projectId)),
  });
  if (!property) {
    res.status(404).json({ error: "Property not found" });
    return;
  }
  if (property.proposedByUserId !== userId) {
    res.status(403).json({ error: "You can only edit your own property" });
    return;
  }

  const trimmedName = parsed.data.name.trim();
  const members = await db.query.projectMembersTable.findMany({
    where: eq(projectMembersTable.projectId, projectId),
  });

  const existingMatch = await findMatchingProperty(
    projectId,
    property.classId,
    trimmedName,
    property.id,
  );
  if (existingMatch) {
    // Renaming into an already-proposed name merges the two: fold this
    // property's agreements into the matching one and drop the duplicate.
    const existingAgreements = await db.query.propertyAgreementsTable.findMany({
      where: eq(propertyAgreementsTable.propertyId, propertyId),
    });
    for (const agreement of existingAgreements) {
      const already = await db.query.propertyAgreementsTable.findFirst({
        where: and(
          eq(propertyAgreementsTable.propertyId, existingMatch.id),
          eq(propertyAgreementsTable.userId, agreement.userId),
        ),
      });
      if (!already) {
        await db
          .insert(propertyAgreementsTable)
          .values({ propertyId: existingMatch.id, userId: agreement.userId });
      }
    }
    await db
      .delete(propertyAgreementsTable)
      .where(eq(propertyAgreementsTable.propertyId, propertyId));
    await db.delete(propertiesTable).where(eq(propertiesTable.id, propertyId));

    const result = await serializeProperty(existingMatch, members.length);
    broadcastToProject(projectId, { type: "property_deleted" });
    broadcastToProject(projectId, { type: "agreement_changed" });
    res.json(result);
    return;
  }

  const [updated] = await db
    .update(propertiesTable)
    .set({ name: trimmedName })
    .where(eq(propertiesTable.id, propertyId))
    .returning();

  const result = await serializeProperty(updated ?? property, members.length);

  broadcastToProject(projectId, { type: "property_updated" });

  res.json(result);
});

router.delete("/projects/:id/properties/:propertyId", async (req, res) => {
  const userId = req.userId!;
  const projectId = Number(req.params.id);
  const propertyId = Number(req.params.propertyId);

  const membership = await getMembership(projectId, userId);
  if (!membership) {
    res.status(403).json({ error: "You are not a member of this project" });
    return;
  }

  const property = await db.query.propertiesTable.findFirst({
    where: and(eq(propertiesTable.id, propertyId), eq(propertiesTable.projectId, projectId)),
  });
  if (!property) {
    res.status(204).end();
    return;
  }

  await db
    .delete(propertyAgreementsTable)
    .where(
      and(
        eq(propertyAgreementsTable.propertyId, propertyId),
        eq(propertyAgreementsTable.userId, userId),
      ),
    );

  const remaining = await db.query.propertyAgreementsTable.findMany({
    where: eq(propertyAgreementsTable.propertyId, propertyId),
  });
  if (remaining.length === 0) {
    await db.delete(propertiesTable).where(eq(propertiesTable.id, propertyId));
  }

  broadcastToProject(projectId, { type: "property_deleted" });

  res.status(204).end();
});

router.post("/projects/:id/properties/:propertyId/agree", async (req, res) => {
  const userId = req.userId!;
  const projectId = Number(req.params.id);
  const propertyId = Number(req.params.propertyId);

  const membership = await getMembership(projectId, userId);
  if (!membership) {
    res.status(403).json({ error: "You are not a member of this project" });
    return;
  }

  const property = await db.query.propertiesTable.findFirst({
    where: and(eq(propertiesTable.id, propertyId), eq(propertiesTable.projectId, projectId)),
  });
  if (!property) {
    res.status(404).json({ error: "Property not found" });
    return;
  }

  const existing = await db.query.propertyAgreementsTable.findFirst({
    where: and(
      eq(propertyAgreementsTable.propertyId, propertyId),
      eq(propertyAgreementsTable.userId, userId),
    ),
  });
  if (!existing) {
    await db.insert(propertyAgreementsTable).values({ propertyId, userId });
  }

  const members = await db.query.projectMembersTable.findMany({
    where: eq(projectMembersTable.projectId, projectId),
  });
  const result = await serializeProperty(property, members.length);

  broadcastToProject(projectId, { type: "agreement_changed" });

  res.json(result);
});

export default router;
