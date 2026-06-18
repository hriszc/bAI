import { useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  SunIcon,
  MoonIcon,
  LogInIcon,
  UserIcon,
  PlusIcon,
  Share2Icon,
  GiftIcon,
  ChevronDownIcon,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { CreditPurchasePopover } from "@/components/CreditPurchasePopover";
import { useTheme } from "@/components/theme-provider";
import { authClient } from "@/lib/auth/auth-client";
import { useCreditSync } from "@/lib/credits/client-sync";
import { useLanguage } from "@/lib/i18n/LanguageContext";
import { buildCnRedirectHref } from "@/lib/i18n/locale-routing";

export function SettingsBar() {
  const { theme, setTheme } = useTheme();
  const { language, setLanguage, t } = useLanguage();
  const { data: session, isPending: sessionLoading } = authClient.useSession();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const syncCredits = useCreditSync(queryClient, !!session?.user?.id);
  const pendingPurchaseCreditSyncRef = useRef(false);

  const schedulePurchaseCreditSync = useCallback(() => {
    const retryDelays = [0, 1000, 3000, 7000, 12_000];
    return retryDelays.map((delay) =>
      window.setTimeout(() => {
        void syncCredits();
      }, delay),
    );
  }, [syncCredits]);

  // Handle Stripe redirects
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    let timers: number[] = [];
    if (params.get("purchase") === "success") {
      toast.success(t("purchaseSuccess"));
      pendingPurchaseCreditSyncRef.current = true;
      if (session?.user?.id) {
        pendingPurchaseCreditSyncRef.current = false;
        timers = schedulePurchaseCreditSync();
      }
      const url = new URL(window.location.href);
      url.searchParams.delete("purchase");
      window.history.replaceState({}, "", url.toString());
    } else if (params.get("purchase") === "canceled") {
      toast.error(t("purchaseCanceled"));
      const url = new URL(window.location.href);
      url.searchParams.delete("purchase");
      window.history.replaceState({}, "", url.toString());
    }

    return () => {
      for (const timer of timers) {
        window.clearTimeout(timer);
      }
    };
  }, [schedulePurchaseCreditSync, session?.user?.id, t]);

  useEffect(() => {
    if (!pendingPurchaseCreditSyncRef.current || !session?.user?.id) return;
    pendingPurchaseCreditSyncRef.current = false;
    const timers = schedulePurchaseCreditSync();
    return () => {
      for (const timer of timers) {
        window.clearTimeout(timer);
      }
    };
  }, [schedulePurchaseCreditSync, session?.user?.id]);

  const resolved =
    theme === "system"
      ? typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light"
      : theme;

  const toggleTheme = () => {
    setTheme(resolved === "dark" ? "light" : "dark");
  };

  const toggleLanguage = () => {
    const nextLanguage = language === "en" ? "zh" : "en";
    setLanguage(nextLanguage);
    if (typeof window === "undefined") return;
    if (nextLanguage === "zh" && !window.location.pathname.startsWith("/cn")) {
      window.location.assign(buildCnRedirectHref(window.location.search, window.location.hash));
    } else if (nextLanguage === "en" && window.location.pathname.startsWith("/cn")) {
      window.location.assign(`/${window.location.search}${window.location.hash}`);
    }
  };

  const handleSignOut = async () => {
    await authClient.signOut();
    void navigate({ to: "/" });
  };

  // Referral stats
  interface ReferralStats {
    tier: string;
    totalReferrals: number;
    totalCreditsEarned: number;
    commissionTotal: number;
    referralCode: string | null;
    shareUrl: string | null;
  }
  const [referralStats, setReferralStats] = useState<ReferralStats | null>(null);
  const [referralLoading, setReferralLoading] = useState(false);
  const [showPurchase, setShowPurchase] = useState(false);
  const [showUserMenu, setShowUserMenu] = useState(false);

  useEffect(() => {
    if (!session?.user) return;
    fetch("/api/referral/stats")
      .then((r) => r.json())
      .then((data: ReferralStats & { error?: string }) => {
        if (!data.error) setReferralStats(data);
      })
      .catch(() => {});
  }, [session?.user]);

  const handleGenerateReferralCode = useCallback(async () => {
    setReferralLoading(true);
    try {
      const resp = await fetch("/api/referral/generate-code", { method: "POST" });
      const data = (await resp.json()) as {
        code?: string;
        shareUrl?: string;
        error?: string;
      };
      if (data.code) {
        // Re-fetch stats
        const statsResp = await fetch("/api/referral/stats");
        const statsData = (await statsResp.json()) as ReferralStats & {
          error?: string;
        };
        if (!statsData.error) setReferralStats(statsData);
        toast.success(t("referralCreated"));
      } else {
        toast.error(data.error || t("referralFailed"));
      }
    } catch {
      toast.error(t("referralFailed"));
    } finally {
      setReferralLoading(false);
    }
  }, [t]);

  const handleCopyReferralLink = useCallback(async () => {
    if (referralStats?.shareUrl) {
      await navigator.clipboard.writeText(referralStats.shareUrl);
      toast.success(t("referralCopied"));
    }
  }, [referralStats, t]);

  return (
    <div className="fixed top-0 right-0 left-0 z-50 flex items-center justify-end gap-1 p-3">
      {sessionLoading ? (
        <div className="flex h-8 w-24 animate-pulse items-center rounded-full bg-muted/80" />
      ) : session?.user ? (
        <div className="flex items-center gap-1">
          <div className="relative">
            <button
              onClick={() => setShowPurchase(!showPurchase)}
              title={t("buyCreditsTitle")}
              className="inline-flex h-8 items-center justify-center gap-1 rounded-full bg-accent-blue/15 px-2 text-xs font-medium text-accent-blue backdrop-blur-sm transition-colors hover:bg-accent-blue/25 sm:px-2.5"
            >
              <PlusIcon className="size-3" />
              <span className="hidden sm:inline">{t("buyCredits")}</span>
            </button>
            {showPurchase && <CreditPurchasePopover onClose={() => setShowPurchase(false)} />}
          </div>

          {/* Referral Section */}
          {referralStats?.referralCode ? (
            <>
              <button
                onClick={handleCopyReferralLink}
                title={t("copyReferralLink")}
                className="hidden h-8 items-center justify-center gap-1 rounded-full bg-green-500/15 px-2.5 text-xs font-medium text-green-600 backdrop-blur-sm transition-colors hover:bg-green-500/25 sm:inline-flex"
              >
                <Share2Icon className="size-3" />
                {referralStats.totalReferrals > 0
                  ? `${referralStats.totalReferrals} ${t("invites")}`
                  : t("copyReferralLink")}
              </button>
              {referralStats.tier !== "none" && (
                <span className="inline-flex h-8 items-center justify-center rounded-full bg-amber-500/15 px-2 text-xs font-semibold text-amber-600 backdrop-blur-sm">
                  {referralStats.tier}
                </span>
              )}
              {referralStats.totalCreditsEarned > 0 && (
                <span className="inline-flex h-8 items-center justify-center gap-0.5 rounded-full bg-muted/80 px-2.5 text-xs font-medium text-muted-foreground backdrop-blur-sm">
                  <span className="font-semibold text-green-600">
                    +{referralStats.totalCreditsEarned}
                  </span>
                  {t("earned")}
                </span>
              )}
            </>
          ) : (
            <>
              <button
                onClick={handleGenerateReferralCode}
                disabled={referralLoading}
                className="hidden h-8 items-center justify-center gap-1 rounded-full bg-purple-500/15 px-2.5 text-xs font-medium text-purple-600 backdrop-blur-sm transition-colors hover:bg-purple-500/25 disabled:opacity-50 sm:inline-flex"
              >
                <GiftIcon className="size-3" />
                {referralLoading ? "..." : t("getReferralLink")}
              </button>
              {/* Viral hint: when user has credits but no referral code */}
              {session?.user && (
                <span className="hidden h-8 items-center gap-1 rounded-full bg-amber-500/15 px-2 text-[10px] font-medium text-amber-600 backdrop-blur-sm sm:inline-flex">
                  Refer & earn 50cr
                </span>
              )}
            </>
          )}

          <span className="inline-flex h-8 items-center justify-center gap-1 rounded-full bg-muted/80 px-2.5 text-xs font-medium text-muted-foreground backdrop-blur-sm">
            <span className="font-semibold text-accent-blue">
              {((session.user as Record<string, unknown>).credits as number) ?? 0}
            </span>
            <span className="hidden sm:inline">{t("credits")}</span>
          </span>
          <div className="relative">
            <button
              onClick={() => setShowUserMenu(!showUserMenu)}
              className="inline-flex h-8 items-center justify-center gap-1.5 rounded-full bg-muted/80 px-2.5 text-xs font-medium text-muted-foreground backdrop-blur-sm transition-colors hover:bg-muted hover:text-foreground"
              aria-label={session.user.name || session.user.email || t("myWorks")}
            >
              <UserIcon className="size-3" />
              <span className="hidden max-w-36 truncate sm:inline">
                {session.user.name || session.user.email}
              </span>
              <ChevronDownIcon className="size-3" />
            </button>
            {showUserMenu && (
              <div className="popover-enter absolute top-full right-0 z-10 mt-1 w-44 rounded-xl border bg-popover shadow-lg">
                <a href="/my/generations" className="block px-3 py-2 text-xs hover:bg-muted">
                  {t("myGenerations")}
                </a>
                <a href="/my/prompts" className="block px-3 py-2 text-xs hover:bg-muted">
                  {t("myPrompts")}
                </a>
                <a href="/my/works" className="block px-3 py-2 text-xs hover:bg-muted">
                  {t("myWorks")}
                </a>
                <div className="border-t" />
                <button
                  onClick={handleSignOut}
                  className="block w-full px-3 py-2 text-left text-xs hover:bg-muted"
                >
                  {t("signOut")}
                </button>
              </div>
            )}
          </div>
        </div>
      ) : (
        <Link
          to="/login"
          className="inline-flex h-8 items-center justify-center gap-1.5 rounded-full bg-muted/80 px-2.5 text-xs font-medium text-muted-foreground backdrop-blur-sm transition-colors hover:bg-muted hover:text-foreground"
        >
          <LogInIcon className="size-3" />
          {t("loginNav")}
        </Link>
      )}
      <a
        href="/discover"
        className="hidden h-8 items-center rounded-full bg-muted/80 px-2.5 text-xs font-medium text-muted-foreground backdrop-blur-sm transition-colors hover:bg-muted hover:text-foreground sm:inline-flex"
      >
        {t("discover")}
      </a>
      <button
        onClick={toggleLanguage}
        className="hidden h-8 items-center justify-center rounded-full bg-muted/80 px-2.5 text-xs font-medium text-muted-foreground backdrop-blur-sm transition-colors hover:bg-muted hover:text-foreground sm:inline-flex"
        aria-label={t("switchLang")}
      >
        {language === "en" ? "CN" : "EN"}
      </button>
      <button
        onClick={toggleTheme}
        className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-muted/80 text-muted-foreground backdrop-blur-sm transition-colors hover:bg-muted hover:text-foreground"
        aria-label={t("switchTheme")}
      >
        {resolved === "dark" ? <SunIcon className="size-3.5" /> : <MoonIcon className="size-3.5" />}
      </button>
    </div>
  );
}
