// @ts-nocheck - route tree auto-generated at build time
import { createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { ArrowLeftIcon, HeartIcon, Repeat2Icon, CopyIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { authClient } from "@/lib/auth/auth-client";
import { useLanguage } from "@/lib/i18n/LanguageContext";
import { createPageMeta } from "@/lib/seo/meta";
import { creativeWorkLd } from "@/lib/seo/structured-data";
import {
  buildWorkSeoDescription,
  extractWorkIdFromPathParam,
  getCategoryDisplayName,
  getModelDisplayName,
  getWorkPath,
  getWorkNoindexReason,
  getWorkPrimaryPrompt,
  getWorkUseCase,
  parseVariableGroups,
  parseWorkResultUrls,
} from "@/lib/works/quality";

const loadWork = createServerFn({ method: "GET" }).handler(async ({ data: workId }) => {
  const id = extractWorkIdFromPathParam(String(workId || ""));
  const { and, desc, eq, ne } = await import("drizzle-orm");
  const { getDb } = await import("@/lib/db");
  const { work } = await import("@/lib/db/schema/data-flywheel.schema");
  const { user } = await import("@/lib/db/schema/auth.schema");

  const platformEnv = (globalThis as Record<string, unknown>).__env__ as
    | Record<string, unknown>
    | undefined;
  const binding = platformEnv?.batchlyai_db as D1Database | undefined;
  if (!binding) return null;
  const db = getDb(binding);

  const [row] = await db
    .select({ w: work, author: { name: user.name } })
    .from(work)
    .leftJoin(user, eq(work.userId, user.id))
    .where(eq(work.id, id));
  if (!row) return null;

  const relatedConditions = [eq(work.isPublished, 1), ne(work.id, id)];
  if (row.w.category) relatedConditions.push(eq(work.category, row.w.category));

  const relatedRows = await db
    .select({ w: work })
    .from(work)
    .where(and(...relatedConditions))
    .orderBy(desc(work.likeCount), desc(work.publishedAt))
    .limit(8);
  const relatedWorks = relatedRows
    .map((item) => item.w)
    .filter((item) => !getWorkNoindexReason(item))
    .slice(0, 4);

  const resultUrls = parseWorkResultUrls(row.w.resultUrls);
  const variableGroups = parseVariableGroups(row.w.variableGroups);
  const path = getWorkPath(row.w);

  return {
    ...row.w,
    authorName: row.author?.name || "Unknown",
    variableGroups,
    resultUrls,
    relatedWorks,
    noindexReason: getWorkNoindexReason({ ...row.w, resultUrls }),
    path,
  };
});

export const Route = createFileRoute("/works/$workId")({
  loader: async ({ params }) => loadWork({ data: params.workId }),
  head: ({ loaderData }) => {
    if (!loaderData) {
      const seo = createPageMeta({
        title: "Work not found — BatchlyAI",
        description: "This shared work is not available.",
        path: "/discover",
        locale: "en",
        noIndex: true,
      });
      return {
        htmlAttrs: { lang: "en" },
        meta: seo.meta,
        links: [{ rel: "canonical", href: "https://batchlyai.com/discover" }],
      };
    }
    const description = buildWorkSeoDescription(loaderData);
    const noIndex = !!loaderData.noindexReason;
    const seo = createPageMeta({
      title: `${loaderData.title} — BatchlyAI`,
      description,
      path: loaderData.path,
      locale: "en",
      ogImage: loaderData.coverUrl,
      ogType: "article",
      noIndex,
      jsonLd: creativeWorkLd({
        title: loaderData.title,
        description,
        url: `https://batchlyai.com${loaderData.path}`,
        image: loaderData.coverUrl,
        authorName: loaderData.authorName,
        datePublished: new Date((loaderData.publishedAt || 0) * 1000).toISOString(),
      }),
    });
    return {
      htmlAttrs: { lang: "en" },
      meta: seo.meta,
      links: [{ rel: "canonical", href: `https://batchlyai.com${loaderData.path}` }],
      scripts: seo.scripts,
    };
  },
  component: WorkDetailPage,
});

function WorkDetailPage() {
  const { t } = useLanguage();
  const data = Route.useLoaderData();
  const { data: session } = authClient.useSession();
  const [liked, setLiked] = useState(false);
  const [likeCount, setLikeCount] = useState(data?.likeCount || 0);
  const navigate = Route.useNavigate();

  if (!data) {
    return (
      <main className="mx-auto max-w-[980px] px-4 py-16 text-center">
        <p className="text-muted-foreground">{t("workNotFound")}</p>
        <a href="/discover" className="mt-2 inline-block text-accent-blue">
          {t("discoverMore")}
        </a>
      </main>
    );
  }

  const handleLike = async () => {
    if (!session?.user) return;
    const resp = await fetch("/api/works/like", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workId: data.id }),
    });
    const r = (await resp.json()) as { liked: boolean; likeCount: number };
    setLiked(r.liked);
    setLikeCount(r.likeCount);
  };

  const handleRemix = () => {
    void navigate({ to: `/?remix=${data.id}` });
  };

  const resultUrls = (data.resultUrls as string[]) || [];
  const relatedWorks = data.relatedWorks || [];
  const variableGroups = data.variableGroups || [];
  const originalPromptTemplate = getWorkPrimaryPrompt({
    originalPromptTemplate: data.originalPromptTemplate,
    promptTemplate: null,
  });
  const hasOriginalPrompt =
    !!originalPromptTemplate && originalPromptTemplate !== data.promptTemplate;
  const promptToCopy = originalPromptTemplate || data.promptTemplate;
  const modelName = getModelDisplayName(data.model);
  const categoryName = getCategoryDisplayName(data.category);
  const useCase = getWorkUseCase(data);

  return (
    <main className="mx-auto max-w-[980px] px-4 pt-16 pb-8 sm:py-8">
      <a
        href="/discover"
        className="mb-6 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeftIcon className="size-4" /> {t("discover")}
      </a>

      <img
        src={data.coverUrl}
        alt={data.title}
        className="mb-6 max-h-96 w-full rounded-2xl object-cover"
      />

      <h1 className="text-2xl font-bold text-foreground">{data.title}</h1>
      {data.description && (
        <p className="mt-3 max-w-3xl text-base leading-7 text-muted-foreground">
          {data.description}
        </p>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
        <span>{data.authorName}</span>
        {data.category && (
          <span className="rounded bg-muted/50 px-1.5 py-0.5 text-xs">{categoryName}</span>
        )}
        {data.publishedAt && <span>{new Date(data.publishedAt * 1000).toLocaleDateString()}</span>}
      </div>

      <section className="mt-6 grid gap-3 sm:grid-cols-3">
        <div className="rounded-lg border bg-card p-4">
          <p className="text-xs font-medium text-muted-foreground">{t("model")}</p>
          <p className="mt-1 text-sm font-semibold text-foreground">{modelName}</p>
        </div>
        <div className="rounded-lg border bg-card p-4">
          <p className="text-xs font-medium text-muted-foreground">{t("workCategory")}</p>
          <p className="mt-1 text-sm font-semibold text-foreground">{categoryName}</p>
        </div>
        <div className="rounded-lg border bg-card p-4">
          <p className="text-xs font-medium text-muted-foreground">{t("results")}</p>
          <p className="mt-1 text-sm font-semibold text-foreground">
            {resultUrls.length} {t("shareResultsUnit")}
          </p>
        </div>
      </section>

      <section className="mt-6 rounded-xl border bg-card p-5">
        <h2 className="text-lg font-semibold text-foreground">{t("workUseCase")}</h2>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">{useCase}</p>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">{t("remixWorkDescription")}</p>
      </section>

      <div className="mt-6 flex flex-wrap items-center gap-2 sm:gap-4">
        <button
          onClick={handleLike}
          className={`inline-flex flex-1 items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-sm sm:flex-none ${liked ? "bg-red-50 text-red-500" : "bg-muted/30 text-muted-foreground hover:text-red-500"}`}
        >
          <HeartIcon className={`size-4 ${liked ? "fill-red-500" : ""}`} /> {t("like")} {likeCount}
        </button>
        <button
          onClick={handleRemix}
          className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-muted/30 px-3 py-2 text-sm text-muted-foreground hover:text-accent-blue sm:flex-none"
        >
          <Repeat2Icon className="size-4" /> {t("remix")} {data.remixCount}
        </button>
        <button
          onClick={() => {
            void navigator.clipboard.writeText(promptToCopy);
            toast.success(t("copied"));
          }}
          className="inline-flex w-full items-center justify-center gap-1.5 rounded-lg bg-muted/30 px-3 py-2 text-sm text-muted-foreground sm:w-auto"
        >
          <CopyIcon className="size-4" /> {t("copyPrompt")}
        </button>
      </div>

      <section className="mt-6">
        <h2 className="text-lg font-semibold text-foreground">{t("promptForThisWork")}</h2>
        {hasOriginalPrompt && (
          <div className="mt-3 text-xs font-medium text-muted-foreground">
            {t("originalPrompt")}
          </div>
        )}
        <pre className="mt-2 rounded-lg bg-muted/20 p-3 text-xs whitespace-pre-wrap">
          {hasOriginalPrompt ? originalPromptTemplate : data.promptTemplate}
        </pre>
        {hasOriginalPrompt && (
          <>
            <div className="mt-3 text-xs font-medium text-muted-foreground">
              {t("expandedPrompt")}
            </div>
            <pre className="mt-2 rounded-lg bg-muted/20 p-3 text-xs whitespace-pre-wrap">
              {data.promptTemplate}
            </pre>
          </>
        )}
      </section>

      {variableGroups.length > 0 && (
        <section className="mt-6">
          <h2 className="text-lg font-semibold text-foreground">{t("variableValues")}</h2>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            {variableGroups.map((group, index) => (
              <div key={group.id} className="rounded-lg border bg-card p-4">
                <p className="text-xs font-medium text-muted-foreground">
                  {t("groupLabel", { index: index + 1 })}
                </p>
                <p className="mt-2 text-sm text-foreground">{group.values.join(", ")}</p>
              </div>
            ))}
          </div>
        </section>
      )}

      <h2 className="mt-8 mb-4 text-lg font-semibold">{t("results")}</h2>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
        {resultUrls.map((url, i) => (
          <img
            key={i}
            src={url}
            alt={t("resultAlt", { index: i + 1 })}
            className="aspect-square rounded-lg object-cover"
          />
        ))}
      </div>

      {relatedWorks.length > 0 && (
        <section className="mt-10">
          <h2 className="mb-4 text-lg font-semibold text-foreground">{t("relatedWorks")}</h2>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            {relatedWorks.map((work) => (
              <a
                key={work.id}
                href={getWorkPath(work)}
                className="group overflow-hidden rounded-lg border bg-card"
              >
                <img
                  src={work.coverUrl}
                  alt={work.title}
                  loading="lazy"
                  decoding="async"
                  className="aspect-square w-full object-cover transition-transform group-hover:scale-105"
                />
                <div className="p-3">
                  <p className="line-clamp-2 text-sm font-medium text-foreground">{work.title}</p>
                </div>
              </a>
            ))}
          </div>
        </section>
      )}
    </main>
  );
}
