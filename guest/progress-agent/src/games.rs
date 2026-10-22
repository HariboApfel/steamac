//! Per-game lifetime and memory statistics on the existing heartbeat tick.
//! Steam's user scopes, not focus or windows, define a run: background games
//! and games still starting are included, and multiple scopes remain one run.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use crate::{appname, focus::STEAM_UI_APPID, freeze, port::Port};

const MEMORY_INTERVAL: Duration = Duration::from_secs(5);

struct Run {
    next_memory: Instant,
    proton_sent: bool,
}

pub struct Games {
    cgroup_root: Option<PathBuf>,
    steam_root: PathBuf,
    meminfo: PathBuf,
    running: BTreeMap<u32, Run>,
}

impl Games {
    pub fn new() -> Games {
        Games {
            cgroup_root: freeze::user_manager_cgroup(),
            steam_root: appname::steam_root(),
            meminfo: PathBuf::from("/proc/meminfo"),
            running: BTreeMap::new(),
        }
    }

    /// Called only after a heartbeat timer expiration, in both main loops.
    /// Events use the normal queued send path; stale periodic samples never
    /// compete with queued events when the host is temporarily not reading.
    pub fn pump(&mut self, now: Instant, port: &mut Port, names: &mut appname::Names) {
        let Some(root) = &self.cgroup_root else { return };
        let Ok(mut scopes) = freeze::game_scopes(root) else { return };
        scopes.remove(&0);
        scopes.remove(&STEAM_UI_APPID);
        self.running.retain(|appid, _| {
            if scopes.contains_key(appid) {
                true
            } else {
                port.send(&format!("game-exit {appid}"));
                false
            }
        });
        // Resolve libraries only if a run still needs its Proton version, and
        // only once this tick. Refreshing later notices newly added libraries.
        let mut libraries = None;
        let mut guest_used = None;
        for (appid, paths) in scopes {
            let run = self.running.entry(appid).or_insert_with(|| {
                port.send(&format!("game-start {appid}"));
                names.report(appid, port);
                Run { next_memory: now + MEMORY_INTERVAL, proton_sent: false }
            });
            if !run.proton_sent {
                let dirs = libraries.get_or_insert_with(|| appname::library_dirs(&self.steam_root));
                if let Some(version) = proton_version(dirs, appid) {
                    port.send(&format!("game-proton {appid} {version}"));
                    run.proton_sent = true;
                }
            }
            if now >= run.next_memory {
                run.next_memory = now + MEMORY_INTERVAL;
                if !port.has_pending() {
                    let used = guest_used.get_or_insert_with(|| guest_used_kib(&self.meminfo));
                    if let (Some(anon), Some(used)) = (anon_kib(&paths), *used) {
                        port.send_quiet(&format!("game-mem {appid} {anon} {used}"));
                    }
                }
            }
        }
    }
}

/// The prefix version's first token only, stripped to printable ASCII and
/// bounded so a malformed file cannot add protocol fields or extra lines.
fn version_token(text: &str) -> Option<String> {
    let token = text.lines().next()?.split_whitespace().next()?;
    let clean: String = token.chars().filter(|c| c.is_ascii_graphic()).take(64).collect();
    if clean.is_empty() { None } else { Some(clean) }
}

fn proton_version(libraries: &[PathBuf], appid: u32) -> Option<String> {
    for library in libraries {
        let path = library.join(format!("steamapps/compatdata/{appid}/version"));
        let Ok(text) = std::fs::read_to_string(path) else { continue };
        if let Some(version) = version_token(&text) {
            return Some(version);
        }
    }
    None
}

/// memory.stat is in bytes. Sum before rounding to KiB; omit a sample if a
/// scope vanishes during the scan rather than publishing a partial total.
fn anon_kib(scopes: &[PathBuf]) -> Option<u64> {
    let mut total = 0u64;
    for scope in scopes {
        let stat = std::fs::read_to_string(scope.join("memory.stat")).ok()?;
        let anon: u64 = stat.lines().find_map(|line| {
            let mut fields = line.split_whitespace();
            (fields.next()? == "anon").then(|| fields.next()?.parse().ok()).flatten()
        })?;
        total = total.saturating_add(anon);
    }
    Some(total / 1024)
}

