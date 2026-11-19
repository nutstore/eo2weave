//! ExecPolicy — command whitelist engine for the exec action (tier 1.5).
//!
//! Reads `~/.creatorweave/execpolicy.json`. Each rule matches a command
//! (and optionally a prefix of its arguments) and assigns a decision:
//!   - `auto`      — execute without prompting
//!   - `prompt`    — require user approval before executing
//!   - `forbidden` — refuse outright
//!
//! Matching priority: **forbidden > auto > prompt > default**.
//! If any forbidden rule matches, the result is forbidden (regardless of
//! other matching auto rules). This ensures dangerous overrides always win.
//!
//! `args` matching is **prefix-based**: `{ command: "git", args: ["status"] }`
//! matches both `git status` and `git status --short`.
//!
//! Policy file is created with sensible defaults on first access if missing.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::scope;

/// Policy decision for a command.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Decision {
    Auto,
    Prompt,
    Forbidden,
}

impl std::fmt::Display for Decision {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Decision::Auto => write!(f, "auto"),
            Decision::Prompt => write!(f, "prompt"),
            Decision::Forbidden => write!(f, "forbidden"),
        }
    }
}

/// A single policy rule.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PolicyRule {
    /// The command name (argv[0], e.g. "npm", "git", "ls").
    pub command: String,
    /// Optional argument prefix to match (e.g. ["test"] for `npm test`).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub args: Vec<String>,
    /// Decision when this rule matches.
    pub decision: Decision,
}

/// The full policy document.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Policy {
    #[serde(default = "default_rules")]
    pub rules: Vec<PolicyRule>,
    #[serde(default = "default_decision")]
    pub default: Decision,
}

fn default_decision() -> Decision {
    Decision::Prompt
}

/// Get the path to the execpolicy file: `~/.creatorweave/execpolicy.json`
pub fn policy_file_path() -> PathBuf {
    scope::dirs_home()
        .join(".creatorweave")
        .join("execpolicy.json")
}

