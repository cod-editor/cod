use anyhow::{Context as _, Result};
use client::Client;
use db::kvp::KeyValueStore;
use futures_lite::StreamExt;
use gpui::{
    App, AppContext as _, AsyncApp, BackgroundExecutor, Context, Entity, EventEmitter, Global,
    Task, TaskExt, Window, actions,
};
use http_client::{HttpClient, HttpClientWithUrl, HttpRequestExt as _};
use paths::remote_servers_dir;
use release_channel::ReleaseChannel;
use semver::Version;
use serde::{Deserialize, Serialize};
use settings::{RegisterSetting, Settings};
use sha2::{Digest, Sha256};
use smol::fs::File;
use smol::{
    fs,
    io::{AsyncReadExt, AsyncWriteExt},
};
use std::{
    env::{self, consts::OS},
    ffi::OsStr,
    path::{Path, PathBuf},
    sync::Arc,
    time::{Duration, SystemTime},
};
use util::command::new_command;

const SHOULD_SHOW_UPDATE_NOTIFICATION_KEY: &str = "auto-updater-should-show-updated-notification";

#[derive(Debug)]
struct MissingDependencyError(String);

impl std::fmt::Display for MissingDependencyError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl std::error::Error for MissingDependencyError {}
const POLL_INTERVAL: Duration = Duration::from_secs(60 * 60);
const NIGHTLY_POLL_INTERVAL: Duration = Duration::from_secs(15 * 60);
const REMOTE_SERVER_CACHE_LIMIT: usize = 5;

actions!(
    auto_update,
    [
        /// Checks for available updates.
        Check,
        /// Dismisses the update error message.
        DismissMessage,
        /// Opens the release notes for the current version in a browser.
        ViewReleaseNotes,
    ]
);

#[derive(Serialize, Debug)]
pub struct AssetQuery<'a> {
    asset: &'a str,
    os: &'a str,
    arch: &'a str,
    metrics_id: Option<&'a str>,
    system_id: Option<&'a str>,
    is_staff: Option<bool>,
}

#[derive(Clone, Debug)]
pub enum AutoUpdateStatus {
    Idle,
    Checking,
    Downloading {
        version: Version,
        /// Download progress as a fraction in the range `0.0..=1.0`, or `None`
        /// when the total download size is not yet known.
        progress: Option<f32>,
    },
    Installing {
        version: Version,
    },
    Updated {
        version: Version,
    },
    Errored {
        error: Arc<anyhow::Error>,
    },
}

impl PartialEq for AutoUpdateStatus {
    // `progress` is deliberately not compared: two `Downloading` statuses for
    // the same version are equal regardless of how far the download is.
    fn eq(&self, other: &Self) -> bool {
        match (self, other) {
            (AutoUpdateStatus::Idle, AutoUpdateStatus::Idle) => true,
            (AutoUpdateStatus::Checking, AutoUpdateStatus::Checking) => true,
            (
                AutoUpdateStatus::Downloading { version: v1, .. },
                AutoUpdateStatus::Downloading { version: v2, .. },
            ) => v1 == v2,
            (
                AutoUpdateStatus::Installing { version: v1 },
                AutoUpdateStatus::Installing { version: v2 },
            ) => v1 == v2,
            (
                AutoUpdateStatus::Updated { version: v1 },
                AutoUpdateStatus::Updated { version: v2 },
            ) => v1 == v2,
            (AutoUpdateStatus::Errored { error: e1 }, AutoUpdateStatus::Errored { error: e2 }) => {
                e1.to_string() == e2.to_string()
            }
            _ => false,
        }
    }
}

impl AutoUpdateStatus {
    pub fn is_updated(&self) -> bool {
        matches!(self, Self::Updated { .. })
    }
}

pub enum AutoUpdateEvent {
    /// A manual check received a release response and found no newer version.
    UpToDate,
}

pub struct AutoUpdater {
    status: AutoUpdateStatus,
    current_version: Version,
    client: Arc<Client>,
    pending_poll: Option<Task<Option<()>>>,
    quit_subscription: Option<gpui::Subscription>,
    update_check_type: UpdateCheckType,
    _wake_subscription: gpui::Subscription,
    dismissed_status: Option<AutoUpdateStatus>,
    polling_task: Option<Task<Result<()>>>,
}

#[derive(Deserialize, Serialize, Clone, Debug)]
pub struct ReleaseAsset {
    pub version: String,
    pub url: String,
}

#[derive(Clone, Copy, Debug, RegisterSetting)]
struct AutoUpdateSetting(bool);

/// Whether or not to automatically check for updates.
///
/// Default: true
impl Settings for AutoUpdateSetting {
    fn from_settings(content: &settings::SettingsContent) -> Self {
        Self(content.auto_update.unwrap())
    }
}

const DESKTOP_UPDATES_ENABLED: bool = cfg!(all(target_os = "macos", target_arch = "aarch64"));
const COD_RELEASES_URL: &str = "https://api.github.com/repos/cod-editor/cod/releases?per_page=100";

#[derive(Default)]
struct GlobalAutoUpdate(Option<Entity<AutoUpdater>>);
impl Global for GlobalAutoUpdate {}

fn bundled_update_version(app_path: &Path) -> Result<Version> {
    anyhow::ensure!(
        app_path.extension() == Some(OsStr::new("app")),
        "not a bundled app"
    );
    let version =
        std::fs::read_to_string(app_path.join("Contents/Resources/cod-update-version.txt"))?;
    let version: Version = version.trim().parse()?;
    validate_update_version(&version)?;
    Ok(version)
}

pub fn init(client: Arc<Client>, cx: &mut App) {
    AutoUpdateSetting::register(cx);
    let bundled_version = DESKTOP_UPDATES_ENABLED
        .then(|| cx.app_path().and_then(|path| bundled_update_version(&path)))
        .and_then(Result::ok);
    let version = bundled_version
        .clone()
        .unwrap_or_else(|| release_channel::AppVersion::global(cx));
    let auto_updater = cx.new(|cx| AutoUpdater::new(version, client, cx));
    cx.set_global(GlobalAutoUpdate(Some(auto_updater.clone())));
    if bundled_version.is_some() {
        cx.on_action(|action: &ViewReleaseNotes, cx| {
            view_release_notes(action, cx);
        });
        cx.observe_new(|workspace: &mut workspace::Workspace, _, _| {
            workspace.register_action(|_, action: &Check, window, cx| check(action, window, cx));
        })
        .detach();
        cx.on_action(|_: &DismissMessage, cx| {
            if let Some(updater) = AutoUpdater::get(cx) {
                updater.update(cx, |updater, cx| updater.dismiss(cx));
            }
        });
        auto_updater.update(cx, |updater, cx| updater.update_polling(cx));
        cx.observe_global::<settings::SettingsStore>(move |cx| {
            auto_updater.update(cx, |updater, cx| updater.update_polling(cx));
        })
        .detach();
    }
}

