import { createFileRoute } from "@tanstack/react-router";
import { eq, sql } from "drizzle-orm";

import { pollGrsaiResult, pollReplicatePrediction } from "@/lib/ai";
import { generateImageFallback, generateVideoFallback } from "@/lib/ai/fallback";
import { CONTENT_SAFETY_BLOCK_MESSAGE, filterSafeImageUrls } from "@/lib/ai/nsfw";
import { jsonResponse } from "@/lib/api-helpers";
import { createAuth } from "@/lib/auth/auth";
import { getD1Binding, getKvBinding } from "@/lib/cloudflare/bindings";
import { mirrorImageToR2 } from "@/lib/cloudflare/r2";
import { recordAiCreditSpend } from "@/lib/credits/audit";
import { getDb } from "@/lib/db";
import { user as userTable } from "@/lib/db/schema/auth.schema";
import { generation } from "@/lib/db/schema/data-flywheel.schema";
import { checkRateLimit } from "@/lib/rate-limit";

interface GrsTaskData {
  userId: string;
  status: string;
  urls?: string[];
  error?: string;
  prompt?: string;
  aspectRatio?: string;
  createdAt?: number;
}

interface GenerationTaskData {
  generationId?: string;
  userId?: string;
  creditsUsed?: number;
  predictionIds?: string[];
}

interface StatusResult {
  id: string;
  status: string;
  urls: string[] | null;
  error: string | null;
  creditsRemaining?: number;
  fallback?: boolean;
}

function mergeUniqueUrls(existing: string[], incoming: string[]): string[] {
  return [...new Set([...existing, ...incoming])];
}

function parseStringList(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === "string")
      : [];
  } catch {
    return [];
  }
}

function safePathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function parseOwnerId(raw: string | null): string | null {
  return parseGenerationTaskData(raw)?.userId ?? null;
}

function parseGuestToken(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const data = JSON.parse(raw) as { guestToken?: string };
    return typeof data.guestToken === "string" ? data.guestToken : null;
  } catch {
    return null;
  }
}

function parseGenerationTaskData(raw: string | null): GenerationTaskData | null {
  if (!raw) return null;
  try {
    const data = JSON.parse(raw) as GenerationTaskData;
    return data && typeof data === "object" ? data : null;
  } catch {
    return null;
  }
}

function isRefundableStatus(status: string): boolean {
  return status === "failed" || status === "canceled" || status === "error";
}

function isTimeoutRequest(url: URL): boolean {
  return url.searchParams.get("timeout") === "1";
}

async function timeoutPendingPrediction(
  kv: KVNamespace | undefined,
  predictionId: string,
  sessionUserId: string | null,
  guestToken: string | null,
): Promise<StatusResult> {
  if (kv) {
    const guestRaw = await kv.get(`guest:${predictionId}`);
    if (guestRaw) {
      const guestOwner = parseGuestToken(guestRaw);
      if (!guestToken || guestOwner !== guestToken) {
        return { id: predictionId, status: "error", urls: null, error: "Not found" };
      }
    } else {
      const ownerId = parseOwnerId(await kv.get(`gen:${predictionId}`));
      if (ownerId && ownerId !== sessionUserId) {
        return { id: predictionId, status: "error", urls: null, error: "Not found" };
      }
    }
  }

  const result: StatusResult = {
    id: predictionId,
    status: "failed",
    urls: null,
    error: "Generation timed out",
  };
  const creditsRemaining = await refundFailedPrediction(kv, predictionId, sessionUserId, {
    requireTimeoutAge: true,
  });
  return creditsRemaining == null ? result : { ...result, creditsRemaining };
}

