import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/env/server", () => ({
  env: { GRS_WEBHOOK_SECRET: "test-secret" },
}));

const mocks = vi.hoisted(() => ({
  mockGenerateImageFallback: vi.fn(),
  mockFilterSafeImageUrls: vi.fn(
    (urls: string[]): Promise<{ safeUrls: string[]; blockedUrls: string[] }> =>
      Promise.resolve({ safeUrls: urls, blockedUrls: [] }),
  ),
}));

vi.mock("@/lib/ai/fallback", () => ({
  generateImageFallback: mocks.mockGenerateImageFallback,
}));

vi.mock("@/lib/ai/nsfw", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ai/nsfw")>();
  return {
    ...actual,
    filterSafeImageUrls: mocks.mockFilterSafeImageUrls,
  };
});

import { CONTENT_SAFETY_BLOCK_MESSAGE } from "@/lib/ai/nsfw";
import { handleGrsWebhook } from "@/routes/api/grs-webhook";

async function signBody(body: string, secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(body));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function makeRequest(overrides?: { body?: Record<string, unknown> }): Promise<Request> {
  const rawBody = JSON.stringify(overrides?.body ?? {});
  const sig = await signBody(rawBody, "test-secret");
  return {
    json: () => Promise.resolve(overrides?.body ?? {}),
    text: () => Promise.resolve(rawBody),
    clone: () => ({
      text: () => Promise.resolve(rawBody),
    }),
    url: "https://batchlyai.com/api/grs-webhook",
    headers: new Headers({ "x-grs-signature": sig }),
  } as unknown as Request;
}

function getKvPutValue(
  mockKv: { put: ReturnType<typeof vi.fn> },
  key: string,
): Record<string, unknown> {
  const call = mockKv.put.mock.calls.find(([putKey]) => putKey === key);
  if (!call) throw new Error(`Missing KV put for ${key}`);
  return JSON.parse(call[1] as string) as Record<string, unknown>;
}

