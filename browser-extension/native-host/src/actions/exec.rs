//! `exec` — execute a command in a scope root, streaming stdout/stderr (tier 1.5).
//!
//! This is a **streaming** action (handled via `connectNative`, see main.rs).
//! The protocol:
//!
//!   1. First message: `{ action: "exec", scope_id, command: [...], cwd?, env? }`
//!      - Host checks execpolicy → returns `{ type: "decision", decision }`
//!      - If decision == "prompt", host waits for a follow-up message with
//!        `_approved: true` before executing.
//!      - If decision == "forbidden", host returns error immediately.
//!      - If decision == "auto", host proceeds to execute right away.
//!
//!   2. Execution: host spawns the child process with cwd = scope root,
//!      captures stdout/stderr in a background thread, and streams each line
//!      back as `{ type: "stdout"|"stderr", data }`.
//!
//!   3. On completion: `{ type: "exit", code }` (or `{ type: "exit", code: null }`
//!      if terminated by signal).
//!
//! `handle_stream` receives the parsed request and a writer (stdout pipe).
//! It writes one or more NM-framed JSON messages as events occur.

use std::io::Write;
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::Duration;

use serde_json::{json, Value};

use crate::nm;
use crate::scope;
use super::execpolicy;

/// Handle an exec streaming request.
///
/// Writes decision, then (if auto or approved) runs the command and streams
/// output events. Returns when the command finishes or an error occurs.
pub fn handle_stream(request: &Value, stdout: &mut impl Write) {
    // ── Parse request ──
    let scope_id = match request.get("scope_id").and_then(|v| v.as_str()) {
        Some(s) => s,
        None => {
            let _ = write_event(stdout, &json!({ "type": "error", "error": "missing scope_id" }));
            return;
        }
    };

    let command: Vec<String> = match request.get("command").and_then(|v| v.as_array()) {
        Some(arr) => arr
            .iter()
            .filter_map(|v| v.as_str().map(|s| s.to_string()))
            .collect(),
        None => {
            let _ = write_event(stdout, &json!({ "type": "error", "error": "missing or invalid command array" }));
            return;
        }
    };

    if command.is_empty() {
        let _ = write_event(stdout, &json!({ "type": "error", "error": "empty command array" }));
        return;
    }

    // ── Resolve scope root (cwd for the command) ──
    let cwd = match scope::resolve_scope_path(scope_id) {
        Some(p) => p,
        None => {
            let _ = write_event(stdout, &json!({ "type": "error", "error": format!("unknown scope_id: {scope_id}") }));
            return;
        }
    };

    // ── Check execpolicy ──
    let decision = execpolicy::check(&command);

    // ── Emit decision event ──
    let _ = write_event(stdout, &json!({
        "type": "decision",
        "decision": decision.to_string(),
        "command": command,
    }));

    match decision {
        execpolicy::Decision::Forbidden => {
            let _ = write_event(stdout, &json!({
                "type": "error",
                "error": format!("command forbidden by execpolicy: {}", command.join(" ")),
            }));
            return;
        }
        execpolicy::Decision::Prompt => {
            // Check if this message carries approval or cancellation
            let approved = request
                .get("_approved")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            let cancelled = request
                .get("_cancelled")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            if cancelled {
                // User rejected the prompt — emit a cancellation event and stop.
                let _ = write_event(stdout, &json!({
                    "type": "cancelled",
                    "command": command,
                }));
                return;
            }
            if !approved {
                // Wait for the browser to send a follow-up approval message.
                // We return here; main.rs's streaming loop will call handle_stream
                // again with the next message (which should have _approved: true
                // or _cancelled: true).
                let _ = write_event(stdout, &json!({
                    "type": "awaiting_approval",
                    "command": command,
                }));
                return;
            }
            // approved == true → proceed to execute
        }
        execpolicy::Decision::Auto => {
            // Execute immediately
        }
    }

    // ── Execute the command ──
    execute_and_stream(stdout, &command, &cwd, request);
}

