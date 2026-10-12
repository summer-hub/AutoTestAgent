// AutoTest 桌面端外壳（Tauri v2）：
//  - 启动时拉起内置的 Node 独立服务器（lib/standalone.js，随机端口，stdout 协议拿端口）
//  - WebView 导航到 http://127.0.0.1:<port>/（与纯 Web 版同一套前端）
//  - 数据目录 / 工作区隔离在应用数据目录（app_data_dir），不污染开发机
//  - 托盘驻留：关闭按钮 = 隐藏到托盘；托盘「退出」才真正杀服务器并退出
//  - 单实例：第二次启动聚焦已有窗口
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs::{create_dir_all, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc::{channel, Receiver, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tauri::tray::{MouseButton, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};

const MIN_NODE_MAJOR: u32 = 20;
const STARTUP_TIMEOUT: Duration = Duration::from_secs(60);

struct ServerProcess(Mutex<Option<Child>>);

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            show_window(app);
        }))
        .plugin(tauri_plugin_dialog::init())
        .manage(ServerProcess(Mutex::new(None)))
        .setup(|app| {
            let handle = app.handle().clone();

            // 1. 数据目录（桌面端独有：不与开发机 / 其他部署混数据）
            let data_dir = match ensure_data_dir(&handle) {
                Ok(d) => d,
                Err(msg) => fail_and_exit(&handle, &msg),
            };

            // 2. 定位内置服务器目录（resources/server，开发模式回退仓库内 dsh-autotest）
            let server_dir = match resolve_server_dir(&handle) {
                Some(d) => d,
                None => fail_and_exit(
                    &handle,
                    "未找到内置服务器（lib/standalone.js）。请重新安装应用；开发模式可设 AUTOTEST_SERVER_DIR 指向 autotest/dsh-autotest 目录。",
                ),
            };

            // 3. Node 运行时：sidecar（随包分发）优先，PATH 兜底
            let node = match resolve_node(&handle) {
                Ok(n) => n,
                Err(msg) => fail_and_exit(&handle, &msg),
            };
            if let Err(msg) = check_node_version(&node) {
                fail_and_exit(&handle, &msg);
            }

            // 4. 拉起服务器并等待端口（stdout 协议：AUTOTEST_LISTENING=<port>）
            let (child, port_rx, log) = match spawn_server(&handle, &node, &server_dir, &data_dir) {
                Ok(v) => v,
                Err(msg) => fail_and_exit(&handle, &format!("{msg}\n\n日志：{}", log_path(&data_dir).display())),
            };
            app.state::<ServerProcess>().0.lock().expect("server state lock").replace(child);
            let port = match wait_port(&port_rx) {
                Ok(p) => p,
                Err(msg) => {
                    append_log(&log, &format!("[desktop] {msg}"));
                    kill_server(&handle);
                    fail_and_exit(&handle, &format!("{msg}\n\n日志：{}", log_path(&data_dir).display()));
                }
            };

            // 5. 主窗口直接指向服务器（同一套前端，无需再嵌一层）
            let url = match format!("http://127.0.0.1:{port}/").parse() {
                Ok(u) => u,
                Err(e) => fail_and_exit(&handle, &format!("服务器地址解析失败：{e}")),
            };
            let window = WebviewWindowBuilder::new(&handle, "main", WebviewUrl::External(url))
                .title("AutoTest 平台 · 鸿蒙三方库自动化测试")
                .inner_size(1440.0, 900.0)
                .min_inner_size(1024.0, 680.0)
                .build()
                .expect("创建主窗口失败");

            // 6. 托盘
            setup_tray(&handle).expect("创建托盘失败");
            let _ = window.show();

            println!("[desktop] 服务器就绪：http://127.0.0.1:{port}/（数据目录 {}）", data_dir.display());
            Ok(())
        })
        .on_window_event(|window, event| {
            // 关闭 = 隐藏到托盘（服务器继续跑，下次左键托盘恢复）
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .build(tauri::generate_context!())
        .expect("构建 Tauri 应用失败")
        .run(|app, event| match event {
            // 进程终结前的最后保险：确保 node 子进程不成为孤儿
            RunEvent::Exit => kill_server(app),
            _ => {}
        });
}

// ---------- 失败提示（阻塞对话框 + 退出） ----------

fn fail_and_exit(handle: &AppHandle, msg: &str) -> ! {
    eprintln!("[desktop] 启动失败：{msg}");
    use tauri_plugin_dialog::DialogExt;
    let _ = handle
        .dialog()
        .message(msg)
        .title("AutoTest 启动失败")
        .blocking_show();
    std::process::exit(1);
}

// ---------- 路径解析 ----------

fn data_root(handle: &AppHandle) -> Result<PathBuf, String> {
    handle.path().app_data_dir().map_err(|e| format!("无法定位应用数据目录：{e}"))
}

fn ensure_data_dir(handle: &AppHandle) -> Result<PathBuf, String> {
    let dir = data_root(handle)?;
    create_dir_all(&dir).map_err(|e| format!("无法创建数据目录 {}：{e}", dir.display()))?;
    Ok(dir)
}

fn is_server_dir(d: &Path) -> bool {
    d.join("lib").join("standalone.js").is_file()
}

fn resolve_server_dir(handle: &AppHandle) -> Option<PathBuf> {
    // 1. 显式指定（开发 / 自托管）
    if let Ok(p) = std::env::var("AUTOTEST_SERVER_DIR") {
        let p = p.trim();
        if !p.is_empty() && is_server_dir(Path::new(p)) {
            return Some(PathBuf::from(p));
        }
    }
    // 2. 打包资源：tauri.conf.json resources 映射 resources/server/ → server/
    if let Ok(res) = handle.path().resource_dir() {
        let cand = res.join("server");
        if is_server_dir(&cand) {
            return Some(cand);
        }
    }
    // 3. 开发布局：target/{debug,release}/<exe> → ../../../../dsh-autotest
    if let Ok(exe) = std::env::current_exe() {
        for up in ["..", "../..", "../../..", "../../../.."] {
            let cand = exe.join(up).join("dsh-autotest");
            if is_server_dir(&cand) {
                return Some(cand);
            }
        }
    }
    None
}

fn resolve_node(handle: &AppHandle) -> Result<PathBuf, String> {
    // 1. 显式指定
    if let Ok(p) = std::env::var("AUTOTEST_NODE") {
        let p = p.trim();
        if !p.is_empty() {
            return Ok(PathBuf::from(p));
        }
    }
    // 2. 随包 sidecar（externalBin: bin/node）。
    //    tauri 实际会把 bin/node-<triple>.exe 复制成 <exe 目录>/node.exe（无后缀），
    //    两种命名都认，避免白丢随包运行时退化成依赖系统 node。
    if let Ok(exe) = std::env::current_exe() {
        let triple = option_env!("TAURI_ENV_TARGET_TRIPLE").unwrap_or("x86_64-pc-windows-msvc");
        let candidates = [
            exe.with_file_name(format!("node-{triple}{}", if cfg!(windows) { ".exe" } else { "" })),
            exe.with_file_name(if cfg!(windows) { "node.exe" } else { "node" }),
        ];
        for cand in candidates {
            if cand.is_file() {
                return Ok(cand);
            }
        }
    }
    // 3. 资源目录里的手工放置 bin/node
    if let Ok(res) = handle.path().resource_dir() {
        let manual = res.join(if cfg!(windows) { "bin\\node.exe" } else { "bin/node" });
        if manual.is_file() {
            return Ok(manual);
        }
    }
    // 4. PATH 兜底（开发模式）
    let probe = if cfg!(windows) { "where" } else { "which" };
    if let Ok(out) = quiet(Command::new(probe).arg("node")).output() {
        if out.status.success() {
            if let Some(first) = String::from_utf8_lossy(&out.stdout).lines().next() {
                let p = first.trim();
                if !p.is_empty() {
                    return Ok(PathBuf::from(p));
                }
            }
        }
    }
    Err("未找到 Node.js 运行时。请安装 Node.js ≥ 20（https://nodejs.org/zh-cn/download），或使用随包分发的 node sidecar。".to_string())
}

fn check_node_version(node: &Path) -> Result<(), String> {
    let out = quiet(Command::new(node).arg("--version"))
        .output()
        .map_err(|e| format!("无法执行 node --version：{e}"))?;
    if !out.status.success() {
        return Err("node --version 执行失败，Node.js 运行时不可用".to_string());
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let major = text
        .trim()
        .trim_start_matches('v')
        .split('.')
        .next()
        .and_then(|s| s.parse::<u32>().ok())
        .unwrap_or(0);
    if major < MIN_NODE_MAJOR {
        return Err(format!("Node.js 版本过低（{}）：AutoTest 需要 ≥ {MIN_NODE_MAJOR}", text.trim()));
    }
    Ok(())
}

// ---------- 服务器托管 ----------

/// Windows 上 Rust 的 `current_exe()` / `resource_dir()` 常返回 `\\?\` 前缀的逐字（verbatim）路径。
/// 这类路径在 Win32 API 层没问题，但**作为参数传给 node 后**，node 的路径解析会踩坑
/// （实测：`lstat 'D:' EISDIR`，node 把 `\\?\D:\...` 的盘符段当成了相对路径）。
/// 所有交给子进程的路径统一剥掉前缀，还原成 `D:\...` 常规形式；UNC 形态 `\\?\UNC\` 还原为 `\\`。
fn strip_verbatim(p: &Path) -> PathBuf {
    let s = p.to_string_lossy().to_string();
    let stripped = match s.strip_prefix(r"\\?\") {
        Some(rest) => rest,
        None => return PathBuf::from(s),
    };
    if let Some(unc) = stripped.strip_prefix("UNC\\") {
        return PathBuf::from(format!("\\{unc}"));
    }
    PathBuf::from(stripped)
}

fn log_path(data_dir: &Path) -> PathBuf {
    data_dir.join("server.log")
}

/// Windows 上给子进程加 CREATE_NO_WINDOW，避免 GUI 应用弹出黑色控制台窗口。
fn quiet(cmd: &mut Command) -> &mut Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    #[cfg(not(windows))]
    {
        let _ = cmd;
    }
    cmd
}

type SharedLog = Arc<Mutex<Option<std::fs::File>>>;

fn append_log(log: &SharedLog, line: &str) {
    if let Ok(mut guard) = log.lock() {
        if let Some(f) = guard.as_mut() {
            let _ = writeln!(f, "{line}");
        }
    }
}

fn spawn_server(
    handle: &AppHandle,
    node: &Path,
    server_dir: &Path,
    data_dir: &Path,
) -> Result<(Child, Receiver<u16>, SharedLog), String> {
    // 所有交给 node 的路径都剥掉 `\\?\` 逐字前缀（node 侧解析会踩坑，见 strip_verbatim 注释）
    let script = strip_verbatim(&server_dir.join("lib").join("standalone.js"));
    if !script.is_file() {
        return Err(format!("服务器入口不存在：{}", script.display()));
    }
    let _ = handle; // 保留签名（未来窗口注入用）
    let data_dir = strip_verbatim(data_dir);
    let web_dir = strip_verbatim(&server_dir.join("dist").join("web"));
    create_dir_all(&data_dir).map_err(|e| format!("无法创建数据目录：{e}"))?;
    let log_file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_path(&data_dir))
        .ok();
    let log: SharedLog = Arc::new(Mutex::new(log_file));

    let mut cmd = Command::new(strip_verbatim(node));
    cmd.arg(&script)
        .env("AUTOTEST_PORT", "0") // 随机端口，避免与机器上其他实例冲突
        .env("AUTOTEST_HOST", "127.0.0.1")
        .env("AUTOTEST_DATA_DIR", data_dir.join("autotest-data"))
        .env("AUTOTEST_WORKSPACE", data_dir.join("workspace"))
        .env("AUTOTEST_WEB_DIR", &web_dir)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    quiet(&mut cmd);

    let mut child = cmd.spawn().map_err(|e| format!("启动 Node 失败（{}）：{e}", node.display()))?;
    attach_to_kill_on_close_job(&child);
    println!("[desktop] 已拉起内置服务器 pid={} script={}", child.id(), script.display());

    let (tx, rx) = channel::<u16>();
    if let Some(stdout) = child.stdout.take() {
        let tx = tx.clone();
        let log = Arc::clone(&log);
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines().flatten() {
                if let Some(rest) = line.strip_prefix("AUTOTEST_LISTENING=") {
                    if let Ok(p) = rest.trim().parse::<u16>() {
                        let _ = tx.send(p);
                    }
                }
                append_log(&log, &line);
            }
        });
    }
    if let Some(stderr) = child.stderr.take() {
        let log = Arc::clone(&log);
        std::thread::spawn(move || {
            for line in BufReader::new(stderr).lines().flatten() {
                append_log(&log, &line);
            }
        });
    }
    Ok((child, rx, log))
}