describe("handleGrsWebhook", () => {
  let mockKv: { get: ReturnType<typeof vi.fn>; put: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    mockKv = {
      get: vi.fn(),
      put: vi.fn().mockResolvedValue(undefined),
    };
    mocks.mockGenerateImageFallback.mockRejectedValue(new Error("fallback unavailable"));
    mocks.mockFilterSafeImageUrls.mockImplementation((urls: string[]) =>
      Promise.resolve({ safeUrls: urls, blockedUrls: [] }),
    );
    (globalThis as Record<string, unknown>).__env__ = { batchlyai_kv: mockKv };
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete (globalThis as Record<string, unknown>).__env__;
  });

  it("returns 401 when signature is wrong", async () => {
    const rawBody = JSON.stringify({ id: "test", status: "succeeded" });
    const resp = await handleGrsWebhook({
      text: () => Promise.resolve(rawBody),
      clone: () => ({ text: () => Promise.resolve(rawBody) }),
      url: "https://batchlyai.com/api/grs-webhook",
      headers: new Headers({ "x-grs-signature": "bad" }),
    } as unknown as Request);
    expect(resp.status).toBe(401);
  });

  it("returns 400 when id is missing from body", async () => {
    const resp = await handleGrsWebhook(await makeRequest({ body: {} }));
    expect(resp.status).toBe(400);
    const body = (await resp.json()) as { error: string };
    expect(body.error).toBe("Missing task id");
  });

  it("returns 404 when KV entry does not exist", async () => {
    mockKv.get.mockResolvedValue(null);
    const resp = await handleGrsWebhook(
      await makeRequest({ body: { id: "grs-nonexistent", status: "succeeded" } }),
    );
    expect(resp.status).toBe(404);
  });

  it("updates KV with succeeded status and image URLs", async () => {
    mockKv.get.mockResolvedValue(
      JSON.stringify({
        userId: "u1",
        status: "processing",
        prompt: "a cat in forest",
        createdAt: Date.now(),
      }),
    );

    const resp = await handleGrsWebhook(
      await makeRequest({
        body: {
          id: "grs-task-001",
          status: "succeeded",
          results: [
            { url: "https://grs-cdn.com/output/cat-forest-1.png" },
            { url: "https://grs-cdn.com/output/cat-forest-2.png" },
          ],
        },
      }),
    );
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { received: boolean };
    expect(body.received).toBe(true);

    expect(mockKv.put).toHaveBeenCalled();
    const putValue = JSON.parse(mockKv.put.mock.calls[0][1] as string);
    expect(putValue.status).toBe("succeeded");
    expect(putValue.urls).toEqual([
      "https://grs-cdn.com/output/cat-forest-1.png",
      "https://grs-cdn.com/output/cat-forest-2.png",
    ]);
  });

  it("accepts succeeded GRS payloads with a top-level image URL", async () => {
    mockKv.get.mockResolvedValue(
      JSON.stringify({
        userId: "u1",
        status: "processing",
        prompt: "a product photo",
        createdAt: Date.now(),
      }),
    );

    const resp = await handleGrsWebhook(
      await makeRequest({
        body: {
          id: "grs-task-top-url",
          status: "succeeded",
          url: "https://grs-cdn.com/output/product.png",
          results: null,
        },
      }),
    );

    expect(resp.status).toBe(200);
    const putValue = JSON.parse(mockKv.put.mock.calls[0][1] as string);
    expect(putValue.status).toBe("succeeded");
    expect(putValue.urls).toEqual(["https://grs-cdn.com/output/product.png"]);
  });

  it("updates KV with failed status and error message", async () => {
    mockKv.get.mockResolvedValue(
      JSON.stringify({
        userId: "u1",
        status: "processing",
        prompt: "something inappropriate",
        createdAt: Date.now(),
      }),
    );

    const resp = await handleGrsWebhook(
      await makeRequest({
        body: {
          id: "grs-task-002",
          status: "failed",
          error: "NSFW content filtered",
        },
      }),
    );
    expect(resp.status).toBe(200);

    const putValue = getKvPutValue(mockKv, "grs:grs-task-002");
    expect(putValue.status).toBe("failed");
    expect(putValue.error).toBe("NSFW content filtered");
  });

  it("uses Workers AI fallback when GRS webhook reports progress -1 failure", async () => {
    mockKv.get.mockResolvedValue(
      JSON.stringify({
        userId: "u1",
        status: "processing",
        prompt: "a cinematic product shot",
        aspectRatio: "1:1",
        createdAt: Date.now(),
      }),
    );
    mocks.mockGenerateImageFallback.mockResolvedValue({
      urls: ["https://workers-ai.example/fallback.png"],
    });

    const resp = await handleGrsWebhook(
      await makeRequest({
        body: {
          id: "13-a5b81b67-ea63-469c-8b0b-e840e9b74420",
          progress: -1,
          status: "failed",
          failure_reason: "error",
          error: "generate image failed",
          results: null,
        },
      }),
    );

    expect(resp.status).toBe(200);
    expect(mocks.mockGenerateImageFallback).toHaveBeenCalledWith(
      "a cinematic product shot",
      "1:1",
      1,
    );
    const putValue = getKvPutValue(mockKv, "grs:13-a5b81b67-ea63-469c-8b0b-e840e9b74420");
    expect(putValue.status).toBe("succeeded");
    expect(putValue.urls).toEqual(["https://workers-ai.example/fallback.png"]);
    expect(putValue.fallback).toBe(true);
    expect(putValue.error).toBeUndefined();
  });

  it("uses Workers AI fallback when GRS succeeds without image URLs", async () => {
    mockKv.get.mockResolvedValue(
      JSON.stringify({
        userId: "u1",
        status: "processing",
        prompt: "a minimal packaging render",
        aspectRatio: "4:3",
        createdAt: Date.now(),
      }),
    );
    mocks.mockGenerateImageFallback.mockResolvedValue({
      urls: ["https://workers-ai.example/no-url-fallback.png"],
    });

    const resp = await handleGrsWebhook(
      await makeRequest({
        body: {
          id: "grs-no-urls",
          status: "succeeded",
          results: null,
        },
      }),
    );

    expect(resp.status).toBe(200);
    expect(mocks.mockGenerateImageFallback).toHaveBeenCalledWith(
      "a minimal packaging render",
      "4:3",
      1,
    );
    const putValue = getKvPutValue(mockKv, "grs:grs-no-urls");
    expect(putValue.status).toBe("succeeded");
    expect(putValue.urls).toEqual(["https://workers-ai.example/no-url-fallback.png"]);
    expect(putValue.fallback).toBe(true);
  });

  it("stores failed status when succeeded webhook output fails content safety", async () => {
    mockKv.get.mockResolvedValue(
      JSON.stringify({
        userId: "u1",
        status: "processing",
        prompt: "test",
        createdAt: Date.now(),
      }),
    );
    mocks.mockFilterSafeImageUrls.mockResolvedValue({
      safeUrls: [] as string[],
      blockedUrls: ["https://grs-cdn.com/output/unsafe.png"] as string[],
    });

    const resp = await handleGrsWebhook(
      await makeRequest({
        body: {
          id: "grs-task-unsafe",
          status: "succeeded",
          results: [{ url: "https://grs-cdn.com/output/unsafe.png" }],
        },
      }),
    );

    expect(resp.status).toBe(200);
    const putValue = JSON.parse(mockKv.put.mock.calls[0][1] as string);
    expect(putValue.status).toBe("failed");
    expect(putValue.urls).toBeUndefined();
    expect(putValue.error).toBe(CONTENT_SAFETY_BLOCK_MESSAGE);
  });

  it("preserves userId and prompt in updated KV entry", async () => {
    const originalTask = {
      userId: "user-abc-123",
      status: "processing",
      prompt: "beautiful sunset over ocean",
      aspectRatio: "16:9",
      createdAt: 1700000000000,
    };
    mockKv.get.mockResolvedValue(JSON.stringify(originalTask));

    await handleGrsWebhook(
      await makeRequest({
        body: {
          id: "grs-task-003",
          status: "succeeded",
          results: [{ url: "https://grs-cdn.com/sunset.png" }],
        },
      }),
    );

    const putValue = JSON.parse(mockKv.put.mock.calls[0][1] as string);
    expect(putValue.userId).toBe("user-abc-123");
    expect(putValue.prompt).toBe("beautiful sunset over ocean");
    expect(putValue.status).toBe("succeeded");
    expect(putValue.urls).toEqual(["https://grs-cdn.com/sunset.png"]);
  });

  it("stores correct KV key format for frontend polling to find", async () => {
    mockKv.get.mockResolvedValue(
      JSON.stringify({ userId: "u1", status: "processing", prompt: "test", createdAt: 1 }),
    );

    await handleGrsWebhook(
      await makeRequest({
        body: {
          id: "grs-task-kv-key",
          status: "succeeded",
          results: [{ url: "https://example.com/img.png" }],
        },
      }),
    );

    expect(mockKv.put).toHaveBeenCalledWith("grs:grs-task-kv-key", expect.any(String), {
      expirationTtl: 3600,
    });
  });
});
