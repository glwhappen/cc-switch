/**
 * 高级模式里的「返回简易模式」入口。
 *
 * 刻意做成一个悬浮小胶囊（右下角），不改上游侧栏/设置页结构：
 * 跟版成本最低，也不会把「简易模式」这个概念渗进上游组件。
 */
import { useTranslation } from "react-i18next";
import { Minimize2 } from "lucide-react";

export function BackToSimpleButton({ onBack }: { onBack: () => void }) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      onClick={onBack}
      className="fixed bottom-4 right-4 z-40 inline-flex items-center gap-1.5 rounded-full border border-border/70 bg-surface/95 px-3.5 py-2 text-caption text-fg-2 shadow-sm backdrop-blur transition-colors hover:text-fg-1"
      title={t("simpleMode.backToSimpleHint")}
    >
      <Minimize2 className="h-3.5 w-3.5" />
      {t("simpleMode.backToSimple")}
    </button>
  );
}