fn guest_used_kib(path: &Path) -> Option<u64> {
    let text = std::fs::read_to_string(path).ok()?;
    let mut total = None;
    let mut available = None;
    for line in text.lines() {
        let mut fields = line.split_whitespace();
        match fields.next() {
            Some("MemTotal:") => total = fields.next().and_then(|v| v.parse::<u64>().ok()),
            Some("MemAvailable:") => available = fields.next().and_then(|v| v.parse::<u64>().ok()),
            _ => {}
        }
    }
    total?.checked_sub(available?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static NEXT: AtomicUsize = AtomicUsize::new(0);

    struct Fixture {
        root: PathBuf,
        games: Games,
        names: appname::Names,
        port: Port,
        now: Instant,
    }

    impl Fixture {
        fn new() -> Fixture {
            let root = std::env::temp_dir().join(format!("fx-games-{}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed)));
            let cgroup = root.join("cgroup");
            let steam = root.join("steam");
            std::fs::create_dir_all(&cgroup).unwrap();
            std::fs::create_dir_all(steam.join("steamapps")).unwrap();
            let meminfo = root.join("meminfo");
            std::fs::write(&meminfo, "MemTotal: 100000 kB\nMemFree: 1000 kB\nMemAvailable: 40000 kB\n").unwrap();
            let output = root.join("port");
            std::fs::write(&output, "").unwrap();
            let port = Port::open(output.to_str().unwrap()).unwrap();
            Fixture {
                names: appname::Names::new(steam.clone(), root.join("named")),
                games: Games { cgroup_root: Some(cgroup), steam_root: steam, meminfo, running: BTreeMap::new() },
                root, port, now: Instant::now(),
            }
        }

        fn scope(&self, name: &str, anon: u64) -> PathBuf {
            let path = self.games.cgroup_root.as_ref().unwrap().join("app.slice").join(name);
            std::fs::create_dir_all(&path).unwrap();
            std::fs::write(path.join("memory.stat"), format!("file 999999\nanon {anon}\nanon_thp 999999\n")).unwrap();
            path
        }

        fn tick(&mut self, seconds: u64) {
            self.games.pump(self.now + Duration::from_secs(seconds), &mut self.port, &mut self.names);
        }

        fn lines(&self) -> Vec<String> {
            std::fs::read_to_string(self.root.join("port")).unwrap().lines().map(str::to_owned).collect()
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    #[test]
    fn scope_lifetime_and_memory_across_scopes() {
        let mut f = Fixture::new();
        f.tick(0);
        assert!(f.lines().is_empty());
        let a = f.scope("app-steam-app570-1.scope", 1536);
        let b = f.scope("app-steam-app570-2.scope", 2560);
        f.tick(1);
        f.tick(5);
        assert_eq!(f.lines(), ["game-start 570"]);
        f.tick(6);
        assert_eq!(f.lines(), ["game-start 570", "game-mem 570 4 60000"]);
        std::fs::remove_dir_all(a).unwrap();
        f.tick(7);
        assert_eq!(f.lines().len(), 2);
        std::fs::remove_dir_all(b).unwrap();
        f.tick(8);
        f.tick(9);
        assert_eq!(f.lines(), ["game-start 570", "game-mem 570 4 60000", "game-exit 570"]);
    }

    #[test]
    fn already_running_once_and_non_games_ignored() {
        let mut f = Fixture::new();
        f.scope("app-steam-app570-1.scope", 1024);
        for name in ["app-steam-app769-1.scope", "app-steam-app0-1.scope", "app-steam-app+1-1.scope", "app-steam-app42-.scope"] {
            f.scope(name, 1024);
        }
        f.tick(0);
        f.tick(1);
        f.tick(2);
        assert_eq!(f.lines(), ["game-start 570"]);
    }

    #[test]
    fn proton_retries_libraries_and_resets_after_exit() {
        let mut f = Fixture::new();
        let scope = f.scope("app-steam-app570-1.scope", 1024);
        f.tick(0);
        let library = f.root.join("extra-library");
        std::fs::write(f.games.steam_root.join("steamapps/libraryfolders.vdf"), format!("\"libraryfolders\" {{ \"1\" {{ \"path\" \"{}\" }} }}", library.display())).unwrap();
        let prefix = library.join("steamapps/compatdata/570");
        std::fs::create_dir_all(&prefix).unwrap();
        std::fs::write(prefix.join("version"), "\n10.0-104\n").unwrap();
        f.tick(1);
        assert_eq!(f.lines(), ["game-start 570"]);
        std::fs::write(prefix.join("version"), "  10.0-104 extra fields\nsecond-line\n").unwrap();
        f.tick(2);
        std::fs::write(prefix.join("version"), "11.0-1\n").unwrap();
        f.tick(3);
        assert_eq!(f.lines(), ["game-start 570", "game-proton 570 10.0-104"]);
        std::fs::remove_dir_all(scope).unwrap();
        f.tick(4);
        f.scope("app-steam-app570-2.scope", 1024);
        f.tick(5);
        assert_eq!(f.lines(), ["game-start 570", "game-proton 570 10.0-104", "game-exit 570", "game-start 570", "game-proton 570 11.0-1"]);
    }

    #[test]
    fn version_is_one_bounded_printable_token() {
        assert_eq!(version_token("  10.0-104\tother\nignored"), Some("10.0-104".into()));
        assert_eq!(version_token("10.\u{7}0-β104\n"), Some("10.0-104".into()));
        assert_eq!(version_token(&"x".repeat(100)), Some("x".repeat(64)));
        assert_eq!(version_token("\n10.0-104"), None);
        assert_eq!(version_token("β"), None);
    }

    #[test]
    fn failed_root_scan_does_not_end_running_games() {
        let mut f = Fixture::new();
        f.scope("app-steam-app570-1.scope", 1024);
        f.tick(0);
        let cgroup = f.games.cgroup_root.clone().unwrap();
        let hidden = f.root.join("unavailable");
        std::fs::rename(&cgroup, &hidden).unwrap();
        f.tick(1);
        std::fs::rename(hidden, cgroup).unwrap();
        f.tick(2);
        assert_eq!(f.lines(), ["game-start 570"]);
    }

    #[test]
    fn game_name_shared_with_focus_and_persisted_once_per_boot() {
        for focus_first in [false, true] {
            let mut f = Fixture::new();
            std::fs::write(f.games.steam_root.join("steamapps/appmanifest_570.acf"),
                "\"AppState\" { \"name\" \"Dota 2\" }").unwrap();
            if focus_first {
                // The same reporter is called by Focus when its app changes.
                f.names.report(570, &mut f.port);
            }
            let scope = f.scope("app-steam-app570-1.scope", 1024);
            f.tick(0);
            if focus_first {
                assert_eq!(f.lines(), ["game 570 Dota 2", "game-start 570"]);
            } else {
                // No X connection/window is needed to send the display name.
                assert_eq!(f.lines(), ["game-start 570", "game 570 Dota 2"]);
            }
            f.names.report(570, &mut f.port);
            f.names = appname::Names::new(f.games.steam_root.clone(), f.root.join("named"));
            f.names.report(570, &mut f.port);
            assert_eq!(f.lines().len(), 2);
            std::fs::remove_dir_all(scope).unwrap();
            f.tick(1);
            f.scope("app-steam-app570-2.scope", 1024);
            f.tick(2);
            assert_eq!(f.lines().iter().filter(|line| line.as_str() == "game 570 Dota 2").count(), 1);
        }
    }

    #[test]
    fn events_survive_backpressure_and_memory_is_skipped() {
        let mut f = Fixture::new();
        let fifo = f.root.join("fifo");
        let name = std::ffi::CString::new(fifo.to_str().unwrap()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
        f.port = Port::open(fifo.to_str().unwrap()).unwrap();
        let fd = f.port.read_fd().unwrap();
        let filler = [b'x'; 4096];
        loop {
            let n = unsafe { libc::write(fd, filler.as_ptr() as *const libc::c_void, filler.len()) };
            if n < 0 {
                assert_eq!(std::io::Error::last_os_error().kind(), std::io::ErrorKind::WouldBlock);
                break;
            }
        }
        let scope = f.scope("app-steam-app570-1.scope", 1024);
        f.tick(0);
        assert!(f.port.has_pending());
        f.tick(5);
        let prefix = f.games.steam_root.join("steamapps/compatdata/570");
        std::fs::create_dir_all(&prefix).unwrap();
        std::fs::write(prefix.join("version"), "10.0-104\n").unwrap();
        f.tick(6);
        std::fs::remove_dir_all(scope).unwrap();
        f.tick(7);
        let mut buf = [0u8; 4096];
        while unsafe { libc::read(fd, buf.as_mut_ptr() as *mut libc::c_void, buf.len()) } > 0 {}
        f.port.flush();
        assert!(!f.port.has_pending());
        let n = unsafe { libc::read(fd, buf.as_mut_ptr() as *mut libc::c_void, buf.len()) };
        assert!(n > 0);
        assert_eq!(std::str::from_utf8(&buf[..n as usize]).unwrap(),
            "game-start 570\ngame-proton 570 10.0-104\ngame-exit 570\n");
    }
}