/// Generate the default policy with sensible rules.
fn default_policy() -> Policy {
    use Decision::*;
    Policy {
        rules: vec![
            // ── Read-only utilities: auto ──
            PolicyRule { command: "ls".into(), args: vec![], decision: Auto },
            PolicyRule { command: "cat".into(), args: vec![], decision: Auto },
            PolicyRule { command: "echo".into(), args: vec![], decision: Auto },
            PolicyRule { command: "pwd".into(), args: vec![], decision: Auto },
            PolicyRule { command: "which".into(), args: vec![], decision: Auto },
            PolicyRule { command: "head".into(), args: vec![], decision: Auto },
            PolicyRule { command: "tail".into(), args: vec![], decision: Auto },
            PolicyRule { command: "wc".into(), args: vec![], decision: Auto },
            PolicyRule { command: "grep".into(), args: vec![], decision: Auto },
            PolicyRule { command: "find".into(), args: vec![], decision: Auto },
            PolicyRule { command: "rg".into(), args: vec![], decision: Auto },
            PolicyRule { command: "sed".into(), args: vec![], decision: Auto },
            PolicyRule { command: "awk".into(), args: vec![], decision: Auto },
            PolicyRule { command: "sort".into(), args: vec![], decision: Auto },
            PolicyRule { command: "uniq".into(), args: vec![], decision: Auto },
            PolicyRule { command: "diff".into(), args: vec![], decision: Auto },
            PolicyRule { command: "tree".into(), args: vec![], decision: Auto },
            PolicyRule { command: "file".into(), args: vec![], decision: Auto },
            PolicyRule { command: "stat".into(), args: vec![], decision: Auto },
            PolicyRule { command: "du".into(), args: vec![], decision: Auto },
            PolicyRule { command: "env".into(), args: vec![], decision: Auto },
            PolicyRule { command: "printenv".into(), args: vec![], decision: Auto },
            PolicyRule { command: "date".into(), args: vec![], decision: Auto },
            PolicyRule { command: "uname".into(), args: vec![], decision: Auto },
            PolicyRule { command: "whoami".into(), args: vec![], decision: Auto },
            // ── Git read-only subcommands: auto ──
            PolicyRule { command: "git".into(), args: vec!["status".into()], decision: Auto },
            PolicyRule { command: "git".into(), args: vec!["diff".into()], decision: Auto },
            PolicyRule { command: "git".into(), args: vec!["log".into()], decision: Auto },
            PolicyRule { command: "git".into(), args: vec!["branch".into()], decision: Auto },
            PolicyRule { command: "git".into(), args: vec!["show".into()], decision: Auto },
            PolicyRule { command: "git".into(), args: vec!["stash".into(), "list".into()], decision: Auto },
            PolicyRule { command: "git".into(), args: vec!["remote".into(), "-v".into()], decision: Auto },
            PolicyRule { command: "git".into(), args: vec!["rev-parse".into()], decision: Auto },
            // ── Build/test/lint: auto ──
            PolicyRule { command: "npm".into(), args: vec!["test".into()], decision: Auto },
            PolicyRule { command: "npm".into(), args: vec!["run".into()], decision: Auto },
            PolicyRule { command: "npx".into(), args: vec!["tsc".into(), "--noEmit".into()], decision: Auto },
            PolicyRule { command: "npx".into(), args: vec!["vitest".into()], decision: Auto },
            PolicyRule { command: "npx".into(), args: vec!["eslint".into()], decision: Auto },
            PolicyRule { command: "pnpm".into(), args: vec!["test".into()], decision: Auto },
            PolicyRule { command: "pnpm".into(), args: vec!["run".into()], decision: Auto },
            PolicyRule { command: "pnpm".into(), args: vec!["lint".into()], decision: Auto },
            PolicyRule { command: "pnpm".into(), args: vec!["typecheck".into()], decision: Auto },
            PolicyRule { command: "pnpm".into(), args: vec!["tsc".into()], decision: Auto },
            PolicyRule { command: "yarn".into(), args: vec!["test".into()], decision: Auto },
            PolicyRule { command: "cargo".into(), args: vec!["build".into()], decision: Auto },
            PolicyRule { command: "cargo".into(), args: vec!["test".into()], decision: Auto },
            PolicyRule { command: "cargo".into(), args: vec!["check".into()], decision: Auto },
            PolicyRule { command: "cargo".into(), args: vec!["clippy".into()], decision: Auto },
            PolicyRule { command: "cargo".into(), args: vec!["fmt".into(), "--check".into()], decision: Auto },
            PolicyRule { command: "cargo".into(), args: vec!["metadata".into()], decision: Auto },
            PolicyRule { command: "rustc".into(), args: vec!["--version".into()], decision: Auto },
            PolicyRule { command: "python".into(), args: vec!["-m".into(), "pytest".into()], decision: Auto },
            PolicyRule { command: "python".into(), args: vec!["-m".into(), "mypy".into()], decision: Auto },
            PolicyRule { command: "python".into(), args: vec!["--version".into()], decision: Auto },
            PolicyRule { command: "pytest".into(), args: vec![], decision: Auto },
            PolicyRule { command: "mypy".into(), args: vec![], decision: Auto },
            PolicyRule { command: "ruff".into(), args: vec![], decision: Auto },
            PolicyRule { command: "go".into(), args: vec!["test".into()], decision: Auto },
            PolicyRule { command: "go".into(), args: vec!["build".into()], decision: Auto },
            PolicyRule { command: "go".into(), args: vec!["vet".into()], decision: Auto },
            PolicyRule { command: "make".into(), args: vec![], decision: Auto },
            PolicyRule { command: "node".into(), args: vec!["--version".into()], decision: Auto },
            PolicyRule { command: "npm".into(), args: vec!["--version".into()], decision: Auto },
            PolicyRule { command: "pnpm".into(), args: vec!["--version".into()], decision: Auto },
            // ── Dangerous commands: forbidden ──
            PolicyRule { command: "rm".into(), args: vec![], decision: Forbidden },
            PolicyRule { command: "rmdir".into(), args: vec![], decision: Forbidden },
            PolicyRule { command: "sudo".into(), args: vec![], decision: Forbidden },
            PolicyRule { command: "chmod".into(), args: vec![], decision: Forbidden },
            PolicyRule { command: "chown".into(), args: vec![], decision: Forbidden },
            PolicyRule { command: "curl".into(), args: vec![], decision: Forbidden },
            PolicyRule { command: "wget".into(), args: vec![], decision: Forbidden },
            PolicyRule { command: "nc".into(), args: vec![], decision: Forbidden },
            PolicyRule { command: "ssh".into(), args: vec![], decision: Forbidden },
            PolicyRule { command: "scp".into(), args: vec![], decision: Forbidden },
            PolicyRule { command: "dd".into(), args: vec![], decision: Forbidden },
            PolicyRule { command: "mkfs".into(), args: vec![], decision: Forbidden },
            PolicyRule { command: "shutdown".into(), args: vec![], decision: Forbidden },
            PolicyRule { command: "reboot".into(), args: vec![], decision: Forbidden },
            PolicyRule { command: "kill".into(), args: vec![], decision: Forbidden },
            PolicyRule { command: "killall".into(), args: vec![], decision: Forbidden },
            PolicyRule { command: "launchctl".into(), args: vec![], decision: Forbidden },
            PolicyRule { command: "defaults".into(), args: vec![], decision: Forbidden },
            PolicyRule { command: "crontab".into(), args: vec![], decision: Forbidden },
            // ── Windows shells & system tools: forbidden ──
            // No shell wrapping: `cmd /c x` / `powershell -Command x` would
            // hide the real command from the allow-list.
            PolicyRule { command: "cmd".into(), args: vec![], decision: Forbidden },
            PolicyRule { command: "cmd.exe".into(), args: vec![], decision: Forbidden },
            PolicyRule { command: "powershell".into(), args: vec![], decision: Forbidden },
            PolicyRule { command: "powershell.exe".into(), args: vec![], decision: Forbidden },
            PolicyRule { command: "pwsh".into(), args: vec![], decision: Forbidden },
            PolicyRule { command: "wsl".into(), args: vec![], decision: Forbidden },
            PolicyRule { command: "taskkill".into(), args: vec![], decision: Forbidden },
            PolicyRule { command: "taskkill.exe".into(), args: vec![], decision: Forbidden },
            PolicyRule { command: "del".into(), args: vec![], decision: Forbidden },
            PolicyRule { command: "rd".into(), args: vec![], decision: Forbidden },
            PolicyRule { command: "format".into(), args: vec![], decision: Forbidden },
            PolicyRule { command: "shutdown".into(), args: vec!["/s".into()], decision: Forbidden },
            PolicyRule { command: "reg".into(), args: vec![], decision: Forbidden },
            PolicyRule { command: "regedit".into(), args: vec![], decision: Forbidden },
            PolicyRule { command: "mshta".into(), args: vec![], decision: Forbidden },
            PolicyRule { command: "rundll32".into(), args: vec![], decision: Forbidden },
            // ── Dangerous git subcommands: forbidden ──
            PolicyRule { command: "git".into(), args: vec!["reset".into(), "--hard".into()], decision: Forbidden },
            PolicyRule { command: "git".into(), args: vec!["push".into(), "--force".into()], decision: Forbidden },
            PolicyRule { command: "git".into(), args: vec!["push".into(), "-f".into()], decision: Forbidden },
            PolicyRule { command: "git".into(), args: vec!["clean".into(), "-fd".into()], decision: Forbidden },
            PolicyRule { command: "git".into(), args: vec!["clean".into(), "-f".into()], decision: Forbidden },
        ],
        default: Decision::Prompt,
    }
}

