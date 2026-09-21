// tangent/note, as a desktop application.
//
// The window is wrapped around the companion rather than around the built files
// directly. `note serve` already owns a folder of notebooks, serves the app and
// keeps the two in sync; running it here means the desktop app *is* the app —
// same origin (`http://localhost:<port>`), so the sync socket, the working
// directory, the offline cache and a local Ollama all behave exactly as they do
// in a browser, with no desktop-only path to keep working.
//
// The companion ships as a sidecar binary (`deno compile`, with the built app
// embedded), so nothing has to be installed alongside.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs;
use std::io::ErrorKind;
use std::net::{Ipv4Addr, SocketAddrV4, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

/// What the companion prints when the page asks for another folder. The page
/// cannot reach this process — in a browser window there is no bridge — but the
/// companion can: it is a child, and this end already reads its output.
const FOLDER_REQUEST: &str = "@tangent-note open-folder";

/// The running companion, so it can be stopped before the app restarts into
/// another folder rather than left holding its port.
struct Companion(Mutex<Option<CommandChild>>);

/// A port the companion can have. Asked of the OS rather than fixed: a fixed one
/// collides with a `note serve` the reader already has running.
///
/// The listener is dropped before the port is handed over, so there is a window
/// in which something else could take it. Nothing else on this machine is
/// looking for a random high port at that instant, and the alternative — passing
/// a socket to a Deno child — buys little for the risk it adds.
fn free_port() -> std::io::Result<u16> {
    let listener = TcpListener::bind(SocketAddrV4::new(Ipv4Addr::LOCALHOST, 0))?;
    let port = listener.local_addr()?.port();
    drop(listener);
    Ok(port)
}

fn port_is_free(port: u16) -> bool {
    TcpListener::bind(SocketAddrV4::new(Ipv4Addr::LOCALHOST, port)).is_ok()
}

/// The same port as last time, whenever it is still free.
///
/// The port is part of the origin, and everything a browser keeps — the
/// library, the offline cache and its frozen snapshot, the theme, the chat —
/// is keyed to the origin. A fresh port each launch would therefore be a fresh
/// browser each launch: an empty library, a cold cache, a folder that is frozen
/// on disk but has nothing cached to be frozen to. So the port is remembered
/// beside the folder, and only changes when something else has taken it.
fn companion_port(app: &tauri::AppHandle) -> std::io::Result<u16> {
    let file = config_file(app, "port.txt");
    let remembered = file
        .as_ref()
        .and_then(|path| fs::read_to_string(path).ok())
        .and_then(|text| text.trim().parse::<u16>().ok());

    if let Some(port) = remembered {
        if port_is_free(port) {
            return Ok(port);
        }
    }

    let port = free_port()?;
    if let Some(path) = file {
        if let Some(dir) = path.parent() {
            let _ = fs::create_dir_all(dir);
        }
        let _ = fs::write(path, port.to_string());
    }
    Ok(port)
}

/// Wait until the companion answers, so the window never opens on a dead port.
fn wait_until_listening(port: u16, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if TcpStream::connect_timeout(
            &SocketAddrV4::new(Ipv4Addr::LOCALHOST, port).into(),
            Duration::from_millis(200),
        )
        .is_ok()
        {
            return true;
        }
        std::thread::sleep(Duration::from_millis(60));
    }
    false
}

/// Where this app remembers things between launches. Plain text, so they can be
/// read and edited by hand.
fn config_file(app: &tauri::AppHandle, name: &str) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|dir| dir.join(name))
}

fn pointer_file(app: &tauri::AppHandle) -> Option<PathBuf> {
    config_file(app, "folder.txt")
}

fn remember_folder(app: &tauri::AppHandle, folder: &Path) {
    if let Some(file) = pointer_file(app) {
        if let Some(dir) = file.parent() {
            let _ = fs::create_dir_all(dir);
        }
        let _ = fs::write(file, folder.to_string_lossy().as_bytes());
    }
}

/// The folder this app opens: the one chosen last time, or a default made on
/// first run.
fn notebooks_folder(app: &tauri::AppHandle) -> PathBuf {
    if let Some(path) = pointer_file(app).and_then(|p| fs::read_to_string(p).ok()) {
        let folder = PathBuf::from(path.trim());
        if folder.is_dir() {
            return folder;
        }
    }

    let default = app
        .path()
        .home_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
        .join("tangent-notebooks");
    if let Err(error) = fs::create_dir_all(&default) {
        if error.kind() != ErrorKind::AlreadyExists {
            eprintln!("could not create {}: {error}", default.display());
        }
    }
    remember_folder(app, &default);
    default
}

