import { Settings2Icon } from "lucide-react";
import { useState } from "react";

import { useLanguage } from "@/lib/i18n/LanguageContext";

import { ModelPicker } from "./ModelPicker";
import { MODELS } from "./models";
import type { TextLength, VideoDuration } from "./types";
import { TEXT_LENGTH_TOKENS, VIDEO_DURATION_SECONDS } from "./types";

const ASPECT_RATIOS = ["16:9", "1:1", "9:16"];
const QUANTITIES = [1, 2, 4];

const TEXT_LENGTHS: { value: TextLength; label: string; labelZh: string }[] = [
  { value: "short", label: "Short", labelZh: "短" },
  { value: "medium", label: "Medium", labelZh: "中" },
  { value: "long", label: "Long", labelZh: "长" },
];

const VIDEO_DURATIONS: { value: VideoDuration; label: string; labelZh: string }[] = [
  { value: "5s", label: "5s", labelZh: "5秒" },
  { value: "10s", label: "10s", labelZh: "10秒" },
  { value: "15s", label: "15s", labelZh: "15秒" },
];

interface GeneratorToolbarProps {
  isGuest?: boolean;
  showVariables: boolean;
  onToggleVariables: () => void;
  canEditGroups: boolean;
  currentModel: string;
  onSelectModel: (modelId: string) => void;
  aspectRatio: string;
  onSetAspectRatio: (ratio: string) => void;
  quantity: number;
  onSetQuantity: (qty: number) => void;
  textLength: TextLength;
  onSetTextLength: (len: TextLength) => void;
  videoDuration: VideoDuration;
  onSetVideoDuration: (dur: VideoDuration) => void;
  comboCount: number;
  groupCount: number;
  hasGroups: boolean;
  creditEstimate: number;
  creditsRemaining: number | null;
}

function ToolbarDivider() {
  return <span className="hidden text-muted-foreground/40 sm:inline">|</span>;
}

