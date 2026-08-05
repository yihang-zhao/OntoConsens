import { Router, type IRouter } from "express";
import multer from "multer";
import crypto from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  db,
  ontologyClassesTable,
  ontologyRelationsTable,
  projectMembersTable,
  projectsTable,
  usersTable,
  MAX_PROJECT_MEMBERS,
} from "@workspace/db";
import { JoinProjectBody, SetReadyBody } from "@workspace/api-zod";
import { requireAuth } from "../lib/auth";
import { parseOntologyFile } from "../lib/ontologyParser";
import { issueTicket, broadcastToProject } from "../lib/wsHub";

const router: IRouter = Router();
const upload = multer({ limits: { fileSize: 5 * 1024 * 1024 } });

router.use(requireAuth);

function serializeProject(project: typeof projectsTable.$inferSelect, memberCount: number) {
  return {
    id: project.id,
    name: project.name,
    inviteCode: project.inviteCode,
    ownerId: project.ownerId,
    memberCount,
    maxMembers: MAX_PROJECT_MEMBERS,
    createdAt: project.createdAt.toISOString(),
  };
}

async function getMembership(projectId: number, userId: number) {
  return db.query.projectMembersTable.findFirst({
    where: and(
      eq(projectMembersTable.projectId, projectId),
      eq(projectMembersTable.userId, userId),
    ),
  });
}

router.get("/projects", async (req, res) => {
  const userId = req.userId!;
  const memberships = await db.query.projectMembersTable.findMany({
    where: eq(projectMembersTable.userId, userId),
  });
  const projectIds = memberships.map((m) => m.projectId);
  if (projectIds.length === 0) {
    res.json([]);
    return;
  }
  const projects = await db.query.projectsTable.findMany();
  const relevant = projects.filter((p) => projectIds.includes(p.id));
  const counts = await Promise.all(
    relevant.map(async (p) => {
      const members = await db.query.projectMembersTable.findMany({
        where: eq(projectMembersTable.projectId, p.id),
      });
      return serializeProject(p, members.length);
    }),
  );
  res.json(counts);
});

router.post("/projects", upload.single("file"), async (req, res) => {
  const userId = req.userId!;
  const name = typeof req.body.name === "string" ? req.body.name.trim() : "";
  const file = req.file;

  if (!name) {
    res.status(400).json({ error: "Project name is required" });
    return;
  }
  if (!file) {
    res.status(400).json({ error: "Ontology file is required" });
    return;
  }

  let parsed;
  try {
    parsed = await parseOntologyFile(file.originalname, file.buffer.toString("utf-8"));
  } catch {
    res.status(400).json({ error: "Could not parse the ontology file" });
    return;
  }

  if (parsed.classes.length === 0) {
    res.status(400).json({ error: "No classes found in the ontology file" });
    return;
  }

  const inviteCode = crypto.randomBytes(4).toString("hex");

  const [project] = await db
    .insert(projectsTable)
    .values({ name, ownerId: userId, inviteCode })
    .returning();
  if (!project) {
    res.status(500).json({ error: "Failed to create project" });
    return;
  }

  await db
    .insert(projectMembersTable)
    .values({ projectId: project.id, userId, colorSlot: 0, ready: false });

  const classIdByUri = new Map<string, number>();
  for (const cls of parsed.classes) {
    const [inserted] = await db
      .insert(ontologyClassesTable)
      .values({ projectId: project.id, uri: cls.uri, label: cls.label })
      .returning();
    if (inserted) {
      classIdByUri.set(cls.uri, inserted.id);
    }
  }

  for (const relation of parsed.relations) {
    const childId = classIdByUri.get(relation.childUri);
    const parentId = classIdByUri.get(relation.parentUri);
    if (childId && parentId) {
      await db
        .insert(ontologyRelationsTable)
        .values({ projectId: project.id, childId, parentId });
    }
  }

  res.status(201).json(serializeProject(project, 1));
});

router.post("/projects/join", async (req, res) => {
  const userId = req.userId!;
  const parsed = JoinProjectBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input" });
    return;
  }

  const project = await db.query.projectsTable.findFirst({
    where: eq(projectsTable.inviteCode, parsed.data.inviteCode),
  });
  if (!project) {
    res.status(400).json({ error: "Invalid invite code" });
    return;
  }

  const members = await db.query.projectMembersTable.findMany({
    where: eq(projectMembersTable.projectId, project.id),
  });

  const existing = members.find((m) => m.userId === userId);
  if (existing) {
    res.json(serializeProject(project, members.length));
    return;
  }

  if (members.length >= MAX_PROJECT_MEMBERS) {
    res.status(400).json({ error: "This project already has the maximum number of members" });
    return;
  }

  await db.insert(projectMembersTable).values({
    projectId: project.id,
    userId,
    colorSlot: members.length,
    ready: false,
  });

  broadcastToProject(project.id, { type: "member_joined" });

  res.json(serializeProject(project, members.length + 1));
});