/// Open another folder.
///
/// Called from the page's own File menu rather than a native menu bar: a menu
/// bar holding one item costs a whole strip of the window, above a header that
/// already has a File menu — two menus, one of them nearly empty. The page is
/// remote (http://localhost), so this is reachable only because the capability
/// beside this file lets that origin talk to the app.
///
/// The whole app is restarted rather than the companion swapped underneath it:
/// a companion owns one root, and the page's sync socket, caches and open tabs
/// are all keyed to that root, so starting again is both the simplest path and
/// the one with nothing left over from the folder before.
#[tauri::command]
fn open_folder(app: tauri::AppHandle) {
    let handle = app.clone();
    let current = notebooks_folder(&app);
    app.dialog()
        .file()
        .set_title("Open a folder of notebooks")
        .set_directory(&current)
        .pick_folder(move |chosen| {
            let Some(folder) = chosen.and_then(|path| path.into_path().ok()) else {
                return;
            };
            if folder == current {
                return;
            }
            remember_folder(&handle, &folder);
            if let Some(companion) = handle.try_state::<Companion>() {
                if let Some(child) = companion.0.lock().ok().and_then(|mut held| held.take()) {
                    let _ = child.kill();
                }
            }
            handle.restart();
        });
}

/// Which engine draws the app: this window, or a browser you already have.
///
/// The app is a page served over http, so the window around it is replaceable.
/// On Linux the built-in one is WebKitGTK, which is slower than Chromium or
/// Firefox at building a large page; naming one here hands it the window
/// instead. Nothing else changes — same companion, same folder, same origin —
/// and "open another folder" still works, because the page asks the companion
/// and the companion asks this process.
///
/// `TANGENT_NOTE_BROWSER`, or `browser.txt` beside `folder.txt`: `chromium`,
/// `firefox`, `chrome`, `brave`, `edge`, or any command that takes a URL.
fn chosen_browser(app: &tauri::AppHandle) -> Option<String> {
    let named = std::env::var("TANGENT_NOTE_BROWSER").ok().or_else(|| {
        config_file(app, "browser.txt")
            .and_then(|path| fs::read_to_string(path).ok())
            .map(|text| text.trim().to_string())
    })?;
    let named = named.trim().to_string();
    if named.is_empty() || named == "webview" {
        None
    } else {
        Some(named)
    }
}

/// A window without an address bar where the browser offers one, and — when it
/// can — a profile of its own: the app's library and caches belong to the app
/// rather than to your browsing.
///
/// The profile is the part that may not work. A browser installed as a snap or
/// a flatpak cannot read a hidden directory in your home, which is exactly
/// where an app's data belongs, and it exits rather than starting without one.
/// So the profile arguments come back separately, to be dropped if the browser
/// refuses them.
fn browser_command(browser: &str, url: &str, profile: &Path) -> (String, Vec<String>, Vec<String>) {
    let profile = profile.to_string_lossy().to_string();
    match browser {
        "chromium" | "chrome" | "google-chrome" | "brave" | "brave-browser" | "edge"
        | "microsoft-edge" => {
            let binary = match browser {
                "chrome" => "google-chrome",
                "brave" => "brave-browser",
                "edge" => "microsoft-edge",
                other => other,
            };
            (
                binary.to_string(),
                vec![format!("--app={url}"), "--no-first-run".into()],
                vec![format!("--user-data-dir={profile}")],
            )
        }
        // Firefox has no app mode since it dropped site-specific browsers, so
        // this is an ordinary window.
        "firefox" => (
            "firefox".to_string(),
            vec!["--new-instance".into(), url.to_string()],
            vec!["--profile".into(), profile],
        ),
        other => (other.to_string(), vec![url.to_string()], vec![]),
    }
}

/// Start the browser and say whether it stayed. A browser that refuses its
/// profile exits at once, so "stayed a moment" is the whole test.
fn start_browser(binary: &str, arguments: &[String]) -> Option<std::process::Child> {
    let mut command = std::process::Command::new(binary);
    command.args(arguments);
    // Inside an AppImage, everything here is pointed at the mounted image: its
    // libraries, its GTK modules, its pixbuf loaders. A browser started from
    // this process would inherit all of it and go looking for its own files in
    // a filesystem that is about to disappear — the first sign being
    // "loaders.cache: No such file or directory" on its way up. It is the
    // system's browser; it wants the system's environment.
    if std::env::var_os("APPDIR").is_some() {
        for leaked in [
            "APPDIR",
            "APPIMAGE",
            "LD_LIBRARY_PATH",
            "LD_PRELOAD",
            "GDK_PIXBUF_MODULE_FILE",
            "GDK_PIXBUF_MODULEDIR",
            "GTK_PATH",
            "GTK_DATA_PREFIX",
            "GTK_EXE_PREFIX",
            "GTK_IM_MODULE_FILE",
            "GI_TYPELIB_PATH",
            "GIO_MODULE_DIR",
            "GSETTINGS_SCHEMA_DIR",
            "QT_PLUGIN_PATH",
            "PYTHONHOME",
            "PYTHONPATH",
            "FONTCONFIG_FILE",
            "FONTCONFIG_PATH",
            "XDG_DATA_DIRS",
        ] {
            command.env_remove(leaked);
        }
    }
    let mut child = command.spawn().ok()?;
    std::thread::sleep(Duration::from_millis(2500));
    match child.try_wait() {
        Ok(Some(_)) => None,
        _ => Some(child),
    }
}

