//! Codex 桌面版（Apps 页的「Codex Desktop」行）。
//!
//! 两件事：
//! 1. 探测装没装：Windows 走 `Get-AppxPackage`（2026-07 起桌面版并进了 ChatGPT 应用，
//!    包名/.msix 仍是 Codex），macOS 看 `/Applications` 下的 `Codex.app` / `ChatGPT.app`；
//!    Linux 暂不支持。所有探测失败都降级成「没装」，不把错误抛给前端。
//! 2. 写配置：桌面 App 与 CLI **共用** `~/.codex/config.toml`，所以只在这份文件里做外科式
//!    增改。桌面 App 不继承 shell 环境变量，key 必须明文写进
//!    `[model_providers.hsfp.http_headers] Authorization`，不能用 `env_key`。

use std::path::{Path, PathBuf};

use serde::Serialize;
use toml_edit::{DocumentMut, Item, Table, TableLike, Value};

use crate::codex_config::get_codex_config_path;
use crate::config::atomic_write;

/// 半价分组只给 deepseek 系开了渠道（`codex-1` 之类会 503），默认模型按此写死。
pub(crate) const HSFP_PROVIDER_ID: &str = "hsfp";
pub(crate) const HSFP_PROVIDER_NAME: &str = "HSFP";
pub(crate) const HSFP_BASE_URL: &str = "https://new-api.hsfp.cn/v1";
pub(crate) const HSFP_WIRE_API: &str = "responses";
pub(crate) const HSFP_DEFAULT_MODEL: &str = "deepseek-flash";

/// Windows：只输出 Name/Version，`-Compress` 让 JSON 单行。
#[cfg(target_os = "windows")]
const LIST_PACKAGES_SCRIPT: &str = "Get-AppxPackage | Where-Object { $_.Name -like 'OpenAI.Codex*' -or $_.Name -like '*ChatGPT*' } | Select-Object Name,Version | ConvertTo-Json -Compress";

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexDesktopPackage {
    pub name: String,
    pub version: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexDesktopStatus {
    /// Linux 为 false；Windows / macOS 为 true（探测失败也 true，只是 installed=false）
    pub supported: bool,
    pub installed: bool,
    pub packages: Vec<CodexDesktopPackage>,
    /// config.toml 里已经有 `[model_providers.hsfp]` 且 `model_provider = "hsfp"`
    pub configured: bool,
    pub config_path: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexDesktopConfigureResult {
    /// 备份文件路径；原来没有 config.toml 时为空字符串
    pub backup_path: String,
    pub config_path: String,
}

#[tauri::command]
pub fn codex_desktop_status() -> CodexDesktopStatus {
    let config_path = get_codex_config_path();
    let config_text = std::fs::read_to_string(&config_path).unwrap_or_default();
    let packages = detect_packages();
    CodexDesktopStatus {
        supported: is_supported_platform(),
        installed: !packages.is_empty(),
        packages,
        configured: is_hsfp_configured(&config_text),
        config_path: config_path.to_string_lossy().into_owned(),
    }
}

#[tauri::command]
pub fn configure_codex_desktop(api_key: String) -> Result<CodexDesktopConfigureResult, String> {
    // 注意：这条链路上一律不打印 api_key（日志里到处都是 log::info!）。
    validate_api_key(&api_key)?;
    let api_key = api_key.trim();

    let config_path = get_codex_config_path();
    let original = if config_path.exists() {
        std::fs::read_to_string(&config_path)
            .map_err(|e| format!("读取 {} 失败：{e}", config_path.display()))?
    } else {
        String::new()
    };

    let updated = apply_hsfp_config(&original, api_key)?;
    let backup = write_config_with_backup(&config_path, &original, &updated)?;

    Ok(CodexDesktopConfigureResult {
        backup_path: backup
            .map(|path| path.to_string_lossy().into_owned())
            .unwrap_or_default(),
        config_path: config_path.to_string_lossy().into_owned(),
    })
}

// ============================================================================
// 探测
// ============================================================================

fn is_supported_platform() -> bool {
    cfg!(any(windows, target_os = "macos"))
}

fn detect_packages() -> Vec<CodexDesktopPackage> {
    #[cfg(target_os = "windows")]
    {
        list_windows_packages()
    }

    #[cfg(target_os = "macos")]
    {
        list_macos_bundles()
    }

    #[cfg(not(any(windows, target_os = "macos")))]
    {
        Vec::new()
    }
}

/// `ConvertTo-Json` 单条结果时给的是对象、多条时才是数组，两种都要认。
fn parse_windows_packages(json: &str) -> Vec<CodexDesktopPackage> {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(json.trim()) else {
        return Vec::new();
    };
    let entries = match value {
        serde_json::Value::Array(items) => items,
        serde_json::Value::Object(_) => vec![value],
        _ => Vec::new(),
    };
    entries
        .into_iter()
        .filter_map(|entry| {
            let name = entry.get("Name")?.as_str()?.trim();
            if name.is_empty() {
                return None;
            }
            let version = entry
                .get("Version")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("")
                .trim()
                .to_string();
            Some(CodexDesktopPackage {
                name: name.to_string(),
                version,
            })
        })
        .collect()
}

#[cfg(target_os = "windows")]
fn list_windows_packages() -> Vec<CodexDesktopPackage> {
    use std::os::windows::process::CommandExt;
    use std::process::Command;

    let encoded = super::misc::powershell_encoded_command(LIST_PACKAGES_SCRIPT);
    let output = Command::new("powershell")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-EncodedCommand",
            &encoded,
        ])
        .creation_flags(CREATE_NO_WINDOW)
        .output();
    match output {
        Ok(output) if output.status.success() => {
            parse_windows_packages(&String::from_utf8_lossy(&output.stdout))
        }
        _ => Vec::new(),
    }
}

