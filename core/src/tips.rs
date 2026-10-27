//! Space-keeping tips for the app's Tips panel.
//!
//! The same tips as `di tips` (backend/diskcli/tips.py); keep the two lists
//! in sync. Each tip says when it is relevant (tool installed, folder
//! present, disk low) and which platforms it applies to.

use serde::Serialize;
use std::path::{Path, PathBuf};

const GB: u64 = 1 << 30;
const LOW_SPACE: u64 = 20 * GB;

#[cfg(windows)]
const PLATFORM: &str = "win32";
#[cfg(target_os = "macos")]
const PLATFORM: &str = "darwin";
#[cfg(not(any(windows, target_os = "macos")))]
const PLATFORM: &str = "linux";

struct Tip {
    id: &'static str,
    title: &'static str,
    body: &'static str,
    command: &'static str,
    /// Shown when any condition holds: "always", "low", "darwin", "win32",
    /// "linux", "tool:<name>", or "path:<p>" where p is home-relative or
    /// starts with %LOCALAPPDATA% / %APPDATA%.
    when: &'static [&'static str],
    /// Only ever shown on these platforms (empty = all).
    only: &'static [&'static str],
}

const fn tip(
    id: &'static str,
    title: &'static str,
    body: &'static str,
    command: &'static str,
    when: &'static [&'static str],
    only: &'static [&'static str],
) -> Tip {
    Tip { id, title, body, command, when, only }
}

const NVM_COMMAND: &str = if cfg!(windows) { "nvm list" } else { "nvm ls" };
const IOS_BACKUP_COMMAND: &str = if cfg!(windows) {
    "explorer %APPDATA%\\Apple Computer\\MobileSync\\Backup"
} else {
    "du -sh ~/Library/Application\\ Support/MobileSync/Backup"
};
const TRASH_COMMAND: &str = if cfg!(target_os = "macos") { "du -sh ~/.Trash" } else { "du -sh ~/.local/share/Trash" };