pub fn check(_: &Check, window: &mut Window, cx: &mut App) {
    if let Some(message) = option_env!("ZED_UPDATE_EXPLANATION")
        .map(ToOwned::to_owned)
        .or_else(|| env::var("ZED_UPDATE_EXPLANATION").ok())
    {
        drop(window.prompt(
            gpui::PromptLevel::Info,
            "Cod was installed via a package manager.",
            Some(&message),
            &["OK"],
            cx,
        ));
        return;
    }

    if let Some(updater) = AutoUpdater::get(cx) {
        updater.update(cx, |updater, cx| updater.poll(UpdateCheckType::Manual, cx));
    } else {
        drop(window.prompt(
            gpui::PromptLevel::Info,
            "Could not check for updates",
            Some("Auto-updates disabled for non-bundled app."),
            &["OK"],
            cx,
        ));
    }
}

pub fn release_notes_url(_cx: &mut App) -> Option<String> {
    Some("https://github.com/cod-editor/cod/releases".to_string())
}

pub fn view_release_notes(_: &ViewReleaseNotes, cx: &mut App) -> Option<()> {
    let url = release_notes_url(cx)?;
    cx.open_url(&url);
    None
}

#[cfg(not(target_os = "windows"))]
const INSTALLER_DIR_PREFIX: &str = "cod-auto-update";

#[cfg(not(target_os = "windows"))]
struct InstallerDir(tempfile::TempDir);

#[cfg(not(target_os = "windows"))]
impl InstallerDir {
    async fn new() -> Result<Self> {
        Ok(Self(
            tempfile::Builder::new()
                .prefix(INSTALLER_DIR_PREFIX)
                .tempdir()?,
        ))
    }

    fn path(&self) -> &Path {
        self.0.path()
    }
}

#[cfg(target_os = "windows")]
struct InstallerDir(PathBuf);

#[cfg(target_os = "windows")]
impl InstallerDir {
    async fn new() -> Result<Self> {
        let installer_dir = std::env::current_exe()?
            .parent()
            .context("No parent dir for Zed.exe")?
            .join("updates");
        if smol::fs::metadata(&installer_dir).await.is_ok() {
            smol::fs::remove_dir_all(&installer_dir).await?;
        }
        smol::fs::create_dir(&installer_dir).await?;
        Ok(Self(installer_dir))
    }