/// macOS 上的两个候选应用包：桌面版并进 ChatGPT 之后，app 名字叫哪个的都有。
const MACOS_BUNDLES: &[&str] = &["Codex.app", "ChatGPT.app"];

#[cfg(target_os = "macos")]
fn list_macos_bundles() -> Vec<CodexDesktopPackage> {
    let mut packages = Vec::new();
    for bundle in MACOS_BUNDLES {
        let path = Path::new("/Applications").join(bundle);
        if !path.is_dir() {
            continue;
        }
        let name = bundle.trim_end_matches(".app").to_string();
        // bundle id / 版本都读不到就留空，不当错误
        let _bundle_id = read_plist_string(&path, "CFBundleIdentifier");
        let version = read_plist_string(&path, "CFBundleShortVersionString")
            .or_else(|| read_plist_string(&path, "CFBundleVersion"))
            .unwrap_or_default();
        packages.push(CodexDesktopPackage { name, version });
    }
    packages
}

/// 先问 `mdls`（App Store 应用的 Info.plist 有时候不在包内），再退到 `defaults read`。
#[cfg(target_os = "macos")]
fn read_plist_string(bundle: &Path, key: &str) -> Option<String> {
    use std::process::Command;

    if let Some(value) = mdls_value(bundle, key) {
        return Some(value);
    }
    let plist = bundle.join("Contents").join("Info.plist");
    let output = Command::new("defaults")
        .arg("read")
        .arg(&plist)
        .arg(key)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if text.is_empty() {
        None
    } else {
        Some(text)
    }
}

#[cfg(target_os = "macos")]
fn mdls_value(bundle: &Path, key: &str) -> Option<String> {
    use std::process::Command;

    let output = Command::new("mdls")
        .arg("-name")
        .arg(key)
        .arg(bundle)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout);
    // 形如 `kMDItemVersion = "1.2.3"`；读不到时是 `(null)`
    let (_, value) = text.split_once('=')?;
    let value = value.trim().trim_matches('"').trim();
    if value.is_empty() || value == "(null)" {
        None
    } else {
        Some(value.to_string())
    }
}