/// Windows：把 node 子进程纳入带 KILL_ON_JOB_CLOSE 的 Job Object。
/// 桌面进程被硬杀（任务管理器 / taskkill /F / 崩溃）时，job 的最后一个句柄随进程消亡而关闭，
/// 其中的 node 会被系统直接终结——不会留下孤儿进程占着数据库/端口。
/// job 句柄**故意不关闭**：优雅退出路径上 kill_server 已先杀 node，本进程死亡时句柄全关才是兜底。
/// 非 Windows 平台为空操作（POSIX 靠 SIGTERM 优雅退出覆盖，硬杀属进程管理器职责）。
#[cfg(windows)]
fn attach_to_kill_on_close_job(child: &Child) {
    use winapi::ctypes::c_void;
    use winapi::shared::minwindef::{FALSE, DWORD};    use winapi::shared::ntdef::NULL;
    use winapi::um::handleapi::CloseHandle;
    use winapi::um::jobapi2::{AssignProcessToJobObject, CreateJobObjectW, SetInformationJobObject};
    use winapi::um::processthreadsapi::OpenProcess;
    use winapi::um::winnt::{
        JobObjectExtendedLimitInformation, JOBOBJECT_EXTENDED_LIMIT_INFORMATION, PROCESS_SET_QUOTA,
        PROCESS_TERMINATE,
    };

    const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE: DWORD = 0x0000_2000;

    unsafe {
        let job = CreateJobObjectW(NULL as *mut _, NULL as *const _);
        if job.is_null() {
            eprintln!("[desktop] CreateJobObject 失败，跳过孤儿进程防护");
            return;
        }
        let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
        info.BasicLimitInformation.LimitFlags |= JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &mut info as *mut _ as *mut c_void,
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as DWORD,
        ) == FALSE
        {
            eprintln!("[desktop] SetInformationJobObject 失败，跳过孤儿进程防护");
            CloseHandle(job);
            return;
        }
        // std 的 Child 句柄权限不保证够 AssignProcessToJobObject，显式 OpenProcess 拿全所需权限
        let ph = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, child.id());
        if ph.is_null() {
            CloseHandle(job);
            return;
        }
        let assigned = AssignProcessToJobObject(job, ph);
        CloseHandle(ph);
        if assigned == FALSE {
            CloseHandle(job);
            return;
        }
        println!("[desktop] node 子进程已纳入 Job Object（KILL_ON_JOB_CLOSE：硬杀本进程时 node 会被系统终结）");
    }
}