router.get("/projects/:id", async (req, res) => {
  const userId = req.userId!;
  const projectId = Number(req.params.id);

  const project = await db.query.projectsTable.findFirst({
    where: eq(projectsTable.id, projectId),
  });
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  const membership = await getMembership(projectId, userId);
  if (!membership) {
    res.status(403).json({ error: "You are not a member of this project" });
    return;
  }

  const memberRows = await db.query.projectMembersTable.findMany({
    where: eq(projectMembersTable.projectId, projectId),
  });
  const users = await db.query.usersTable.findMany();
  const usersById = new Map(users.map((u) => [u.id, u]));

  const members = memberRows.map((m) => ({
    userId: m.userId,
    username: usersById.get(m.userId)?.username ?? "unknown",
    colorSlot: m.colorSlot,
    ready: m.ready,
    isOwner: m.userId === project.ownerId,
  }));

  const classes = await db.query.ontologyClassesTable.findMany({
    where: eq(ontologyClassesTable.projectId, projectId),
  });
  const relations = await db.query.ontologyRelationsTable.findMany({
    where: eq(ontologyRelationsTable.projectId, projectId),
  });

  res.json({
    id: project.id,
    name: project.name,
    inviteCode: project.inviteCode,
    ownerId: project.ownerId,
    maxMembers: MAX_PROJECT_MEMBERS,
    createdAt: project.createdAt.toISOString(),
    members,
    classes: classes.map((c) => ({ id: c.id, uri: c.uri, label: c.label })),
    relations: relations.map((r) => ({ childId: r.childId, parentId: r.parentId })),
  });
});

router.patch("/projects/:id/ready", async (req, res) => {
  const userId = req.userId!;
  const projectId = Number(req.params.id);
  const parsed = SetReadyBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input" });
    return;
  }

  const membership = await getMembership(projectId, userId);
  if (!membership) {
    res.status(403).json({ error: "You are not a member of this project" });
    return;
  }

  if (membership.ready && !parsed.data.ready) {
    res.status(400).json({ error: "You cannot unmark yourself as ready once you have marked ready" });
    return;
  }

  const [updated] = await db
    .update(projectMembersTable)
    .set({ ready: parsed.data.ready })
    .where(
      and(
        eq(projectMembersTable.projectId, projectId),
        eq(projectMembersTable.userId, userId),
      ),
    )
    .returning();

  const user = await db.query.usersTable.findFirst({ where: eq(usersTable.id, userId) });
  const project = await db.query.projectsTable.findFirst({ where: eq(projectsTable.id, projectId) });

  broadcastToProject(projectId, { type: "member_ready" });

  res.json({
    userId,
    username: user?.username ?? "unknown",
    colorSlot: updated?.colorSlot ?? membership.colorSlot,
    ready: updated?.ready ?? membership.ready,
    isOwner: project?.ownerId === userId,
  });
});

router.post("/projects/:id/ws-ticket", async (req, res) => {
  const userId = req.userId!;
  const projectId = Number(req.params.id);

  const membership = await getMembership(projectId, userId);
  if (!membership) {
    res.status(403).json({ error: "You are not a member of this project" });
    return;
  }

  const ticket = issueTicket(userId, projectId);
  res.json({ ticket });
});

router.get("/projects/:id/export", async (req, res) => {
  const userId = req.userId!;
  const projectId = Number(req.params.id);

  const project = await db.query.projectsTable.findFirst({
    where: eq(projectsTable.id, projectId),
  });
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  const membership = await getMembership(projectId, userId);
  if (!membership) {
    res.status(403).json({ error: "You are not a member of this project" });
    return;
  }

  const memberRows = await db.query.projectMembersTable.findMany({
    where: eq(projectMembersTable.projectId, projectId),
  });
  const totalMembers = memberRows.length;

  const classes = await db.query.ontologyClassesTable.findMany({
    where: eq(ontologyClassesTable.projectId, projectId),
  });
  const { propertiesTable, propertyAgreementsTable } = await import("@workspace/db");
  const properties = await db.query.propertiesTable.findMany({
    where: eq(propertiesTable.projectId, projectId),
  });
  const agreements = await db.query.propertyAgreementsTable.findMany();

  const agreementCountByProperty = new Map<number, number>();
  for (const agreement of agreements) {
    if (properties.some((p) => p.id === agreement.propertyId)) {
      agreementCountByProperty.set(
        agreement.propertyId,
        (agreementCountByProperty.get(agreement.propertyId) ?? 0) + 1,
      );
    }
  }

  const exportClasses = classes.map((cls) => ({
    uri: cls.uri,
    label: cls.label,
    properties: properties
      .filter(
        (p) =>
          p.classId === cls.id &&
          (agreementCountByProperty.get(p.id) ?? 0) >= totalMembers,
      )
      .map((p) => p.name),
  }));

  res.json({
    projectName: project.name,
    exportedAt: new Date().toISOString(),
    classes: exportClasses,
  });
});

export default router;
