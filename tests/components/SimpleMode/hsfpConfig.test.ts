/**
 * 简易模式写入的 HSFP 配置契约单测。
 *
 * 目的：把「简易模式 / 一键装好」真正落到用户机器上的那几项锁死——
 * 预设名、base_url、模型、协议、以及「从已有配置里读回 Key」。
 * 这些一旦被上游改预设带偏，用户拿到的 Key 就会直接 503（半价分组没有那些模型）。
 */
import { describe, expect, it } from "vitest";
import {
  HSFP_CLAUDE_BASE_URL,
  HSFP_CODEX_BASE_URL,
  HSFP_DEFAULT_MODEL,
  HSFP_PRESET_NAME,
  buildHsfpClaudeProvider,
  buildHsfpCodexProvider,
  findClaudeHsfpPreset,
  findCodexHsfpPreset,
  normalizeApiKey,
} from "@/components/SimpleMode/providers";
import { providerPresets } from "@/config/claudeProviderPresets";
import { codexProviderPresets } from "@/config/codexProviderPresets";

describe("简易模式的 HSFP 配置契约", () => {
  it("预设名固定 HSFP，且 Claude / Codex 两边都置顶", () => {
    expect(HSFP_PRESET_NAME).toBe("HSFP");
    expect(providerPresets[0]?.name).toBe("HSFP");
    expect(codexProviderPresets[0]?.name).toBe("HSFP");
    expect(findClaudeHsfpPreset().name).toBe("HSFP");
    expect(findCodexHsfpPreset().name).toBe("HSFP");
  });

  it("默认模型是 deepseek-flash（半价分组只有 deepseek 系有渠道）", () => {
    expect(HSFP_DEFAULT_MODEL).toBe("deepseek-flash");
  });

  it("Claude 配置写进站点根 base_url、Key 与 deepseek-flash", () => {
    const provider = buildHsfpClaudeProvider("sk-test-key");
    const env = (provider.settingsConfig as { env: Record<string, string> })
      .env;
    expect(env.ANTHROPIC_BASE_URL).toBe(HSFP_CLAUDE_BASE_URL);
    expect(env.ANTHROPIC_BASE_URL).toBe("https://new-api.hsfp.cn");
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("sk-test-key");
    expect(env.ANTHROPIC_MODEL).toBe(HSFP_DEFAULT_MODEL);
    expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe(HSFP_DEFAULT_MODEL);
    expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe(HSFP_DEFAULT_MODEL);
    expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe(HSFP_DEFAULT_MODEL);
  });

  it("Codex 配置写进 auth 的 Key、TOML 里的 deepseek-flash 与 responses 协议", () => {
    const provider = buildHsfpCodexProvider("sk-test-key");
    const config = provider.settingsConfig as {
      auth: Record<string, unknown>;
      config: string;
    };
    expect(config.auth.OPENAI_API_KEY).toBe("sk-test-key");
    expect(config.config).toContain(`model = "${HSFP_DEFAULT_MODEL}"`);
    expect(config.config).toContain('wire_api = "responses"');
    expect(config.config).toContain(`base_url = "${HSFP_CODEX_BASE_URL}"`);
    expect(config.config).toContain('name = "HSFP"');
    // 覆盖模型行不能写出两行 model = …
    expect(config.config.match(/^model\s*=/gm)).toHaveLength(1);
    // 不能出现半价分组里没渠道的模型
    expect(config.config).not.toContain("codex-1");
    expect(config.config).not.toContain("gpt-5");
  });

  it("Key 归一化：允许带 Bearer 前缀与空白，拒绝空/非 sk-", () => {
    expect(normalizeApiKey("  sk-abc  ")).toBe("sk-abc");
    expect(normalizeApiKey("Bearer sk-abc")).toBe("sk-abc");
    expect(() => normalizeApiKey("")).toThrow();
    expect(() => normalizeApiKey("abc")).toThrow();
  });

  it("构造出的供应商带着网站与图标（关于页/卡片能显示）", () => {
    for (const provider of [
      buildHsfpClaudeProvider("sk-x"),
      buildHsfpCodexProvider("sk-x"),
    ]) {
      expect(provider.name).toBe("HSFP");
      expect(provider.websiteUrl).toBe("https://new-api.hsfp.cn");
      expect(provider.icon).toBe("generic");
    }
  });
});