/// 只认我们写的那一套：有 `[model_providers.hsfp]` 且 `model_provider = "hsfp"`。
fn is_hsfp_configured(config_text: &str) -> bool {
    let Ok(doc) = config_text.parse::<DocumentMut>() else {
        return false;
    };
    let active = doc
        .get("model_provider")
        .and_then(Item::as_str)
        .map(str::trim)
        .unwrap_or_default();
    let has_section = doc
        .get("model_providers")
        .and_then(|providers| providers.get(HSFP_PROVIDER_ID))
        .is_some();
    active == HSFP_PROVIDER_ID && has_section
}

// ============================================================================
// 写配置
// ============================================================================

fn validate_api_key(api_key: &str) -> Result<(), String> {
    let key = api_key.trim();
    if key.is_empty() {
        return Err("API Key 不能为空".to_string());
    }
    if !key.starts_with("sk-") {
        return Err("API Key 必须以 sk- 开头".to_string());
    }
    if key.len() <= 3 {
        return Err("API Key 不完整".to_string());
    }
    if key.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return Err("API Key 里不能有空白或控制字符".to_string());
    }
    Ok(())
}

/// 「读文本 → 改文本」的纯函数：只动我们自己的几个键，其余部分保持原样。
///
/// 允许改动的范围（别的键一个都不许碰）：
/// - 顶层 `model`、`model_provider`
/// - `[model_providers.hsfp]` 整个子树（含 `http_headers`，并删掉 `env_key`）
pub(crate) fn apply_hsfp_config(original: &str, api_key: &str) -> Result<String, String> {
    let before = parse_config(original)?;
    let mut doc = parse_config(original)?;

    {
        let table = doc.as_table_mut();
        set_string(table, "model", HSFP_DEFAULT_MODEL);
        set_string(table, "model_provider", HSFP_PROVIDER_ID);
    }

    let created_providers = !doc.contains_key("model_providers");
    {
        let providers_item = doc
            .entry("model_providers")
            .or_insert_with(|| Item::Table(Table::new()));
        if created_providers {
            if let Item::Table(table) = providers_item {
                // 只有子表时不必单独渲染一行 `[model_providers]`
                table.set_implicit(true);
            }
        }
        let providers = providers_item
            .as_table_like_mut()
            .ok_or_else(|| "config.toml 里的 model_providers 不是表，无法安全写入".to_string())?;
        if !providers.contains_key(HSFP_PROVIDER_ID) {
            providers.insert(HSFP_PROVIDER_ID, Item::Table(Table::new()));
        }
        let hsfp = providers
            .get_mut(HSFP_PROVIDER_ID)
            .and_then(Item::as_table_like_mut)
            .ok_or_else(|| {
                format!("config.toml 里的 model_providers.{HSFP_PROVIDER_ID} 不是表")
            })?;
        set_string(hsfp, "name", HSFP_PROVIDER_NAME);
        set_string(hsfp, "base_url", HSFP_BASE_URL);
        set_string(hsfp, "wire_api", HSFP_WIRE_API);
        // 桌面版不继承环境变量：留着 env_key 会让 Codex 去找一个不存在的变量
        hsfp.remove("env_key");
        if !hsfp.contains_key("http_headers") {
            hsfp.insert("http_headers", Item::Table(Table::new()));
        }
        let headers = hsfp
            .get_mut("http_headers")
            .and_then(Item::as_table_like_mut)
            .ok_or_else(|| {
                format!("config.toml 里的 model_providers.{HSFP_PROVIDER_ID}.http_headers 不是表")
            })?;
        set_string(headers, "Authorization", &format!("Bearer {api_key}"));
    }

    let updated = doc.to_string();

    // 自检：把改完的文本再解析一遍，断言除上面几个键外其它键的字符串表示完全相同。
    let after = updated
        .parse::<DocumentMut>()
        .map_err(|e| format!("写入结果不是合法 TOML：{e}"))?;
    ensure_untouched(&before, &after)?;

    Ok(updated)
}

fn parse_config(text: &str) -> Result<DocumentMut, String> {
    if text.trim().is_empty() {
        return Ok(DocumentMut::new());
    }
    text.parse::<DocumentMut>()
        .map_err(|e| format!("config.toml 解析失败：{e}"))
}

