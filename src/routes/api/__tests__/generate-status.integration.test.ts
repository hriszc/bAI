import { eq } from "drizzle-orm";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import { createTestDb, applyMigrations, seedUser } from "#test/db-setup";
import { user as userTable } from "@/lib/db/schema/auth.schema";

const mocks = vi.hoisted(() => {
  const mockGetSession = vi.fn();
  const mockPollReplicate = vi.fn();
  const mockPollGrsai = vi.fn();
  const mockGenerateImageFallback = vi.fn();
  const mockGenerateVideoFallback = vi.fn();
  const mockMirrorImageToR2 = vi.fn((url: string) => Promise.resolve(url));
  const mockFilterSafeImageUrls = vi.fn(
    (urls: string[]): Promise<{ safeUrls: string[]; blockedUrls: string[] }> =>
      Promise.resolve({ safeUrls: urls, blockedUrls: [] }),
  );
  return {
    mockGetSession,
    mockPollReplicate,
    mockPollGrsai,
    mockGenerateImageFallback,
    mockGenerateVideoFallback,
    mockMirrorImageToR2,
    mockFilterSafeImageUrls,
  };
});

vi.mock("@/lib/auth/auth", () => ({
  createAuth: () => ({
    api: { getSession: mocks.mockGetSession },
  }),
}));

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: () => ({ allowed: true, remaining: 59, resetAt: Date.now() + 60000 }),
}));

vi.mock("@/lib/ai", () => ({
  pollReplicatePrediction: mocks.mockPollReplicate,
  pollGrsaiResult: mocks.mockPollGrsai,
}));

vi.mock("@/lib/ai/fallback", () => ({
  generateImageFallback: mocks.mockGenerateImageFallback,
  generateVideoFallback: mocks.mockGenerateVideoFallback,
}));

vi.mock("@/lib/cloudflare/r2", () => ({
  mirrorImageToR2: mocks.mockMirrorImageToR2,
}));

vi.mock("@/lib/ai/nsfw", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ai/nsfw")>();
  return {
    ...actual,
    filterSafeImageUrls: mocks.mockFilterSafeImageUrls,
  };
});

vi.mock("@/lib/db", () => ({
  getDb: (b: any) => b,
}));

import { CONTENT_SAFETY_BLOCK_MESSAGE } from "@/lib/ai/nsfw";
import { generation } from "@/lib/db/schema/data-flywheel.schema";
import { handleGenerateStatus } from "@/routes/api/generate-status";

function makeRequest(params: string): Request {
  return {
    url: `https://batchlyai.com/api/generate-status?${params}`,
    headers: new Headers({ "CF-Connecting-IP": "1.2.3.4" }),
  } as unknown as Request;
}

function makeRequestWithWaitUntil(params: string) {
  const deferred: Promise<unknown>[] = [];
  return {
    request: {
      url: `https://batchlyai.com/api/generate-status?${params}`,
      headers: new Headers({ "CF-Connecting-IP": "1.2.3.4" }),
      waitUntil: (promise: Promise<unknown>) => {
        deferred.push(promise);
      },
    } as unknown as Request,
    waitForDeferred: () => Promise.all(deferred),
  };
}

