#!/usr/bin/env python3
"""校验 Tauri updater 清单（latest.json）。

用途：CI 在发布前校验 latest.json，格式不对就直接失败——自动更新的故障一旦发出去，
      所有客户端都会静默收不到更新，属于不可回滚事故。
用法：python3 validate-updater-manifest.py <latest.json> <version>
出参：校验通过打印一行 ✅ 摘要（退出码 0）；失败打印原因（退出码 1）
依赖：python3（标准库）
关键词：tauri, updater, latest.json, pub_date, RFC3339, 校验, CI, 自动更新, 白牌
更新：2026-10-31
"""
import json
import re
import sys

# Tauri updater 用 time::OffsetDateTime::parse(..., Rfc3339) 严格解析，必须完整到秒并带时区。
RFC3339 = re.compile(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z")
REQUIRED_PLATFORMS = {
    "darwin-aarch64",
    "darwin-x86_64",
    "windows-x86_64",
    "windows-aarch64",
    "linux-x86_64",
    "linux-aarch64",
}


def main() -> int:
    if len(sys.argv) != 3:
        print("用法: validate-updater-manifest.py <latest.json> <version>", file=sys.stderr)
        return 2
    path, version = sys.argv[1], sys.argv[2]

    with open(path, encoding="utf-8") as fh:
        try:
            data = json.load(fh)
        except json.JSONDecodeError as exc:
            print(f"❌ latest.json 不是合法 JSON: {exc}", file=sys.stderr)
            return 1

    pub = data.get("pub_date")
    if not isinstance(pub, str) or not RFC3339.fullmatch(pub):
        print(f"❌ pub_date 不是完整 RFC3339: {pub!r}", file=sys.stderr)
        return 1

    if data.get("version") != version:
        print(f"❌ version 与 tag 不一致: {data.get('version')!r} != {version!r}", file=sys.stderr)
        return 1

    platforms = data.get("platforms") or {}
    missing = REQUIRED_PLATFORMS - set(platforms)
    if missing:
        print(f"❌ 缺少平台: {sorted(missing)}", file=sys.stderr)
        return 1

    for key, value in platforms.items():
        if not isinstance(value, dict) or not value.get("signature") or not value.get("url"):
            print(f"❌ 平台 {key} 缺少 signature/url", file=sys.stderr)
            return 1

    print(f"✅ latest.json validated: version={version} pub_date={pub} platforms={len(platforms)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