/// 写字符串值；已有同名字面值时尽量沿用它的前缀装饰（缩进、空格），少制造无谓 diff。
fn set_string(table: &mut dyn TableLike, key: &str, value: &str) {
    if let Some(item) = table.get_mut(key) {
        if let Some(existing) = item.as_value() {
            let decor = existing.decor().clone();
            let mut new_value = Value::from(value);
            *new_value.decor_mut() = decor;
            *item = Item::Value(new_value);
            return;
        }
    }
    table.insert(key, Item::Value(Value::from(value)));
}

/// 允许改动的路径前缀。
fn is_writable_path(path: &[String]) -> bool {
    match path.len() {
        0 => false,
        1 => path[0] == "model" || path[0] == "model_provider",
        _ => path[0] == "model_providers" && path[1] == HSFP_PROVIDER_ID,
    }
}

/// 原本没有 `[model_providers]` 时，这个容器段是我们新建的：允许它出现，但仍要求
/// 里面的子段只有 `hsfp`（递归时其它子段照样会报错）。
fn is_writable_container(path: &[String]) -> bool {
    path.len() == 1 && path[0] == "model_providers"
}

fn ensure_untouched(before: &DocumentMut, after: &DocumentMut) -> Result<(), String> {
    compare_tables(before.as_table(), after.as_table(), &[])
}

fn compare_tables(
    before: &dyn TableLike,
    after: &dyn TableLike,
    path: &[String],
) -> Result<(), String> {
    let mut keys: Vec<String> = before.iter().map(|(key, _)| key.to_string()).collect();
    for (key, _) in after.iter() {
        if !keys.iter().any(|known| known == key) {
            keys.push(key.to_string());
        }
    }

    for key in keys {
        let mut child = path.to_vec();
        child.push(key.clone());
        if is_writable_path(&child) {
            continue;
        }
        match (before.get(&key), after.get(&key)) {
            (Some(before_item), Some(after_item)) => {
                compare_items(before_item, after_item, &child)?;
            }
            (None, Some(after_item)) if is_writable_container(&child) => {
                if let Some(after_table) = after_item.as_table_like() {
                    let empty = Table::new();
                    compare_tables(&empty, after_table, &child)?;
                }
            }
            (None, None) => {}
            _ => {
                return Err(format!("写入时意外改动了配置段 {}", child.join(".")));
            }
        }
    }

    Ok(())
}

fn compare_items(before: &Item, after: &Item, path: &[String]) -> Result<(), String> {
    match (before.as_table_like(), after.as_table_like()) {
        (Some(before_table), Some(after_table)) => {
            compare_tables(before_table, after_table, path)
        }
        _ => {
            if before.to_string() == after.to_string() {
                Ok(())
            } else {
                Err(format!("写入时意外改动了配置键 {}", path.join(".")))
            }
        }
    }
}

/// 先把原文复制成 `config.toml.bak.<YYYYMMDDHHMMSS>`，再原子写新内容。
///
/// 同一秒里重复点（或第二次点）时，加序号后缀避免覆盖已有备份；备份只复制、不移动。
fn write_config_with_backup(
    config_path: &Path,
    original: &str,
    updated: &str,
) -> Result<Option<PathBuf>, String> {
    if let Some(parent) = config_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("创建 {} 失败：{e}", parent.display()))?;
    }

    let backup = if config_path.exists() {
        Some(create_backup(config_path)?)
    } else {
        None
    };

    atomic_write(config_path, updated.as_bytes())
        .map_err(|e| format!("写入 {} 失败：{e}", config_path.display()))?;

    if let Some(path) = backup.as_ref() {
        // 复制之后再确认一遍，读到的原文就是备份里那份
        let copied = std::fs::read(path).unwrap_or_default();
        if copied != original.as_bytes() {
            return Err(format!(
                "备份 {} 与读到的原文不一致，已中止写入",
                path.display()
            ));
        }
    }

    Ok(backup)
}

