import {
  BookOpenIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  SparklesIcon,
  UploadIcon,
  XIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { LoginCard } from "@/components/LoginCard";
import { FaqSection } from "@/components/seo/FaqSection";
import { GeneratorCard } from "@/components/universal-generator/GeneratorCard";
import { MODELS } from "@/components/universal-generator/models";
import { ResultsGrid } from "@/components/universal-generator/ResultsGrid";
import { ShareScreenshot } from "@/components/universal-generator/ShareScreenshot";
import { ShareVideo } from "@/components/universal-generator/ShareVideo";
import { useGeneratorState } from "@/components/universal-generator/useGeneratorState";
import { computePromptCombinations } from "@/components/universal-generator/utils";
import { useAuthGate } from "@/components/useAuthGate";
import { authClient } from "@/lib/auth/auth-client";
import { useLanguage } from "@/lib/i18n/LanguageContext";
import {
  buildCnRedirectHref,
  isChineseLanguageTag,
  parseStoredLanguage,
} from "@/lib/i18n/locale-routing";
import type { TranslationKey } from "@/lib/i18n/translations";
import { getHomepageFaq } from "@/lib/seo/geo-content";

export function shouldRedirectToCn(): boolean {
  if (typeof window === "undefined") return false;
  if (window.location.pathname.startsWith("/cn")) return false;
  try {
    const saved = parseStoredLanguage(localStorage.getItem("language"));
    if (saved === "en") return false;
    if (saved === "zh") return true;
  } catch {}
  const preferred = navigator.languages?.[0] || navigator.language || "";
  return isChineseLanguageTag(preferred);
}

interface HomePageProps {
  forceLanguage?: "en" | "zh";
  showTaaftBadge?: boolean;
}

const STARTER_TEMPLATES = [
  {
    label: "Product hero",
    prompt: "A studio product photo of {{sneakers, headphones}} on {{marble, glass}}",
  },
  {
    label: "Social ad",
    prompt: "{{Minimal, cinematic}} poster for {{coffee, skincare}} with bold typography",
  },
  {
    label: "Character set",
    prompt: "A {{robot, astronaut}} character in {{pixel art, watercolor}} style",
  },
];

const HOMEPAGE_EXAMPLE_MODEL = "Image Pro";
const HOMEPAGE_EXAMPLE_INPUT = "/examples/anime-couples/input.webp";
const HOMEPAGE_EXAMPLE_RESULTS = [
  "/examples/anime-couples/result-1.webp",
  "/examples/anime-couples/result-2.webp",
  "/examples/anime-couples/result-3.webp",
  "/examples/anime-couples/result-4.webp",
  "/examples/anime-couples/result-5.webp",
];
const ONBOARDING_EXAMPLE_RESULTS = HOMEPAGE_EXAMPLE_RESULTS.slice(0, 3);
const ONBOARDING_STEPS = [
  {
    visual: "upload",
    titleKey: "onboardingStepUploadTitle",
    bodyKey: "onboardingStepUploadBody",
  },
  {
    visual: "expand",
    titleKey: "onboardingStepExpandTitle",
    bodyKey: "onboardingStepExpandBody",
  },
  {
    visual: "variables",
    titleKey: "onboardingStepVariablesTitle",
    bodyKey: "onboardingStepVariablesBody",
  },
  {
    visual: "results",
    titleKey: "onboardingStepResultsTitle",
    bodyKey: "onboardingStepResultsBody",
  },
] as const satisfies ReadonlyArray<{
  visual: "upload" | "expand" | "variables" | "results";
  titleKey: TranslationKey;
  bodyKey: TranslationKey;
}>;

function OnboardingVisual({
  visual,
  t,
}: {
  visual: (typeof ONBOARDING_STEPS)[number]["visual"];
  t: (key: TranslationKey) => string;
}) {
  if (visual === "upload") {
    return (
      <div className="relative h-full min-h-[240px] overflow-hidden rounded-lg border bg-background">
        <img
          src={HOMEPAGE_EXAMPLE_INPUT}
          alt={t("homepageExampleInputAlt")}
          width={900}
          height={900}
          loading="lazy"
          decoding="async"
          className="h-full w-full object-cover"
        />
        <div className="absolute bottom-3 left-3 inline-flex items-center gap-1.5 rounded-md bg-background/90 px-2.5 py-1.5 text-xs font-medium text-foreground shadow-sm backdrop-blur">
          <UploadIcon className="size-3.5" />
          {t("homepageExampleInputLabel")}
        </div>
      </div>
    );
  }

  if (visual === "expand") {
    return (
      <div className="flex h-full min-h-[240px] flex-col justify-center rounded-lg border bg-[radial-gradient(circle_at_top_left,rgba(41,118,255,0.16),transparent_34%),linear-gradient(135deg,hsl(var(--background)),hsl(var(--muted)))] p-5">
        <div className="mb-5 inline-flex w-fit items-center gap-2 rounded-full border bg-background/80 px-3 py-1.5 text-xs font-semibold text-accent-blue shadow-sm">
          <SparklesIcon className="size-3.5" />
          {t("expandAi")}
        </div>
        <div className="rounded-lg border bg-background/90 p-4 font-mono text-sm leading-6 text-foreground shadow-sm">
          {t("onboardingExpandExample")}
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          {[
            t("onboardingValueExampleOne"),
            t("onboardingValueExampleTwo"),
            t("onboardingValueExampleThree"),
            t("onboardingValueExampleFour"),
          ].map((value) => (
            <span
              key={value}
              className="rounded-full border bg-background/85 px-3 py-1.5 text-xs font-medium text-muted-foreground"
            >
              {value}
            </span>
          ))}
        </div>
      </div>
    );
  }

  if (visual === "variables") {
    return (
      <div className="flex h-full min-h-[240px] flex-col justify-center rounded-lg border bg-muted/35 p-5">
        <div className="rounded-lg border bg-background p-4 font-mono text-sm leading-6 break-words text-foreground shadow-sm">
          {t("onboardingVariableExample")}
        </div>
        <div className="mt-4 grid grid-cols-2 gap-2">
          {[
            t("onboardingValueExampleOne"),
            t("onboardingValueExampleTwo"),
            t("onboardingValueExampleThree"),
            t("onboardingValueExampleFour"),
          ].map((value, index) => (
            <div key={value} className="rounded-md border bg-background px-3 py-2 shadow-sm">
              <div className="text-[11px] font-medium text-muted-foreground">#{index + 1}</div>
              <div className="text-sm font-semibold text-foreground">{value}</div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="grid h-full min-h-[240px] grid-cols-3 gap-2 rounded-lg border bg-background p-2">
      {ONBOARDING_EXAMPLE_RESULTS.map((src) => (
        <img
          key={src}
          src={src}
          alt={t("homepageExampleOutputAlt")}
          width={600}
          height={1200}
          loading="lazy"
          decoding="async"
          className="aspect-[1/2] w-full rounded-md object-cover"
        />
      ))}
    </div>
  );
}

function HomepageExample({ t }: { t: (key: TranslationKey) => string }) {
  return (
    <section
      className="mx-auto w-full max-w-[1180px] px-4 pt-6 pb-14 sm:pt-10 sm:pb-20"
      aria-labelledby="homepage-example-title"
    >
      <div className="border-y border-border/70 py-8 sm:py-10 lg:py-12">
        <div className="grid gap-6 lg:grid-cols-[minmax(0,0.95fr)_440px] lg:items-end">
          <div className="space-y-4">
            <div className="text-xs font-semibold tracking-[0.18em] text-accent-blue uppercase">
              {t("homepageExampleEyebrow")}
            </div>
            <h2
              id="homepage-example-title"
              className="max-w-2xl text-3xl leading-tight font-semibold tracking-[-0.02em] text-foreground sm:text-4xl"
            >
              {t("homepageExampleTitle")}
            </h2>
            <p className="max-w-2xl text-base leading-7 text-muted-foreground">
              {t("homepageExampleDescription")}
            </p>
          </div>

          <div className="grid gap-3 sm:grid-cols-[1fr_140px]">
            <div className="rounded-lg border bg-background p-4">
              <div className="mb-2 text-xs font-medium tracking-[0.12em] text-muted-foreground uppercase">
                {t("homepageExamplePromptLabel")}
              </div>
              <div className="font-mono text-sm leading-6 break-words text-foreground">
                {t("homepageExamplePromptValue")}
              </div>
            </div>
            <div className="rounded-lg border bg-background p-4">
              <div className="mb-2 text-xs font-medium tracking-[0.12em] text-muted-foreground uppercase">
                {t("homepageExampleModelLabel")}
              </div>
              <div className="text-sm font-semibold text-foreground">{HOMEPAGE_EXAMPLE_MODEL}</div>
            </div>
          </div>
        </div>

        <div className="mt-8 grid gap-4 lg:grid-cols-[280px_minmax(0,1fr)]">
          <figure className="relative overflow-hidden rounded-lg border bg-muted">
            <img
              src={HOMEPAGE_EXAMPLE_INPUT}
              alt={t("homepageExampleInputAlt")}
              width={900}
              height={900}
              loading="lazy"
              decoding="async"
              sizes="(min-width: 1024px) 280px, 100vw"
              className="aspect-square w-full object-cover"
            />
            <figcaption className="absolute bottom-3 left-3 rounded-md bg-background/90 px-2.5 py-1.5 text-xs font-medium text-foreground shadow-sm backdrop-blur">
              {t("homepageExampleInputLabel")}
            </figcaption>
          </figure>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            {HOMEPAGE_EXAMPLE_RESULTS.map((src, index) => (
              <figure key={src} className="relative overflow-hidden rounded-lg border bg-muted">
                <img
                  src={src}
                  alt={t("homepageExampleOutputAlt")}
                  width={600}
                  height={1200}
                  loading="lazy"
                  decoding="async"
                  sizes="(min-width: 1024px) 170px, (min-width: 640px) 33vw, 50vw"
                  className="aspect-[1/2] w-full object-cover"
                />
                {index === 0 && (
                  <figcaption className="absolute bottom-3 left-3 rounded-md bg-background/90 px-2.5 py-1.5 text-xs font-medium text-foreground shadow-sm backdrop-blur">
                    {t("homepageExampleOutputLabel")}
                  </figcaption>
                )}
              </figure>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

export function HomePage({ forceLanguage, showTaaftBadge = false }: HomePageProps) {
  const { state, actions } = useGeneratorState();
  const resultsRef = useRef<HTMLDivElement>(null);
  const { language, setLanguage, t } = useLanguage();
  const [hydrated, setHydrated] = useState(false);
  const [shareImageMode, setShareImageMode] = useState(false);
  const [shareVideoMode, setShareVideoMode] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [showOnboardingCard, setShowOnboardingCard] = useState(false);
  const [onboardingStep, setOnboardingStep] = useState(0);

  const sourceImageUrls = useMemo(
    () =>
      state.attachedFiles.filter((file) => !file.uploading && file.url).map((file) => file.url!),
    [state.attachedFiles],
  );

  const handlePublish = useCallback(async () => {
    if (publishing || state.results.length === 0) return;
    const coverUrl = state.results.find((r) => r.imageUrl)?.imageUrl;
    const resultUrls = state.results.filter((r) => r.imageUrl).map((r) => r.imageUrl!);
    if (!coverUrl || resultUrls.length === 0) {
      toast.error(t("resultFailed"));
      return;
    }
    setPublishing(true);
    const publishToastId = toast.loading(t("publishing"));
    try {
      const body = {
        coverUrl,
        resultUrls,
        promptTemplate: state.promptTemplate,
        originalPromptTemplate: state.originalPromptTemplate,
        variableGroups: JSON.stringify(state.variableGroups),
        model: state.model,
        aspectRatio: state.aspectRatio,
      };
      const resp = await fetch("/api/works", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (resp.ok) {
        const workData = (await resp.json()) as {
          coverUrl?: string;
          resultUrls?: string[];
        };
        const publicCoverUrl = workData.coverUrl || coverUrl;
        const publicResultUrls = workData.resultUrls?.length ? workData.resultUrls : resultUrls;
        // Auto-save as template
        void fetch("/api/templates", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            promptTemplate: state.promptTemplate,
            variableGroups: JSON.stringify(state.variableGroups),
            model: state.model,
            aspectRatio: state.aspectRatio,
            previewImageUrl: publicCoverUrl,
            coverUrl: publicCoverUrl,
            resultUrls: publicResultUrls,
          }),
        }).catch(() => {});
        toast.success(t("publishSuccess"), {
          id: publishToastId,
          action: {
            label: t("discover"),
            onClick: () => {
              window.location.href = "/discover?tab=new";
            },
          },
        });
      } else {
        const errBody = (await resp.json().catch(() => ({}))) as { error?: string };
        toast.error(errBody.error || t("publishFailed"), { id: publishToastId });
      }
    } catch {
      toast.error(t("publishFailed"), { id: publishToastId });
    } finally {
      setPublishing(false);
    }
  }, [
    publishing,
    state.promptTemplate,
    state.originalPromptTemplate,
    state.results,
    state.variableGroups,
    state.model,
    state.aspectRatio,
    t,
  ]);
  const { data: session, isPending: sessionLoading } = authClient.useSession();
  const sessionReady = hydrated && !sessionLoading;
  const visibleSession = sessionReady ? session : null;
  const visibleUser = visibleSession?.user;
  const userCredits = ((visibleUser as Record<string, unknown>)?.credits as number) ?? 0;
  const effectiveCredits = state.creditsRemaining ?? userCredits;
  const showWatermark = effectiveCredits <= 10;
  const authGate = useAuthGate();
  const isLoggedIn = !!visibleUser;
  const canGuestGenerate = !isLoggedIn;
  const activeModel = MODELS.find((model) => model.id === state.model);
  const expectedUnitsPerCombination = activeModel?.category === "video" ? 1 : state.quantity;
  const { setPromptTemplate, updateValue, setAspectRatio, setModel } = actions;
  const homepageFaq = getHomepageFaq(language);
  const onboardingCurrentStep = useMemo(
    () => ONBOARDING_STEPS[onboardingStep] ?? ONBOARDING_STEPS[0],
    [onboardingStep],
  );
  const showOnboardingGuideButton = state.results.length === 0;
  const showOnboardingGuide = showOnboardingCard && showOnboardingGuideButton;

  const dismissOnboardingCard = useCallback(() => {
    setShowOnboardingCard(false);
  }, []);

  const handleUseOnboardingExample = useCallback(() => {
    setPromptTemplate(t("homepageExamplePromptValue"));
    dismissOnboardingCard();
  }, [dismissOnboardingCard, setPromptTemplate, t]);

  useEffect(() => {
    // Keep the first client render aligned with SSR to avoid hydration remounts
    // when auth state resolves before the page finishes hydrating.
    // oxlint-disable-next-line react-hooks-js/set-state-in-effect
    setHydrated(true);
  }, []);

  // Restore pending prompt from sessionStorage (preserved across login redirect)
  useEffect(() => {
    try {
      const pending = sessionStorage.getItem("pendingPrompt");
      if (pending) {
        setPromptTemplate(pending);
        sessionStorage.removeItem("pendingPrompt");
      }
    } catch {}
  }, [setPromptTemplate]);

  // Save prompt to sessionStorage so it survives login redirect
  useEffect(() => {
    if (!state.promptTemplate) return;
    try {
      sessionStorage.setItem("pendingPrompt", state.promptTemplate);
    } catch {}
  }, [state.promptTemplate]);

  // Server routing normally handles this. Keep a client fallback for static
  // previews and client-only navigations where the first request did not run.
  useEffect(() => {
    if (forceLanguage === "zh" || !shouldRedirectToCn()) return;
    const target = buildCnRedirectHref(window.location.search, window.location.hash);
    if (window.location.pathname !== "/cn") {
      window.location.replace(target);
    }
  }, [forceLanguage]);

  useEffect(() => {
    if (forceLanguage) {
      setLanguage(forceLanguage, { persist: false });
      document.documentElement.lang = forceLanguage === "zh" ? "zh-CN" : "en";
    }
  }, [forceLanguage, setLanguage]);

  useEffect(() => {
    if (!sessionReady) return;
    if (!isLoggedIn && state.model !== "z-image-fast") {
      setModel("z-image-fast");
    }
  }, [isLoggedIn, sessionReady, setModel, state.model]);

  // Handle ?template=<slug> for "Use this template" flow
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const templateSlug = params.get("template");
    if (!templateSlug) return;

    void (async () => {
      try {
        const resp = await fetch(`/api/templates/${templateSlug}`);
        const data = (await resp.json()) as {
          error?: string;
          promptTemplate?: string;
          variableGroups?: Array<{ values: string[] }>;
          model?: string;
          aspectRatio?: string;
        };
        if (data.error || !data.promptTemplate) return;

        setPromptTemplate(data.promptTemplate);
        setTimeout(() => {
          const groups = data.variableGroups;
          if (!groups) return;
          groups.forEach((group, i) => {
            group.values.forEach((value, j) => {
              updateValue(`var_${i}`, j, value);
            });
          });
          if (data.model) setModel(data.model);
          if (data.aspectRatio) setAspectRatio(data.aspectRatio);
        }, 600);

        const url = new URL(window.location.href);
        url.searchParams.delete("template");
        window.history.replaceState({}, "", url.toString());
      } catch {
        // Non-critical
      }
    })();
  }, [setPromptTemplate, setAspectRatio, setModel, updateValue]);

  // Handle ?remix=<workId> for remix flow
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const remixId = params.get("remix");
    if (!remixId) return;

    void (async () => {
      try {
        const resp = await fetch(`/api/works?remix=${remixId}`);
        const data = (await resp.json()) as {
          promptTemplate?: string;
          variableGroups?: string;
          model?: string;
        };
        if (!data.promptTemplate) return;

        setPromptTemplate(data.promptTemplate);
        setTimeout(() => {
          try {
            const groups = JSON.parse(data.variableGroups || "[]") as Array<{ values: string[] }>;
            groups.forEach((group, i) => {
              group.values.forEach((value, j) => {
                updateValue(`var_${i}`, j, value);
              });
            });
          } catch {}
          if (data.model) setModel(data.model);
        }, 600);

        const url = new URL(window.location.href);
        url.searchParams.delete("remix");
        window.history.replaceState({}, "", url.toString());
      } catch {
        /* Non-critical */
      }
    })();
  }, [setPromptTemplate, setModel, updateValue]);

  const prevGeneratingRef = useRef(state.isGenerating);
  useEffect(() => {
    if (prevGeneratingRef.current && !state.isGenerating && state.results.length > 0) {
      toast.success(`${state.results.length} images ready!`);
      if (resultsRef.current) {
        resultsRef.current.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    }
    prevGeneratingRef.current = state.isGenerating;
  }, [state.isGenerating, state.results]);

  const hasResults = state.results.length > 0;

  return (
    <main>
      <section
        className={`mx-auto max-w-[980px] px-4 ${
          hasResults
            ? "py-8 sm:py-10"
            : "pt-28 pb-8 sm:flex sm:min-h-[100svh] sm:flex-col sm:justify-center sm:py-14"
        }`}
      >
        <div className="mb-2 flex justify-center">
          <img
            src="/logo-light.png"
            alt="BatchlyAI"
            className="block h-12 w-auto sm:h-14 md:h-16 dark:hidden"
          />
          <img
            src="/logo-dark.png"
            alt="BatchlyAI"
            className="hidden h-12 w-auto sm:h-14 md:h-16 dark:block"
          />
        </div>
        <h1 className="sr-only">{t("siteTitle")}</h1>
        <p className="mb-8 text-center text-[17px] leading-[1.19] tracking-[-0.022em] text-muted-foreground sm:text-[21px]">
          {t("siteDescription")}
        </p>

        <GeneratorCard
          state={state}
          actions={actions}
          onRequireAuth={authGate.checkAuth}
          canGuestGenerate={canGuestGenerate}
          canExpandVars={isLoggedIn}
          isGuest={canGuestGenerate}
          availableCredits={effectiveCredits}
          isSessionReady={sessionReady}
        />

        {showOnboardingGuideButton && (
          <div className="mt-4 flex justify-center">
            <button
              type="button"
              onClick={() => setShowOnboardingCard((visible) => !visible)}
              aria-expanded={showOnboardingGuide}
              className="inline-flex h-9 items-center gap-2 rounded-full border bg-background px-3.5 text-sm font-medium text-muted-foreground shadow-sm transition-colors hover:border-accent-blue/40 hover:text-accent-blue"
            >
              <BookOpenIcon className="size-4" />
              {t("onboardingGuideButton")}
            </button>
          </div>
        )}

        {showOnboardingGuide && (
          <aside
            aria-label={t("onboardingEyebrow")}
            className="mt-4 overflow-hidden rounded-lg border bg-background shadow-sm"
          >
            <div className="grid gap-0 lg:grid-cols-[minmax(0,1fr)_360px]">
              <div className="p-3 sm:p-4">
                <OnboardingVisual visual={onboardingCurrentStep.visual} t={t} />
              </div>
              <div className="flex min-h-[260px] flex-col border-t p-5 lg:border-t-0 lg:border-l">
                <div className="mb-4 flex items-center justify-between gap-3">
                  <div className="text-xs font-semibold tracking-[0.18em] text-accent-blue uppercase">
                    {t("onboardingEyebrow")}
                  </div>
                  <button
                    type="button"
                    onClick={dismissOnboardingCard}
                    aria-label={t("settingsClose")}
                    className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                  >
                    <XIcon className="size-4" />
                  </button>
                </div>

                <div className="text-xs font-medium text-muted-foreground">
                  {onboardingStep + 1} / {ONBOARDING_STEPS.length}
                </div>
                <h2 className="mt-2 text-2xl leading-tight font-semibold tracking-[-0.02em] text-foreground">
                  {t(onboardingCurrentStep.titleKey)}
                </h2>
                <p className="mt-3 text-sm leading-6 text-muted-foreground">
                  {t(onboardingCurrentStep.bodyKey)}
                </p>
                <div className="mt-4 rounded-lg border bg-muted/35 p-3 font-mono text-xs leading-5 break-words text-foreground">
                  {t("homepageExamplePromptValue")}
                </div>

                <div className="mt-auto pt-5">
                  <div className="mb-4 flex items-center gap-2">
                    {ONBOARDING_STEPS.map((step, index) => (
                      <button
                        key={step.titleKey}
                        type="button"
                        onClick={() => setOnboardingStep(index)}
                        aria-label={`${t("onboardingGoToStep")} ${index + 1}`}
                        aria-current={index === onboardingStep ? "step" : undefined}
                        className={`h-2 rounded-full transition-all ${
                          index === onboardingStep
                            ? "w-7 bg-accent-blue"
                            : "w-2 bg-muted-foreground/25 hover:bg-muted-foreground/45"
                        }`}
                      />
                    ))}
                  </div>

                  <div className="flex items-center justify-between gap-3">
                    <button
                      type="button"
                      onClick={() => setOnboardingStep((step) => Math.max(0, step - 1))}
                      disabled={onboardingStep === 0}
                      className="inline-flex h-10 items-center gap-2 rounded-md border bg-background px-3 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
                    >
                      <ChevronLeftIcon className="size-4" />
                      {t("onboardingPrevious")}
                    </button>
                    {onboardingStep === ONBOARDING_STEPS.length - 1 ? (
                      <button
                        type="button"
                        onClick={handleUseOnboardingExample}
                        className="inline-flex h-10 items-center gap-2 rounded-md bg-foreground px-4 text-sm font-semibold text-background transition-opacity hover:opacity-90"
                      >
                        <SparklesIcon className="size-4" />
                        {t("onboardingUseExample")}
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() =>
                          setOnboardingStep((step) =>
                            Math.min(ONBOARDING_STEPS.length - 1, step + 1),
                          )
                        }
                        className="inline-flex h-10 items-center gap-2 rounded-md bg-foreground px-4 text-sm font-semibold text-background transition-opacity hover:opacity-90"
                      >
                        {t("onboardingNext")}
                        <ChevronRightIcon className="size-4" />
                      </button>
                    )}
                  </div>
                </div>
              </div>
            </div>
          </aside>
        )}

        {!state.promptTemplate.trim() && state.results.length === 0 && (
          <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
            <span className="text-xs font-medium text-muted-foreground">
              {t("promptTemplates")}
            </span>
            {STARTER_TEMPLATES.map((starter) => (
              <button
                key={starter.label}
                type="button"
                onClick={() => setPromptTemplate(starter.prompt)}
                className="rounded-full border bg-background px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:border-accent-blue/40 hover:text-accent-blue"
              >
                {starter.label}
              </button>
            ))}
          </div>
        )}

        <div ref={resultsRef}>
          <ResultsGrid
            results={state.results}
            isGenerating={state.isGenerating}
            totalExpected={
              computePromptCombinations(state.promptTemplate, state.variableGroups).length *
              expectedUnitsPerCombination
            }
            showWatermark={showWatermark}
            onShareImage={() => {
              if (state.results.length === 0) return;
              setShareImageMode(true);
            }}
            onShareVideo={() => {
              if (state.results.length === 0) return;
              setShareVideoMode(true);
            }}
            onPublish={isLoggedIn ? handlePublish : undefined}
            isPublishing={publishing}
          />
        </div>
      </section>

      <HomepageExample t={t} />

      {showTaaftBadge && (
        <section className="mx-auto flex max-w-[980px] justify-center px-4 pb-12">
          <a
            href="https://theresanaiforthat.com/ai/batchlyai/?ref=featured&v=8086392"
            target="_blank"
            rel="nofollow"
          >
            <img
              width="300"
              height="100"
              src="https://media.theresanaiforthat.com/featured-on-taaft.png?width=600"
              alt="Featured on There's An AI For That"
              loading="lazy"
              decoding="async"
            />
          </a>
        </section>
      )}

      <section className="mx-auto max-w-[980px] px-4 pb-16">
        <FaqSection
          title={t("homepageFaqTitle")}
          description={t("homepageFaqDescription")}
          items={homepageFaq}
        />
      </section>

      {shareImageMode && (
        <ShareScreenshot
          promptTemplate={state.promptTemplate}
          originalPromptTemplate={state.originalPromptTemplate}
          sourceImageUrls={sourceImageUrls}
          variableGroups={state.variableGroups}
          results={state.results}
          onComplete={() => {
            setShareImageMode(false);
            toast.success(t("shareSuccess"));
          }}
          onError={(msg) => {
            setShareImageMode(false);
            toast.error(t("shareFailed"));
            console.error("[share]", msg);
          }}
        />
      )}

      {shareVideoMode && (
        <ShareVideo
          promptTemplate={state.promptTemplate}
          originalPromptTemplate={state.originalPromptTemplate}
          sourceImageUrls={sourceImageUrls}
          variableGroups={state.variableGroups}
          results={state.results}
          onComplete={() => {
            setShareVideoMode(false);
            toast.success(t("shareVideoSuccess"));
          }}
          onError={(msg) => {
            setShareVideoMode(false);
            toast.error(msg || t("shareVideoFailed"));
            console.error("[share-video]", msg);
          }}
        />
      )}

      {authGate.showLoginCard && (
        <LoginCard onSuccess={authGate.onLoginSuccess} onClose={authGate.closeLogin} />
      )}
    </main>
  );
}
