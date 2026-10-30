/**
 * 简易模式用到的两个 HSFP 供应商构造器。
 *
 * 直接复用上游预设里的数据结构（`settingsConfig` / `generateThirdPartyConfig`），
 * 不另写一套协议字段：这样预设改模型时简易模式跟着变，不会两处漂移。
 */
import { providerPresets } from "@/config/claudeProviderPresets";
import {
  codexProviderPresets,
  generateThirdPartyAuth,
  generateThirdPartyConfig,
} from "@/config/codexProviderPresets";
import type { Provider } from "@/types";

/** 简易模式固定用「HSFP」预设（数组首位那一份）。 */
export const HSFP_PRESET_NAME = "HSFP";

export const HSFP_CODEX_BASE_URL = "https://new-api.hsfp.cn/v1";
export const HSFP_CLAUDE_BASE_URL = "https://new-api.hsfp.cn";
/** 半价分组可用模型（详见 README-DIST 第 10 节）。 */
export const HSFP_DEFAULT_MODEL = "deepseek-flash";

export function findClaudeHsfpPreset() {
  const preset = providerPresets.find((item) => item.name === HSFP_PRESET_NAME);
  if (!preset) throw new Error("内置预设里找不到 HSFP，安装包可能不完整");
  return preset;
}

export function findCodexHsfpPreset() {
  const preset = codexProviderPresets.find(
    (item) => item.name === HSFP_PRESET_NAME,
  );
  if (!preset) throw new Error("内置预设里找不到 HSFP，安装包可能不完整");
  return preset;
}

/** 基础校验：半价分组的 key 都是 new-api 的 sk- 令牌。 */
export function normalizeApiKey(raw: string): string {
  const key = raw.trim().replace(/^Bearer\s+/i, "");
  if (!key) throw new Error("请先粘贴 API Key");
  if (!key.startsWith("sk-")) throw new Error("Key 格式不对：应以 sk- 开头");
  return key;
}

export function buildHsfpClaudeProvider(apiKey: string): Omit<Provider, "id"> {
  const preset = findClaudeHsfpPreset();
  // 复用预设的 env（含 base url 与四档模型），只把 token 填进去
  const settingsConfig = JSON.parse(JSON.stringify(preset.settingsConfig)) as {
    env?: Record<string, string>;
  } & Record<string, unknown>;
  if (!settingsConfig.env) throw new Error("HSFP 预设缺少 env 配置");
  settingsConfig.env.ANTHROPIC_AUTH_TOKEN = apiKey;
  return {
    name: HSFP_PRESET_NAME,
    settingsConfig,
    websiteUrl: preset.websiteUrl,
    category: preset.category,
    icon: preset.icon,
    iconColor: preset.iconColor,
  };
}

export function buildHsfpCodexProvider(apiKey: string): Omit<Provider, "id"> {
  const preset = findCodexHsfpPreset();
  return {
    name: HSFP_PRESET_NAME,
    settingsConfig: {
      auth: generateThirdPartyAuth(apiKey),
      // 模型取预设里那一个（当前是 deepseek-flash），避免和预设漂移
      config:
        preset.config ||
        generateThirdPartyConfig(
          HSFP_PRESET_NAME,
          HSFP_CODEX_BASE_URL,
          HSFP_DEFAULT_MODEL,
        ),
    },
    websiteUrl: preset.websiteUrl,
    category: preset.category,
    icon: preset.icon,
    iconColor: preset.iconColor,
  };
}