describe("handleGenerateStatus", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.mockGetSession.mockResolvedValue({ user: { id: "u1" } });
    mocks.mockPollGrsai.mockResolvedValue({ status: "processing", urls: null, error: null });
    mocks.mockGenerateImageFallback.mockRejectedValue(new Error("fallback unavailable"));
    mocks.mockGenerateVideoFallback.mockRejectedValue(new Error("fallback unavailable"));
    mocks.mockFilterSafeImageUrls.mockImplementation((urls: string[]) =>
      Promise.resolve({ safeUrls: urls, blockedUrls: [] }),
    );
    delete (globalThis as Record<string, unknown>).__env__;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns 401 when not authenticated", async () => {
    mocks.mockGetSession.mockResolvedValue(null);
    const resp = await handleGenerateStatus(makeRequest("ids=pred-1"));
    expect(resp.status).toBe(401);
  });

  it("allows guest polling with guest token", async () => {
    mocks.mockGetSession.mockResolvedValue(null);
    const mockKv = {
      get: vi.fn((key: string) => {
        if (key === "guest:pred-1") {
          return Promise.resolve(JSON.stringify({ guestToken: "guest-123" }));
        }
        return Promise.resolve(null);
      }),
    };
    (globalThis as Record<string, unknown>).__env__ = { batchlyai_kv: mockKv };

    const req = {
      url: "https://batchlyai.com/api/generate-status?ids=pred-1&type=replicate",
      headers: new Headers({ "x-guest-token": "guest-123" }),
    } as unknown as Request;
    mocks.mockPollReplicate.mockResolvedValue({
      id: "pred-1",
      status: "processing",
      urls: null,
      error: null,
    });
    const resp = await handleGenerateStatus(req);
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { results: { status: string }[] };
    expect(body.results[0].status).toBe("processing");
  });

  it("returns 400 when ids parameter is missing", async () => {
    const resp = await handleGenerateStatus(makeRequest("other=1"));
    expect(resp.status).toBe(400);
    const body = (await resp.json()) as { error: string };
    expect(body.error).toBe("Missing ids parameter");
  });

  // --- Replicate Polling (default type) ---
  it("returns processing status for in-progress Replicate predictions", async () => {
    mocks.mockPollReplicate.mockResolvedValue({
      id: "pred-1",
      status: "processing",
      urls: null,
      error: null,
    });

    const resp = await handleGenerateStatus(makeRequest("ids=pred-1&type=replicate"));
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as {
      results: { id: string; status: string; urls: string[] | null }[];
    };
    expect(body.results[0].id).toBe("pred-1");
    expect(body.results[0].status).toBe("processing");
  });

  it("returns succeeded with image URLs for completed Replicate predictions", async () => {
    mocks.mockPollReplicate.mockResolvedValue({
      id: "pred-1",
      status: "succeeded",
      urls: ["https://replicate.delivery/pbix/abc123/output-0.png"],
      error: null,
    });

    const resp = await handleGenerateStatus(makeRequest("ids=pred-1&type=replicate"));
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as {
      results: { id: string; status: string; urls: string[] }[];
    };
    expect(body.results[0].status).toBe("succeeded");
    expect(body.results[0].urls).toEqual(["https://replicate.delivery/pbix/abc123/output-0.png"]);
  });

  it("returns failed and refunds when completed Replicate output is unsafe", async () => {
    const db = createTestDb();
    applyMigrations(db);
    seedUser(db, { id: "u1", credits: 60 });

    const genId = "gen-replicate-unsafe";
    db.insert(generation)
      .values({
        id: genId,
        userId: "u1",
        promptTemplate: "test prompt",
        resolvedPrompts: JSON.stringify(["test prompt"]),
        variableGroups: JSON.stringify([]),
        resultUrls: JSON.stringify([]),
        model: "z-image-fast",
        creditsUsed: 10,
        createdAt: Math.floor(Date.now() / 1000),
      })
      .run();

    const kvStore = new Map<string, string>();
    kvStore.set(
      "gen:pred-unsafe",
      JSON.stringify({ generationId: genId, userId: "u1", creditsUsed: 10 }),
    );
    const mockKv = {
      get: vi.fn((key: string) => Promise.resolve(kvStore.get(key) ?? null)),
      put: vi.fn((key: string, value: string) => {
        kvStore.set(key, value);
        return Promise.resolve();
      }),
    };
    (globalThis as Record<string, unknown>).__env__ = {
      batchlyai_kv: mockKv,
      batchlyai_db: db,
    };

    mocks.mockPollReplicate.mockResolvedValue({
      id: "pred-unsafe",
      status: "succeeded",
      urls: ["https://replicate.delivery/unsafe.png"],
      error: null,
    });
    mocks.mockFilterSafeImageUrls.mockResolvedValue({
      safeUrls: [] as string[],
      blockedUrls: ["https://replicate.delivery/unsafe.png"] as string[],
    });

    const resp = await handleGenerateStatus(makeRequest("ids=pred-unsafe&type=replicate"));

    expect(resp.status).toBe(200);
    const body = (await resp.json()) as {
      results: { status: string; error: string; creditsRemaining?: number }[];
    };
    expect(body.results[0].status).toBe("failed");
    expect(body.results[0].error).toBe(CONTENT_SAFETY_BLOCK_MESSAGE);
    expect(body.results[0].creditsRemaining).toBe(70);
    expect(
      db.select({ credits: userTable.credits }).from(userTable).where(eq(userTable.id, "u1")).get()
        ?.credits,
    ).toBe(70);
    const row = db
      .select({ resultUrls: generation.resultUrls })
      .from(generation)
      .where(eq(generation.id, genId))
      .get();
    expect(JSON.parse(row!.resultUrls)).toEqual([]);
    expect(mocks.mockMirrorImageToR2).not.toHaveBeenCalled();
  });

  it("polls multiple Replicate IDs and returns results for all", async () => {
    mocks.mockPollReplicate
      .mockResolvedValueOnce({
        id: "pred-1",
        status: "succeeded",
        urls: ["https://replicate.delivery/img1.png"],
        error: null,
      })
      .mockResolvedValueOnce({
        id: "pred-2",
        status: "processing",
        urls: null,
        error: null,
      });

    const resp = await handleGenerateStatus(makeRequest("ids=pred-1,pred-2&type=replicate"));
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as {
      results: { id: string; status: string; urls: string[] | null }[];
    };
    expect(body.results).toHaveLength(2);
    expect(body.results[0].status).toBe("succeeded");
    expect(body.results[1].status).toBe("processing");
  });

  it("handles Replicate poll errors gracefully", async () => {
    mocks.mockPollReplicate.mockRejectedValue(new Error("Network error"));

    const resp = await handleGenerateStatus(makeRequest("ids=pred-1&type=replicate"));
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as {
      results: { id: string; status: string; error: string }[];
    };
    expect(body.results[0].status).toBe("error");
    expect(body.results[0].error).toBe("Network error");
  });

  it("uses Workers AI fallback when a Replicate prediction fails after task creation", async () => {
    const db = createTestDb();
    applyMigrations(db);
    seedUser(db, { id: "u1", credits: 60 });

    const genId = "gen-fallback-replicate";
    db.insert(generation)
      .values({
        id: genId,
        userId: "u1",
        promptTemplate: "fallback prompt",
        resolvedPrompts: JSON.stringify(["resolved fallback prompt"]),
        variableGroups: JSON.stringify([]),
        resultUrls: JSON.stringify([]),
        model: "z-image-fast",
        creditsUsed: 10,
        createdAt: Math.floor(Date.now() / 1000),
      })
      .run();

    const kvStore = new Map<string, string>();
    kvStore.set(
      "gen:pred-fallback",
      JSON.stringify({ generationId: genId, userId: "u1", creditsUsed: 10 }),
    );
    const mockKv = {
      get: vi.fn((key: string) => Promise.resolve(kvStore.get(key) ?? null)),
      put: vi.fn((key: string, value: string) => {
        kvStore.set(key, value);
        return Promise.resolve();
      }),
    };
    (globalThis as Record<string, unknown>).__env__ = {
      batchlyai_kv: mockKv,
      batchlyai_db: db,
    };

    mocks.mockPollReplicate.mockResolvedValue({
      id: "pred-fallback",
      status: "failed",
      urls: null,
      error: "primary provider failed",
    });
    mocks.mockGenerateImageFallback.mockResolvedValue({
      urls: ["https://workers-ai.example/fallback.png"],
    });

    const resp = await handleGenerateStatus(makeRequest("ids=pred-fallback&type=replicate"));
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as {
      results: { status: string; urls: string[]; fallback?: boolean; creditsRemaining?: number }[];
    };
    expect(body.results[0]).toMatchObject({
      status: "succeeded",
      urls: ["https://workers-ai.example/fallback.png"],
      fallback: true,
    });
    expect(body.results[0].creditsRemaining).toBeUndefined();
    expect(mocks.mockGenerateImageFallback).toHaveBeenCalledWith(
      "resolved fallback prompt",
      "1:1",
      1,
    );
    expect(
      db.select({ credits: userTable.credits }).from(userTable).where(eq(userTable.id, "u1")).get()
        ?.credits,
    ).toBe(60);
    const row = db
      .select({ resultUrls: generation.resultUrls })
      .from(generation)
      .where(eq(generation.id, genId))
      .get();
    expect(JSON.parse(row!.resultUrls)).toEqual(["https://workers-ai.example/fallback.png"]);
  });

  it("refunds credits once when a Replicate prediction fails after task creation", async () => {
    const db = createTestDb();
    applyMigrations(db);
    seedUser(db, { id: "u1", credits: 60 });

    const genId = "gen-refund-replicate";
    db.insert(generation)
      .values({
        id: genId,
        userId: "u1",
        promptTemplate: "test prompt",
        resolvedPrompts: JSON.stringify(["test prompt"]),
        variableGroups: JSON.stringify([]),
        resultUrls: JSON.stringify([]),
        model: "z-image-pro",
        creditsUsed: 40,
        createdAt: Math.floor(Date.now() / 1000),
      })
      .run();

    const kvStore = new Map<string, string>();
    kvStore.set(
      "gen:pred-fail",
      JSON.stringify({
        generationId: genId,
        userId: "u1",
        creditsUsed: 40,
        predictionIds: ["pred-fail", "pred-ok"],
      }),
    );
    const mockKv = {
      get: vi.fn((key: string) => Promise.resolve(kvStore.get(key) ?? null)),
      put: vi.fn((key: string, value: string) => {
        kvStore.set(key, value);
        return Promise.resolve();
      }),
    };
    (globalThis as Record<string, unknown>).__env__ = {
      batchlyai_kv: mockKv,
      batchlyai_db: db,
    };

    mocks.mockPollReplicate.mockResolvedValue({
      id: "pred-fail",
      status: "failed",
      urls: null,
      error: "provider failed",
    });

    const firstResp = await handleGenerateStatus(makeRequest("ids=pred-fail&type=replicate"));
    expect(firstResp.status).toBe(200);
    const firstBody = (await firstResp.json()) as {
      results: { status: string; creditsRemaining?: number }[];
    };
    expect(firstBody.results[0].status).toBe("failed");
    expect(firstBody.results[0].creditsRemaining).toBe(80);
    expect(
      db.select({ credits: userTable.credits }).from(userTable).where(eq(userTable.id, "u1")).get()
        ?.credits,
    ).toBe(80);

    const secondResp = await handleGenerateStatus(makeRequest("ids=pred-fail&type=replicate"));
    expect(secondResp.status).toBe(200);
    expect(
      db.select({ credits: userTable.credits }).from(userTable).where(eq(userTable.id, "u1")).get()
        ?.credits,
    ).toBe(80);
  });

  it("refunds credits once when polling times out after task creation", async () => {
    const db = createTestDb();
    applyMigrations(db);
    seedUser(db, { id: "u1", credits: 60 });

    const genId = "gen-timeout-refund";
    db.insert(generation)
      .values({
        id: genId,
        userId: "u1",
        promptTemplate: "test prompt",
        resolvedPrompts: JSON.stringify(["test prompt"]),
        variableGroups: JSON.stringify([]),
        resultUrls: JSON.stringify([]),
        model: "z-image-pro",
        creditsUsed: 40,
        createdAt: Math.floor(Date.now() / 1000) - 6 * 60,
      })
      .run();

    const kvStore = new Map<string, string>();
    kvStore.set(
      "gen:pred-timeout",
      JSON.stringify({
        generationId: genId,
        userId: "u1",
        creditsUsed: 40,
        predictionIds: ["pred-timeout", "pred-other"],
      }),
    );
    const mockKv = {
      get: vi.fn((key: string) => Promise.resolve(kvStore.get(key) ?? null)),
      put: vi.fn((key: string, value: string) => {
        kvStore.set(key, value);
        return Promise.resolve();
      }),
    };
    (globalThis as Record<string, unknown>).__env__ = {
      batchlyai_kv: mockKv,
      batchlyai_db: db,
    };

    const firstResp = await handleGenerateStatus(
      makeRequest("ids=pred-timeout&type=replicate&timeout=1"),
    );
    expect(firstResp.status).toBe(200);
    const firstBody = (await firstResp.json()) as {
      results: { status: string; error: string; creditsRemaining?: number }[];
    };
    expect(firstBody.results[0].status).toBe("failed");
    expect(firstBody.results[0].error).toBe("Generation timed out");
    expect(firstBody.results[0].creditsRemaining).toBe(80);
    expect(
      db.select({ credits: userTable.credits }).from(userTable).where(eq(userTable.id, "u1")).get()
        ?.credits,
    ).toBe(80);

    const secondResp = await handleGenerateStatus(
      makeRequest("ids=pred-timeout&type=replicate&timeout=1"),
    );
    expect(secondResp.status).toBe(200);
    expect(
      db.select({ credits: userTable.credits }).from(userTable).where(eq(userTable.id, "u1")).get()
        ?.credits,
    ).toBe(80);
  });

  it("does not refund a timeout before the server-side minimum wait has elapsed", async () => {
    const db = createTestDb();
    applyMigrations(db);
    seedUser(db, { id: "u1", credits: 60 });

    const genId = "gen-timeout-too-soon";
    db.insert(generation)
      .values({
        id: genId,
        userId: "u1",
        promptTemplate: "test prompt",
        resolvedPrompts: JSON.stringify(["test prompt"]),
        variableGroups: JSON.stringify([]),
        resultUrls: JSON.stringify([]),
        model: "z-image-pro",
        creditsUsed: 40,
        createdAt: Math.floor(Date.now() / 1000),
      })
      .run();

    const kvStore = new Map<string, string>();
    kvStore.set(
      "gen:pred-too-soon",
      JSON.stringify({
        generationId: genId,
        userId: "u1",
        creditsUsed: 40,
        predictionIds: ["pred-too-soon", "pred-other"],
      }),
    );
    const mockKv = {
      get: vi.fn((key: string) => Promise.resolve(kvStore.get(key) ?? null)),
      put: vi.fn((key: string, value: string) => {
        kvStore.set(key, value);
        return Promise.resolve();
      }),
    };
    (globalThis as Record<string, unknown>).__env__ = {
      batchlyai_kv: mockKv,
      batchlyai_db: db,
    };

    const resp = await handleGenerateStatus(
      makeRequest("ids=pred-too-soon&type=replicate&timeout=1"),
    );
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as {
      results: { status: string; creditsRemaining?: number }[];
    };
    expect(body.results[0].status).toBe("failed");
    expect(body.results[0].creditsRemaining).toBeUndefined();
    expect(
      db.select({ credits: userTable.credits }).from(userTable).where(eq(userTable.id, "u1")).get()
        ?.credits,
    ).toBe(60);
  });

  it("rejects timeout refund for another user's prediction", async () => {
    const kvStore = new Map<string, string>();
    kvStore.set(
      "gen:pred-other-user",
      JSON.stringify({ generationId: "gen-other-user", userId: "u2", creditsUsed: 40 }),
    );
    const mockKv = {
      get: vi.fn((key: string) => Promise.resolve(kvStore.get(key) ?? null)),
      put: vi.fn(),
    };
    (globalThis as Record<string, unknown>).__env__ = { batchlyai_kv: mockKv };

    const resp = await handleGenerateStatus(
      makeRequest("ids=pred-other-user&type=replicate&timeout=1"),
    );
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { results: { status: string; error: string }[] };
    expect(body.results[0].status).toBe("error");
    expect(body.results[0].error).toBe("Not found");
  });

  // --- GRS Polling (KV-based) ---
  it("returns processing when GRS task is still processing in KV", async () => {
    const mockKv = {
      get: vi.fn().mockResolvedValue(JSON.stringify({ userId: "u1", status: "processing" })),
      put: vi.fn(),
    };
    (globalThis as Record<string, unknown>).__env__ = { batchlyai_kv: mockKv };

    const resp = await handleGenerateStatus(makeRequest("ids=grs-1&type=grs"));
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as {
      results: { id: string; status: string }[];
    };
    expect(body.results[0].status).toBe("processing");
    expect(mocks.mockPollGrsai).toHaveBeenCalledWith("grs-1");
  });

  it("polls the GRS result endpoint and persists succeeded URLs before webhook arrives", async () => {
    const db = createTestDb();
    applyMigrations(db);
    seedUser(db, { id: "u1" });

    const genId = "gen-grs-result-poll";
    db.insert(generation)
      .values({
        id: genId,
        userId: "u1",
        promptTemplate: "test prompt",
        resolvedPrompts: JSON.stringify(["test prompt"]),
        variableGroups: JSON.stringify([]),
        resultUrls: JSON.stringify([]),
        model: "z-image-pro",
        creditsUsed: 20,
        createdAt: Math.floor(Date.now() / 1000),
      })
      .run();

    const kvStore = new Map<string, string>();
    kvStore.set("grs:grs-polled", JSON.stringify({ userId: "u1", status: "processing" }));
    kvStore.set("gen:grs-polled", JSON.stringify({ generationId: genId, userId: "u1" }));
    const mockKv = {
      get: vi.fn((key: string) => Promise.resolve(kvStore.get(key) ?? null)),
      put: vi.fn((key: string, value: string) => {
        kvStore.set(key, value);
        return Promise.resolve();
      }),
    };
    (globalThis as Record<string, unknown>).__env__ = {
      batchlyai_kv: mockKv,
      batchlyai_db: db,
    };
    mocks.mockPollGrsai.mockResolvedValue({
      status: "succeeded",
      urls: ["https://grs-cdn.com/result.png"],
      error: null,
    });

    const { request, waitForDeferred } = makeRequestWithWaitUntil("ids=grs-polled&type=grs");
    const resp = await handleGenerateStatus(request);
    expect(resp.status).toBe(200);
    await waitForDeferred();
    const body = (await resp.json()) as {
      results: { status: string; urls: string[] }[];
    };
    expect(body.results[0].status).toBe("succeeded");
    expect(body.results[0].urls).toEqual(["https://grs-cdn.com/result.png"]);
    expect(JSON.parse(kvStore.get("grs:grs-polled")!).status).toBe("succeeded");
    expect(JSON.parse(kvStore.get("grs:grs-polled")!).urls).toEqual([
      "https://grs-cdn.com/result.png",
    ]);
    const row = db
      .select({ resultUrls: generation.resultUrls })
      .from(generation)
      .where(eq(generation.id, genId))
      .get();
    expect(JSON.parse(row!.resultUrls)).toEqual(["https://grs-cdn.com/result.png"]);
  });

  it("polls the GRS result endpoint and refunds when it reports failure", async () => {
    const db = createTestDb();
    applyMigrations(db);
    seedUser(db, { id: "u1", credits: 20 });

    const genId = "gen-grs-result-failed";
    db.insert(generation)
      .values({
        id: genId,
        userId: "u1",
        promptTemplate: "test prompt",
        resolvedPrompts: JSON.stringify(["test prompt"]),
        variableGroups: JSON.stringify([]),
        resultUrls: JSON.stringify([]),
        model: "z-image-pro",
        creditsUsed: 20,
        createdAt: Math.floor(Date.now() / 1000),
      })
      .run();

    const kvStore = new Map<string, string>();
    kvStore.set("grs:grs-failed-poll", JSON.stringify({ userId: "u1", status: "processing" }));
    kvStore.set(
      "gen:grs-failed-poll",
      JSON.stringify({ generationId: genId, userId: "u1", creditsUsed: 20 }),
    );
    const mockKv = {
      get: vi.fn((key: string) => Promise.resolve(kvStore.get(key) ?? null)),
      put: vi.fn((key: string, value: string) => {
        kvStore.set(key, value);
        return Promise.resolve();
      }),
    };
    (globalThis as Record<string, unknown>).__env__ = {
      batchlyai_kv: mockKv,
      batchlyai_db: db,
    };
    mocks.mockPollGrsai.mockResolvedValue({
      status: "failed",
      urls: null,
      error: "output_moderation",
    });

    const resp = await handleGenerateStatus(makeRequest("ids=grs-failed-poll&type=grs"));
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as {
      results: { status: string; error: string; creditsRemaining?: number }[];
    };
    expect(body.results[0].status).toBe("failed");
    expect(body.results[0].error).toBe("output_moderation");
    expect(body.results[0].creditsRemaining).toBe(40);
    expect(JSON.parse(kvStore.get("grs:grs-failed-poll")!).status).toBe("failed");
  });

  it("uses Workers AI fallback when the GRS result endpoint reports failure", async () => {
    const db = createTestDb();
    applyMigrations(db);
    seedUser(db, { id: "u1", credits: 20 });

    const genId = "gen-grs-fallback";
    db.insert(generation)
      .values({
        id: genId,
        userId: "u1",
        promptTemplate: "fallback grs prompt",
        resolvedPrompts: JSON.stringify(["resolved grs prompt"]),
        variableGroups: JSON.stringify([]),
        resultUrls: JSON.stringify([]),
        model: "z-image-pro",
        creditsUsed: 20,
        createdAt: Math.floor(Date.now() / 1000),
      })
      .run();

    const kvStore = new Map<string, string>();
    kvStore.set("grs:grs-fallback", JSON.stringify({ userId: "u1", status: "processing" }));
    kvStore.set(
      "gen:grs-fallback",
      JSON.stringify({ generationId: genId, userId: "u1", creditsUsed: 20 }),
    );
    const mockKv = {
      get: vi.fn((key: string) => Promise.resolve(kvStore.get(key) ?? null)),
      put: vi.fn((key: string, value: string) => {
        kvStore.set(key, value);
        return Promise.resolve();
      }),
    };
    (globalThis as Record<string, unknown>).__env__ = {
      batchlyai_kv: mockKv,
      batchlyai_db: db,
    };
    mocks.mockPollGrsai.mockResolvedValue({
      status: "failed",
      urls: null,
      error: "upstream error",
    });
    mocks.mockGenerateImageFallback.mockResolvedValue({
      urls: ["https://workers-ai.example/grs-fallback.png"],
    });

    const resp = await handleGenerateStatus(makeRequest("ids=grs-fallback&type=grs"));
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as {
      results: { status: string; urls: string[]; fallback?: boolean; creditsRemaining?: number }[];
    };
    expect(body.results[0]).toMatchObject({
      status: "succeeded",
      urls: ["https://workers-ai.example/grs-fallback.png"],
      fallback: true,
    });
    expect(body.results[0].creditsRemaining).toBeUndefined();
    expect(mocks.mockGenerateImageFallback).toHaveBeenCalledWith("resolved grs prompt", "1:1", 1);
    expect(
      db.select({ credits: userTable.credits }).from(userTable).where(eq(userTable.id, "u1")).get()
        ?.credits,
    ).toBe(20);
  });

  it("keeps GRS task processing when result polling has a transient error", async () => {
    const mockKv = {
      get: vi.fn().mockResolvedValue(JSON.stringify({ userId: "u1", status: "processing" })),
      put: vi.fn(),
    };
    (globalThis as Record<string, unknown>).__env__ = { batchlyai_kv: mockKv };
    mocks.mockPollGrsai.mockRejectedValue(new Error("temporary gateway issue"));

    const resp = await handleGenerateStatus(makeRequest("ids=grs-transient&type=grs"));
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as {
      results: { status: string; error: string | null; creditsRemaining?: number }[];
    };
    expect(body.results[0].status).toBe("processing");
    expect(body.results[0].error).toBeNull();
    expect(body.results[0].creditsRemaining).toBeUndefined();
    expect(mockKv.put).not.toHaveBeenCalled();
  });

  it("returns succeeded with image URLs when GRS webhook has completed", async () => {
    const taskData = {
      userId: "u1",
      status: "succeeded",
      urls: ["https://grs-cdn.com/output/image1.png", "https://grs-cdn.com/output/image2.png"],
    };
    const mockKv = {
      get: vi.fn().mockResolvedValue(JSON.stringify(taskData)),
    };
    (globalThis as Record<string, unknown>).__env__ = { batchlyai_kv: mockKv };

    const resp = await handleGenerateStatus(makeRequest("ids=grs-1&type=grs"));
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as {
      results: { id: string; status: string; urls: string[] }[];
    };
    expect(body.results[0].status).toBe("succeeded");
    expect(body.results[0].urls).toEqual([
      "https://grs-cdn.com/output/image1.png",
      "https://grs-cdn.com/output/image2.png",
    ]);
  });

  it("returns failed when completed GRS webhook URLs are unsafe", async () => {
    const kvStore = new Map<string, string>();
    kvStore.set(
      "grs:grs-unsafe",
      JSON.stringify({
        userId: "u1",
        status: "succeeded",
        urls: ["https://grs-cdn.com/output/unsafe.png"],
      }),
    );
    const mockKv = {
      get: vi.fn((key: string) => Promise.resolve(kvStore.get(key) ?? null)),
      put: vi.fn((key: string, value: string) => {
        kvStore.set(key, value);
        return Promise.resolve();
      }),
    };
    (globalThis as Record<string, unknown>).__env__ = { batchlyai_kv: mockKv };
    mocks.mockFilterSafeImageUrls.mockResolvedValue({
      safeUrls: [] as string[],
      blockedUrls: ["https://grs-cdn.com/output/unsafe.png"] as string[],
    });

    const resp = await handleGenerateStatus(makeRequest("ids=grs-unsafe&type=grs"));

    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { results: { status: string; error: string }[] };
    expect(body.results[0].status).toBe("failed");
    expect(body.results[0].error).toBe(CONTENT_SAFETY_BLOCK_MESSAGE);
    expect(JSON.parse(kvStore.get("grs:grs-unsafe")!).status).toBe("failed");
  });

  it("returns failed with error when GRS webhook reports failure", async () => {
    const taskData = {
      userId: "u1",
      status: "failed",
      error: "NSFW content detected",
    };
    const mockKv = {
      get: vi.fn().mockResolvedValue(JSON.stringify(taskData)),
    };
    (globalThis as Record<string, unknown>).__env__ = { batchlyai_kv: mockKv };

    const resp = await handleGenerateStatus(makeRequest("ids=grs-1&type=grs"));
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as {
      results: { id: string; status: string; error: string }[];
    };
    expect(body.results[0].status).toBe("failed");
    expect(body.results[0].error).toBe("NSFW content detected");
  });

  it("returns processing when KV key does not exist yet", async () => {
    const mockKv = { get: vi.fn().mockResolvedValue(null) };
    (globalThis as Record<string, unknown>).__env__ = { batchlyai_kv: mockKv };

    const resp = await handleGenerateStatus(makeRequest("ids=grs-1&type=grs"));
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as {
      results: { id: string; status: string }[];
    };
    expect(body.results[0].status).toBe("processing");
  });

  it("returns error when KV is not available", async () => {
    // No __env__ set — KV not available
    const resp = await handleGenerateStatus(makeRequest("ids=grs-1&type=grs"));
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as {
      results: { id: string; status: string; error: string }[];
    };
    expect(body.results[0].status).toBe("error");
    expect(body.results[0].error).toBe("KV not available");
  });

  it("rejects replicate polling for mismatched guest token", async () => {
    const mockKv = {
      get: vi.fn((key: string) => {
        if (key === "guest:pred-1") {
          return Promise.resolve(JSON.stringify({ guestToken: "guest-abc" }));
        }
        return Promise.resolve(null);
      }),
    };
    (globalThis as Record<string, unknown>).__env__ = { batchlyai_kv: mockKv };
    mocks.mockGetSession.mockResolvedValue(null);

    const req = {
      url: "https://batchlyai.com/api/generate-status?ids=pred-1&type=replicate",
      headers: new Headers({ "x-guest-token": "guest-wrong" }),
    } as unknown as Request;
    const resp = await handleGenerateStatus(req);
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { results: { status: string; error: string }[] };
    expect(body.results[0].status).toBe("error");
    expect(body.results[0].error).toBe("Not found");
  });

  // --- Generation record update via poll results ---
  it("updates generation resultUrls when Replicate poll returns succeeded", async () => {
    const db = createTestDb();
    applyMigrations(db);
    seedUser(db, { id: "u1" });

    // Pre-insert generation record
    const genId = "gen-test-001";
    db.insert(generation)
      .values({
        id: genId,
        userId: "u1",
        promptTemplate: "test prompt",
        resolvedPrompts: JSON.stringify(["test prompt"]),
        variableGroups: JSON.stringify([]),
        resultUrls: JSON.stringify([]),
        model: "z-image-fast",
        creditsUsed: 10,
        createdAt: Math.floor(Date.now() / 1000),
      })
      .run();

    // Set up KV with generation mapping
    const kvStore = new Map<string, string>();
    kvStore.set("gen:pred-abc", JSON.stringify({ generationId: genId }));
    const mockKv = {
      get: vi.fn((key: string) => Promise.resolve(kvStore.get(key) ?? null)),
      put: vi.fn(),
    };

    (globalThis as Record<string, unknown>).__env__ = {
      batchlyai_kv: mockKv,
      batchlyai_db: db,
    };

    mocks.mockPollReplicate.mockResolvedValue({
      id: "pred-abc",
      status: "succeeded",
      urls: ["https://replicate.delivery/test-output.png"],
      error: null,
    });

    await handleGenerateStatus(makeRequest("ids=pred-abc&type=replicate"));

    // Wait for async update
    await new Promise((r) => setTimeout(r, 100));

    // Verify generation was updated
    const row = db
      .select({ resultUrls: generation.resultUrls })
      .from(generation)
      .where(eq(generation.id, genId))
      .get();
    expect(row).toBeDefined();
    const urls = JSON.parse(row!.resultUrls);
    expect(urls).toEqual(["https://replicate.delivery/test-output.png"]);
  });

  it("appends resultUrls when multiple async tasks finish for one generation", async () => {
    const db = createTestDb();
    applyMigrations(db);
    seedUser(db, { id: "u1" });

    const genId = "gen-test-append";
    db.insert(generation)
      .values({
        id: genId,
        userId: "u1",
        promptTemplate: "test prompt",
        resolvedPrompts: JSON.stringify(["test prompt"]),
        variableGroups: JSON.stringify([]),
        resultUrls: JSON.stringify([]),
        model: "z-image-pro",
        creditsUsed: 40,
        createdAt: Math.floor(Date.now() / 1000),
      })
      .run();

    const kvStore = new Map<string, string>();
    kvStore.set("gen:grs-a", JSON.stringify({ generationId: genId, userId: "u1" }));
    kvStore.set("gen:grs-b", JSON.stringify({ generationId: genId, userId: "u1" }));
    kvStore.set(
      "grs:grs-a",
      JSON.stringify({ userId: "u1", status: "succeeded", urls: ["https://cdn/a.png"] }),
    );
    kvStore.set(
      "grs:grs-b",
      JSON.stringify({ userId: "u1", status: "succeeded", urls: ["https://cdn/b.png"] }),
    );
    const mockKv = {
      get: vi.fn((key: string) => Promise.resolve(kvStore.get(key) ?? null)),
      put: vi.fn(),
    };

    (globalThis as Record<string, unknown>).__env__ = {
      batchlyai_kv: mockKv,
      batchlyai_db: db,
    };

    const { request, waitForDeferred } = makeRequestWithWaitUntil("ids=grs-a,grs-b&type=grs");
    const resp = await handleGenerateStatus(request);
    expect(resp.status).toBe(200);
    await waitForDeferred();

    const row = db
      .select({ resultUrls: generation.resultUrls })
      .from(generation)
      .where(eq(generation.id, genId))
      .get();
    expect(JSON.parse(row!.resultUrls)).toEqual(["https://cdn/a.png", "https://cdn/b.png"]);
  });

  it("does not update generation when KV entry is missing", async () => {
    const db = createTestDb();
    applyMigrations(db);
    seedUser(db, { id: "u1" });

    const genId = "gen-test-002";
    db.insert(generation)
      .values({
        id: genId,
        userId: "u1",
        promptTemplate: "test",
        resolvedPrompts: JSON.stringify(["test"]),
        variableGroups: JSON.stringify([]),
        resultUrls: JSON.stringify([]),
        model: "z-image-fast",
        creditsUsed: 10,
        createdAt: Math.floor(Date.now() / 1000),
      })
      .run();

    // NO KV entry for this prediction
    const mockKv = {
      get: vi.fn(() => Promise.resolve(null)),
      put: vi.fn(),
    };
    (globalThis as Record<string, unknown>).__env__ = {
      batchlyai_kv: mockKv,
      batchlyai_db: db,
    };

    mocks.mockPollReplicate.mockResolvedValue({
      id: "pred-missing",
      status: "succeeded",
      urls: ["https://example.com/img.png"],
      error: null,
    });

    await handleGenerateStatus(makeRequest("ids=pred-missing&type=replicate"));
    await new Promise((r) => setTimeout(r, 100));

    // Generation should still have empty resultUrls
    const row = db
      .select({ resultUrls: generation.resultUrls })
      .from(generation)
      .where(eq(generation.id, genId))
      .get();
    const urls = JSON.parse(row!.resultUrls);
    expect(urls).toEqual([]);
  });
});