fn default_rules() -> Vec<PolicyRule> {
    default_policy().rules
}

/// Load the policy from disk, creating a default file if it doesn't exist.
///
/// Upgrades: when an existing file predates a set of
/// safety-critical default Forbidden rules (Windows shells etc.), the
/// missing ones are appended and persisted — user edits (Auto/Prompt rules,
/// removals of *non-safety* defaults) are preserved. A user may still
/// explicitly loosen a forbidden rule afterwards; safety floors apply only
/// when the file simply doesn't mention the command at all.
pub fn load_policy() -> Policy {
    let path = policy_file_path();
    match std::fs::read_to_string(&path) {
        Ok(content) => {
            let mut policy: Policy = serde_json::from_str(&content).unwrap_or_else(|e| {
                eprintln!(
                    "[cw-native-host] execpolicy.json parse error, using defaults: {e}"
                );
                default_policy()
            });
            let upgraded = append_missing_forbidden_defaults(&mut policy);
            if upgraded {
                if let Ok(json) = serde_json::to_string_pretty(&policy) {
                    let _ = std::fs::write(&path, json);
                }
            }
            policy
        }
        Err(_) => {
            // File doesn't exist — create it with defaults
            let policy = default_policy();
            if let Ok(json) = serde_json::to_string_pretty(&policy) {
                let _ = std::fs::create_dir_all(path.parent().unwrap_or(&path));
                let _ = std::fs::write(&path, json);
            }
            policy
        }
    }
}

/// Append any default Forbidden rule the loaded policy doesn't cover.
/// Returns true when the policy changed (caller persists).
/// A rule is "covered" when ANY rule with the same command name exists —
/// deliberate user overrides (e.g. `cmd` → Prompt) are respected.
fn append_missing_forbidden_defaults(policy: &mut Policy) -> bool {
    let known_commands: std::collections::HashSet<String> =
        policy.rules.iter().map(|r| r.command.clone()).collect();
    let mut changed = false;
    for default_rule in default_policy().rules {
        if default_rule.decision == Decision::Forbidden
            && !known_commands.contains(&default_rule.command)
        {
            policy.rules.push(default_rule);
            changed = true;
        }
    }
    changed
}

