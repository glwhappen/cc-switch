import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { getVersion } from "@tauri-apps/api/app";
import { ExternalLink, Sparkles } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useSettingsQuery } from "@/lib/query";
import { settingsApi } from "@/lib/api";
import { markSeen } from "@/lib/whatsNew";

/** 用户拿 Key 的控制台地址（本分发版私有网关）。 */
const CONSOLE_URL = "https://new-api.hsfp.cn/console/token";

const STEP_KEYS = ["step1", "step2", "step3"] as const;

/** 首次运行欢迎提示：仅当后端启动阶段保留 firstRunNoticeConfirmed 为空时弹出。 */
export function FirstRunNoticeDialog() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { data: settings } = useSettingsQuery();

  // 后端启动时已经决定好要不要弹：条件不满足的话字段会立即被写成 true，
  // 所以前端这里只需要判空即可——与其他既有确认标记的模式一致。
  const isOpen = settings != null && settings.firstRunNoticeConfirmed !== true;

  const handleAcknowledge = async () => {
    if (!settings) return;
    try {
      const { webdavSync: _, ...rest } = settings;
      // 新装用户看的就是新界面、新版本，「界面改版了」弹窗和更新摘要一并记成已看过
      const version = await getVersion().catch(() => undefined);
      await settingsApi.save({
        ...rest,
        firstRunNoticeConfirmed: true,
        newLayoutNoticeConfirmed: true,
        whatsNewSeenVersion: markSeen(settings.whatsNewSeenVersion, version),
      });
      await queryClient.invalidateQueries({ queryKey: ["settings"] });
    } catch (error) {
      console.error("Failed to save firstRunNoticeConfirmed:", error);
    }
  };

  return (
    <Dialog
      open={isOpen}
      onOpenChange={(open) => {
        if (!open) void handleAcknowledge();
      }}
    >
      <DialogContent className="max-w-md" zIndex="top">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="h-5 w-5 text-fg-1" />
            {t("firstRunNotice.title")}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-2.5 px-6 py-5">
          {STEP_KEYS.map((key) => {
            const text = t(`firstRunNotice.${key}`);
            const [head, ...rest] = text.split("\n");
            return (
              <div
                key={key}
                className="rounded-lg border border-border/40 bg-muted/15 px-3 py-2.5"
              >
                <div className="text-[13px] font-medium text-fg-1">
                  {head}
                </div>
                {rest.length > 0 && (
                  <DialogDescription className="mt-1 whitespace-pre-line text-[13px] leading-relaxed">
                    {rest.join("\n")}
                  </DialogDescription>
                )}
              </div>
            );
          })}
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => void settingsApi.openExternal(CONSOLE_URL)}
          >
            <ExternalLink className="mr-1.5 h-4 w-4" />
            {t("firstRunNotice.openConsole")}
          </Button>
          <Button onClick={handleAcknowledge}>
            {t("firstRunNotice.confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