    fn path(&self) -> &Path {
        self.0.as_path()
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum UpdateCheckType {
    Automatic,
    Manual,
}

impl UpdateCheckType {
    pub fn is_manual(self) -> bool {
        self == Self::Manual
    }
}

impl EventEmitter<AutoUpdateEvent> for AutoUpdater {}

impl AutoUpdater {
    pub fn get(cx: &mut App) -> Option<Entity<Self>> {
        cx.default_global::<GlobalAutoUpdate>().0.clone()
    }

    fn new(current_version: Version, client: Arc<Client>, cx: &mut Context<Self>) -> Self {
        // On windows, executable files cannot be overwritten while they are
        // running, so we must wait to overwrite the application until quitting
        // or restarting. When quitting the app, we spawn the auto update helper
        // to finish the auto update process after Zed exits. When restarting
        // the app after an update, we use `set_restart_path` to run the auto
        // update helper instead of the app, so that it can overwrite the app
        // and then spawn the new binary.
        // Cod: this quit hook installs a staged update, so it is off with desktop updates.
        #[cfg(target_os = "windows")]
        let quit_subscription =
            DESKTOP_UPDATES_ENABLED.then(|| cx.on_app_quit(|_, _| finalize_auto_update_on_quit()));
        #[cfg(not(target_os = "windows"))]
        let quit_subscription = None;

        cx.on_app_restart(|this, _| {
            this.quit_subscription.take();
        })
        .detach();

        // A download or check that was in flight when the machine went to sleep
        // is almost certainly riding a TCP connection that silently died during
        // suspend, so it would otherwise appear to stall indefinitely.
        let wake_subscription = cx.on_system_wake({
            let this = cx.entity().downgrade();
            move |cx| {
                this.update(cx, |this, cx| this.restart_after_wake(cx)).ok();
            }
        });

        Self {
            status: AutoUpdateStatus::Idle,
            current_version,
            client,
            pending_poll: None,
            quit_subscription,
            update_check_type: UpdateCheckType::Automatic,
            _wake_subscription: wake_subscription,
            dismissed_status: None,
            polling_task: None,
        }
    }

    fn restart_after_wake(&mut self, cx: &mut Context<Self>) {
        // Only network phases can be safely restarted. `Installing` is a local
        // operation (mounting a dmg, rsync, etc.) that must not be interrupted.
        if !matches!(
            self.status,
            AutoUpdateStatus::Checking | AutoUpdateStatus::Downloading { .. }
        ) {
            return;
        }

        let check_type = self.update_check_type;
        self.pending_poll.take();
        self.status = AutoUpdateStatus::Idle;
        self.poll(check_type, cx);
    }

    fn update_polling(&mut self, cx: &mut Context<Self>) {
        if AutoUpdateSetting::get_global(cx).0 {
            if self.polling_task.is_none() {
                self.polling_task = Some(self.start_polling(cx));
            }
        } else {
            self.polling_task.take();
        }
    }

    pub fn start_polling(&self, cx: &mut Context<Self>) -> Task<Result<()>> {
        let poll_interval =
            ReleaseChannel::try_global(cx).map_or(POLL_INTERVAL, |channel| match channel {
                ReleaseChannel::Nightly => NIGHTLY_POLL_INTERVAL,
                _ => POLL_INTERVAL,
            });

        cx.spawn(async move |this, cx| {
            if cfg!(target_os = "windows") {
                use util::ResultExt;

                cleanup_windows()
                    .await
                    .context("failed to cleanup old directories")
                    .log_err();
            }

            #[cfg(all(not(target_os = "windows"), not(test)))]
            cx.background_spawn(cleanup_stale_installer_dirs()).detach();

            loop {
                this.update(cx, |this, cx| this.poll(UpdateCheckType::Automatic, cx))?;
                cx.background_executor().timer(poll_interval).await;
            }
        })
    }

    pub fn update_check_type(&self) -> UpdateCheckType {
        self.update_check_type
    }

    pub fn poll(&mut self, check_type: UpdateCheckType, cx: &mut Context<Self>) {
        // Development binaries and unsupported platforms must never replace themselves.
        if !DESKTOP_UPDATES_ENABLED
            || cx
                .app_path()
                .and_then(|path| bundled_update_version(&path))
                .is_err()
        {
            return;
        }
        if check_type.is_manual() {
            self.dismissed_status = None;
        }
        if self.pending_poll.is_some() {
            if self.update_check_type == UpdateCheckType::Automatic {
                self.update_check_type = check_type;
                cx.notify();
            }
            return;
        }
        self.update_check_type = check_type;

        cx.notify();

        self.pending_poll = Some(cx.spawn(async move |this, cx| {
            let result = Self::update(this.upgrade()?, cx).await;
            this.update(cx, |this, cx| {
                this.pending_poll = None;
                if let Err(error) = result {
                    let is_missing_dependency =
                        error.downcast_ref::<MissingDependencyError>().is_some();
                    this.status = match check_type {
                        UpdateCheckType::Automatic if is_missing_dependency => {
                            log::warn!("auto-update: {}", error);
                            AutoUpdateStatus::Errored {
                                error: Arc::new(error),
                            }
                        }
                        // Be quiet if the check was automated (e.g. when offline)
                        UpdateCheckType::Automatic => {
                            log::info!("auto-update check failed: error:{:?}", error);
                            AutoUpdateStatus::Idle
                        }
                        UpdateCheckType::Manual => {
                            log::error!("auto-update failed: error:{:?}", error);
                            AutoUpdateStatus::Errored {
                                error: Arc::new(error),
                            }
                        }
                    };

                    cx.notify();
                }
            })
            .ok()
        }));
    }

    pub fn current_version(&self) -> Version {
        self.current_version.clone()
    }

    pub fn status(&self) -> AutoUpdateStatus {
        self.status.clone()
    }

    pub fn dismissed_status(&self) -> Option<AutoUpdateStatus> {
        self.dismissed_status.clone()
    }

    pub fn dismiss_status(&mut self, status: AutoUpdateStatus, cx: &mut Context<Self>) {
        self.dismissed_status = Some(status);
        cx.notify();
    }

    pub fn dismiss(&mut self, cx: &mut Context<Self>) -> bool {
        if let AutoUpdateStatus::Idle = self.status {
            return false;
        }
        self.status = AutoUpdateStatus::Idle;
        cx.notify();
        true
    }

    // If you are packaging Zed and need to override the place it downloads SSH remotes from,
    // you can override this function. You should also update get_remote_server_release_url to return
    // Ok(None).
    pub async fn download_remote_server_release(
        release_channel: ReleaseChannel,
        version: Option<Version>,
        os: &str,
        arch: &str,
        set_status: impl Fn(&str, &mut AsyncApp) + Send + 'static,
        cx: &mut AsyncApp,
    ) -> Result<PathBuf> {
        let this = cx.update(|cx| {
            cx.default_global::<GlobalAutoUpdate>()
                .0
                .clone()
                .context("auto-update not initialized")
        })?;

        set_status("Fetching remote server release", cx);
        let release = Self::get_release_asset(
            &this,
            release_channel,
            version,
            "zed-remote-server",
            os,
            arch,
            cx,
        )
        .await?;

        let servers_dir = paths::remote_servers_dir();
        let channel_dir = servers_dir.join(release_channel.dev_name());
        let platform_dir = channel_dir.join(format!("{}-{}", os, arch));
        let version_path = platform_dir.join(format!("{}.gz", release.version));
        smol::fs::create_dir_all(&platform_dir).await.ok();

        let client = this.read_with(cx, |this, _| this.client.http_client());

        if smol::fs::metadata(&version_path).await.is_err() {
            log::info!(
                "downloading zed-remote-server {os} {arch} version {}",
                release.version
            );
            set_status("Downloading remote server", cx);
            download_remote_server_binary(&version_path, release, client).await?;
        }

        if let Err(error) =
            cleanup_remote_server_cache(&platform_dir, &version_path, REMOTE_SERVER_CACHE_LIMIT)
                .await
        {
            log::warn!(
                "Failed to clean up remote server cache in {:?}: {error:#}",
                platform_dir
            );
        }

        Ok(version_path)
    }

    pub async fn get_remote_server_release_url(
        channel: ReleaseChannel,
        version: Option<Version>,
        os: &str,
        arch: &str,
        cx: &mut AsyncApp,
    ) -> Result<Option<String>> {
        let this = cx.update(|cx| {
            cx.default_global::<GlobalAutoUpdate>()
                .0
                .clone()
                .context("auto-update not initialized")
        })?;

        let release =
            Self::get_release_asset(&this, channel, version, "zed-remote-server", os, arch, cx)
                .await?;

        Ok(Some(release.url))
    }

    async fn get_release_asset(
        this: &Entity<Self>,
        release_channel: ReleaseChannel,
        version: Option<Version>,
        asset: &str,
        os: &str,
        arch: &str,
        cx: &mut AsyncApp,
    ) -> Result<ReleaseAsset> {
        let client = this.read_with(cx, |this, _| this.client.clone());

        let (system_id, metrics_id, is_staff) = if client.telemetry().metrics_enabled() {
            (
                client.telemetry().system_id(),
                client.telemetry().metrics_id(),
                client.telemetry().is_staff(),
            )
        } else {
            (None, None, None)
        };

        let version = if let Some(mut version) = version {
            version.pre = semver::Prerelease::EMPTY;
            version.build = semver::BuildMetadata::EMPTY;
            version.to_string()
        } else {
            "latest".to_string()
        };
        let http_client = client.http_client();

        let path = format!("/releases/{}/{}/asset", release_channel.dev_name(), version,);
        let url = http_client.build_zed_cloud_url_with_query(
            &path,
            AssetQuery {
                os,
                arch,
                asset,
                metrics_id: metrics_id.as_deref(),
                system_id: system_id.as_deref(),
                is_staff,
            },
        )?;

        let mut response = http_client
            .get(url.as_str(), Default::default(), true)
            .await?;
        let mut body = Vec::new();
        response.body_mut().read_to_end(&mut body).await?;

        anyhow::ensure!(
            response.status().is_success(),
            "failed to fetch release: {:?}",
            String::from_utf8_lossy(&body),
        );

        serde_json::from_slice(body.as_slice()).with_context(|| {
            format!(
                "error deserializing release {:?}",
                String::from_utf8_lossy(&body),
            )
        })
    }

    async fn update(this: Entity<Self>, cx: &mut AsyncApp) -> Result<()> {
        let (client, installed_version, previous_status) = this.read_with(cx, |this, _| {
            (
                this.client.http_client(),
                this.current_version.clone(),
                this.status.clone(),
            )
        });

        this.update(cx, |this, cx| {
            this.status = AutoUpdateStatus::Checking;
            log::info!("Auto Update: checking for updates");
            cx.notify();
        });

        let metadata = fetch_cod_release(client.clone()).await?;
        let fetched_version: Version = metadata.version.parse()?;
        let current_version = match &previous_status {
            AutoUpdateStatus::Updated { version } => version,
            _ => &installed_version,
        };
        let newer_version = newer_cod_version(current_version, fetched_version);
        let fetched_release_data = ReleaseAsset {
            version: metadata.version.clone(),
            url: metadata.macos_aarch64.url.clone(),
        };

        let Some(newer_version) = newer_version else {
            this.update(cx, |this, cx| {
                this.status = match previous_status {
                    AutoUpdateStatus::Updated { .. } => previous_status,
                    _ => {
                        if this.update_check_type.is_manual() {
                            cx.emit(AutoUpdateEvent::UpToDate);
                        }
                        AutoUpdateStatus::Idle
                    }
                };
                cx.notify();
            });
            return Ok(());
        };

        this.update(cx, |this, cx| {
            this.status = AutoUpdateStatus::Downloading {
                version: newer_version.clone(),
                progress: None,
            };
            cx.notify();
        });

        let installer_dir = InstallerDir::new()
            .await
            .context("Failed to create installer dir")?;
        let target_path = Self::target_path(&installer_dir).await?;
        let progress_entity = this.clone();
        let mut progress_cx = cx.clone();
        download_release(
            &target_path,
            fetched_release_data,
            client,
            move |progress| {
                progress_entity.update(&mut progress_cx, |this, cx| {
                    if let AutoUpdateStatus::Downloading {
                        progress: current_progress,
                        ..
                    } = &mut this.status
                    {
                        *current_progress = progress;
                        cx.notify();
                    }
                });
            },
        )
        .await
        .with_context(|| format!("Failed to download update to {}", target_path.display()))?;

        cx.background_spawn({
            let path = target_path.clone();
            let checksum = metadata.macos_aarch64.sha256.clone();
            async move { verify_download(&path, &checksum).await }
        })
        .await?;

        this.update(cx, |this, cx| {
            this.status = AutoUpdateStatus::Installing {
                version: newer_version.clone(),
            };
            cx.notify();
        });

        #[cfg(test)]
        let install_result = match cx
            .try_read_global::<tests::InstallOverride, _>(|g, _| g.0.clone())
            .map(|test_install| test_install(&target_path, cx))
        {
            Some(result) => result,
            None => return Ok(()),
        };

        #[cfg(not(test))]
        let install_result = {
            let running_app_path = cx.update(|cx| cx.app_path())?;
            let background_executor = cx.background_executor().clone();
            let channel = cx.update(|cx| ReleaseChannel::global(cx).dev_name());
            cx.background_spawn(Self::install_release(
                installer_dir,
                target_path.clone(),
                running_app_path,
                channel,
                background_executor,
                newer_version.clone(),
                metadata.commit.clone(),
            ))
            .await
        };
        let new_binary_path = install_result
            .with_context(|| format!("Failed to install update at: {}", target_path.display()))?;
        if let Some(new_binary_path) = new_binary_path {
            cx.update(|cx| cx.set_restart_path(new_binary_path));
        }

        this.update(cx, |this, cx| {
            this.set_should_show_update_notification(true, cx)
                .detach_and_log_err(cx);
            this.status = AutoUpdateStatus::Updated {
                version: newer_version,
            };
            cx.notify();
        });
        Ok(())
    }

    async fn target_path(installer_dir: &InstallerDir) -> Result<PathBuf> {
        let filename = match OS {
            "macos" => anyhow::Ok("Cod.zip"),
            "linux" => Ok("zed.tar.gz"),
            "windows" => Ok("Zed.exe"),
            unsupported_os => anyhow::bail!("not supported: {unsupported_os}"),
        }?;

        Ok(installer_dir.path().join(filename))
    }

    #[cfg_attr(test, allow(dead_code))]
    async fn install_release(
        installer_dir: InstallerDir,
        target_path: PathBuf,
        running_app_path: PathBuf,
        channel: &str,
        background_executor: BackgroundExecutor,
        expected_version: Version,
        expected_commit: String,
    ) -> Result<Option<PathBuf>> {
        match OS {
            "macos" => {
                install_release_macos(
                    &installer_dir,
                    &target_path,
                    running_app_path,
                    &background_executor,
                    &expected_version,
                    &expected_commit,
                )
                .await
            }
            "linux" => {
                install_release_linux(&installer_dir, &target_path, channel, running_app_path).await
            }
            "windows" => install_release_windows(&target_path).await,
            unsupported_os => anyhow::bail!("not supported: {unsupported_os}"),
        }
    }

    pub fn set_should_show_update_notification(
        &self,
        should_show: bool,
        cx: &App,
    ) -> Task<Result<()>> {
        let kvp = KeyValueStore::global(cx);
        cx.background_spawn(async move {
            if should_show {
                kvp.write_kvp(
                    SHOULD_SHOW_UPDATE_NOTIFICATION_KEY.to_string(),
                    "".to_string(),
                )
                .await?;
            } else {
                kvp.delete_kvp(SHOULD_SHOW_UPDATE_NOTIFICATION_KEY.to_string())
                    .await?;
            }
            Ok(())
        })
    }

    pub fn should_show_update_notification(&self, cx: &App) -> Task<Result<bool>> {
        let kvp = KeyValueStore::global(cx);
        cx.background_spawn(async move {
            Ok(kvp.read_kvp(SHOULD_SHOW_UPDATE_NOTIFICATION_KEY)?.is_some())
        })
    }
}

async fn download_remote_server_binary(
    target_path: &PathBuf,
    release: ReleaseAsset,
    client: Arc<HttpClientWithUrl>,
) -> Result<()> {
    let temp = tempfile::Builder::new().tempfile_in(remote_servers_dir())?;
    let mut temp_file = File::create(&temp).await?;

    let mut response = client.get(&release.url, Default::default(), true).await?;
    anyhow::ensure!(
        response.status().is_success(),
        "failed to download remote server release: {:?}",
        response.status()
    );
    smol::io::copy(response.body_mut(), &mut temp_file).await?;
    smol::fs::rename(&temp, &target_path).await?;

    Ok(())
}

async fn cleanup_remote_server_cache(
    platform_dir: &Path,
    keep_path: &Path,
    limit: usize,
) -> Result<()> {
    if limit == 0 {
        return Ok(());
    }

    let mut entries = smol::fs::read_dir(platform_dir).await?;
    let now = SystemTime::now();
    let mut candidates = Vec::new();

    while let Some(entry) = entries.next().await {
        let entry = entry?;
        let path = entry.path();
        if path.extension() != Some(OsStr::new("gz")) {
            continue;
        }

        let mtime = if path == keep_path {
            now
        } else {
            smol::fs::metadata(&path)
                .await
                .and_then(|metadata| metadata.modified())
                .unwrap_or(SystemTime::UNIX_EPOCH)
        };

        candidates.push((path, mtime));
    }

    if candidates.len() <= limit {
        return Ok(());
    }

    candidates.sort_by(|(path_a, time_a), (path_b, time_b)| {
        time_b.cmp(time_a).then_with(|| path_a.cmp(path_b))
    });

    for (index, (path, _)) in candidates.into_iter().enumerate() {
        if index < limit || path == keep_path {
            continue;
        }

        if let Err(error) = smol::fs::remove_file(&path).await {
            log::warn!(
                "Failed to remove old remote server archive {:?}: {}",
                path,
                error
            );
        }
    }

    Ok(())
}

#[derive(Deserialize)]
struct GithubRelease {
    draft: bool,
    assets: Vec<GithubAsset>,
}

#[derive(Deserialize)]
struct GithubAsset {
    name: String,
    browser_download_url: String,
}

#[derive(Deserialize)]
struct CodRelease {
    commit: String,
    version: String,
    macos_aarch64: CodAsset,
}

#[derive(Deserialize)]
struct CodAsset {
    url: String,
    sha256: String,
}

fn update_fixture_enabled() -> bool {
    env::var_os("COD_E2E_SOCKET").is_some()
}

fn newer_cod_version(installed: &Version, fetched: Version) -> Option<Version> {
    (fetched > *installed).then_some(fetched)
}

fn validate_update_version(version: &Version) -> Result<()> {
    anyhow::ensure!(
        version.major == 0
            && version.minor == 0
            && version.pre.is_empty()
            && version.build.is_empty(),
        "invalid Cod update version"
    );
    Ok(())
}

fn validate_cod_release(release: &CodRelease) -> Result<Version> {
    let version: Version = release.version.parse()?;
    validate_update_version(&version)?;
    anyhow::ensure!(
        release.commit.len() == 40 && release.commit.bytes().all(|byte| byte.is_ascii_hexdigit()),
        "invalid Cod update commit"
    );
    anyhow::ensure!(
        release.macos_aarch64.sha256.len() == 64
            && release
                .macos_aarch64
                .sha256
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit()),
        "invalid Cod update checksum"
    );
    validate_asset_url(&release.macos_aarch64.url)?;
    Ok(version)
}

fn validate_asset_url(url: &str) -> Result<()> {
    anyhow::ensure!(
        url.starts_with("https://github.com/cod-editor/cod/releases/download/")
            || (update_fixture_enabled() && url.starts_with("http://127.0.0.1:")),
        "update asset must belong to cod-editor/cod"
    );
    Ok(())
}

async fn get_json<T: serde::de::DeserializeOwned>(client: &dyn HttpClient, url: &str) -> Result<T> {
    let request = http_client::Request::builder()
        .uri(url)
        .header("User-Agent", "Cod-Updater")
        .follow_redirects(http_client::RedirectPolicy::FollowAll)
        .timeout(Duration::from_secs(30))
        .body(Default::default())?;
    let mut response = client.send(request).await?;
    anyhow::ensure!(
        response.status().is_success(),
        "failed to fetch Cod update: {}",
        response.status()
    );
    let mut bytes = Vec::new();
    response.body_mut().read_to_end(&mut bytes).await?;
    Ok(serde_json::from_slice(&bytes)?)
}

async fn fetch_cod_release(client: Arc<HttpClientWithUrl>) -> Result<CodRelease> {
    let url = if update_fixture_enabled() {
        env::var("COD_UPDATE_RELEASES_URL").unwrap_or_else(|_| COD_RELEASES_URL.to_string())
    } else {
        COD_RELEASES_URL.to_string()
    };
    let releases: Vec<GithubRelease> = get_json(client.as_ref(), &url).await?;
    let mut newest: Option<(Version, CodRelease)> = None;
    for release in releases.into_iter().filter(|release| !release.draft) {
        let Some(asset) = release
            .assets
            .iter()
            .find(|asset| asset.name == "cod-update.json")
        else {
            continue;
        };
        let candidate = async {
            validate_asset_url(&asset.browser_download_url)?;
            let metadata: CodRelease =
                get_json(client.as_ref(), &asset.browser_download_url).await?;
            let version = validate_cod_release(&metadata)?;
            anyhow::Ok((version, metadata))
        }
        .await;
        let (version, metadata) = match candidate {
            Ok(candidate) => candidate,
            Err(error) => {
                log::warn!("ignoring unusable Cod release metadata: {error:#}");
                continue;
            }
        };
        if newest
            .as_ref()
            .is_none_or(|(current, _)| version > *current)
        {
            newest = Some((version, metadata));
        }
    }
    newest
        .map(|(_, release)| release)
        .context("no published Cod update is available")
}

async fn verify_download(path: &Path, expected: &str) -> Result<()> {
    let mut file = File::open(path).await?;
    let mut digest = Sha256::new();
    let mut buffer = [0u8; 65536];
    loop {
        let count = file.read(&mut buffer).await?;
        if count == 0 {
            break;
        }
        digest.update(&buffer[..count]);
    }
    anyhow::ensure!(
        format!("{:x}", digest.finalize()).eq_ignore_ascii_case(expected),
        "Cod update checksum does not match the published release"
    );
    Ok(())
}

async fn download_release(
    target_path: &Path,
    release: ReleaseAsset,
    client: Arc<HttpClientWithUrl>,
    mut on_progress: impl FnMut(Option<f32>),
) -> Result<()> {
    let mut target_file = File::create(&target_path).await?;

    let mut response = client.get(&release.url, Default::default(), true).await?;
    anyhow::ensure!(
        response.status().is_success(),
        "failed to download update: {:?}",
        response.status()
    );

    let total_bytes = response
        .headers()
        .get(http_client::http::header::CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|total_bytes| *total_bytes > 0);

    let mut downloaded_bytes: u64 = 0;
    let mut last_reported_percent: Option<u8> = None;
    let mut buffer = [0u8; 8192];
    let body = response.body_mut();
    loop {
        let bytes_read = body.read(&mut buffer).await?;
        if bytes_read == 0 {
            break;
        }
        target_file.write_all(&buffer[..bytes_read]).await?;
        downloaded_bytes += bytes_read as u64;

        if let Some(total_bytes) = total_bytes {
            let fraction = (downloaded_bytes as f32 / total_bytes as f32).clamp(0.0, 1.0);
            // Only report when the whole-number percentage changes to avoid notifying the UI on every chunk.
            let percent = (fraction * 100.0) as u8;
            if last_reported_percent != Some(percent) {
                last_reported_percent = Some(percent);
                on_progress(Some(fraction));
            }
        }
    }
    target_file.flush().await?;
    if total_bytes.is_some() && last_reported_percent != Some(100) {
        on_progress(Some(1.0));
    }
    log::info!("downloaded update. path:{:?}", target_path);

    Ok(())
}

async fn install_release_linux(
    temp_dir: &InstallerDir,
    downloaded_tar_gz: &Path,
    channel: &str,
    running_app_path: PathBuf,
) -> Result<Option<PathBuf>> {
    let home_dir = PathBuf::from(env::var("HOME").context("no HOME env var set")?);

    let extracted = temp_dir.path().join("zed");
    fs::create_dir_all(&extracted)
        .await
        .context("failed to create directory into which to extract update")?;

    let mut cmd = new_command("tar");
    cmd.arg("-xzf")
        .arg(&downloaded_tar_gz)
        .arg("-C")
        .arg(&extracted);
    let output = cmd
        .output()
        .await
        .with_context(|| "failed to extract: {cmd}")?;

    anyhow::ensure!(
        output.status.success(),
        "failed to extract {:?} to {:?}: {:?}",
        downloaded_tar_gz,
        extracted,
        String::from_utf8_lossy(&output.stderr)
    );

    let suffix = if channel != "stable" {
        format!("-{}", channel)
    } else {
        String::default()
    };
    let app_folder_name = format!("zed{}.app", suffix);

    let from = extracted.join(&app_folder_name);
    let mut to = home_dir.join(".local");

    let expected_suffix = format!("{}/libexec/zed-editor", app_folder_name);

    if let Some(prefix) = running_app_path
        .to_str()
        .and_then(|str| str.strip_suffix(&expected_suffix))
    {
        to = PathBuf::from(prefix);
    }

    let mut cmd = new_command("rsync");
    cmd.args(["-av", "--delete"]).arg(&from).arg(&to);
    let output = cmd
        .output()
        .await
        .with_context(|| "failed to rsync: {cmd}")?;

    anyhow::ensure!(
        output.status.success(),
        "failed to copy Zed update from {:?} to {:?}: {:?}",
        from,
        to,
        String::from_utf8_lossy(&output.stderr)
    );

    Ok(Some(to.join(expected_suffix)))
}

async fn install_release_macos(
    temp_dir: &InstallerDir,
    downloaded_zip: &Path,
    running_app_path: PathBuf,
    _background_executor: &BackgroundExecutor,
    expected_version: &Version,
    expected_commit: &str,
) -> Result<Option<PathBuf>> {
    let extracted = temp_dir.path().join("extracted");
    let output = new_command("/usr/bin/ditto")
        .args(["-x", "-k"])
        .arg(downloaded_zip)
        .arg(&extracted)
        .output()
        .await?;
    anyhow::ensure!(
        output.status.success(),
        "failed to extract Cod update: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let updated_app = extracted.join("Cod.app");
    anyhow::ensure!(
        bundled_update_version(&updated_app)? == *expected_version,
        "Cod bundle version does not match the published update"
    );
    let bundled_commit =
        fs::read_to_string(updated_app.join("Contents/Resources/cod-commit.txt")).await?;
    anyhow::ensure!(
        bundled_commit.trim() == expected_commit,
        "Cod bundle commit does not match the published update"
    );
    let output = new_command("/usr/bin/codesign")
        .args(["--verify", "--deep", "--strict"])
        .arg(&updated_app)
        .output()
        .await?;
    anyhow::ensure!(
        output.status.success(),
        "Cod update signature verification failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let staging_dir = tempfile::Builder::new().prefix(".cod-update-").tempdir_in(
        running_app_path
            .parent()
            .context("Cod bundle has no parent")?,
    )?;
    let staged = staging_dir.path().join("Cod.app");
    let backup = staging_dir.path().join("previous.app");
    let output = new_command("/usr/bin/ditto")
        .arg(&updated_app)
        .arg(&staged)
        .output()
        .await?;
    anyhow::ensure!(
        output.status.success(),
        "failed to stage Cod update: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    fs::rename(&running_app_path, &backup).await?;
    if let Err(error) = fs::rename(&staged, &running_app_path).await {
        if let Err(restore_error) = fs::rename(&backup, &running_app_path).await {
            // Keep the backup on disk if restoring failed so recovery is still possible.
            let recovery_path = staging_dir.keep();
            anyhow::bail!(
                "failed to install Cod: {error}; failed to restore previous app: {restore_error}; previous app retained at {}",
                recovery_path.display()
            );
        }
        return Err(error.into());
    }
    Ok(None)
}

/// Removes stale installer dirs from the system temp dir. Older Zed versions
/// leaked one per update by deleting the dir while the downloaded disk image
/// was still mounted inside it, which made the deletion fail silently.
#[cfg(any(rust_analyzer, all(not(target_os = "windows"), not(test))))]
async fn cleanup_stale_installer_dirs() {
    const STALE_INSTALLER_DIR_AGE: Duration = Duration::from_secs(24 * 60 * 60);

    let temp_dir = std::env::temp_dir();
    let Ok(mut entries) = fs::read_dir(&temp_dir).await else {
        log::warn!("failed to read temp dir {temp_dir:?} while cleaning up installer dirs");
        return;
    };
    while let Some(entry) = entries.next().await {
        let Ok(entry) = entry else {
            continue;
        };
        if !entry
            .file_name()
            .to_string_lossy()
            .starts_with(INSTALLER_DIR_PREFIX)
        {
            continue;
        }
        // Leave recent dirs alone, as they may belong to an update currently
        // in progress in another Zed instance.
        let is_stale = entry.metadata().await.ok().is_some_and(|metadata| {
            metadata.is_dir()
                && metadata.modified().ok().is_some_and(|modified| {
                    SystemTime::now()
                        .duration_since(modified)
                        .is_ok_and(|age| age > STALE_INSTALLER_DIR_AGE)
                })
        });
        if is_stale {
            if let Err(error) = fs::remove_dir_all(entry.path()).await {
                log::warn!(
                    "failed to remove stale installer dir {:?}: {error}",
                    entry.path()
                );
            } else {
                log::info!("removed stale installer dir {:?}", entry.path());
            }
        }
    }
}

async fn cleanup_windows() -> Result<()> {
    let parent = std::env::current_exe()?
        .parent()
        .context("No parent dir for Zed.exe")?
        .to_owned();

    // keep in sync with crates/auto_update_helper/src/updater.rs
    _ = smol::fs::remove_dir(parent.join("updates")).await;
    _ = smol::fs::remove_dir(parent.join("install")).await;
    _ = smol::fs::remove_dir(parent.join("old")).await;

    Ok(())
}

async fn install_release_windows(downloaded_installer: &Path) -> Result<Option<PathBuf>> {
    let mut cmd = new_command(downloaded_installer);
    cmd.arg("/verysilent")
        .arg("/update=true")
        .arg("/MERGETASKS=!desktopicon");
    let output = cmd.output().await?;
    anyhow::ensure!(
        output.status.success(),
        "failed to start installer: {:?}",
        String::from_utf8_lossy(&output.stderr)
    );
    // We return the path to the update helper program, because it will
    // perform the final steps of the update process, copying the new binary,
    // deleting the old one, and launching the new binary.
    let helper_path = std::env::current_exe()?
        .parent()
        .context("No parent dir for Zed.exe")?
        .join("tools")
        .join("auto_update_helper.exe");
    Ok(Some(helper_path))
}

pub async fn finalize_auto_update_on_quit() {
    if !DESKTOP_UPDATES_ENABLED {
        return;
    }
    let Some(installer_path) = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|p| p.join("updates")))
    else {
        return;
    };

    // The installer will create a flag file after it finishes updating
    let flag_file = installer_path.join("versions.txt");
    if flag_file.exists()
        && let Some(helper) = installer_path
            .parent()
            .map(|p| p.join("tools").join("auto_update_helper.exe"))
    {
        let mut command = util::command::new_command(helper);
        command.arg("--launch");
        command.arg("false");
        if let Ok(mut cmd) = command.spawn() {
            _ = cmd.status().await;
        }
    }
}

#[cfg(test)]
mod tests {
    use client::Client;
    use clock::FakeSystemClock;
    use gpui::{BorrowAppContext as _, TestAppContext};
    use http_client::{FakeHttpClient, Response};
    use settings::default_settings;
    use std::{
        rc::Rc,
        sync::{
            Arc,
            atomic::{self, AtomicUsize},
        },
    };
    use tempfile::tempdir;

