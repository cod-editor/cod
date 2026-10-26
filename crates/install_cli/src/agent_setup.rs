use anyhow::{Context as _, Result, bail};
use gpui::{AppContext as _, Context, PromptLevel, Window, actions};
use std::path::{Path, PathBuf};
use workspace::Workspace;
use workspace::notifications::DetachAndPromptErr;

actions!(
    cod,
    [
        /// Installs codctl and the control skill for Claude Code and Codex.
        SetUpCodingAgents,
    ]
);

const SKILL: &str = include_str!("../skills/cod-control/SKILL.md");

pub fn set_up_coding_agents(window: &mut Window, cx: &mut Context<Workspace>) {
    cx.spawn_in(window, async move |_, cx| {
        let executable = std::env::current_exe()?.canonicalize()?;
        let home = std::env::var_os("HOME")
            .map(PathBuf::from)
            .context("HOME is not set")?;
        let codex_home = std::env::var_os("CODEX_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join(".codex"));
        let bin = if cfg!(target_os = "macos") {
            PathBuf::from("/usr/local/bin")
        } else {
            home.join(".local/bin")
        };
        let detail = cx
            .background_spawn(async move { install(&executable, &home, &codex_home, &bin).await })
            .await?;
        cx.prompt(
            PromptLevel::Info,
            "Coding agents are ready",
            Some(&detail),
            &["OK"],
        )
        .await?;
        Ok(())
    })
    .detach_and_prompt_err("Could not set up coding agents", window, cx, |_, _, _| None);
}

async fn install(executable: &Path, home: &Path, codex_home: &Path, bin: &Path) -> Result<String> {
    let siblings = executable
        .parent()
        .context("Cod has no executable directory")?;
    let control = siblings.join("codctl");
    anyhow::ensure!(
        control.is_file(),
        "The bundled codctl is missing at {}",
        control.display()
    );
    let skills = [
        home.join(".claude/skills/cod-control"),
        codex_home.join("skills/cod-control"),
    ];
    for skill in &skills {
        let path = skill.join("SKILL.md");
        match smol::fs::read_to_string(&path).await {
            Ok(content) if !content.contains("<!-- cod-control-skill -->") => {
                bail!(
                    "{} already contains a different skill. Move it before running setup again.",
                    path.display()
                );
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(error).with_context(|| format!("Cannot read {}", path.display()));
            }
        }
    }
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
    for skill in &skills {
        smol::fs::create_dir_all(skill).await?;
        smol::fs::write(skill.join("SKILL.md"), SKILL).await?;
    }
    let path_has_bin = std::env::var_os("PATH")
        .is_some_and(|path| std::env::split_paths(&path).any(|entry| entry == bin));
    Ok(format!(
        "Installed codctl in {} and the Cod control skill for Claude Code and Codex.\n\nStart a new agent session from your Cod workspace to load the skill.{}",
        bin.display(),
        if path_has_bin {
            String::new()
        } else {
            format!(
                "\n\nThe skill also knows the full path in {} when it is not on PATH.",
                bin.display()
            )
        }
    ))
}

fn shell_quote(path: &Path) -> String {
    format!("'{}'", path.to_string_lossy().replace('\'', "'\\''"))
}
