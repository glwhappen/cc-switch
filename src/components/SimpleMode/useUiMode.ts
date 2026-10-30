/**
 * 简易 / 高级模式的选择与持久化。
 *
 * 存在 localStorage（纯界面偏好，不写进 config.json，避免和上游设置结构耦合）：
 * - 没有记录 → 简易模式（新用户默认）；
 * - 用户手动切过 → 记住他的选择；老用户进过高级模式就不会被强行切回。
 */
import { useCallback, useEffect, useState } from "react";

export type UiMode = "simple" | "advanced";

const STORAGE_KEY = "ai-coding-tools:ui-mode";

function readStoredMode(): UiMode | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === "simple" || raw === "advanced") return raw;
  } catch {
    // localStorage 不可用（隐私模式等）：当作没记录，用默认值
  }
  return null;
}

export function useUiMode(): {
  mode: UiMode;
  setMode: (next: UiMode) => void;
  /** 用户是否已经明确选过（用于首启引导判断） */
  explicit: boolean;
} {
  const [stored, setStored] = useState<UiMode | null>(() => readStoredMode());

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === STORAGE_KEY) setStored(readStoredMode());
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const setMode = useCallback((next: UiMode) => {
    setStored(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // 存不下也不影响本次使用
    }
  }, []);

  return {
    mode: stored ?? "simple",
    setMode,
    explicit: stored !== null,
  };
}
