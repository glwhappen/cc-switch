/**
 * 简易模式的「一键装好」编排：写 HSFP 供应商 → 装 Claude Code → 装 Codex → 设为主力。
 *
 * 设计要点：
 * - 默认路径不给选择：只有「一键装好 / 我已经装过了 / 重试」三种意图；
 * - 每步幂等：HSFP 供应商已存在就更新、CLI 已装好就跳过；
 * - 每步都有可读日志；失败立刻停在明确错误态（哪一步失败、下一步怎么做），不空转。
 */
import { useCallback, useRef, useState } from "react";
import { providersApi, settingsApi } from "@/lib/api";
import { buildHsfpClaudeProvider, buildHsfpCodexProvider } from "./providers";
import { generateUUID } from "@/utils/uuid";
import type { Provider } from "@/types";

export type SimpleFlowStepId = "provider" | "claude" | "codex" | "activate";
export type SimpleFlowStepState =
  | "pending"
  | "running"
  | "done"
  | "skipped"
  | "failed";

export interface SimpleFlowLogLine {
  id: string;
  at: number;
  level: "info" | "ok" | "warn" | "error";
  text: string;
}

export interface SimpleFlowStep {
  id: SimpleFlowStepId;
  state: SimpleFlowStepState;
  /** 失败时的可复制错误原文 */
  error?: string;
}

export interface SimpleFlowState {
  running: boolean;
  steps: SimpleFlowStep[];
  log: SimpleFlowLogLine[];
  outcome: "success" | "failed" | null;
  nextAction: string | null;
}

export const SIMPLE_FLOW_STEP_ORDER: SimpleFlowStepId[] = [
  "provider",
  "claude",
  "codex",
  "activate",
];

const initialSteps = (): SimpleFlowStep[] =>
  SIMPLE_FLOW_STEP_ORDER.map((id) => ({ id, state: "pending" as SimpleFlowStepState }));

const initialState = (): SimpleFlowState => ({
  running: false,
  steps: initialSteps(),
  log: [],
  outcome: null,
  nextAction: null,
});

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export interface UseOneClickSetupOptions {
  apiKey: string;
  /** 「我已经装过了」：只写配置，不装 CLI */
  configureOnly: boolean;
  onFinished?: (ok: boolean) => void;
  onProviderReady?: () => void;
}

