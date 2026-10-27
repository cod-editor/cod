mod dispatcher;
mod headless;
mod keyboard;
mod platform;
mod system_notifications;
#[cfg(any(feature = "wayland", feature = "x11"))]
mod text_system;
#[cfg(feature = "wayland")]
mod wayland;
#[cfg(feature = "x11")]
mod x11;

#[cfg(any(feature = "wayland", feature = "x11"))]
mod xdg_desktop_portal;

pub use dispatcher::*;
pub(crate) use headless::*;
pub(crate) use keyboard::*;
pub(crate) use platform::*;
#[cfg(any(feature = "wayland", feature = "x11"))]
pub(crate) use text_system::*;
#[cfg(feature = "wayland")]
pub(crate) use wayland::*;
#[cfg(feature = "x11")]
pub(crate) use x11::*;

use std::rc::Rc;

/// Returns the default platform implementation for the current OS.
pub fn current_platform(headless: bool) -> Rc<dyn gpui::Platform> {
    #[cfg(feature = "x11")]
    use anyhow::Context as _;

    if headless {
        return Rc::new(LinuxPlatform {
            inner: HeadlessClient::new(),
        });
    }

    match gpui::guess_compositor() {
        #[cfg(feature = "wayland")]
        "Wayland" => Rc::new(LinuxPlatform {
            inner: WaylandClient::new(),
        }),

        #[cfg(feature = "x11")]
        "X11" => Rc::new(LinuxPlatform {
            inner: X11Client::new()
                .context("Failed to initialize X11 client.")
                .unwrap(),
        }),

        "Headless" => Rc::new(LinuxPlatform {
            inner: HeadlessClient::new(),
        }),
        _ => unreachable!(
            r#"At least one of the "wayland" or "x11" features must be enabled on gpui_linux or gpui_platform."#
        ),
    }
}

#[cfg(any(feature = "wayland", feature = "x11"))]
fn file_paths_from_uri_list(uri_list: &str) -> smallvec::SmallVec<[std::path::PathBuf; 2]> {
    uri_list
        .lines()
        .filter(|line| !line.starts_with('#'))
        .filter_map(|line| url::Url::parse(line).ok())
        .filter_map(|url| url.to_file_path().ok())
        .collect()
}

#[cfg(all(test, any(feature = "wayland", feature = "x11")))]
mod uri_list_tests {
    use super::file_paths_from_uri_list;
    use std::path::PathBuf;

    #[test]
    fn ignores_web_links_and_plain_text() {
        assert!(
            file_paths_from_uri_list(
                "https://example.org/article\r\nselected text\r\nrelative/path\r\n"
            )
            .is_empty()
        );
    }

    #[test]
    fn keeps_local_files_in_mixed_uri_list() {
        let paths = file_paths_from_uri_list(
            "# File manager comment\r\n\r\nhttps://example.org/article\r\nfile:///tmp/drag%20file.txt\r\nfile://localhost/tmp/second.txt\r\nfile://remote-host/tmp/remote.txt\r\ninvalid text\r\n",
        );
        assert_eq!(
            paths.as_slice(),
            &[
                PathBuf::from("/tmp/drag file.txt"),
                PathBuf::from("/tmp/second.txt"),
            ]
        );
    }
}
