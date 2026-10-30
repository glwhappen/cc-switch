/**
 * 简易模式首屏：一个小白打开软件只该看到「一个按钮把事办完」。
 *
 * 独立目录，不侵入上游组件；数据全部走现有 IPC（providersApi / settingsApi）。
 * 规矩：默认路径不给选择——主按钮只有「一键装好 / 去领一个 Key / 开始使用」三种形态，
 * 其余能力都收进「高级模式」。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Copy,
  Download,
  ExternalLink,
  Loader2,
  Rocket,
  Settings2,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "@/lib/toast";
import { providersApi, settingsApi } from "@/lib/api";
import { markSeen } from "@/lib/whatsNew";
import { getVersion } from "@tauri-apps/api/app";
import { HSFP_PRESET_NAME, normalizeApiKey } from "./providers";
import { useOneClickSetup, SIMPLE_FLOW_STEP_ORDER } from "./useOneClickSetup";
import type { Provider } from "@/types";

const HSFP_SITE_URL = "https://cc.hsfp.cn/";

interface SimpleStatus {
  hasKey: boolean;
  claudeVersion: string | null;
  codexVersion: string | null;
  hsfpIsCurrent: boolean;
}

function readKeyFromProvider(provider: Provider | undefined): string | null {
  if (!provider) return null;
  const config = provider.settingsConfig ?? {};
  const env = (config.env ?? {}) as Record<string, unknown>;
  const token = env.ANTHROPIC_AUTH_TOKEN ?? env.ANTHROPIC_API_KEY;
  if (typeof token === "string" && token.startsWith("sk-")) return token;
  const auth = (config.auth ?? {}) as Record<string, unknown>;
  const openaiKey = auth.OPENAI_API_KEY;
  if (typeof openaiKey === "string" && openaiKey.startsWith("sk-")) {
    return openaiKey;
  }
  return null;
}

export function SimpleModePage({
  onEnterAdvanced,
}: {
  onEnterAdvanced: () => void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [apiKey, setApiKey] = useState("");
  const [keyDraft, setKeyDraft] = useState("");
  const [showKeyInput, setShowKeyInput] = useState(false);
  const [logOpen, setLogOpen] = useState(false);

  const { data: status, isPending } = useQuery<SimpleStatus>({
    queryKey: ["simple-mode-status"],
    queryFn: async () => {
      const [claudeAll, codexAll, claudeCurrent, codexCurrent, versions] =
        await Promise.all([
          providersApi.getAll("claude"),
          providersApi.getAll("codex"),
          providersApi.getCurrent("claude"),
          providersApi.getCurrent("codex"),
          settingsApi.getToolVersions(["claude", "codex"]),
        ]);
      const claudeHsfp = Object.values(claudeAll ?? {}).find(
        (provider) => provider.name === HSFP_PRESET_NAME,
      );
      const codexHsfp = Object.values(codexAll ?? {}).find(
        (provider) => provider.name === HSFP_PRESET_NAME,
      );
      const key =
        readKeyFromProvider(claudeHsfp) ?? readKeyFromProvider(codexHsfp);
      const claudeVersion =
        versions?.find((item) => item.name === "claude")?.version ?? null;
      const codexVersion =
        versions?.find((item) => item.name === "codex")?.version ?? null;
      return {
        hasKey: Boolean(key),
        claudeVersion,
        codexVersion,
        hsfpIsCurrent:
          Boolean(claudeHsfp && claudeCurrent === claudeHsfp.id) &&
          Boolean(codexHsfp && codexCurrent === codexHsfp.id),
      };
    },
    staleTime: 10_000,
  });

  // 首次读到已保存的 Key 时把它带进输入框，用户不用再粘一次
  useEffect(() => {
    if (!apiKey && status?.hasKey) {
      void (async () => {
        const all = await providersApi.getAll("codex");
        const found = Object.values(all ?? {}).find(
          (provider) => provider.name === HSFP_PRESET_NAME,
        );
        const key = readKeyFromProvider(found);
        if (key) setApiKey(key);
      })();
    }
  }, [apiKey, status?.hasKey]);

  const refreshStatus = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ["simple-mode-status"] });
    void queryClient.invalidateQueries({ queryKey: ["providers"] });
  }, [queryClient]);

  const setup = useOneClickSetup({
    apiKey,
    configureOnly: false,
    onFinished: (ok) => {
      refreshStatus();
      if (!ok) setLogOpen(true);
    },
  });

  const configure = useOneClickSetup({
    apiKey,
    configureOnly: true,
    onFinished: (ok) => {
      refreshStatus();
      if (!ok) setLogOpen(true);
    },
  });

  const busy = setup.state.running || configure.state.running;
  const lastOutcome = setup.state.outcome ?? configure.state.outcome;
  const lastNextAction = setup.state.nextAction ?? configure.state.nextAction;
  const activeLog = setup.state.running
    ? setup.state.log
    : configure.state.running
      ? configure.state.log
      : setup.state.log.length
        ? setup.state.log
        : configure.state.log;

  const ready = Boolean(
    status?.hasKey &&
      status.claudeVersion &&
      status.codexVersion &&
      status.hsfpIsCurrent,
  );

  const statusLine = useMemo(() => {
    if (busy) return t("simpleMode.statusWorking");
    if (ready) return t("simpleMode.statusReady");
    return t("simpleMode.statusAlmost");
  }, [busy, ready, t]);

  /**
   * 进高级界面前，把「首启三步向导」和「更新摘要」都记成已看过：
   * 简易模式已经把同一件事（拿 Key → 装好）办完了，再弹向导/更新弹窗纯属打扰。
   * 写失败也不拦用户进界面。
   */
  const acknowledgeGuides = useCallback(async () => {
    try {
      const settings = await settingsApi.get();
      // 与首启向导同一套写法：webdavSync 不回写，界面改版提示与更新摘要一并记成已看过
      const { webdavSync: _omit, ...rest } = settings;
      const version = await getVersion().catch(() => undefined);
      await settingsApi.save({
        ...rest,
        firstRunNoticeConfirmed: true,
        newLayoutNoticeConfirmed: true,
        whatsNewSeenVersion: markSeen(settings.whatsNewSeenVersion, version),
      });
      await queryClient.invalidateQueries({ queryKey: ["settings"] });
    } catch (error) {
      console.error("[SimpleMode] acknowledge guides failed", error);
    }
  }, [queryClient]);

  const leaveToAdvanced = useCallback(() => {
    void acknowledgeGuides();
    onEnterAdvanced();
  }, [acknowledgeGuides, onEnterAdvanced]);

  const openKeySite = useCallback(() => {
    void settingsApi.openExternal(HSFP_SITE_URL);
    setShowKeyInput(true);
  }, []);

  const acceptKey = useCallback(() => {
    try {
      const key = normalizeApiKey(keyDraft || apiKey);
      setApiKey(key);
      setShowKeyInput(false);
      toast.success(t("simpleMode.keySaved"));
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : t("simpleMode.keyInvalid"),
      );
    }
  }, [apiKey, keyDraft, t]);

  const handlePrimary = useCallback(() => {
    if (!status?.hasKey && !apiKey) {
      openKeySite();
      return;
    }
    if (ready) {
      leaveToAdvanced();
      return;
    }
    if (!apiKey) {
      setShowKeyInput(true);
      return;
    }
    void setup.run();
  }, [apiKey, leaveToAdvanced, openKeySite, ready, setup, status?.hasKey]);

  const handleConfigureOnly = useCallback(() => {
    if (!apiKey) {
      openKeySite();
      return;
    }
    void configure.run();
  }, [apiKey, configure, openKeySite]);

  const primaryLabel = ready
    ? t("simpleMode.startUsing")
    : status?.hasKey || apiKey
      ? t("simpleMode.oneClickInstall")
      : t("simpleMode.getKey");

  const installedLine = [
    status?.claudeVersion ? `Claude Code ${status.claudeVersion}` : null,
    status?.codexVersion ? `Codex ${status.codexVersion}` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  const steps = setup.state.running
    ? setup.state.steps
    : configure.state.running
      ? configure.state.steps
      : setup.state.steps.some((step) => step.state !== "pending")
        ? setup.state.steps
        : configure.state.steps;

  return (
    <div className="flex min-h-screen flex-col bg-surface text-fg-1">
      <div className="flex flex-1 items-center justify-center px-6 py-10">
        <div className="w-full max-w-xl text-center">
          {/* 状态一行 */}
          <div className="mb-8 flex items-center justify-center gap-2 text-body text-fg-2">
            {busy ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : ready ? (
              <ShieldCheck className="h-4 w-4 text-green-600" />
            ) : (
              <Sparkles className="h-4 w-4 text-action" />
            )}
            <span>{isPending ? t("simpleMode.statusLoading") : statusLine}</span>
          </div>

          <h1 className="mb-3 text-[28px] font-semibold leading-tight">
            {t("simpleMode.title")}
          </h1>
          <p className="mb-10 text-body text-fg-2">{t("simpleMode.subtitle")}</p>

          {/* 主按钮：整页唯一强调色 */}
          <Button
            size="regular"
            variant="default"
            className="h-14 w-full rounded-xl bg-action text-[17px] text-white hover:bg-action/90"
            disabled={busy || isPending}
            onClick={handlePrimary}
          >
            {busy ? (
              <Loader2 className="mr-2 h-5 w-5 animate-spin" />
            ) : ready ? (
              <Rocket className="mr-2 h-5 w-5" />
            ) : status?.hasKey || apiKey ? (
              <Download className="mr-2 h-5 w-5" />
            ) : (
              <ExternalLink className="mr-2 h-5 w-5" />
            )}
            {busy ? t("simpleMode.installing") : primaryLabel}
          </Button>

          {ready && installedLine && (
            <p className="mt-3 text-caption text-fg-2">{installedLine}</p>
          )}

          {/* 领 Key 后的粘贴框：只让用户粘一次，没有别的选择 */}
          {(showKeyInput || (!status?.hasKey && Boolean(apiKey))) && (
            <div className="mt-6 rounded-xl border border-border/60 bg-muted/20 p-4 text-left">
              <p className="mb-2 text-caption text-fg-2">
                {t("simpleMode.pasteHint")}
              </p>
              <div className="flex gap-2">
                <Input
                  value={keyDraft || apiKey}
                  onChange={(event) => setKeyDraft(event.target.value)}
                  placeholder="sk-..."
                  className="h-11"
                  autoFocus
                />
                <Button
                  variant="neutral"
                  size="regular"
                  className="h-11 shrink-0"
                  onClick={acceptKey}
                >
                  {t("simpleMode.keyConfirm")}
                </Button>
              </div>
              <button
                type="button"
                className="mt-2 inline-flex items-center gap-1 text-caption text-fg-2 hover:text-fg-1"
                onClick={() => void settingsApi.openExternal(HSFP_SITE_URL)}
              >
                <ExternalLink className="h-3 w-3" />
                {t("simpleMode.getKeyAgain")}
              </button>
            </div>
          )}

          {/* 次按钮：低调 */}
          <button
            type="button"
            className="mt-6 text-caption text-fg-2 underline-offset-4 hover:text-fg-1 hover:underline disabled:opacity-50"
            disabled={busy}
            onClick={handleConfigureOnly}
          >
            {t("simpleMode.alreadyInstalled")}
          </button>

          {/* 失败态：明确说哪一步、下一步怎么办 */}
          {lastOutcome === "failed" && lastNextAction && (
            <div className="mt-6 rounded-xl border border-red-500/30 bg-red-500/5 p-4 text-left">
              <p className="text-caption font-medium text-red-600">
                {t("simpleMode.failedTitle")}
              </p>
              <p className="mt-1 text-caption text-fg-2">{lastNextAction}</p>
            </div>
          )}
        </div>
      </div>

      {/* 折叠区：已装清单 + 日志（失败自动展开） */}
      <div className="mx-auto w-full max-w-2xl px-6 pb-8">
        <button
          type="button"
          className="flex w-full items-center gap-1.5 text-caption text-fg-2 hover:text-fg-1"
          onClick={() => setLogOpen((prev) => !prev)}
        >
          {logOpen ? (
            <ChevronDown className="h-3.5 w-3.5" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5" />
          )}
          {t("simpleMode.details")}
        </button>

        {logOpen && (
          <div className="mt-3 space-y-3 rounded-xl border border-border/60 bg-muted/15 p-4">
            <div className="text-caption text-fg-2">
              <span className="font-medium text-fg-1">
                {t("simpleMode.installedTitle")}
              </span>
              <span className="ml-2">
                {installedLine || t("simpleMode.nothingInstalled")}
              </span>
            </div>

            <div className="space-y-1">
              {SIMPLE_FLOW_STEP_ORDER.map((stepId) => {
                const step = steps.find((item) => item.id === stepId);
                const state = step?.state ?? "pending";
                return (
                  <div
                    key={stepId}
                    className="flex items-start gap-2 text-caption"
                  >
                    {state === "running" ? (
                      <Loader2 className="mt-0.5 h-3.5 w-3.5 animate-spin text-action" />
                    ) : state === "done" ? (
                      <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 text-green-600" />
                    ) : state === "failed" ? (
                      <span className="mt-0.5 h-3.5 w-3.5 text-center text-red-600">
                        ×
                      </span>
                    ) : (
                      <span className="mt-0.5 h-3.5 w-3.5 text-center text-fg-3">
                        ·
                      </span>
                    )}
                    <span
                      className={
                        state === "failed" ? "text-red-600" : "text-fg-2"
                      }
                    >
                      {t(`simpleMode.step.${stepId}`)}
                      {state === "skipped" && ` ${t("simpleMode.stepSkipped")}`}
                    </span>
                  </div>
                );
              })}
            </div>

            {activeLog.length > 0 && (
              <div className="max-h-52 overflow-auto rounded-lg bg-black/5 p-2 font-mono text-[11px] leading-relaxed">
                {activeLog.map((line) => (
                  <div
                    key={line.id}
                    className={
                      line.level === "error"
                        ? "text-red-600"
                        : line.level === "ok"
                          ? "text-green-700"
                          : "text-fg-2"
                    }
                  >
                    {line.text}
                  </div>
                ))}
              </div>
            )}

            {lastOutcome === "failed" && (
              <Button
                variant="neutral"
                size="compact"
                onClick={() => {
                  const errors = activeLog
                    .filter((line) => line.level === "error")
                    .map((line) => line.text)
                    .join("\n");
                  void navigator.clipboard.writeText(errors);
                  toast.success(t("simpleMode.errorCopied"));
                }}
              >
                <Copy className="mr-1.5 h-3.5 w-3.5" />
                {t("simpleMode.copyError")}
              </Button>
            )}
          </div>
        )}

        {/* 底部小字：高级模式入口 */}
        <div className="mt-8 flex items-center justify-center">
          <button
            type="button"
            className="inline-flex items-center gap-1.5 text-caption text-fg-2 underline-offset-4 hover:text-fg-1 hover:underline"
            onClick={leaveToAdvanced}
          >
            <Settings2 className="h-3.5 w-3.5" />
            {t("simpleMode.enterAdvanced")}
          </button>
        </div>
      </div>
    </div>
  );
}
