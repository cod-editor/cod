import { test, expect, type Locator } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { WorkspaceApp } from "./helpers/workspace-app";
import type { AppState } from "../../src/types";

async function square(button: Locator) {
  const box = (await button.boundingBox())!;
  expect(box.width, "An icon button has a nonzero target").toBeGreaterThan(0);
  expect(
    Math.abs(box.width - box.height),
    "The visible button area stays square",
  ).toBeLessThan(0.1);
  return box;
}
for (const scale of [1, 1.5, 2]) {
  test(`Close, unpin and neighboring icon buttons keep square states at display scale ${scale}`, async ({}, info) => {
    const app = new WorkspaceApp();
    await app.prepare();
    app.launchArguments = [`--force-device-scale-factor=${scale}`];
    try {
      await app.start();
      const workspace = await app.create("Icon controls");
      const initial = (await app.cli<AppState>("state")).workspaces.find(
        (w) => w.id === workspace,
      )!;
      const chatGroup = initial.groups![0].id;
      const short = await app.cli<{ paneId: string }>(
        "file",
        "open",
        "--workspace",
        workspace,
        "--path",
        app.file,
      );
      const longName =
        "An intentionally long document name that is clipped inside an ordinary tab.md";
      const file = path.join(app.folders[0], longName);
      await writeFile(file, "# Invented layout fixture\n");
      const pinned = await app.cli<{ paneId: string }>(
        "file",
        "open",
        "--workspace",
        workspace,
        "--path",
        file,
      );
      await app.cli(
        "pane",
        "pin",
        "--workspace",
        workspace,
        "--id",
        pinned.paneId,
        "--pinned",
        "true",
      );
      const current = (await app.cli<AppState>("state")).workspaces.find(
        (w) => w.id === workspace,
      )!;
      const group = current.groups!.find((g) =>
        g.paneIds.includes(short.paneId),
      )!.id;
      for (let i = 0; i < 3; i++)
        await app.cli(
          "pane",
          "new",
          "--workspace",
          workspace,
          "--group",
          group,
        );
      await app.cli(
        "group",
        "visibility",
        "--workspace",
        workspace,
        "--id",
        chatGroup,
        "--hidden",
        "true",
      );
      const tab = (id: string) =>
        app.page.locator(`[role=tab][data-tab-id="${id}"]`);
      const close = tab(short.paneId).getByRole("button", {
        name: "Close spec.md",
        exact: true,
      });
      const unpin = tab(pinned.paneId).getByRole("button", {
        name: `Unpin ${longName}`,
        exact: true,
      });
      const bar = app.page.locator(
        `.tab-group[data-group-id="${group}"] .tab-bar`,
      );
      const split = app.page.getByRole("button", {
        name: "Toggle split view",
        exact: true,
      });
      await expect(split).toHaveAttribute("aria-pressed", "false");
      for (const fontSize of [14, 22]) {
        await app.cli(
          "settings",
          "update",
          "--values",
          JSON.stringify({ "ui.fontSize": fontSize }),
        );
        await expect(app.page.locator("html")).toHaveCSS(
          "font-size",
          `${fontSize}px`,
        );
        for (const width of [1280, 760]) {
          await app.app!.evaluate(
            ({ BrowserWindow }, width) =>
              BrowserWindow.getAllWindows()[0].setSize(width, 800),
            width,
          );
          for (const button of [close, unpin]) {
            await button.scrollIntoViewIfNeeded();
            const normal = await square(button);
            expect(normal.width).toBe(20);
            await button.hover();
            await expect(button).not.toHaveCSS(
              "background-color",
              "rgba(0, 0, 0, 0)",
            );
            await square(button);
            const hoverBackground = await button.evaluate(
              (node) => getComputedStyle(node).backgroundColor,
            );
            await app.page.mouse.down();
            await expect(button).not.toHaveCSS(
              "background-color",
              hoverBackground,
            );
            await square(button);
            await app.page.mouse.move(30, 30);
            await app.page.mouse.up();
            await app.page.keyboard.press("Tab");
            await button.focus();
            await expect(button).toBeFocused();
            await expect(button).toHaveCSS("outline-style", "solid");
            await square(button);
          }
          for (const button of [
            bar.getByRole("button", {
              name: "Choose new tab type",
              exact: true,
            }),
            split,
          ]) {
            const normal = await square(button);
            expect(normal.width).toBe(28);
            const background = await button.evaluate(
              (b) => getComputedStyle(b).backgroundColor,
            );
            await button.hover();
            await square(button);
            if (await button.isDisabled())
              await expect(button).toHaveCSS("background-color", background);
          }
          await unpin.scrollIntoViewIfNeeded();
          await unpin.hover();
          await app.page.screenshot({
            path: info.outputPath(`icon-states-${width}-${fontSize}.png`),
          });
        }
      }
      await unpin.scrollIntoViewIfNeeded();
      await app.page.keyboard.press("Tab");
      await unpin.focus();
      await unpin.press("Enter");
      await expect(tab(pinned.paneId)).toHaveAttribute("data-pinned", "false");
      await close.scrollIntoViewIfNeeded();
      await close.focus();
      await close.press("Enter");
      await expect(tab(short.paneId)).toHaveCount(0);
      await expect(tab(pinned.paneId)).toBeVisible();
    } finally {
      await app.cleanup();
    }
  });
}
