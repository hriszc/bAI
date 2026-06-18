import { createFileRoute, Link } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { useEffect, useState } from "react";

import { useLanguage } from "@/lib/i18n/LanguageContext";
import { hreflangLinks } from "@/lib/seo/hreflang";
import { createPageMeta } from "@/lib/seo/meta";
import { getWorkPath, isIndexableWork } from "@/lib/works/quality";

interface WorkCard {
  id: string;
  title: string;
  coverUrl: string;
  authorName?: string;
  likeCount: number;
  remixCount: number;
  category: string | null;
  description: string | null;
}

interface TemplateCard {
  slug: string;
  name: string;
  description: string;
  category: string;
  previewImageUrl: string | null;
  usageCount: number;
}

const TABS = ["hot", "new", "ecommerce", "art", "social-media", "marketing", "templates"] as const;
type DiscoverTab = (typeof TABS)[number];

const TAB_LABELS: Record<DiscoverTab, string> = {
  hot: "Hot",
  new: "New",
  ecommerce: "Ecommerce",
  art: "Art",
  "social-media": "Social media",
  marketing: "Marketing",
  templates: "Templates",
};

function normalizeDiscoverTab(tab: unknown): DiscoverTab {
  return typeof tab === "string" && TABS.includes(tab as DiscoverTab)
    ? (tab as DiscoverTab)
    : "hot";
}

interface DiscoverLoaderData {
  tab?: unknown;
}

const loadDiscover = createServerFn({ method: "GET" })
  .inputValidator((data: DiscoverLoaderData) => ({ tab: normalizeDiscoverTab(data.tab) }))
  .handler(async ({ data }) => {
    const activeTab = data.tab;
    const { and, desc, eq, gte } = await import("drizzle-orm");
    const { getD1Binding } = await import("@/lib/cloudflare/bindings");
    const { getDb } = await import("@/lib/db");
    const { user } = await import("@/lib/db/schema/auth.schema");
    const { template: templateTable, work } = await import("@/lib/db/schema");

    const binding = getD1Binding();
    if (!binding) return { works: [], templates: [] };
    const db = getDb(binding);

    try {
      if (activeTab === "templates") {
        const templates = await db
          .select()
          .from(templateTable)
          .where(eq(templateTable.isPublic, true))
          .orderBy(desc(templateTable.usageCount), desc(templateTable.createdAt))
          .limit(20);
        return { works: [], templates };
      }

      const category = ["ecommerce", "art", "social-media", "marketing"].includes(activeTab)
        ? activeTab
        : "";
      const conditions = [eq(work.isPublished, 1)];
      if (category) conditions.push(eq(work.category, category));
      if (activeTab === "hot") {
        const weekAgo = Math.floor(Date.now() / 1000) - 7 * 86400;
        conditions.push(gte(work.publishedAt, weekAgo));
      }

      const rows = await db
        .select({ w: work, author: { name: user.name } })
        .from(work)
        .leftJoin(user, eq(work.userId, user.id))
        .where(and(...conditions))
        .orderBy(desc(activeTab === "hot" ? work.likeCount : work.createdAt))
        .limit(48);

      const works = rows
        .map((row) => ({
          ...row.w,
          authorName: row.author?.name || undefined,
        }))
        .filter((item) => isIndexableWork(item))
        .slice(0, 20);

      return { works, templates: [] };
    } catch (error) {
      console.warn("[discover] initial data unavailable", error);
      return { works: [], templates: [] };
    }
  });

const meta = createPageMeta({
  title: "Discover AI Works and Templates — BatchlyAI",
  description:
    "Explore AI-generated works, real preview images, and prompt templates to remix ideas or start from proven scenes.",
  path: "/discover",
  locale: "en",
});

export const Route = createFileRoute("/discover")({
  validateSearch: (search: Record<string, unknown>) => {
    const tab = normalizeDiscoverTab(search.tab);
    return tab === "hot" ? {} : { tab };
  },
  loaderDeps: ({ search }) => ({ tab: search.tab ?? "hot" }),
  loader: async ({ deps }) => loadDiscover({ data: deps }),
  head: () => ({
    htmlAttrs: { lang: "en" },
    meta: meta.meta,
    links: [
      ...hreflangLinks("/discover"),
      { rel: "canonical", href: "https://batchlyai.com/discover" },
    ],
  }),
  component: DiscoverPage,
});