#[cfg(not(windows))]
fn attach_to_kill_on_close_job(_child: &Child) {}

fn wait_port(rx: &Receiver<u16>) -> Result<u16, String> {
    let deadline = Instant::now() + STARTUP_TIMEOUT;
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err("内置服务器启动超时（60 秒）".to_string());
        }
        match rx.recv_timeout(remaining) {
            Ok(p) => return Ok(p),
            Err(RecvTimeoutError::Timeout) => return Err("内置服务器启动超时（60 秒）".to_string()),
            Err(RecvTimeoutError::Disconnected) => {
                return Err("内置服务器提前退出（详见下方日志路径）".to_string());
            }
        }
    }
}

fn kill_server(app: &AppHandle) {
    if let Some(state) = app.try_state::<ServerProcess>() {
        if let Ok(mut guard) = state.0.lock() {
            if let Some(mut child) = guard.take() {
                println!("[desktop] 正在停止内置服务器 pid={}", child.id());
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }
}

// ---------- 托盘 ----------

fn setup_tray(handle: &AppHandle) -> tauri::Result<()> {
    use tauri::menu::MenuBuilder;
    let menu = MenuBuilder::new(handle)
        .text("show", "显示主窗口")
        .text("open-data", "打开数据目录")
        .separator()
        .text("quit", "退出")
        .build()?;
    let icon = handle
        .default_window_icon()
        .cloned()
        .ok_or_else(|| tauri::Error::AssetNotFound("default window icon".to_string()))?;
    TrayIconBuilder::new()
        .icon(icon)
        .tooltip("AutoTest 平台")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show" => show_window(app),
            "open-data" => open_data_dir(app),
            "quit" => {
                kill_server(app);
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                ..
            } = event
            {
                show_window(tray.app_handle());
            }
        })
        .build(handle)?;
    Ok(())
}

fn show_window(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

fn open_data_dir(app: &AppHandle) {
    let Ok(dir) = data_root(app) else { return };
    let _ = create_dir_all(&dir);
    let cmd = if cfg!(windows) {
        "explorer"
    } else if cfg!(target_os = "macos") {
        "open"
    } else {
        "xdg-open"
    };
    let mut c = Command::new(cmd);
    c.arg(&dir);
    quiet(&mut c);
    if let Err(e) = c.spawn() {
        eprintln!("[desktop] 打开数据目录失败：{e}");
    }
}
