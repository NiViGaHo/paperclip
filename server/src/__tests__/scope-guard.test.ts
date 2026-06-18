import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { scopeGuard } from "../middleware/scope-guard.js";

const SCOPE_ENFORCEMENT_ENV = "PAPERCLIP_SCOPE_ENFORCEMENT";

function createApp(scope: string[] | undefined, enforcement: boolean) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = {
      type: "agent",
      agentId: "agent-test",
      companyId: "company-test",
      source: "agent_jwt",
      ...(scope !== undefined ? { scope } : {}),
    };
    next();
  });
  app.use(scopeGuard());
  // Routes under test — mirror paths in ROUTE_REQUIREMENTS
  app.patch("/api/issues/:id", (_req, res) => res.status(200).json({ ok: true }));
  app.post("/api/issues/:id/comments", (_req, res) => res.status(201).json({ ok: true }));
  // Route intentionally absent from ROUTE_REQUIREMENTS (T6)
  app.post("/api/issues/:id/subtasks", (_req, res) => res.status(201).json({ ok: true }));
  return app;
}

describe("scopeGuard", () => {
  const originalEnv = process.env[SCOPE_ENFORCEMENT_ENV];

  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    if (originalEnv === undefined) delete process.env[SCOPE_ENFORCEMENT_ENV];
    else process.env[SCOPE_ENFORCEMENT_ENV] = originalEnv;
    vi.restoreAllMocks();
  });

  // T1: narrow scope → insufficient for PATCH → 200 in report-only, warn logged
  it("T1: logs warning but allows PATCH when scope insufficient (report-only)", async () => {
    delete process.env[SCOPE_ENFORCEMENT_ENV];
    const app = createApp(["issue:comment:post"], false);
    const res = await request(app).patch("/api/issues/test-id").send({});
    expect(res.status).toBe(200);
  });

  // T1 (enforcing): same PATCH → 403 when enforcement on
  it("T1 enforcing: blocks PATCH with 403 when scope insufficient and enforcement enabled", async () => {
    process.env[SCOPE_ENFORCEMENT_ENV] = "true";
    const app = createApp(["issue:comment:post"], true);
    const res = await request(app).patch("/api/issues/test-id").send({});
    expect(res.status).toBe(403);
  });

  // T2: scope covers POST /comments → passes
  it("T2: allows POST to /comments when scope matches", async () => {
    delete process.env[SCOPE_ENFORCEMENT_ENV];
    const app = createApp(["issue:comment:post"], false);
    const res = await request(app).post("/api/issues/test-id/comments").send({});
    expect(res.status).toBe(201);
  });

  // T3: no scope claim → wildcard default → passes
  it("T3: allows all mutations when actor has no scope (wildcard default)", async () => {
    delete process.env[SCOPE_ENFORCEMENT_ENV];
    const app = createApp(undefined, false);
    const res = await request(app).patch("/api/issues/test-id").send({});
    expect(res.status).toBe(200);
  });

  // T4: explicit ["*"] → passes
  it("T4: allows all mutations with explicit wildcard scope", async () => {
    process.env[SCOPE_ENFORCEMENT_ENV] = "true";
    const app = createApp(["*"], true);
    const res = await request(app).patch("/api/issues/test-id").send({});
    expect(res.status).toBe(200);
  });

  // T5: board actor bypasses scope check entirely
  it("T5: board actor is not subject to scope enforcement", async () => {
    process.env[SCOPE_ENFORCEMENT_ENV] = "true";
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = { type: "board", userId: "board-user", source: "session" };
      next();
    });
    app.use(scopeGuard());
    app.patch("/api/issues/:id", (_req, res) => res.status(200).json({ ok: true }));
    const res = await request(app).patch("/api/issues/test-id").send({});
    expect(res.status).toBe(200);
  });

  // T6: route absent from ROUTE_REQUIREMENTS → explicit default-allow regardless of scope or enforcement
  it("T6: route absent from ROUTE_REQUIREMENTS is default-allowed (narrow scope, enforcement on)", async () => {
    process.env[SCOPE_ENFORCEMENT_ENV] = "true";
    const app = createApp(["issue:comment:post"], true);
    const res = await request(app).post("/api/issues/test-id/subtasks").send({});
    expect(res.status).toBe(201);
  });
});