export function useOneClickSetup({
  apiKey,
  configureOnly,
  onFinished,
  onProviderReady,
}: UseOneClickSetupOptions) {
  const [state, setState] = useState<SimpleFlowState>(initialState);
  const runIdRef = useRef(0);

  const append = useCallback(
    (level: SimpleFlowLogLine["level"], text: string) => {
      setState((prev) => ({
        ...prev,
        log: [
          ...prev.log,
          { id: `${Date.now()}-${prev.log.length}`, at: Date.now(), level, text },
        ],
      }));
    },
    [],
  );

  const mark = useCallback(
    (id: SimpleFlowStepId, next: SimpleFlowStepState, error?: string) => {
      setState((prev) => ({
        ...prev,
        steps: prev.steps.map((step) =>
          step.id === id
            ? { ...step, state: next, ...(error ? { error } : {}) }
            : step,
        ),
      }));
    },
    [],
  );

  const run = useCallback(async () => {
    const runId = ++runIdRef.current;
    const stale = () => runIdRef.current !== runId;
    // 当前步用闭包变量记录：不能读 state（异步里拿到的永远是旧值）
    let currentStep: SimpleFlowStepId = "provider";

    setState({ ...initialState(), running: true });

    const stopWithError = (message: string) => {
      mark(currentStep, "failed", message);
      append("error", message);
      setState((prev) => ({
        ...prev,
        running: false,
        outcome: "failed",
        nextAction:
          currentStep === "provider"
            ? "检查 Key 是否正确（应以 sk- 开头），然后重新点一次。"
            : "换个时间再点一次即可，已完成的步骤不会重做。",
      }));
      onFinished?.(false);
    };

    try {
      // ---- 第 1 步：写供应商（幂等 upsert） ----
      currentStep = "provider";
      mark("provider", "running");
      append("info", "第 1 步 · 写入 HSFP 供应商（Claude Code + Codex）");

      const existing: Record<"claude" | "codex", Provider | undefined> = {
        claude: undefined,
        codex: undefined,
      };
      for (const appId of ["claude", "codex"] as const) {
        const all = await providersApi.getAll(appId);
        existing[appId] = Object.values(all ?? {}).find(
          (provider) => provider.name === "HSFP",
        );
      }
      if (stale()) return;

      const upsert = async (appId: "claude" | "codex"): Promise<string> => {
        const built =
          appId === "claude"
            ? buildHsfpClaudeProvider(apiKey)
            : buildHsfpCodexProvider(apiKey);
        const found = existing[appId];
        const label = appId === "claude" ? "Claude Code" : "Codex";
        if (found) {
          await providersApi.update({ ...built, id: found.id }, appId);
          append("info", `${label}：已更新现有 HSFP 供应商`);
          return found.id;
        }
        const id = generateUUID();
        await providersApi.add({ ...built, id }, appId, false);
        append("ok", `${label}：已写入 HSFP 供应商`);
        return id;
      };

      const claudeId = await upsert("claude");
      const codexId = await upsert("codex");
      if (stale()) return;
      onProviderReady?.();
      mark("provider", "done");

      // ---- 第 2/3 步：装 CLI（或按用户选择跳过） ----
      const installIfNeeded = async (tool: "claude" | "codex", label: string) => {
        const before = await settingsApi.getToolVersions([tool]);
        const installed = before?.[0]?.version ?? null;
        if (installed) {
          append("info", `${label} 已经装好（${installed}），跳过`);
          return "skipped" as const;
        }
        append("info", `正在安装 ${label}（国内镜像直下，不需要 Node）…`);
        await settingsApi.runToolLifecycleAction([tool], "install");
        const after = await settingsApi.getToolVersions([tool]);
        const version = after?.[0]?.version ?? null;
        if (!version) {
          throw new Error(
            `${label} 的安装命令执行完了，但没有检测到可运行的版本。请到「高级模式 → 应用」里点一次安装看详细报错。`,
          );
        }
        append("ok", `${label} 装好了：${version}`);
        return "done" as const;
      };

      if (configureOnly) {
        mark("claude", "skipped");
        mark("codex", "skipped");
        append("info", "已选择「我已经装过了」：跳过安装，只写配置");
      } else {
        currentStep = "claude";
        mark("claude", "running");
        append("info", "第 2 步 · 安装 Claude Code");
        const claudeResult = await installIfNeeded("claude", "Claude Code");
        if (stale()) return;
        mark("claude", claudeResult);

        currentStep = "codex";
        mark("codex", "running");
        append("info", "第 3 步 · 安装 Codex");
        const codexResult = await installIfNeeded("codex", "Codex");
        if (stale()) return;
        mark("codex", codexResult);
      }

      // ---- 第 4 步：设为主力 ----
      currentStep = "activate";
      mark("activate", "running");
      append("info", "第 4 步 · 把 HSFP 设为当前供应商");
      await providersApi.switch(claudeId, "claude");
      await providersApi.switch(codexId, "codex");
      if (stale()) return;
      mark("activate", "done");

      append("ok", "全部完成。打开终端输入 claude 或 codex 就能用。");
      setState((prev) => ({
        ...prev,
        running: false,
        outcome: "success",
        nextAction: null,
      }));
      onFinished?.(true);
    } catch (error) {
      if (stale()) return;
      stopWithError(errorText(error));
    }
  }, [apiKey, append, configureOnly, mark, onFinished, onProviderReady]);

  const reset = useCallback(() => {
    runIdRef.current += 1;
    setState(initialState());
  }, []);

  return { state, run, reset };
}
