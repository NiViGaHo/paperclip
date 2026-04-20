import { afterEach, describe, expect, it, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";

// Mock pino and pino-http before importing modules that depend on them.
const mockPino = vi.hoisted(() => {
  const fn = vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })),
  }));
  (fn as any).transport = vi.fn(() => ({}));
  return fn;
});
vi.mock("pino", () => ({ default: mockPino }));
vi.mock("pino-http", () => ({ pinoHttp: vi.fn(() => vi.fn()) }));

// Also stub config-file and home-paths so logger module-init doesn't fail.
vi.mock("../config-file.js", () => ({ readConfigFile: vi.fn(() => ({ logging: {} })) }));
vi.mock("../home-paths.js", () => ({
  resolvePaperclipInstanceRoot: vi.fn(() => os.tmpdir()),
  resolveDefaultLogsDir: vi.fn(() => os.tmpdir()),
  resolveHomeAwarePath: vi.fn((p: string) => p),
}));

const { createLocalFileRunLogStore } = await import("../services/run-log-store.js");
const { REDACTED_JWT_TOKEN } = await import("../log-redaction.js");

// Synthetic 3-part base64url token — fake payload, not a real key.
// Each segment is 20+ chars of base64url-safe chars to match JWT_TEXT_RE.
const FAKE_JWT =
  "AAAAAAAAAAAAAAAAAAAA.BBBBBBBBBBBBBBBBBBBB.CCCCCCCCCCCCCCCCCCCC";

// Non-global copy of JWT_TEXT_RE pattern for assertion (avoids lastIndex issues).
const JWT_PATTERN =
  /[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}(?:\.[A-Za-z0-9_-]{20,})?/;

describe("run-log-store JWT redaction", () => {
  const tempRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      tempRoots.map((root) => fs.rm(root, { recursive: true, force: true })),
    );
    tempRoots.length = 0;
  });

  it("redacts JWT tokens written via append() before persisting to ndjson", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "paperclip-run-log-"),
    );
    tempRoots.push(root);

    const store = createLocalFileRunLogStore(root);
    const ts = new Date().toISOString();

    const handle = await store.begin({
      companyId: "test-company",
      agentId: "test-agent",
      runId: "test-run-001",
    });
    await store.append(handle, {
      stream: "stdout",
      chunk: `Authorization: Bearer ${FAKE_JWT}`,
      ts,
    });
    await store.finalize(handle);

    const { content } = await store.read(handle);
    const lines = content.trim().split("\n").filter(Boolean);
    const chunks = lines
      .map((l) => (JSON.parse(l) as { chunk: string }).chunk)
      .join("\n");

    expect(chunks).toContain(REDACTED_JWT_TOKEN);
    expect(JWT_PATTERN.test(chunks)).toBe(false);
  });
});
