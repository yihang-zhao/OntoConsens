import { Router, type IRouter } from "express";
import { db, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { RegisterBody, LoginBody } from "@workspace/api-zod";
import {
  hashPassword,
  verifyPassword,
  createSessionToken,
  destroySessionToken,
  requireAuth,
} from "../lib/auth";

const router: IRouter = Router();

router.post("/auth/register", async (req, res) => {
  const parsed = RegisterBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input", details: parsed.error.issues });
    return;
  }
  const { username, password } = parsed.data;

  const existing = await db.query.usersTable.findFirst({
    where: eq(usersTable.username, username),
  });
  if (existing) {
    res.status(409).json({ error: "Username already taken" });
    return;
  }

  const passwordHash = await hashPassword(password);
  const [user] = await db
    .insert(usersTable)
    .values({ username, passwordHash })
    .returning();

  if (!user) {
    res.status(500).json({ error: "Failed to create user" });
    return;
  }

  const token = createSessionToken(user.id);
  res.status(201).json({ id: user.id, username: user.username, token });
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
  res.json({ id: user.id, username: user.username, token });
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
  res.json({ id: user.id, username: user.username });
});

export default router;