fn create_backup(config_path: &Path) -> Result<PathBuf, String> {
    let dir = config_path
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."));
    let file_name = config_path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "config.toml".to_string());
    let stamp = chrono::Local::now().format("%Y%m%d%H%M%S").to_string();

    let mut candidate = dir.join(format!("{file_name}.bak.{stamp}"));
    let mut attempt = 0u32;
    while candidate.exists() {
        attempt += 1;
        candidate = dir.join(format!("{file_name}.bak.{stamp}-{attempt}"));
        if attempt > 100 {
            return Err(format!("{} 附近备份文件过多，放弃写入", dir.display()));
        }
    }

    std::fs::copy(config_path, &candidate)
        .map_err(|e| format!("备份 {} 失败：{e}", config_path.display()))?;
    Ok(candidate)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 用户手写的配置：`[desktop]`、`[projects.*]`、`[sandbox_workspace_write]`、`mcp_servers`
    /// 以及一个「已经不是第一次配置」的 hsfp 段（带 `env_key`）。
    const SAMPLE: &str = r#"model = "gpt-5"
model_provider = "custom"

[desktop]
locale = "zh-CN"
theme = "dark"

[projects."/tmp/x"]
trust_level = "trusted"

[model_providers.hsfp]
name = "HSFP"
base_url = "https://old.example/v1"
env_key = "HSFP_API_KEY"

[model_providers.other]
name = "Other"
base_url = "https://other.example/v1"

[sandbox_workspace_write]
network_access = true