export function DiscoverPage() {
  const { t } = useLanguage();
  const navigate = Route.useNavigate();
  const { tab } = Route.useSearch();
  const loaderData = Route.useLoaderData();
  const activeTab = tab ?? "hot";
  const serverWorks = loaderData.works as WorkCard[];
  const serverTemplates = loaderData.templates as TemplateCard[];
  const [hiddenWorks, setHiddenWorks] = useState<{ tab: DiscoverTab; ids: Set<string> }>(() => ({
    tab: activeTab,
    ids: new Set(),
  }));
  const [clientFallback, setClientFallback] = useState<{
    tab: DiscoverTab;
    works: WorkCard[];
    templates: TemplateCard[];
  } | null>(null);

  useEffect(() => {
    if (activeTab !== "templates" || serverTemplates.length > 0) return;

    let cancelled = false;
    void fetch("/api/templates?limit=20")
      .then((r) => r.json() as Promise<{ templates: TemplateCard[] }>)
      .then((data) => {
        if (!cancelled) {
          setClientFallback({ tab: activeTab, works: [], templates: data.templates || [] });
        }
      })
      .catch(() => {
        if (!cancelled) setClientFallback({ tab: activeTab, works: [], templates: [] });
      });

    return () => {
      cancelled = true;
    };
  }, [activeTab, serverTemplates.length]);

  const hiddenWorkIds = hiddenWorks.tab === activeTab ? hiddenWorks.ids : new Set<string>();
  const fallback = clientFallback?.tab === activeTab ? clientFallback : null;
  const visibleWorks = (fallback?.works.length ? fallback.works : serverWorks).filter(
    (w) => !hiddenWorkIds.has(w.id),
  );
  const templates = fallback?.templates.length ? fallback.templates : serverTemplates;

  return (
    <main className="mx-auto max-w-[980px] px-4 pt-16 pb-8 sm:py-8">
      <h1 className="mb-6 text-3xl font-bold text-foreground">{t("discover")}</h1>
      <div className="mb-6 flex flex-wrap gap-1.5 sm:flex-nowrap sm:overflow-x-auto">
        {TABS.map((tab) => (
          <button
            key={tab}
            onClick={() =>
              void navigate({
                to: "/discover",
                search: tab === "hot" ? {} : { tab },
                replace: true,
              })
            }
            className={`rounded-lg px-3 py-1.5 text-sm whitespace-nowrap ${activeTab === tab ? "bg-accent-blue text-white" : "bg-muted/30 text-muted-foreground hover:bg-muted"}`}
          >
            {tab === "hot" || tab === "new" || tab === "templates" ? t(tab) : TAB_LABELS[tab]}
          </button>
        ))}
      </div>
      {activeTab === "templates" ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {templates.map((template) => (
            <Link
              key={template.slug}
              to="/templates/$slug"
              params={{ slug: template.slug }}
              className="group overflow-hidden rounded-lg border bg-card shadow-sm transition-shadow hover:shadow-md"
            >
              <div className="aspect-[16/10] bg-muted">
                {template.previewImageUrl ? (
                  <img
                    src={template.previewImageUrl}
                    alt={template.name}
                    className="h-full w-full object-cover transition-transform group-hover:scale-105"
                  />
                ) : (
                  <div className="flex h-full items-center justify-center text-sm text-muted-foreground/40">
                    {t("promptTemplates")}
                  </div>
                )}
              </div>
              <div className="p-4">
                <h3 className="font-medium group-hover:text-accent-blue">{template.name}</h3>
                <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                  {template.description}
                </p>
                <div className="mt-3 flex items-center gap-2">
                  <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">
                    {template.category}
                  </span>
                  <span className="text-[10px] text-muted-foreground">
                    {template.usageCount} uses
                  </span>
                </div>
              </div>
            </Link>
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4 lg:grid-cols-4 xl:grid-cols-5">
          {visibleWorks.map((w) => (
            <a
              key={w.id}
              href={getWorkPath(w)}
              className="group rounded-xl border bg-card shadow-sm transition-shadow hover:shadow-md"
            >
              <div className="aspect-square overflow-hidden rounded-t-xl">
                <img
                  src={w.coverUrl}
                  alt={w.title}
                  loading="lazy"
                  decoding="async"
                  onError={() =>
                    setHiddenWorks((current) => {
                      const next = new Set(current.tab === activeTab ? current.ids : []);
                      next.add(w.id);
                      return { tab: activeTab, ids: next };
                    })
                  }
                  className="h-full w-full object-cover transition-transform group-hover:scale-105"
                />
              </div>
              <div className="p-3">
                <p className="line-clamp-1 text-sm font-medium text-foreground">{w.title}</p>
                {w.description && (
                  <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{w.description}</p>
                )}
                <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
                  {w.authorName && <span>{w.authorName}</span>}
                  <span>{w.likeCount} likes</span>
                </div>
              </div>
            </a>
          ))}
        </div>
      )}
    </main>
  );
}