    #[ctor::ctor(unsafe)]
    fn init_logger() {
        zlog::init_test();
    }

    use super::*;

    pub(super) struct InstallOverride(pub Rc<dyn Fn(&Path, &AsyncApp) -> Result<Option<PathBuf>>>);
    impl Global for InstallOverride {}

    #[gpui::test]
    fn test_auto_update_defaults_to_true(cx: &mut TestAppContext) {
        cx.update(|cx| {
            let mut store = settings::SettingsStore::new(cx, &settings::default_settings());
            store
                .set_default_settings(&default_settings(), cx)
                .expect("Unable to set default settings");
            store
                .set_user_settings("{}", cx)
                .expect("Unable to set user settings");
            cx.set_global(store);
            assert!(AutoUpdateSetting::get_global(cx).0);
        });
    }

    #[gpui::test]
    async fn test_desktop_updates_never_run(cx: &mut TestAppContext) {
        cx.background_executor.allow_parking();
        zlog::init_test();
        let requests = Arc::new(AtomicUsize::new(0));

        cx.update(|cx| {
            settings::init(cx);

            let current_version = semver::Version::new(0, 100, 0);
            release_channel::init_test(current_version, ReleaseChannel::Stable, cx);

            let clock = Arc::new(FakeSystemClock::new());
            let requests = Arc::clone(&requests);
            let fake_client_http = FakeHttpClient::create(move |_req| {
                requests.fetch_add(1, atomic::Ordering::SeqCst);
                async move {
                    Ok(Response::builder()
                        .status(200)
                        .body(
                            r#"{"version":"0.100.1","url":"https://test.example/new-download"}"#
                                .into(),
                        )
                        .unwrap())
                }
            });
            let client = Client::new(clock, fake_client_http, cx);
            crate::init(client, cx);
        });

        let auto_updater = cx.update(|cx| AutoUpdater::get(cx).expect("auto updater should exist"));
        let assert_idle_and_silent = |cx: &mut TestAppContext, step: &str| {
            cx.background_executor.run_until_parked();
            auto_updater.read_with(cx, |updater, _| {
                assert_eq!(updater.status(), AutoUpdateStatus::Idle, "{step}");
            });
            assert_eq!(requests.load(atomic::Ordering::SeqCst), 0, "{step}");
        };

        assert_idle_and_silent(cx, "after startup");

        cx.background_executor.advance_clock(POLL_INTERVAL * 3);
        assert_idle_and_silent(cx, "after advancing the clock");

        cx.update(|cx| {
            cx.update_global::<settings::SettingsStore, _>(|store, cx| {
                store
                    .set_user_settings(r#"{ "auto_update": true }"#, cx)
                    .expect("Unable to set user settings");
            });
        });
        cx.background_executor.advance_clock(POLL_INTERVAL);
        assert_idle_and_silent(cx, "after enabling the auto_update setting");

        auto_updater.update(cx, |updater, cx| {
            updater.poll(UpdateCheckType::Manual, cx);
        });
        assert_idle_and_silent(cx, "after a manual check");
    }

    #[gpui::test]
    async fn test_download_release_reports_progress(cx: &mut TestAppContext) {
        cx.background_executor.allow_parking();

        let body = vec![0u8; 20_000];
        let content_length = body.len();

        let client = FakeHttpClient::create(move |_req| {
            let body = body.clone();
            async move {
                Ok(Response::builder()
                    .status(200)
                    .header(
                        http_client::http::header::CONTENT_LENGTH,
                        body.len().to_string(),
                    )
                    .body(body.into())
                    .unwrap())
            }
        });

        let temp_dir = tempdir().unwrap();
        let target_path = temp_dir.path().join("zed-download");
        let release = ReleaseAsset {
            version: "1.0.0".to_string(),
            url: "https://test.example/download".to_string(),
        };

        let reported = Rc::new(std::cell::RefCell::new(Vec::<f32>::new()));
        download_release(&target_path, release, client, {
            let reported = reported.clone();
            move |fraction| {
                if let Some(fraction) = fraction {
                    reported.borrow_mut().push(fraction);
                }
            }
        })
        .await
        .unwrap();

        let reported = reported.borrow();
        assert!(
            reported.len() >= 2,
            "expected progress to be reported across multiple reads, got {reported:?}"
        );
        assert_eq!(
            reported.last().copied(),
            Some(1.0),
            "download should finish at 100%"
        );
        for fraction in reported.iter() {
            assert!(
                (0.0..=1.0).contains(fraction),
                "progress {fraction} out of range"
            );
        }
        for pair in reported.windows(2) {
            assert!(
                pair[0] <= pair[1],
                "progress must not decrease: {reported:?}"
            );
        }

        let downloaded_len = std::fs::metadata(&target_path).unwrap().len();
        assert_eq!(downloaded_len, content_length as u64);
    }

    #[gpui::test]
    async fn test_download_release_without_content_length_reports_no_progress(
        cx: &mut TestAppContext,
    ) {
        cx.background_executor.allow_parking();

        let body = vec![0u8; 20_000];
        let content_length = body.len();

        let client = FakeHttpClient::create(move |_req| {
            let body = body.clone();
            async move { Ok(Response::builder().status(200).body(body.into()).unwrap()) }
        });

        let temp_dir = tempdir().unwrap();
        let target_path = temp_dir.path().join("zed-download");
        let release = ReleaseAsset {
            version: "1.0.0".to_string(),
            url: "https://test.example/download".to_string(),
        };

        let reported = Rc::new(std::cell::RefCell::new(Vec::<Option<f32>>::new()));
        download_release(&target_path, release, client, {
            let reported = reported.clone();
            move |fraction| {
                reported.borrow_mut().push(fraction);
            }
        })
        .await
        .unwrap();

        assert!(
            reported.borrow().is_empty(),
            "progress should not be reported when the total size is unknown, got {:?}",
            reported.borrow()
        );

        let downloaded_len = std::fs::metadata(&target_path).unwrap().len();
        assert_eq!(downloaded_len, content_length as u64);
    }

    #[test]
    fn test_cod_versions_never_downgrade_or_reinstall() {
        let current = Version::new(0, 0, 200);
        assert!(newer_cod_version(&current, Version::new(0, 0, 199)).is_none());
        assert!(newer_cod_version(&current, current.clone()).is_none());
        assert_eq!(
            newer_cod_version(&current, Version::new(0, 0, 201)),
            Some(Version::new(0, 0, 201))
        );
    }

    #[test]
    fn test_bundle_version_requires_monotonic_cod_identity() {
        let directory = tempdir().unwrap();
        let app = directory.path().join("Cod.app");
        std::fs::create_dir_all(app.join("Contents/Resources")).unwrap();
        let version_path = app.join("Contents/Resources/cod-update-version.txt");
        assert!(bundled_update_version(&app).is_err());
        for invalid in ["0.0.1+abc", "1.23.2", "invalid", "0.0.1-beta"] {
            std::fs::write(&version_path, invalid).unwrap();
            assert!(bundled_update_version(&app).is_err(), "{invalid}");
        }
        std::fs::write(&version_path, "0.0.123456\n").unwrap();
        assert_eq!(
            bundled_update_version(&app).unwrap(),
            Version::new(0, 0, 123456)
        );
    }

    #[gpui::test]
    async fn test_checksum_rejects_corruption(cx: &mut TestAppContext) {
        cx.background_executor.allow_parking();
        let directory = tempdir().unwrap();
        let path = directory.path().join("Cod.zip");
        std::fs::write(&path, b"hello").unwrap();
        verify_download(
            &path,
            "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
        )
        .await
        .unwrap();
        std::fs::write(&path, b"corrupted").unwrap();
        assert!(
            verify_download(
                &path,
                "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
            )
            .await
            .is_err()
        );
    }

    #[gpui::test]
    async fn test_release_selection_ignores_drafts_and_legacy_releases(cx: &mut TestAppContext) {
        cx.background_executor.allow_parking();
        let client = FakeHttpClient::create(|request| async move {
            let body = if request.uri().path() == "/repos/cod-editor/cod/releases" {
                serde_json::json!([
                    {"draft":true,"assets":[{"name":"cod-update.json","browser_download_url":"https://github.com/cod-editor/cod/releases/download/draft/cod-update.json"}]},
                    {"draft":false,"assets":[{"name":"Cod.zip","browser_download_url":"https://github.com/cod-editor/cod/releases/download/legacy/Cod.zip"}]},
                    {"draft":false,"assets":[{"name":"cod-update.json","browser_download_url":"https://github.com/cod-editor/cod/releases/download/broken/cod-update.json"}]},
                    {"draft":false,"assets":[{"name":"cod-update.json","browser_download_url":"https://github.com/cod-editor/cod/releases/download/older/cod-update.json"}]},
                    {"draft":false,"assets":[{"name":"cod-update.json","browser_download_url":"https://github.com/cod-editor/cod/releases/download/newer/cod-update.json"}]}
                ])
            } else if request.uri().path().contains("/broken/") {
                serde_json::json!({"invalid":true})
            } else {
                let version = if request.uri().path().contains("/older/") {
                    "0.0.20"
                } else if request.uri().path().contains("/newer/") {
                    "0.0.30"
                } else {
                    panic!("unexpected request: {}", request.uri())
                };
                serde_json::json!({"commit":"a".repeat(40),"version":version,"macos_aarch64":{"url":"https://github.com/cod-editor/cod/releases/download/newer/Cod.zip","sha256":"a".repeat(64)}})
            };
            Ok(Response::builder()
                .status(200)
                .body(body.to_string().into())
                .unwrap())
        });
        let release = fetch_cod_release(Arc::new(HttpClientWithUrl::new(
            client,
            "https://example.com",
            None,
        )))
        .await
        .unwrap();
        assert_eq!(release.version, "0.0.30");
    }
}