[mcp_servers.files]
command = "npx"
args = ["-y", "files"]
"#;

    const UNTOUCHED_SEGMENTS: &[&str] = &[
        "[desktop]\nlocale = \"zh-CN\"\ntheme = \"dark\"",
        "[projects.\"/tmp/x\"]\ntrust_level = \"trusted\"",
        "[model_providers.other]\nname = \"Other\"\nbase_url = \"https://other.example/v1\"",
        "[sandbox_workspace_write]\nnetwork_access = true",
        "[mcp_servers.files]\ncommand = \"npx\"\nargs = [\"-y\", \"files\"]",
    ];

    #[test]
    fn apply_writes_hsfp_and_keeps_other_sections_byte_identical() {
        let updated = apply_hsfp_config(SAMPLE, "sk-test-0123").expect("apply");

        for segment in UNTOUCHED_SEGMENTS {
            assert!(
                updated.contains(segment),
                "段落被改动了：{segment}\n--- 实际 ---\n{updated}"
            );
        }

        let doc: DocumentMut = updated.parse().expect("parse result");
        assert_eq!(doc["model"].as_str(), Some(HSFP_DEFAULT_MODEL));
        assert_eq!(doc["model_provider"].as_str(), Some(HSFP_PROVIDER_ID));

        let hsfp = &doc["model_providers"]["hsfp"];
        assert_eq!(hsfp["name"].as_str(), Some(HSFP_PROVIDER_NAME));
        assert_eq!(hsfp["base_url"].as_str(), Some(HSFP_BASE_URL));
        assert_eq!(hsfp["wire_api"].as_str(), Some(HSFP_WIRE_API));
        assert!(
            hsfp.get("env_key").is_none(),
            "env_key 应该被删掉：{updated}"
        );
        assert_eq!(
            hsfp["http_headers"]["Authorization"].as_str(),
            Some("Bearer sk-test-0123")
        );

        // 键值顺序 / 段顺序也没被整篇重排
        let desktop_pos = updated.find("[desktop]").unwrap();
        let projects_pos = updated.find("[projects.\"/tmp/x\"]").unwrap();
        assert!(desktop_pos < projects_pos);
        assert!(is_hsfp_configured(&updated));
    }

    #[test]
    fn apply_on_empty_config_creates_a_complete_document() {
        let updated = apply_hsfp_config("", "sk-empty-1").expect("apply");
        let doc: DocumentMut = updated.parse().expect("parse result");
        assert_eq!(doc["model"].as_str(), Some(HSFP_DEFAULT_MODEL));
        assert_eq!(
            doc["model_providers"]["hsfp"]["http_headers"]["Authorization"].as_str(),
            Some("Bearer sk-empty-1")
        );
        assert!(is_hsfp_configured(&updated));
    }

    #[test]
    fn apply_rejects_unparsable_config() {
        assert!(apply_hsfp_config("model = \n[oops", "sk-x-1").is_err());
    }

    #[test]
    fn backup_file_holds_the_original_text() {
        let dir = tempfile::tempdir().expect("tempdir");
        let config_path = dir.path().join("config.toml");
        std::fs::write(&config_path, SAMPLE).expect("seed");
        let original = std::fs::read_to_string(&config_path).expect("read seeded");

        let updated = apply_hsfp_config(&original, "sk-backup-1").expect("apply");
        let backup = write_config_with_backup(&config_path, &original, &updated)
            .expect("write")
            .expect("有原文时必须有备份");

        assert_eq!(backup.parent(), Some(dir.path()));
        let backup_name = backup
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default();
        assert!(
            backup_name.starts_with("config.toml.bak."),
            "备份名不合规：{backup_name}"
        );
        assert_eq!(
            std::fs::read_to_string(&backup).expect("read backup"),
            original
        );
        assert_eq!(
            std::fs::read_to_string(&config_path).expect("read written"),
            updated
        );

        // 同一秒里再写一次：旧备份不能被覆盖
        let second = write_config_with_backup(&config_path, &updated, &updated)
            .expect("write again")
            .expect("backup");
        assert_ne!(second, backup);
        assert_eq!(
            std::fs::read_to_string(&backup).expect("read first backup"),
            original
        );
    }

    #[test]
    fn backup_is_skipped_when_config_does_not_exist() {
        let dir = tempfile::tempdir().expect("tempdir");
        let config_path = dir.path().join("nested").join("config.toml");
        let updated = apply_hsfp_config("", "sk-new-1").expect("apply");
        let backup = write_config_with_backup(&config_path, "", &updated).expect("write");
        assert!(backup.is_none());
        assert_eq!(
            std::fs::read_to_string(&config_path).expect("read written"),
            updated
        );
    }

    #[test]
    fn parses_single_object_and_array_package_json() {
        let single = r#"[{"Name":"OpenAI.Codex_1.2.3.0_x64__abc","Version":"1.2.3.0"}]"#;
        assert_eq!(
            parse_windows_packages(single),
            vec![CodexDesktopPackage {
                name: "OpenAI.Codex_1.2.3.0_x64__abc".to_string(),
                version: "1.2.3.0".to_string(),
            }]
        );

        let object = r#"{"Name":"OpenAI.ChatGPT_9.9.9.0_x64__def","Version":"9.9.9.0"}"#;
        assert_eq!(
            parse_windows_packages(object),
            vec![CodexDesktopPackage {
                name: "OpenAI.ChatGPT_9.9.9.0_x64__def".to_string(),
                version: "9.9.9.0".to_string(),
            }]
        );

        // 空输出 / 垃圾输出都降级成「没装」
        assert!(parse_windows_packages("").is_empty());
        assert!(parse_windows_packages("Get-AppxPackage : 拒绝访问").is_empty());
    }

    #[test]
    fn detects_hsfp_only_when_both_provider_and_section_are_present() {
        assert!(!is_hsfp_configured(""));
        assert!(!is_hsfp_configured("model_provider = \"hsfp\""));
        assert!(!is_hsfp_configured(
            "[model_providers.hsfp]\nname = \"HSFP\"\n"
        ));
        assert!(is_hsfp_configured(
            "model_provider = \"hsfp\"\n[model_providers.hsfp]\nname = \"HSFP\"\n"
        ));
        // 别的供应商也叫 hsfp 不算
        assert!(!is_hsfp_configured("model_provider = \"custom\"\n[model_providers.hsfp]\n"));
    }

    #[test]
    fn validates_api_key() {
        assert!(validate_api_key("").is_err());
        assert!(validate_api_key("   ").is_err());
        assert!(validate_api_key("pk-123").is_err());
        assert!(validate_api_key("sk-").is_err());
        assert!(validate_api_key("sk-a b").is_err());
        assert!(validate_api_key("sk-0123456789").is_ok());
    }
}