/// Where a profile for this browser can actually live.
///
/// The app's own data directory is the right place and the first tried. A
/// browser installed as a snap cannot read it — snap confinement hides every
/// dot-directory in your home — but it can read its own, so that comes next.
///
/// Running without a profile is not on the list: a second `chromium` with the
/// ordinary profile hands its window to the copy already running and exits,
/// and this process would take that for the window closing and shut the
/// companion down underneath it.
fn profile_candidates(app: &tauri::AppHandle, browser: &str) -> Vec<PathBuf> {
    let mut places = Vec::new();
    // A browser with a ~/snap directory is confined and will not see the app's
    // own; its own is where it can write, so it goes first rather than after a
    // failure that is hard to detect — the snap launcher stays alive for a
    // moment even when the browser it started has already given up.
    if let Some(home) = std::env::var_os("HOME").map(PathBuf::from) {
        let snap = home.join("snap").join(browser);
        if snap.is_dir() {
            places.push(snap.join("common").join("tangent-note"));
        }
    }
    if let Ok(data) = app.path().app_data_dir() {
        places.push(data.join(format!("browser-{browser}")));
    }
    places
}

fn main() {

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![open_folder])
        .setup(|app| {
            let handle = app.handle().clone();
            let folder = notebooks_folder(&handle);
            let port = companion_port(&handle)?;

            let mut args = vec![
                folder.to_string_lossy().to_string(),
                "--port".into(),
                port.to_string(),
                // A window killed rather than closed never gets to tidy up;
                // the companion watches its own stdin and goes with it.
                "--exit-with-parent".into(),
                // …and can ask this end for a folder picker, which is the only
                // thing here that has a window to show one in.
                "--folder-dialog".into(),
            ];
            // Working on the app itself: the built files live inside the
            // sidecar, so a change to the page would otherwise mean recompiling
            // 100 MB of Deno to see it. Point this at the repository's `dist`
            // and `npm run build` is the whole loop.
            if let Some(dist) = std::env::var_os("TANGENT_NOTE_DIST") {
                args.push("--dist".into());
                args.push(dist.to_string_lossy().to_string());
            }

            let (mut events, child) = handle.shell().sidecar("note-serve")?.args(args).spawn()?;
            // The child is owned by the app, so it lives as long as the window
            // and is killed with it rather than outliving it.
            app.manage(Companion(Mutex::new(Some(child))));

            // The companion's own log, forwarded so a failure to start is
            // visible rather than silent.
            let asked = handle.clone();
            tauri::async_runtime::spawn(async move {
                while let Some(event) = events.recv().await {
                    match event {
                        CommandEvent::Stdout(line) => {
                            let text = String::from_utf8_lossy(&line);
                            if text.trim_end() == FOLDER_REQUEST {
                                open_folder(asked.clone());
                            } else {
                                print!("{text}");
                            }
                        }
                        CommandEvent::Stderr(line) => eprint!("{}", String::from_utf8_lossy(&line)),
                        CommandEvent::Terminated(status) => {
                            eprintln!("note serve stopped ({:?})", status.code)
                        }
                        _ => {}
                    }
                }
            });

            if !wait_until_listening(port, Duration::from_secs(20)) {
                return Err("note serve did not start".into());
            }

            // A browser of your choosing, in place of this window.
            if let Some(browser) = chosen_browser(&handle) {
                let url = format!("http://localhost:{port}");
                let mut started = None;
                let mut binary = browser.clone();
                for profile in profile_candidates(&handle, &browser) {
                    if fs::create_dir_all(&profile).is_err() {
                        continue;
                    }
                    let (found, arguments, profile_arguments) =
                        browser_command(&browser, &url, &profile);
                    binary = found;
                    let mut full = arguments;
                    full.extend(profile_arguments);
                    started = start_browser(&binary, &full);
                    if started.is_some() {
                        break;
                    }
                }
                match started {
                    Some(mut child) => {
                        println!("tangent/note  {}  {url}  ({browser})", folder.display());
                        // No window of our own: this process lives exactly as
                        // long as the browser it opened, and the companion goes
                        // with it.
                        let quit = handle.clone();
                        std::thread::spawn(move || {
                            let _ = child.wait();
                            quit.exit(0);
                        });
                        return Ok(());
                    }
                    None => {
                        eprintln!(
                            "{binary} would not start with a profile of its own — opening the built-in window instead"
                        );
                    }
                }
            }

            let name = folder
                .file_name()
                .map(|name| name.to_string_lossy().to_string())
                .unwrap_or_else(|| folder.to_string_lossy().to_string());

            WebviewWindowBuilder::new(
                app,
                "main",
                WebviewUrl::External(format!("http://localhost:{port}").parse()?),
            )
            .title(format!("tangent/note — {name}"))
            .inner_size(1360.0, 900.0)
            .min_inner_size(640.0, 480.0)
            .build()?;

            println!("tangent/note  {}  http://localhost:{port}", folder.display());
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("tangent/note failed to start");
}