const TIPS: &[Tip] = &[
    tip("docker-disk",
        "Docker's disk image keeps what it grabs",
        "Docker.raw grows as images and volumes pile up. Pruning frees space inside the VM; \
         Docker Desktop then hands it back to macOS. Lower Settings → Resources → Disk usage limit \
         to cap how big it can get.",
        "docker system prune -a --volumes",
        &["tool:docker", "path:Library/Containers/com.docker.docker"], &["darwin"]),
    tip("wsl-vhdx",
        "WSL and Docker disks only ever grow",
        "WSL distros and Docker Desktop keep their files in .vhdx virtual disks that don't shrink when \
         you delete things inside them. Prune Docker first, then make the disks sparse (WSL 2.0+) \
         so freed space returns to Windows automatically.",
        "docker system prune -a --volumes; wsl --shutdown; wsl --manage <distro> --set-sparse true",
        &["tool:wsl", "tool:docker", "path:%LOCALAPPDATA%/Docker/wsl"], &["win32"]),
    tip("hiberfil",
        "hiberfil.sys can be many GB",
        "Hibernation reserves a file sized to a large share of your RAM on C:. If you never hibernate, \
         turn it off (admin terminal). Fast Startup also uses it.",
        "powercfg /hibernate off",
        &["win32"], &["win32"]),
    tip("pagefile",
        "The page file lives on C:",
        "Windows grows pagefile.sys when memory runs short. Closing idle Electron apps and dev servers \
         keeps it small; check its current size in Settings → System → About → Advanced system settings.",
        "Get-CimInstance Win32_PageFileUsage",
        &["win32"], &["win32"]),
    tip("restore-points",
        "System Restore can hold a lot of space",
        "Restore points and shadow copies are capped as a percentage of the drive. Check the cap and lower \
         it under System Protection → Configure if it's large.",
        "vssadmin list shadowstorage",
        &["win32"], &["win32"]),
    tip("winsxs",
        "Old Windows Update components",
        "The component store (WinSxS) keeps superseded update files. Cleaning it is safe; run it from \
         an admin terminal.",
        "Dism.exe /Online /Cleanup-Image /StartComponentCleanup",
        &["win32"], &["win32"]),
    tip("storage-sense",
        "Storage Sense is Windows' built-in guard",
        "Turn it on in Settings → System → Storage to empty the Recycle Bin, temp files and old \
         Downloads on a schedule. It pairs well with di guard for developer caches.",
        "start ms-settings:storagepolicies",
        &["win32"], &["win32"]),
    tip("recycle-bin",
        "Deleted isn't freed until the Recycle Bin is empty",
        "Files in the Recycle Bin still count against your drive.",
        "Clear-RecycleBin -Force",
        &["win32"], &["win32"]),
    tip("apfs-snapshots",
        "\"System Data\" is often snapshots",
        "Time Machine and macOS updates leave local APFS snapshots that hold on to deleted files. \
         Update snapshots clear after the update finishes and you restart; Time Machine ones can be thinned.",
        "tmutil listlocalsnapshots /",
        &["darwin"], &["darwin"]),
    tip("purgeable",
        "Finder's \"available\" counts space macOS hasn't freed yet",
        "Finder includes purgeable space (caches, snapshots) that macOS only frees under pressure. \
         df shows what is actually free right now.",
        "df -h /System/Volumes/Data",
        &["darwin"], &["darwin"]),
    tip("swap",
        "Swap lives on your disk",
        "When memory runs short, macOS writes swap files to /private/var/vm, and they can reach several GB. \
         Quitting idle Electron apps and dev servers keeps swap small; a restart clears it.",
        "sysctl vm.swapusage",
        &["darwin"], &["darwin"]),
    tip("headroom",
        "Leave 10–15% of the disk free",
        "APFS, swap and updates all need working room, and a nearly full SSD is slower. \
         A ballast file holds a floor of space you can release in an emergency.",
        "di ballast set 5G",
        &["low"], &[]),
    tip("guard",
        "Let di watch the disk for you",
        "The guard runs every couple of hours: it notifies you when space runs low, cleans safe caches, \
         and releases the ballast when things get critical.",
        "di guard --auto --dev ~/dev --install",
        &["always"], &[]),
    tip("dev-junk",
        "Old projects keep their node_modules forever",
        "Dependencies and build caches in projects you haven't touched in weeks are pure dead weight. \
         Reinstalling takes one command when you come back.",
        "di clean ~/dev --older-than 14",
        &["path:dev"], &[]),
    tip("pkg-caches",
        "Package managers never clean up after themselves",
        "npm, yarn, bun, pip, cargo and editor updaters keep every download. They are safe to clear \
         and refill as needed.",
        "di caches",
        &["always"], &[]),
    tip("brew",
        "Homebrew keeps old versions and downloads",
        "brew cleanup deletes old kegs and cached downloads; autoremove drops dependencies nothing uses.",
        "brew cleanup -s --prune=all && brew autoremove",
        &["tool:brew"], &["darwin", "linux"]),
    tip("xcode",
        "Xcode and simulators are space hogs",
        "DerivedData, old device support files and simulator runtimes for unavailable devices \
         can take tens of GB.",
        "xcrun simctl delete unavailable",
        &["path:Library/Developer"], &["darwin"]),
    tip("nvm",
        "Unused Node versions add up",
        "Each Node version under nvm is 50–100 MB, plus its global packages.",
        NVM_COMMAND,
        &["path:.nvm", "path:%APPDATA%/nvm"], &[]),
    tip("conda",
        "Conda keeps every package tarball",
        "conda clean removes cached tarballs and unused packages.",
        "conda clean -a",
        &["tool:conda"], &[]),
    tip("ios-backups",
        "Old iPhone backups",
        "Device backups live in MobileSync and can be many GB each. Manage them in Finder \
         (select the device → Manage Backups), or in iTunes / Apple Devices on Windows.",
        IOS_BACKUP_COMMAND,
        &["path:Library/Application Support/MobileSync/Backup",
          "path:%APPDATA%/Apple Computer/MobileSync/Backup", "path:Apple/MobileSync/Backup"], &[]),
    tip("messages",
        "Messages attachments",
        "Photos and videos from Messages pile up in ~/Library/Messages. System Settings → General → \
         Storage → Messages lets you review and remove large attachments.",
        "du -sh ~/Library/Messages/Attachments",
        &["path:Library/Messages/Attachments"], &["darwin"]),
    tip("trash",
        "Deleted isn't freed until the Trash is empty",
        "Anything in the Trash still counts against your disk.",
        TRASH_COMMAND,
        &["path:.Trash", "path:.local/share/Trash"], &["darwin", "linux"]),
    tip("apt-cache",
        "apt keeps every package it downloads",
        "Downloaded .deb files stay in /var/cache/apt/archives after install. autoremove also drops \
         old kernels and dependencies nothing needs any more.",
        "sudo apt clean && sudo apt autoremove --purge",
        &["tool:apt"], &["linux"]),
    tip("journald",
        "The system journal grows to its cap",
        "journald keeps logs until they hit a size limit that can be several GB, which hurts on a small \
         SD card. Vacuum it now; set SystemMaxUse= in /etc/systemd/journald.conf to keep it down.",
        "sudo journalctl --vacuum-size=200M",
        &["tool:journalctl"], &["linux"]),
    tip("docker-linux",
        "Docker images and volumes pile up",
        "Old images, stopped containers and dangling volumes live under /var/lib/docker.",
        "docker system df && docker system prune -a --volumes",
        &["tool:docker"], &["linux"]),
];

