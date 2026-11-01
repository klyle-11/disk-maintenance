//! Tips for keeping freed space free: the same list `di tips` prints, read
//! from the tips.json both share.

use serde::{Deserialize, Serialize};

use crate::util::{free_bytes, home_dir};

const LOW_SPACE: u64 = 20 * (1 << 30);
const TIPS_JSON: &str = include_str!("../../backend/diskcli/tips.json");

#[derive(Debug, Deserialize)]
struct TipDef {
    id: String,
    title: String,
    body: String,
    #[serde(default)]
    command: String,
    /// Shown when any condition holds (see `condition`).
    #[serde(default = "always")]
    when: Vec<String>,
    /// Only ever shown on these platforms (empty = all).
    #[serde(default)]
    only: Vec<String>,
}

fn always() -> Vec<String> {
    vec!["always".into()]
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Tip {
    pub id: String,
    pub title: String,
    pub body: String,
    pub command: String,
    /// True when the tip applies to this machine right now.
    pub relevant: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct TipsPayload {
    pub free_bytes: u64,
    pub low_space: bool,
    pub tips: Vec<Tip>,
}

/// The platform names tips.json uses (Python's sys.platform).
fn platform() -> &'static str {
    if cfg!(target_os = "macos") {
        "darwin"
    } else if cfg!(target_os = "windows") {
        "win32"
    } else {
        "linux"
    }
}

/// A tips.json path: home-relative, or starting with %LOCALAPPDATA% / %APPDATA%.
fn expand(p: &str) -> Option<std::path::PathBuf> {
    if let Some(rest) = p.strip_prefix('%') {
        let (var, tail) = rest.split_once('%')?;
        let base = std::env::var_os(var)?;
        return Some(tail.trim_matches('/').split('/').fold(std::path::PathBuf::from(base), |acc, part| acc.join(part)));
    }
    Some(p.split('/').fold(home_dir(), |acc, part| acc.join(part)))
}

fn condition(cond: &str, free: u64) -> bool {
    match cond {
        "always" => true,
        "low" => free < LOW_SPACE,
        "darwin" | "win32" | "linux" => cond == platform(),
        _ => {
            if let Some(path) = cond.strip_prefix("path:") {
                expand(path).map(|p| p.exists()).unwrap_or(false)
            } else if let Some(tool) = cond.strip_prefix("tool:") {
                which::which(tool).is_ok()
            } else {
                false
            }
        }
    }
}

/// Every tip for this OS, the ones that apply here first.
pub fn payload() -> TipsPayload {
    let free = free_bytes();
    let defs: Vec<TipDef> = serde_json::from_str(TIPS_JSON).expect("tips.json is valid");
    let mut tips: Vec<Tip> = defs
        .into_iter()
        .filter(|t| t.only.is_empty() || t.only.iter().any(|p| p == platform()))
        .map(|t| Tip {
            relevant: t.when.iter().any(|c| condition(c, free)),
            id: t.id,
            title: t.title,
            body: t.body,
            command: t.command,
        })
        .collect();
    // Stable: relevant ones first, otherwise in file order.
    tips.sort_by_key(|t| !t.relevant);
    TipsPayload { free_bytes: free, low_space: free < LOW_SPACE, tips }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn loads_every_tip_for_this_os() {
        let p = payload();
        assert!(!p.tips.is_empty());
        let first_irrelevant = p.tips.iter().position(|t| !t.relevant).unwrap_or(p.tips.len());
        assert!(p.tips[first_irrelevant..].iter().all(|t| !t.relevant), "relevant tips come first");
        assert!(p.tips.iter().any(|t| t.id == "guard"), "an always-relevant tip");
    }
}