async function refundFailedPrediction(
  kv: KVNamespace | undefined,
  predictionId: string,
  sessionUserId: string | null,
  options: { requireTimeoutAge?: boolean } = {},
): Promise<number | undefined> {
  if (!kv || !sessionUserId) return undefined;

  const genData = parseGenerationTaskData(await kv.get(`gen:${predictionId}`));
  if (!genData?.generationId) return undefined;
  if (genData.userId && genData.userId !== sessionUserId) return undefined;

  const refundKey = `refund:${predictionId}`;
  if (await kv.get(refundKey)) return undefined;

  const binding = getD1Binding();
  if (!binding) return undefined;
  const db = getDb(binding);

  const [row] = await db
    .select({
      userId: generation.userId,
      creditsUsed: generation.creditsUsed,
      model: generation.model,
      createdAt: generation.createdAt,
    })
    .from(generation)
    .where(eq(generation.id, genData.generationId))
    .limit(1);
  if (!row || row.userId !== sessionUserId) return undefined;

  const minAgeSeconds = row.model.startsWith("z-video") ? 5 * 60 : 90;
  if (options.requireTimeoutAge && Math.floor(Date.now() / 1000) - row.createdAt < minAgeSeconds) {
    return undefined;
  }

  const totalCredits = genData.creditsUsed ?? row.creditsUsed;
  const totalPredictions = genData.predictionIds?.length || 1;
  const creditsToRefund = Math.max(1, Math.round(totalCredits / totalPredictions));

  const [updated] = await db
    .update(userTable)
    .set({ credits: sql`${userTable.credits} + ${creditsToRefund}` })
    .where(eq(userTable.id, sessionUserId))
    .returning({ credits: userTable.credits });

  await kv.put(
    refundKey,
    JSON.stringify({
      userId: sessionUserId,
      generationId: genData.generationId,
      creditsRefunded: creditsToRefund,
      createdAt: Date.now(),
    }),
    { expirationTtl: 7 * 24 * 60 * 60 },
  );

  try {
    await recordAiCreditSpend({
      db,
      userId: sessionUserId,
      credits: creditsToRefund,
      provider:
        row.model.startsWith("z-video") || row.model === "z-image-fast" ? "replicate" : "grsai",
      model: row.model,
      apiCallCount: 1,
      status: "refunded",
      sourceId: genData.generationId,
      metadata: { predictionId, reason: "async_generation_failed" },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    console.error("[credit-audit] Failed to record async refund:", message);
  }

  return updated?.credits;
}

async function tryFallbackForFailedPrediction(
  kv: KVNamespace | undefined,
  predictionId: string,
  sessionUserId: string | null,
  failureReason: string,
): Promise<StatusResult | null> {
  if (!kv || !sessionUserId) return null;

  const fallbackKey = `fallback:${predictionId}`;
  const existingRaw = await kv.get(fallbackKey);
  if (existingRaw) {
    try {
      const existing = JSON.parse(existingRaw) as {
        status?: string;
        urls?: string[];
        error?: string;
      };
      if (existing.status === "succeeded" && existing.urls?.length) {
        return {
          id: predictionId,
          status: "succeeded",
          urls: existing.urls,
          error: null,
          fallback: true,
        };
      }
      if (existing.status === "failed") return null;
    } catch {
      // Ignore malformed fallback cache and try again.
    }
  }

  const genData = parseGenerationTaskData(await kv.get(`gen:${predictionId}`));
  if (!genData?.generationId) return null;
  if (genData.userId && genData.userId !== sessionUserId) return null;

  const binding = getD1Binding();
  if (!binding) return null;
  const db = getDb(binding);
  const [row] = await db
    .select({
      userId: generation.userId,
      promptTemplate: generation.promptTemplate,
      resolvedPrompts: generation.resolvedPrompts,
      model: generation.model,
      creditsUsed: generation.creditsUsed,
    })
    .from(generation)
    .where(eq(generation.id, genData.generationId))
    .limit(1);
  if (!row || row.userId !== sessionUserId) return null;

  const prompt = parseStringList(row.resolvedPrompts)[0] || row.promptTemplate;
  try {
    const fbResult = row.model.startsWith("z-video")
      ? await generateVideoFallback(prompt, "1:1", 5)
      : await generateImageFallback(prompt, "1:1", 1);
    const { safeUrls } = await filterSafeImageUrls(fbResult.urls);
    if (safeUrls.length === 0) {
      throw new Error(CONTENT_SAFETY_BLOCK_MESSAGE);
    }

    await kv.put(
      fallbackKey,
      JSON.stringify({ status: "succeeded", urls: safeUrls, createdAt: Date.now() }),
      { expirationTtl: 7 * 24 * 60 * 60 },
    );
    await tryUpdateGeneration(kv, predictionId, safeUrls);
    try {
      await recordAiCreditSpend({
        db,
        userId: sessionUserId,
        credits: genData.creditsUsed ?? row.creditsUsed,
        provider: "workers-ai",
        model: row.model.startsWith("z-video") ? "video-fallback" : "image-fallback",
        apiCallCount: 1,
        status: "succeeded",
        sourceId: genData.generationId,
        metadata: {
          primaryModel: row.model,
          predictionId,
          failureReason,
          asyncFallback: true,
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "unknown error";
      console.error("[credit-audit] Failed to record async fallback spend:", message);
    }

    return { id: predictionId, status: "succeeded", urls: safeUrls, error: null, fallback: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Workers AI fallback failed";
    await kv.put(
      fallbackKey,
      JSON.stringify({ status: "failed", error: message, createdAt: Date.now() }),
      { expirationTtl: 60 * 60 },
    );
    console.warn(`[gen-status] Async fallback failed for ${predictionId}:`, err);
    return null;
  }
}

async function attachRefundsToFailedResults(
  kv: KVNamespace | undefined,
  results: StatusResult[],
  userId: string | null,
): Promise<StatusResult[]> {
  return Promise.all(
    results.map(async (result) => {
      if (!isRefundableStatus(result.status)) return result;
      const fallbackResult = await tryFallbackForFailedPrediction(
        kv,
        result.id,
        userId,
        result.error || result.status,
      );
      if (fallbackResult) return fallbackResult;
      const creditsRemaining = await refundFailedPrediction(kv, result.id, userId);
      return creditsRemaining == null ? result : { ...result, creditsRemaining };
    }),
  );
}

async function pollAndPersistGrsResult(
  kv: KVNamespace,
  predictionId: string,
  taskData: GrsTaskData,
): Promise<StatusResult> {
  const pollResult = await pollGrsaiResult(predictionId);
  if (pollResult.status === "succeeded" && pollResult.urls?.length) {
    const { safeUrls, blockedUrls } = await filterSafeImageUrls(pollResult.urls);
    if (blockedUrls.length > 0 && safeUrls.length === 0) {
      await kv.put(
        `grs:${predictionId}`,
        JSON.stringify({
          ...taskData,
          status: "failed",
          urls: undefined,
          error: CONTENT_SAFETY_BLOCK_MESSAGE,
        }),
        { expirationTtl: 3600 },
      );
      return {
        id: predictionId,
        status: "failed",
        urls: null,
        error: CONTENT_SAFETY_BLOCK_MESSAGE,
      };
    }
    await kv.put(
      `grs:${predictionId}`,
      JSON.stringify({
        ...taskData,
        status: "succeeded",
        urls: safeUrls,
        error: undefined,
      }),
      { expirationTtl: 3600 },
    );
    return { id: predictionId, status: "succeeded", urls: safeUrls, error: null };
  }

  if (pollResult.status === "failed" || pollResult.status === "error") {
    await kv.put(
      `grs:${predictionId}`,
      JSON.stringify({
        ...taskData,
        status: "failed",
        error: pollResult.error || "Generation failed",
      }),
      { expirationTtl: 3600 },
    );
    return {
      id: predictionId,
      status: "failed",
      urls: null,
      error: pollResult.error || "Generation failed",
    };
  }

  return { id: predictionId, status: "processing", urls: null, error: null };
}

async function tryUpdateGeneration(kv: KVNamespace, predictionId: string, urls: string[]) {
  try {
    const kvKey = `gen:${predictionId}`;
    console.log(`[gen-status] tryUpdateGeneration: looking up KV key=${kvKey}`);
    const genRaw = await kv.get(kvKey);
    if (!genRaw) {
      console.warn(
        `[gen-status] No KV entry for prediction ${predictionId} (key=${kvKey}), cannot update generation`,
      );
      return;
    }
    console.log(`[gen-status] Found KV entry for ${predictionId}:`, genRaw.slice(0, 200));
    const genData = JSON.parse(genRaw) as { generationId: string; userId: string };
    const binding = getD1Binding();
    if (!binding) {
      console.warn("[gen-status] D1 binding not available, cannot update generation");
      return;
    }

    // Mirror images to R2 for permanent storage.
    const r2Urls = await Promise.all(
      urls.map((url, i) =>
        mirrorImageToR2(
          url,
          `generations/${genData.userId}/${genData.generationId}/${safePathSegment(predictionId)}-${i}.png`,
        ),
      ),
    );

    const db = getDb(binding);
    const [existing] = await db
      .select({ resultUrls: generation.resultUrls })
      .from(generation)
      .where(eq(generation.id, genData.generationId))
      .limit(1);
    const mergedUrls = mergeUniqueUrls(parseStringList(existing?.resultUrls ?? "[]"), r2Urls);
    await db
      .update(generation)
      .set({ resultUrls: JSON.stringify(mergedUrls) })
      .where(eq(generation.id, genData.generationId));
    console.log(
      `[gen-status] Updated generation ${genData.generationId} with ${mergedUrls.length} URLs`,
    );
  } catch (err) {
    console.error("[gen-status] Failed to update generation record:", err);
  }
}

export async function handleGenerateStatus(request: Request): Promise<Response> {
  const auth = createAuth();
  if (!auth) {
    return jsonResponse({ error: "Database not available" }, 501);
  }

  const session = await auth.api.getSession({ headers: request.headers });
  const guestToken = request.headers.get("x-guest-token");
  const userId = session?.user?.id || null;
  if (!userId && !guestToken) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }

  const limitKey = userId ? `generate-status:${userId}` : `generate-status:guest:${guestToken}`;
  const limit = checkRateLimit(limitKey, 30, 10);
  if (!limit.allowed) {
    return jsonResponse({ error: "Too many status checks. Please slow down." }, 429);
  }

  // Nitro injects waitUntil from the Cloudflare execution context
  const req = request as Request & { waitUntil?: (p: Promise<unknown>) => void };
  const waitUntil = req.waitUntil?.bind(req) ?? ((_p: Promise<unknown>) => {});
  let mirrorTaskChain = Promise.resolve();
  const scheduleMirrorTask = (task: () => Promise<void>) => {
    mirrorTaskChain = mirrorTaskChain.then(task, task);
  };
  const flushMirrorTasks = () => {
    waitUntil(mirrorTaskChain);
    return mirrorTaskChain;
  };

  const url = new URL(request.url);
  const idsParam = url.searchParams.get("ids");
  const type = url.searchParams.get("type") || "replicate";
  const timeout = isTimeoutRequest(url);

  if (!idsParam) {
    return jsonResponse({ error: "Missing ids parameter" }, 400);
  }

  const ids = idsParam.split(",").filter(Boolean);

  try {
    const kv = getKvBinding();
    if (timeout) {
      const results = await Promise.all(
        ids.map((id) => timeoutPendingPrediction(kv, id, userId, guestToken)),
      );
      return jsonResponse({ results }, 200);
    }

    if (type === "grs") {
      const results = await Promise.all(
        ids.map(async (id) => {
          try {
            if (!kv) return { id, status: "error", urls: null, error: "KV not available" };
            const raw = await kv.get(`grs:${id}`);
            if (!raw) return { id, status: "processing", urls: null, error: null };
            const data: GrsTaskData = JSON.parse(raw);
            const ownerId = data.userId;
            if (ownerId !== userId) {
              return { id, status: "error", urls: null, error: "Not found" };
            }
            if (data.status === "succeeded" && data.urls?.length) {
              const { safeUrls, blockedUrls } = await filterSafeImageUrls(data.urls);
              if (blockedUrls.length > 0 && safeUrls.length === 0) {
                await kv.put(
                  `grs:${id}`,
                  JSON.stringify({
                    ...data,
                    status: "failed",
                    urls: undefined,
                    error: CONTENT_SAFETY_BLOCK_MESSAGE,
                  }),
                  { expirationTtl: 3600 },
                );
                return { id, status: "failed", urls: null, error: CONTENT_SAFETY_BLOCK_MESSAGE };
              }
              scheduleMirrorTask(() => tryUpdateGeneration(kv, id, safeUrls));
              return { id, status: "succeeded", urls: safeUrls, error: null };
            }
            if (data.status === "succeeded") {
              return {
                id,
                status: "failed",
                urls: null,
                error: "Generation finished without image URLs",
              };
            }
            if (data.status === "failed") {
              return {
                id,
                status: "failed",
                urls: null,
                error: data.error || "Generation failed",
              };
            }
            try {
              const polled = await pollAndPersistGrsResult(kv, id, data);
              if (polled.status === "succeeded" && polled.urls?.length) {
                scheduleMirrorTask(() => tryUpdateGeneration(kv, id, polled.urls!));
              }
              return polled;
            } catch (err) {
              console.warn(`[gen-status] GRS result poll failed for ${id}:`, err);
              return { id, status: "processing", urls: null, error: null };
            }
          } catch {
            return { id, status: "error", urls: null, error: "Poll failed" };
          }
        }),
      );

      await flushMirrorTasks();
      const refundedResults = await attachRefundsToFailedResults(kv, results, userId);
      return jsonResponse({ results: refundedResults }, 200);
    }

    // Replicate type (default)
    const results = await Promise.all(
      ids.map(async (id) => {
        try {
          if (kv) {
            const guestRaw = await kv.get(`guest:${id}`);
            if (guestRaw) {
              const guestOwner = parseGuestToken(guestRaw);
              if (!guestToken || guestOwner !== guestToken) {
                return { id, status: "error", urls: null, error: "Not found" };
              }
            } else {
              const ownerId = parseOwnerId(await kv.get(`gen:${id}`));
              if (ownerId && ownerId !== userId) {
                return { id, status: "error", urls: null, error: "Not found" };
              }
            }
          }
          return await pollReplicatePrediction(id);
        } catch (err) {
          const message = err instanceof Error ? err.message : "Poll failed";
          return { id, status: "error", urls: null, error: message };
        }
      }),
    );

    // Update generation records for succeeded Replicate results
    const moderatedResults = await Promise.all(
      results.map(async (result) => {
        if (result.status !== "succeeded" || !result.urls?.length) return result;
        const { safeUrls, blockedUrls } = await filterSafeImageUrls(result.urls);
        if (blockedUrls.length > 0 && safeUrls.length === 0) {
          return { status: "failed", urls: null, error: CONTENT_SAFETY_BLOCK_MESSAGE };
        }
        return { ...result, urls: safeUrls };
      }),
    );

    if (kv) {
      for (const [i, r] of moderatedResults.entries()) {
        if (r.status === "succeeded" && r.urls?.length) {
          scheduleMirrorTask(() => tryUpdateGeneration(kv, ids[i], r.urls!));
        }
      }
    }

    await flushMirrorTasks();
    const resultsWithIds = moderatedResults.map((r, i) => ({ id: ids[i], ...r }));
    const refundedResults = await attachRefundsToFailedResults(kv, resultsWithIds, userId);
    return jsonResponse({ results: refundedResults }, 200);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return jsonResponse({ error: message }, 500);
  }
}

export const Route = createFileRoute("/api/generate-status")({
  server: {
    handlers: {
      GET: async ({ request }) => handleGenerateStatus(request),
    },
  },
});
