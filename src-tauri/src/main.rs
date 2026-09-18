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

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

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

/// Where the choice of folder is remembered. Plain text, so it can be read and
/// edited by hand.
fn pointer_file(app: &tauri::AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|dir| dir.join("folder.txt"))
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
/// The whole app is restarted rather than the companion swapped underneath it:
/// a companion owns one root, and the page's sync socket, caches and open tabs
/// are all keyed to that root, so starting again is both the simplest path and
/// the one with nothing left over from the folder before.
fn choose_folder(app: &tauri::AppHandle) {
    let handle = app.clone();
    let current = notebooks_folder(app);
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

/// The one thing the desktop app has that a browser tab does not: a choice of
/// which folder to open. Everything else lives in the app's own File menu.
fn build_menu(app: &tauri::AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let open = MenuItem::with_id(app, "open-folder", "Open Folder…", true, Some("CmdOrCtrl+Shift+O"))?;
    let file = Submenu::with_items(
        app,
        "File",
        true,
        &[&open, &PredefinedMenuItem::separator(app)?, &PredefinedMenuItem::quit(app, None)?],
    )?;
    Menu::with_items(app, &[&file])
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .on_menu_event(|app, event| {
            if event.id() == "open-folder" {
                choose_folder(app);
            }
        })
        .setup(|app| {
            let handle = app.handle().clone();
            let folder = notebooks_folder(&handle);
            let port = free_port()?;

            let (mut events, child) = handle
                .shell()
                .sidecar("note-serve")?
                .args([
                    folder.to_string_lossy().to_string(),
                    "--port".into(),
                    port.to_string(),
                    // A window killed rather than closed never gets to tidy up;
                    // the companion watches its own stdin and goes with it.
                    "--exit-with-parent".into(),
                ])
                .spawn()?;
            // The child is owned by the app, so it lives as long as the window
            // and is killed with it rather than outliving it.
            app.manage(Companion(Mutex::new(Some(child))));

            // The companion's own log, forwarded so a failure to start is
            // visible rather than silent.
            tauri::async_runtime::spawn(async move {
                while let Some(event) = events.recv().await {
                    match event {
                        CommandEvent::Stdout(line) => print!("{}", String::from_utf8_lossy(&line)),
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
            .menu(build_menu(app.handle())?)
            .inner_size(1360.0, 900.0)
            .min_inner_size(640.0, 480.0)
            .build()?;

            println!("tangent/note  {}  http://localhost:{port}", folder.display());
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("tangent/note failed to start");
}
