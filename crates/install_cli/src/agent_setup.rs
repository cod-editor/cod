use anyhow::{Context as _, Result, bail};
use gpui::{App, AppContext as _, ClipboardItem, Context, PromptLevel, Window, actions};
use std::path::{Path, PathBuf};
use workspace::Workspace;
use workspace::notifications::{
    DetachAndPromptErr, NotificationId, show_app_notification,
    simple_message_notification::MessageNotification,
};

actions!(
    cod,
    [
        /// Shows plugin installation commands for Claude Code and Codex.
        SetUpCodingAgents,
        /// Installs the bundled codctl command line tool.
        InstallCodctl,
    ]
);

const CLAUDE_COMMANDS: &str =
    "claude plugin marketplace add cod-editor/cod\nclaude plugin install cod-control@cod";
const CODEX_COMMANDS: &str =
    "codex plugin marketplace add cod-editor/cod\ncodex plugin add cod-control@cod";

pub fn set_up_coding_agents(cx: &mut App) {
    show_app_notification(NotificationId::named("cod-agent-setup".into()), cx, |cx| {
        cx.new(|cx| {
            MessageNotification::new(
                format!("Install the Cod control plugin in your agent's terminal.\n\nClaude Code:\n{CLAUDE_COMMANDS}\n\nCodex:\n{CODEX_COMMANDS}"),
                cx,
            )
            .with_title("Let your coding agents use Cod")
            .secondary_content("Then start a new agent session. Help > Install codctl adds the editor command to PATH. Reopen these instructions from Help > Set Up Coding Agents.")
            .show_suppress_button(false)
            .primary_message("Copy Claude")
            .primary_on_click(|_, cx| cx.write_to_clipboard(ClipboardItem::new_string(CLAUDE_COMMANDS.into())))
            .secondary_message("Copy Codex")
            .secondary_on_click(|_, cx| cx.write_to_clipboard(ClipboardItem::new_string(CODEX_COMMANDS.into())))
        })
    });
}

pub fn install_codctl(window: &mut Window, cx: &mut Context<Workspace>) {
    cx.spawn_in(window, async move |_, cx| {
        let executable = std::env::current_exe()?.canonicalize()?;
        let home = std::env::var_os("HOME")
            .map(PathBuf::from)
            .context("HOME is not set")?;
        let bin = if cfg!(target_os = "macos") {
            PathBuf::from("/usr/local/bin")
        } else {
            home.join(".local/bin")
        };
        let detail = cx
            .background_spawn(async move { install(&executable, &bin).await })
            .await?;
        cx.prompt(PromptLevel::Info, "codctl is ready", Some(&detail), &["OK"])
            .await?;
        Ok(())
    })
    .detach_and_prompt_err("Could not install codctl", window, cx, |_, _, _| None);
}

async fn install(executable: &Path, bin: &Path) -> Result<String> {
    let siblings = executable
        .parent()
        .context("Cod has no executable directory")?;
    let control = siblings.join("codctl");
    anyhow::ensure!(
        control.is_file(),
        "The bundled codctl is missing at {}",
        control.display()
    );
    let links = [(control.as_path(), bin.join("codctl"))];
    for (_, destination) in &links {
        match smol::fs::symlink_metadata(destination).await {
            Ok(metadata) if !metadata.file_type().is_symlink() => {
                bail!(
                    "{} already exists and is not a symlink. Move it before running setup again.",
                    destination.display()
                );
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
    }
    let result = async {
        smol::fs::create_dir_all(bin).await?;
        for (source, destination) in &links {
            match smol::fs::remove_file(destination).await {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(error),
            }
            smol::fs::unix::symlink(source, destination).await?;
        }
        std::io::Result::Ok(())
    }
    .await;
    if let Err(error) = result {
        if !cfg!(target_os = "macos") || error.kind() != std::io::ErrorKind::PermissionDenied {
            return Err(error).context("Cannot install codctl");
        }
        let mut command = format!("mkdir -p {}", shell_quote(bin));
        for (source, destination) in &links {
            command.push_str(&format!(
                " && ln -sfn {} {}",
                shell_quote(source),
                shell_quote(destination)
            ));
        }
        let script = format!(
            "do shell script \"{}\" with administrator privileges",
            command.replace('\\', "\\\\").replace('"', "\\\"")
        );
        let output = smol::process::Command::new("/usr/bin/osascript")
            .args(["-e", &script])
            .output()
            .await?;
        anyhow::ensure!(
            output.status.success(),
            "Command line installation did not finish: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }
    let path_has_bin = std::env::var_os("PATH")
        .is_some_and(|path| std::env::split_paths(&path).any(|entry| entry == bin));
    Ok(format!(
        "Installed codctl in {}.{}",
        bin.display(),
        if path_has_bin {
            String::new()
        } else {
            format!(
                "\n\nAdd {} to PATH, or use the full path to codctl.",
                bin.display()
            )
        }
    ))
}

fn shell_quote(path: &Path) -> String {
    format!("'{}'", path.to_string_lossy().replace('\'', "'\\''"))
}