/// Check whether a rule matches the given command array.
///
/// A rule matches when:
/// 1. `rule.command` equals `command[0]` (case-sensitive)
/// 2. `command[1..]` starts with `rule.args` (prefix match)
fn rule_matches(rule: &PolicyRule, command: &[String]) -> bool {
    if command.is_empty() {
        return false;
    }
    if rule.command != command[0] {
        return false;
    }
    // Check arg prefix: command[1..1+rule.args.len()] must equal rule.args
    if rule.args.is_empty() {
        return true; // generic rule — matches all invocations of this command
    }
    if command.len() < 1 + rule.args.len() {
        return false; // not enough args for the prefix
    }
    command[1..1 + rule.args.len()] == rule.args[..]
}

/// Evaluate the policy for a command array.
///
/// Returns the effective decision. Priority: forbidden > auto > prompt > default.
pub fn check(command: &[String]) -> Decision {
    if command.is_empty() || command[0].is_empty() {
        return Decision::Forbidden;
    }

    let policy = load_policy();

    let mut found_forbidden = false;
    let mut found_auto = false;
    let mut found_prompt = false;

    for rule in &policy.rules {
        if rule_matches(rule, command) {
            match rule.decision {
                Decision::Forbidden => found_forbidden = true,
                Decision::Auto => found_auto = true,
                Decision::Prompt => found_prompt = true,
            }
        }
    }

    if found_forbidden {
        Decision::Forbidden
    } else if found_auto {
        Decision::Auto
    } else if found_prompt {
        Decision::Prompt
    } else {
        policy.default
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rule_matches_exact() {
        let rule = PolicyRule {
            command: "git".into(),
            args: vec!["status".into()],
            decision: Decision::Auto,
        };
        assert!(rule_matches(&rule, &["git".into(), "status".into()]));
    }

    #[test]
    fn rule_matches_prefix() {
        let rule = PolicyRule {
            command: "git".into(),
            args: vec!["status".into()],
            decision: Decision::Auto,
        };
        // git status --short should match (prefix)
        assert!(rule_matches(
            &rule,
            &["git".into(), "status".into(), "--short".into()]
        ));
    }

    #[test]
    fn rule_does_not_match_different_subcommand() {
        let rule = PolicyRule {
            command: "git".into(),
            args: vec!["status".into()],
            decision: Decision::Auto,
        };
        assert!(!rule_matches(&rule, &["git".into(), "push".into()]));
    }

    #[test]
    fn rule_generic_matches_all() {
        let rule = PolicyRule {
            command: "ls".into(),
            args: vec![],
            decision: Decision::Auto,
        };
        assert!(rule_matches(&rule, &["ls".into()]));
        assert!(rule_matches(&rule, &["ls".into(), "-la".into()]));
        assert!(rule_matches(
            &rule,
            &["ls".into(), "-la".into(), "/tmp".into()]
        ));
    }

    #[test]
    fn check_forbidden_overrides_auto() {
        // Directly test the priority logic with a synthetic policy
        let policy = Policy {
            rules: vec![
                PolicyRule {
                    command: "test".into(),
                    args: vec![],
                    decision: Decision::Auto,
                },
                PolicyRule {
                    command: "test".into(),
                    args: vec!["danger".into()],
                    decision: Decision::Forbidden,
                },
            ],
            default: Decision::Prompt,
        };

        // Simulate check logic
        let cmd = vec!["test".to_string(), "danger".to_string()];
        let mut found_forbidden = false;
        let mut found_auto = false;
        for rule in &policy.rules {
            if rule_matches(rule, &cmd) {
                match rule.decision {
                    Decision::Forbidden => found_forbidden = true,
                    Decision::Auto => found_auto = true,
                    Decision::Prompt => {}
                }
            }
        }
        assert!(found_forbidden);
        assert!(found_auto);
        // forbidden wins
        assert_eq!(
            if found_forbidden {
                Decision::Forbidden
            } else if found_auto {
                Decision::Auto
            } else {
                policy.default
            },
            Decision::Forbidden
        );
    }

    #[test]
    fn empty_command_is_forbidden() {
        assert_eq!(check(&[]), Decision::Forbidden);
        assert_eq!(check(&["".to_string()]), Decision::Forbidden);
    }

    #[test]
    fn windows_shells_are_forbidden() {
        // Shell wrappers must never be allowed — they
        // hide the real command from the allow-list.
        for shell in ["cmd", "cmd.exe", "powershell", "powershell.exe", "pwsh", "wsl"] {
            assert_eq!(
                check(&[shell.to_string(), "/c".into(), "rm".into()]),
                Decision::Forbidden,
                "{shell} should be forbidden"
            );
        }
    }
}