#[derive(Debug, Serialize)]
pub struct TipRow {
    pub id: &'static str,
    pub title: &'static str,
    pub body: &'static str,
    pub command: &'static str,
    pub relevant: bool,
}

#[derive(Debug, Serialize)]
pub struct TipsPayload {
    pub free_bytes: u64,
    pub low_space: bool,
    pub tips: Vec<TipRow>,
}

fn home() -> PathBuf {
    dirs::home_dir().unwrap_or_else(|| PathBuf::from("."))
}

/// Free space on the disk that holds the home folder.
pub fn free_bytes() -> u64 {
    fs4::available_space(home()).unwrap_or(0)
}

fn condition_path(p: &str) -> Option<PathBuf> {
    if let Some(rest) = p.strip_prefix('%') {
        let (var, rest) = rest.split_once('%')?;
        let base = std::env::var_os(var)?;
        return Some(Path::new(&base).join(rest.trim_matches('/')));
    }
    Some(home().join(p))
}

fn condition(cond: &str, free: u64) -> bool {
    match cond {
        "always" => true,
        "low" => free < LOW_SPACE,
        "darwin" | "win32" | "linux" => cond == PLATFORM,
        _ => {
            if let Some(p) = cond.strip_prefix("path:") {
                condition_path(p).is_some_and(|full| full.exists())
            } else if let Some(tool) = cond.strip_prefix("tool:") {
                which::which(tool).is_ok()
            } else {
                false
            }
        }
    }
}

fn applies_here(t: &Tip) -> bool {
    t.only.is_empty() || t.only.contains(&PLATFORM)
}

/// Free space and every tip for this platform, relevant ones first.
pub fn tips_payload() -> TipsPayload {
    let free = free_bytes();
    let mut tips: Vec<TipRow> = TIPS
        .iter()
        .filter(|t| applies_here(t))
        .map(|t| TipRow {
            id: t.id,
            title: t.title,
            body: t.body,
            command: t.command,
            relevant: t.when.iter().any(|c| condition(c, free)),
        })
        .collect();
    // Stable sort keeps the list order within each group.
    tips.sort_by_key(|t| !t.relevant);
    TipsPayload { free_bytes: free, low_space: free < LOW_SPACE, tips }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn relevant_tips_come_first_and_other_platforms_are_left_out() {
        let payload = tips_payload();
        assert!(!payload.tips.is_empty());
        let first_irrelevant = payload.tips.iter().position(|t| !t.relevant).unwrap_or(payload.tips.len());
        assert!(payload.tips[first_irrelevant..].iter().all(|t| !t.relevant));
        // "guard" is always relevant on every platform.
        assert!(payload.tips.iter().any(|t| t.id == "guard" && t.relevant));
        let foreign = if PLATFORM == "win32" { "apfs-snapshots" } else { "hiberfil" };
        assert!(payload.tips.iter().all(|t| t.id != foreign));
    }

    #[test]
    fn same_tip_ids_as_the_cli() {
        let py = include_str!("../../backend/diskcli/tips.py");
        for t in TIPS {
            assert!(py.contains(&format!("Tip(\"{}\"", t.id)), "{} missing from tips.py", t.id);
        }
        let py_count = py.matches("    Tip(\"").count();
        assert_eq!(py_count, TIPS.len(), "tips.py and tips.rs have different tips");
    }
}