export function GeneratorToolbar({
  isGuest = false,
  showVariables,
  onToggleVariables,
  canEditGroups,
  currentModel,
  onSelectModel,
  aspectRatio,
  onSetAspectRatio,
  quantity,
  onSetQuantity,
  textLength,
  onSetTextLength,
  videoDuration,
  onSetVideoDuration,
  comboCount,
  groupCount,
  hasGroups,
  creditEstimate,
  creditsRemaining,
}: GeneratorToolbarProps) {
  const { t, language } = useLanguage();
  const [showSettings, setShowSettings] = useState(false);
  const modelInfo = MODELS.find((m) => m.id === currentModel);
  const isImage = modelInfo?.category === "image";
  const isText = modelInfo?.category === "text";
  const isVideo = modelInfo?.category === "video";

  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 border-t bg-muted/20 px-3 py-2.5 text-sm sm:gap-3 sm:px-4">
      <div className="relative">
        <button
          type="button"
          onClick={() => setShowSettings(!showSettings)}
          className={`flex h-8 w-8 items-center justify-center rounded-lg transition-colors hover:bg-muted ${
            showSettings ? "text-accent-blue" : "text-muted-foreground"
          }`}
          title={t("advancedSettings")}
        >
          <Settings2Icon className="h-4 w-4" />
        </button>
        {showSettings && (
          <div className="absolute bottom-full left-0 z-10 mb-2 w-56 rounded-xl border bg-popover p-3 shadow-lg">
            <p className="mb-2 text-xs font-semibold text-foreground">
              {t("settingsTitle", { model: modelInfo?.label || "" })}
            </p>
            {isImage && (
              <div className="space-y-2">
                <p className="text-xs text-muted-foreground">{t("aspectRatioSetting")}</p>
              </div>
            )}
            {isText && (
              <div className="space-y-2">
                <p className="text-xs text-muted-foreground">
                  {t("outputLengthSetting", { tokens: String(TEXT_LENGTH_TOKENS[textLength]) })}
                </p>
              </div>
            )}
            {isVideo && (
              <div className="space-y-2">
                <p className="text-xs text-muted-foreground">
                  {t("durationSetting", {
                    duration: String(VIDEO_DURATION_SECONDS[videoDuration]),
                  })}
                </p>
              </div>
            )}
            <button
              onClick={() => setShowSettings(false)}
              className="mt-2 w-full rounded bg-muted py-1 text-xs"
            >
              {t("settingsClose")}
            </button>
          </div>
        )}
      </div>

      <ToolbarDivider />

      {canEditGroups && (
        <>
          <button
            type="button"
            onClick={onToggleVariables}
            className={`inline-flex items-center rounded-lg px-2.5 py-1 text-xs transition-colors ${
              showVariables
                ? "bg-accent-blue/10 font-medium text-accent-blue"
                : "text-muted-foreground hover:bg-muted hover:text-foreground"
            }`}
          >
            {showVariables ? t("hideGroups") : t("editGroups")}
          </button>
          <ToolbarDivider />
        </>
      )}

      {isGuest ? (
        <div
          className="inline-flex items-center gap-1.5 rounded-lg border bg-muted/30 px-2.5 py-1 text-xs text-muted-foreground"
          title={t("loginRequiredToGenerate")}
        >
          <span className="font-medium text-foreground">{t("imageTurbo")}</span>
          <span className="rounded-full bg-accent-blue/10 px-1.5 py-0.5 text-[10px] font-medium text-accent-blue">
            {t("loginRequiredBadge")}
          </span>
        </div>
      ) : (
        <ModelPicker currentModel={currentModel} onSelect={onSelectModel} />
      )}

      {/* Aspect ratio: shown for image and video, hidden for text */}
      {!isText && (
        <>
          <ToolbarDivider />
          <div className="flex items-center gap-1">
            {ASPECT_RATIOS.map((ratio) => (
              <button
                key={ratio}
                type="button"
                onClick={() => onSetAspectRatio(ratio)}
                className={`rounded px-2 py-1 text-xs whitespace-nowrap transition-colors ${
                  aspectRatio === ratio
                    ? "bg-accent-blue/10 font-medium text-accent-blue"
                    : "text-muted-foreground hover:bg-muted hover:text-foreground"
                }`}
              >
                {ratio}
              </button>
            ))}
          </div>
        </>
      )}

      <ToolbarDivider />

      {/* Image: quantity selector */}
      {isImage && (
        <div className="flex items-center gap-1">
          <span className="whitespace-nowrap text-muted-foreground">{t("quantity")}：</span>
          {QUANTITIES.map((qty) => (
            <button
              key={qty}
              type="button"
              onClick={() => onSetQuantity(qty)}
              className={`h-6 w-6 rounded text-xs transition-colors ${
                quantity === qty
                  ? "bg-accent-blue/10 font-medium text-accent-blue"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground"
              }`}
            >
              {qty}
            </button>
          ))}
        </div>
      )}

      {/* Text: output length selector */}
      {isText && (
        <div className="flex items-center gap-1">
          <span className="whitespace-nowrap text-muted-foreground">{t("length")}：</span>
          {TEXT_LENGTHS.map((len) => (
            <button
              key={len.value}
              type="button"
              onClick={() => onSetTextLength(len.value)}
              className={`rounded px-2 py-1 text-xs whitespace-nowrap transition-colors ${
                textLength === len.value
                  ? "bg-accent-blue/10 font-medium text-accent-blue"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground"
              }`}
            >
              {language === "zh" ? len.labelZh : len.label}
            </button>
          ))}
        </div>
      )}

      {/* Video: duration selector */}
      {isVideo && (
        <div className="flex items-center gap-1">
          <span className="whitespace-nowrap text-muted-foreground">{t("duration")}：</span>
          {VIDEO_DURATIONS.map((dur) => (
            <button
              key={dur.value}
              type="button"
              onClick={() => onSetVideoDuration(dur.value)}
              className={`rounded px-2 py-1 text-xs whitespace-nowrap transition-colors ${
                videoDuration === dur.value
                  ? "bg-accent-blue/10 font-medium text-accent-blue"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground"
              }`}
            >
              {language === "zh" ? dur.labelZh : dur.label}
            </button>
          ))}
        </div>
      )}

      <ToolbarDivider />

      <span className="whitespace-nowrap text-muted-foreground">
        {hasGroups && `${groupCount} ${t("groups")} · `}
        {comboCount} {t("variants")}
      </span>

      <ToolbarDivider />

      <span className="whitespace-nowrap text-muted-foreground">
        {t("estimatedCredits")}：{creditEstimate} {t("credits")}
      </span>

      {creditsRemaining != null && (
        <>
          <ToolbarDivider />
          <span className="whitespace-nowrap text-muted-foreground">
            {t("credits")}: {creditsRemaining}
          </span>
        </>
      )}
    </div>
  );
}