/// Spawn the command and stream stdout/stderr events.
fn execute_and_stream(
    stdout: &mut impl Write,
    command: &[String],
    cwd: &std::path::Path,
    request: &Value,
) {
    // Build the command
    #[cfg(windows)]
    let command: Vec<String> = {
        // PATH×PATHEXT resolution AFTER policy check.
        let mut resolved = command.to_vec();
        resolved[0] = crate::win::resolve_command(&resolved[0]);
        resolved
    };
    let mut cmd = Command::new(&command[0]);
    cmd.args(&command[1..]);
    cmd.current_dir(cwd);
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use crate::win::CommandExtNoWindow;
        cmd.creation_flags_no_window();
    }

    // Inherit stdin from the host process (which is the NM pipe — typically empty).
    // For interactive commands, stdin won't work well, but that's acceptable for tier 1.5.
    cmd.stdin(Stdio::null());

    // Optional: additional env vars from request
    if let Some(env) = request.get("env").and_then(|v| v.as_object()) {
        for (k, v) in env {
            if let Some(val) = v.as_str() {
                cmd.env(k, val);
            }
        }
    }

    // Optional: timeout (seconds)
    let timeout_secs = request
        .get("timeout")
        .and_then(|v| v.as_u64())
        .unwrap_or(120); // default 2 min

    let _ = write_event(stdout, &json!({
        "type": "start",
        "command": command,
        "cwd": cwd.to_string_lossy(),
    }));

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            let error_msg = if e.kind() == std::io::ErrorKind::NotFound {
                format!("command not found: {}", command[0])
            } else {
                format!("failed to spawn: {e}")
            };
            let _ = write_event(stdout, &json!({ "type": "error", "error": error_msg }));
            return;
        }
    };

    // Take stdout and stderr handles
    let child_stdout = child.stdout.take();
    let child_stderr = child.stderr.take();

    // Channel to collect output lines from both streams
    let (tx, rx) = mpsc::channel::<OutputLine>();

    // Spawn reader threads for stdout and stderr
    let tx_stdout = tx.clone();
    if let Some(mut out) = child_stdout {
        thread::spawn(move || {
            use std::io::{BufRead, BufReader};
            let reader = BufReader::new(&mut out);
            for line in reader.lines() {
                match line {
                    Ok(text) => {
                        if tx_stdout.send(OutputLine::Stdout(text)).is_err() {
                            break;
                        }
                    }
                    Err(_) => break,
                }
            }
        });
    }

    let tx_stderr = tx.clone();
    if let Some(mut err) = child_stderr {
        thread::spawn(move || {
            use std::io::{BufRead, BufReader};
            let reader = BufReader::new(&mut err);
            for line in reader.lines() {
                match line {
                    Ok(text) => {
                        if tx_stderr.send(OutputLine::Stderr(text)).is_err() {
                            break;
                        }
                    }
                    Err(_) => break,
                }
            }
        });
    }

    // Drop our copies of the senders so rx iterator ends when threads finish
    drop(tx);

    // Wait for the child process with a timeout
    // We poll output lines while waiting, flushing them to stdout.
    let deadline = std::time::Instant::now() + Duration::from_secs(timeout_secs);
    let mut timed_out = false;

    loop {
        // Check for output (non-blocking, with short timeout)
        match rx.recv_timeout(Duration::from_millis(100)) {
            Ok(OutputLine::Stdout(line)) => {
                let _ = write_event(stdout, &json!({ "type": "stdout", "data": line }));
            }
            Ok(OutputLine::Stderr(line)) => {
                let _ = write_event(stdout, &json!({ "type": "stderr", "data": line }));
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                // No output yet — check if we've timed out
                if std::time::Instant::now() > deadline {
                    timed_out = true;
                    break;
                }
                // Check if child has exited (non-blocking)
                match child.try_wait() {
                    Ok(Some(_status)) => {
                        // Child exited — drain remaining output
                        while let Ok(line) = rx.try_recv() {
                            match line {
                                OutputLine::Stdout(l) => {
                                    let _ = write_event(stdout, &json!({ "type": "stdout", "data": l }));
                                }
                                OutputLine::Stderr(l) => {
                                    let _ = write_event(stdout, &json!({ "type": "stderr", "data": l }));
                                }
                            }
                        }
                        break;
                    }
                    Ok(None) => {
                        // Still running — continue waiting
                    }
                    Err(_) => {
                        // Error checking status — stop
                        break;
                    }
                }
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                // Both reader threads finished — drain and wait for child
                while let Ok(line) = rx.try_recv() {
                    match line {
                        OutputLine::Stdout(l) => {
                            let _ = write_event(stdout, &json!({ "type": "stdout", "data": l }));
                        }
                        OutputLine::Stderr(l) => {
                            let _ = write_event(stdout, &json!({ "type": "stderr", "data": l }));
                        }
                    }
                }
                break;
            }
        }
    }

    // Handle timeout: kill the child
    if timed_out {
        let _ = child.kill();
        let _ = child.wait();
        let _ = write_event(stdout, &json!({
            "type": "exit",
            "code": null,
            "signal": null,
            "timeout": true,
            "error": format!("command timed out after {timeout_secs}s"),
        }));
        return;
    }

    // Wait for child to fully exit
    let status = child.wait();

    match status {
        Ok(s) => {
            let code = s.code(); // None if killed by signal
            #[cfg(unix)]
            let signal = {
                use std::os::unix::process::ExitStatusExt;
                s.signal()
            };
            #[cfg(not(unix))]
            let signal: Option<i32> = None;

            let _ = write_event(stdout, &json!({
                "type": "exit",
                "code": code,
                "signal": signal,
            }));
        }
        Err(e) => {
            let _ = write_event(stdout, &json!({
                "type": "exit",
                "code": null,
                "signal": null,
                "error": format!("wait failed: {e}"),
            }));
        }
    }
}

/// Write a single NM-framed JSON event to stdout.
fn write_event(stdout: &mut impl Write, value: &Value) -> std::io::Result<()> {
    nm::write_message(stdout, value)
}

/// Internal enum for multiplexing stdout/stderr lines.
enum OutputLine {
    Stdout(String),
    Stderr(String),
}
