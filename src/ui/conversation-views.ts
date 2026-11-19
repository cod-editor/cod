import { backgroundActivity } from "./background-activity";
import { webLinkMenu } from "./web-links";
import { actionRow, uiButton } from "./primitives";
import { showActionError } from "./action-feedback";
import { permissionContent } from "./permission-content";
import {
  groupTurnActivity,
  toolCaption,
  compactToolCaption,
} from "./turn-activity";
import {
  routeProviderCommand,
  showProviderCommands,
} from "./provider-commands";
import { createIntegrationSetup } from "./integration";
import { reconcileView } from "./view-reconcile";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { structuredMessageLabel } from "./message-label";
import { icon, iconButton, menu } from "./controls";
import type { AppState, PaneState, WorkspaceState } from "../types";
import type { Invoke } from "./contracts";
function setChoiceCaption(button: HTMLButtonElement, text: string): void {
  let label = button.querySelector<HTMLSpanElement>(".choice-caption");
  if (!label) {
    label = document.createElement("span");
    label.className = "choice-caption";
    const arrow = icon("chevron");
    arrow.classList.add("choice-chevron");
    button.append(label, arrow);
  }
  label.textContent = text;
}
interface ChatDependencies {
  getState: () => AppState;
  invoke: Invoke;
  host: HTMLElement;
  invalidate: () => void;
  report: (message: string) => void;
  openReference: (workspace: string, reference: string) => Promise<void>;
  actionButton: (
    label: string,
    action: () => Promise<unknown>,
  ) => HTMLButtonElement;
}
export function createConversationViews({
  getState,
  invoke,
  host: panes,
  invalidate,
  report: setStatus,
  openReference,
  actionButton: paneButton,
}: ChatDependencies) {
  const composerDrafts = new Map<string, string>();
  const skillDrafts = new Map<string, Array<{ name: string; path: string }>>();
  function selectedSkills(key: string) {
    const names = new Set(
      (composerDrafts.get(key) ?? "").match(/\$[\w.-]+/g) ?? [],
    );
    const skills = (skillDrafts.get(key) ?? []).filter((skill) =>
      names.has(`$${skill.name}`),
    );
    skillDrafts.set(key, skills);
    return skills;
  }
  const queueEdits = new Map<string, string>();
  const pendingSends = new Set<string>();
  const pendingStarts = new Set<string>();
  const loadingImages = new Set<string>();
  const sendErrors = new Map<string, string>();
  const expandedTools = new Set<string>();
  const integration = createIntegrationSetup(invoke, invalidate);
  function providerLabel(provider: string): string {
    return provider === "codex"
      ? "Codex"
      : provider === "kimi"
        ? "Kimi"
        : "Claude Code";
  }
  const hydratedComposers = new Set<string>();
  type ComposerDraft = NonNullable<WorkspaceState["chatDrafts"]>[string];
  const writer = crypto.randomUUID();
  const versions = new Map<string, string>();
  const seenVersions = new Map<string, string>();
  const dirtyComposers = new Set<string>();
  const composerConflicts = new Map<string, ComposerDraft>();
  const saves = new Map<
    string,
    { again: boolean; textOnly: boolean; promise: Promise<void> }
  >();
  function acceptDraft(key: string, paneId: string, draft: ComposerDraft) {
    versions.set(key, draft.version ?? "");
    composerDrafts.set(key, draft.text);
    skillDrafts.set(key, draft.skills ?? []);
    attachmentDrafts.set(key, draft.images ?? []);
    if (draft.provider) draftProviders.set(paneId, draft.provider);
    else draftProviders.delete(paneId);
    dirtyComposers.delete(key);
    composerConflicts.delete(key);
  }
  function draftConflict(key: string, paneId: string): HTMLElement | undefined {
    if (!composerConflicts.has(key)) return;
    const panel = document.createElement("section");
    panel.className = "conversation-status";
    panel.setAttribute("aria-label", "Draft conflict");
    const message = document.createElement("p");
    message.textContent =
      "This unsent message has another saved version. Your text is preserved; choose which version to keep.";
    const keep = uiButton("Keep my message");
    keep.onclick = async () => {
      await saves.get(key)?.promise;
      const remote = composerConflicts.get(key);
      if (!remote) return;
      versions.set(key, remote.version ?? "");
      composerConflicts.delete(key);
      void persistComposer(key).then(invalidate);
    };
    const use = uiButton("Use saved version");
    use.onclick = async () => {
      await saves.get(key)?.promise;
      const remote = composerConflicts.get(key);
      if (!remote) return;
      acceptDraft(key, paneId, remote);
      await persistComposer(key);
      invalidate();
    };
    panel.append(message, actionRow(keep, use));
    return panel;
  }
  function persistComposer(key: string, textOnly = false): Promise<void> {
    dirtyComposers.add(key);
    const pending = saves.get(key);
    if (pending) {
      pending.again = true;
      pending.textOnly &&= textOnly;
      return pending.promise;
    }
    const entry = { again: true, textOnly, promise: Promise.resolve() };
    saves.set(key, entry);
    entry.promise = (async () => {
      while (entry.again) {
        const conversation = getState().conversations.find((c) => c.id === key);
        const paneId = conversation?.paneId ?? key;
        const workspace = getState().workspaces.find((w) =>
          w.panes.some((p) => p.id === paneId),
        );
        if (!workspace) return;
        const onlyText = entry.textOnly;
        entry.again = false;
        entry.textOnly = true;
        const result = await invoke<{
          version?: string;
          conflict?: boolean;
          conflictSaved?: boolean;
          draft?: ComposerDraft;
        }>(
          "conversation.composer",
          {
            workspace: workspace.id,
            paneId,
            text: composerDrafts.get(key) ?? "",
            ...(onlyText ? {} : { images: attachmentDrafts.get(key) ?? [] }),
            skills: selectedSkills(key),
            ...(draftProviders.has(paneId)
              ? { provider: draftProviders.get(paneId) }
              : {}),
            expectedVersion: versions.get(key) ?? "",
            saveConflict: composerConflicts.has(key),
            writer,
          },
          { reportError: false },
        );
        if (result.conflict && result.draft) {
          composerConflicts.set(key, result.draft);
          invalidate();
          entry.again = true;
          entry.textOnly = false;
          continue;
        }
        if (!composerConflicts.has(key))
          versions.set(key, result.version ?? "");
        if (!entry.again) dirtyComposers.delete(key);
      }
    })()
      .catch(() => {
        setStatus(
          "Could not save this unsent message. Keep Cod open and try again.",
        );
      })
      .finally(() => saves.delete(key));
    return entry.promise;
  }

  const draftProviders = new Map<string, string>();
  function renderDraftChat(
    workspace: WorkspaceState,
    pane: PaneState,
  ): HTMLElement {
    const body = document.createElement("div");
    body.className = "pane-body chat-body";
    const transcript = document.createElement("div");
    transcript.className = "transcript";
    body.append(transcript);
    const setup = integration.offer(draftProviders.get(pane.id) ?? "codex");
    if (setup) transcript.append(setup);
    const composer = document.createElement("div");
    composer.className = "composer";
    const input = document.createElement("textarea");
    input.setAttribute("aria-label", "Message");
    const selected = draftProviders.get(pane.id) ?? "codex";
    input.placeholder = `Message ${providerLabel(selected)}...`;
    input.value = composerDrafts.get(pane.id) ?? "";
    input.oninput = () => {
      composerDrafts.set(pane.id, input.value);
      persistComposer(pane.id, true);
    };
    input.disabled = pendingStarts.has(pane.id);
    const feedback = document.createElement("div");
    feedback.className = "conversation-status";
    feedback.setAttribute("role", "status");
    feedback.textContent =
      sendErrors.get(pane.id) ??
      (pendingStarts.has(pane.id)
        ? `Starting ${providerLabel(selected)}...`
        : "");
    feedback.hidden = !feedback.textContent;
    body.append(feedback);
    const send = async () => {
      if (loadingImages.has(pane.id)) {
        setStatus("Wait for the image to finish loading");
        return;
      }
      await saves.get(pane.id)?.promise;
      if (composerConflicts.has(pane.id) || dirtyComposers.has(pane.id)) {
        setStatus("Resolve or save this unsent message before sending.");
        return;
      }
      const text = input.value;
      const images = attachmentDrafts.get(pane.id) ?? [];
      if ((!text.trim() && !images.length) || pendingStarts.has(pane.id))
        return;
      pendingStarts.add(pane.id);
      sendErrors.delete(pane.id);
      input.disabled = true;
      invalidate();
      try {
        const result = await invoke<import("../types").ConversationState>(
          "conversation.start",
          {
            workspace: workspace.id,
            paneId: pane.id,
            provider: draftProviders.get(pane.id) ?? "codex",
          },
          { reportError: false },
        );
        composerDrafts.set(result.id, text);
        attachmentDrafts.set(result.id, images);
        skillDrafts.set(result.id, selectedSkills(pane.id));
        await sendMessage(result.id);
        composerDrafts.delete(pane.id);
        attachmentDrafts.delete(pane.id);
        skillDrafts.delete(pane.id);
      } catch (error) {
        sendErrors.set(
          pane.id,
          `Could not start ${providerLabel(draftProviders.get(pane.id) ?? "codex")}: ${error instanceof Error ? error.message : String(error)}`,
        );
      } finally {
        pendingStarts.delete(pane.id);
        invalidate();
      }
    };
    input.addEventListener("cod:send-message", () => void send());
    composer.oncontextmenu = (e) => {
      if (e.target === input) return;
      e.preventDefault();
      menu({ x: e.clientX, y: e.clientY }, [
        { label: "Send message", run: () => void send() },
      ]);
    };
    const actions = document.createElement("div");
    actions.className = "composer-actions";
    const provider = document.createElement("button");
    provider.type = "button";
    provider.setAttribute("aria-label", "Provider");
    provider.className = "composer-choice";
    provider.setAttribute("aria-haspopup", "dialog");
    setChoiceCaption(provider, providerLabel(selected));
    provider.onclick = () =>
      menu(
        provider,
        ["codex", "kimi", "claude"].map((id) => ({
          label: providerLabel(id) + (id === "claude" ? " (unavailable)" : ""),
          disabled: id === "claude",
          selected: id === (draftProviders.get(pane.id) ?? "codex"),
          run: () => {
            draftProviders.set(pane.id, id);
            void persistComposer(pane.id);
            setChoiceCaption(provider, providerLabel(id));
            input.placeholder = `Message ${providerLabel(id)}...`;
            invalidate();
          },
        })),
      );
    actions.append(provider);
    composer.append(input, actions);
    bindImages(composer, input, pane.id);
    const conflict = draftConflict(pane.id, pane.id);
    if (conflict) body.append(conflict);
    body.append(composer);
    return body;
  }

  const artifactImages = new Map<string, Promise<ChatImage>>();
  function appendChatReferences(
    target: HTMLElement,
    source: string,
    workspace: string,
    messageId: string,
    conversationId: string,
  ): void {
    target.classList.add("markdown-message");
    const imageReferences = new Set<string>();
    source = source.replace(
      /!\[([^\]]*)\]\(([^)]+)\)/g,
      (_match, label: string, reference: string) => {
        if (!/^[a-z]+:/i.test(reference) || reference.startsWith("file:"))
          imageReferences.add(reference);
        return `[${label || reference}](${reference})`;
      },
    );
    target.innerHTML = DOMPurify.sanitize(
      marked.parse(source, { async: false }) as string,
      {
        FORBID_TAGS: ["img", "iframe", "style", "form", "input", "button"],
        FORBID_ATTR: ["style"],
      },
    );
    let occurrence = 0;
    const link = (element: HTMLElement, reference: string) => {
      element.dataset.focusKey = JSON.stringify([
        "reference",
        messageId,
        occurrence++,
        reference,
      ]);
      element.oncontextmenu = (event) => {
        const owner =
          getState().conversations.find((item) => item.id === conversationId)
            ?.workspaceId ?? workspace;
        if (
          webLinkMenu(
            { x: event.clientX, y: event.clientY },
            reference,
            owner,
            invoke,
          )
        )
          event.preventDefault();
      };
      element.onclick = (event) => {
        event.preventDefault();
        const owner =
          getState().conversations.find(
            (conversation) => conversation.id === conversationId,
          )?.workspaceId ?? workspace;
        if (/^https?:\/\//.test(reference))
          void invoke("browser.open", {
            workspace: owner,
            url: reference,
          }).catch(() => undefined);
        else if (!/^[a-z]+:/i.test(reference))
          void openReference(owner, reference).catch(() => undefined);
      };
    };
    for (const anchor of target.querySelectorAll<HTMLAnchorElement>("a")) {
      const reference = anchor.getAttribute("href") ?? "";
      link(anchor, reference);
      if (imageReferences.has(reference) && !/^file:/i.test(reference)) {
        const key = JSON.stringify([workspace, messageId, reference]);
        let image = artifactImages.get(key);
        if (!image) {
          image = invoke<ChatImage>(
            "file.image",
            { workspace, path: reference },
            { reportError: false },
          );
          artifactImages.set(key, image);
          if (artifactImages.size > 30)
            artifactImages.delete(artifactImages.keys().next().value!);
        }
        void image
          .then((value) => {
            if (anchor.isConnected) anchor.replaceWith(imageStrip([value]));
          })
          .catch(() => {
            anchor.title = "Image unavailable; open file reference";
          });
      }
    }
    for (const code of target.querySelectorAll<HTMLElement>("code")) {
      if (code.closest("pre")) continue;
      const reference = code.textContent ?? "";
      if (!/^[a-z]+:/i.test(reference) && /[./\\]/.test(reference)) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "file-reference";
        button.textContent = reference;
        link(button, reference);
        code.replaceWith(button);
      }
    }
  }

  type ChatImage = import("../providers/types").ImageAttachment;
  const attachmentDrafts = new Map<string, ChatImage[]>();
  const providerOptions = new Map<
    string,
    import("../providers/types").ProviderOptions
  >();
  const optionsLoading = new Set<string>();
  const pendingOptions = new Map<string, string>();
  function imageStrip(
    images: ChatImage[],
    remove?: (index: number) => void,
  ): HTMLElement {
    const strip = document.createElement("div");
    strip.className = remove ? "composer-images" : "message-images";
    images.forEach((image, index) => {
      const item = document.createElement("div");
      const img = document.createElement("img");
      img.src = `data:${image.mimeType};base64,${image.data}`;
      img.alt = image.name || "Attached image";
      const preview = document.createElement("button");
      preview.type = "button";
      preview.className = "image-preview";
      preview.setAttribute("aria-label", `View ${img.alt}`);
      preview.onclick = () => {
        const dialog = document.createElement("dialog");
        dialog.className = "image-viewer";
        const large = img.cloneNode() as HTMLImageElement;
        const close = () => {
          dialog.close();
          if (preview.isConnected) preview.focus();
        };
        dialog.addEventListener("cancel", (event) => {
          event.preventDefault();
          close();
        });
        dialog.append(large, iconButton("close", "Close image", close));
        document.body.append(dialog);
        dialog.onclose = () => {
          const restore =
            dialog.contains(document.activeElement) ||
            document.activeElement === document.body;
          dialog.remove();
          if (restore && preview.isConnected) preview.focus();
        };
        dialog.showModal();
      };
      const caption = document.createElement("span");
      caption.className = "image-reference";
      caption.textContent = `[Image ${image.reference ?? index + 1}]`;
      preview.append(img, caption);
      item.append(preview);
      if (remove) {
        const close = iconButton("close", "Remove image", () => remove(index));
        close.classList.add("compact");
        item.append(close);
      }
      strip.append(item);
    });
    return strip;
  }
  function bindImages(
    composer: HTMLElement,
    input: HTMLTextAreaElement,
    key: string,
  ): void {
    const refresh = () => {
      composer.querySelector(".composer-images")?.remove();
      const images = attachmentDrafts.get(key) ?? [];
      if (images.length)
        composer.prepend(
          imageStrip(images, (index) => {
            const marker = `[Image ${images[index].reference ?? index + 1}]`;
            const position = input.value.indexOf(marker);
            if (position >= 0)
              input.setRangeText(
                "",
                position,
                position + marker.length,
                "preserve",
              );
            composerDrafts.set(key, input.value);
            images.splice(index, 1);
            attachmentDrafts.set(key, images);
            persistComposer(key);
            refresh();
          }),
        );
    };
    const add = async (files: File[]) => {
      if (loadingImages.has(key)) {
        setStatus("Wait for the image to finish loading");
        return;
      }
      loadingImages.add(key);
      let unfinishedMarker: string | undefined;
      try {
        const images = attachmentDrafts.get(key) ?? [];
        attachmentDrafts.set(key, images);
        for (const file of files) {
          if (
            !["image/png", "image/jpeg", "image/webp", "image/gif"].includes(
              file.type,
            )
          )
            continue;
          if (
            images.length >= 8 ||
            images.reduce(
              (total, image) => total + Math.ceil((image.data.length * 3) / 4),
              0,
            ) +
              file.size >
              20 * 1024 * 1024
          ) {
            setStatus("Use at most 8 images, up to 20 MB total");
            break;
          }
          const reference =
            Math.max(
              0,
              ...images.map((image, index) => image.reference ?? index + 1),
              ...[...input.value.matchAll(/\[Image (\d+)\]/g)].map((match) =>
                Number(match[1]),
              ),
            ) + 1;
          const marker = `[Image ${reference}]`;
          unfinishedMarker = marker;
          input.setRangeText(
            marker,
            input.selectionStart,
            input.selectionEnd,
            "end",
          );
          composerDrafts.set(key, input.value);
          const data = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result).split(",")[1]);
            reader.onerror = reject;
            reader.readAsDataURL(file);
          });
          images.push({
            reference,
            mimeType: file.type as ChatImage["mimeType"],
            data,
            name: file.name,
          });
          unfinishedMarker = undefined;
        }
        attachmentDrafts.set(key, images);
        await persistComposer(key);
        refresh();
      } catch (error) {
        if (unfinishedMarker) {
          input.value = input.value.replace(unfinishedMarker, "");
          composerDrafts.set(key, input.value);
        }
        await persistComposer(key);
        refresh();
        setStatus(`Could not attach image: ${String(error)}`);
      } finally {
        loadingImages.delete(key);
      }
    };
    input.addEventListener("paste", (e) => {
      const files = [...(e.clipboardData?.files ?? [])];
      if (files.some((f) => f.type.startsWith("image/"))) {
        e.preventDefault();
        void add(files);
      }
    });
    composer.ondragover = (e) => {
      if (e.dataTransfer?.types.includes("Files")) e.preventDefault();
    };
    composer.ondrop = (e) => {
      e.preventDefault();
      void add([...(e.dataTransfer?.files ?? [])]);
    };
    refresh();
  }
  function modelChoices(
    conversation: import("../types").ConversationState,
  ): HTMLElement {
    const host = document.createElement("span");
    host.className = "model-choices";
    host.dataset.conversationId = conversation.id;
    const options = providerOptions.get(conversation.id);
    if (
      !options &&
      !optionsLoading.has(conversation.id) &&
      conversation.status === "ready" &&
      !conversation.handoffTerminalId
    ) {
      optionsLoading.add(conversation.id);
      void invoke<import("../providers/types").ProviderOptions>(
        "conversation.options",
        { id: conversation.id },
        { reportError: false },
      )
        .then((result) => {
          providerOptions.set(conversation.id, result);
          for (const current of panes.querySelectorAll<HTMLElement>(
            `.model-choices[data-conversation-id="${conversation.id}"]`,
          ))
            reconcileView(
              current,
              modelChoices(
                getState().conversations.find(
                  (c) => c.id === conversation.id,
                ) ?? conversation,
              ),
            );
        })
        .catch(() => undefined)
        .finally(() => optionsLoading.delete(conversation.id));
    }
    if (options)
      for (const [option, choices] of [
        ["model", options.models],
        ["reasoning", options.reasoning],
      ] as const) {
        if (!choices.length) continue;
        const choiceLabel = (choice: { value: string; label: string }) =>
          option === "reasoning"
            ? ((
                {
                  xhigh: "Extra high",
                  minimal: "Minimal",
                  low: "Low",
                  medium: "Medium",
                  high: "High",
                  none: "None",
                  max: "Max",
                } as Record<string, string>
              )[choice.value] ??
              choice.value
                .replace(/[_-]/g, " ")
                .replace(/^./, (c) => c.toUpperCase()))
            : choice.label.split(/\n| — /)[0];
        const optionKey = `${conversation.id}:${option}`;
        const value =
          pendingOptions.get(optionKey) ??
          options.pending?.[option] ??
          options.current[option] ??
          choices[0].value;
        const button = document.createElement("button");
        button.type = "button";
        button.className = "composer-choice";
        button.dataset.focusKey = `option:${optionKey}`;
        button.setAttribute(
          "aria-label",
          option === "model" ? "Model" : "Reasoning effort",
        );
        button.setAttribute("aria-haspopup", "dialog");
        setChoiceCaption(
          button,
          choiceLabel(
            choices.find((choice) => choice.value === value) ?? choices[0],
          ),
        );
        button.disabled = conversation.status !== "ready";
        button.setAttribute("aria-busy", String(pendingOptions.has(optionKey)));
        button.onclick = () => {
          if (pendingOptions.has(optionKey)) return;
          const latest = providerOptions.get(conversation.id);
          if (
            !latest ||
            getState().conversations.find((c) => c.id === conversation.id)
              ?.status !== "ready"
          )
            return;
          const currentValue =
            latest.pending?.[option] ?? latest.current[option];
          const currentChoices =
            option === "model" ? latest.models : latest.reasoning;
          menu(
            button,
            currentChoices.map((choice) => ({
              label: choiceLabel(choice),
              selected: choice.value === currentValue,
              run: () => {
                button.focus({ preventScroll: true });
                if (
                  choice.value === currentValue ||
                  pendingOptions.has(optionKey)
                )
                  return;
                pendingOptions.set(optionKey, choice.value);
                setChoiceCaption(button, choiceLabel(choice));
                button.setAttribute("aria-busy", "true");
                void invoke<import("../providers/types").ProviderOptions>(
                  "conversation.option",
                  { id: conversation.id, option, value: choice.value },
                  { reportError: false },
                )
                  .then((result) =>
                    providerOptions.set(conversation.id, result),
                  )
                  .catch((error) =>
                    showActionError(error, button.closest(".composer") ?? host),
                  )
                  .finally(() => {
                    pendingOptions.delete(optionKey);
                    const current =
                      button.closest<HTMLElement>(".model-choices");
                    if (current)
                      reconcileView(
                        current,
                        modelChoices(
                          getState().conversations.find(
                            (c) => c.id === conversation.id,
                          ) ?? conversation,
                        ),
                      );
                  });
              },
            })),
          );
        };
        host.append(button);
      }
    return host;
  }

  const historyCounts = new Map<string, number>();
  function recentCount(
    entries: Array<{ type: "message" | "tool"; message?: { text: string } }>,
  ): number {
    let characters = 0,
      count = 0;
    for (let index = entries.length - 1; index >= 0 && count < 60; index--) {
      const size = entries[index].message?.text.length ?? 0;
      if (count && characters + size > 256 * 1024) break;
      characters += size;
      count++;
    }
    return count;
  }

  function renderConversation(
    conversation: import("../types").ConversationState,
  ): HTMLElement {
    const body = document.createElement("div");
    body.className = "pane-body chat-body";
    const transcript = document.createElement("div");
    transcript.className = "transcript";
    transcript.setAttribute("role", "region");
    transcript.setAttribute("aria-label", "Conversation transcript");
    transcript.tabIndex = 0;
    const timeline = [
      ...conversation.messages.map((message) => ({
        type: "message" as const,
        order: message.order,
        message,
      })),
      ...conversation.tools.map((tool) => ({
        type: "tool" as const,
        order: tool.order,
        tool,
      })),
    ].sort((a, b) => a.order - b.order);
    const count = Math.max(
      historyCounts.get(conversation.id) ?? 0,
      recentCount(timeline),
    );
    historyCounts.set(conversation.id, count);
    const start = Math.max(0, timeline.length - count);
    const earlier = (all = false) => {
      const current = getState().conversations.find(
        (item) => item.id === conversation.id,
      );
      if (!current) return;
      const entries = [
        ...current.messages.map((message) => ({
          type: "message" as const,
          order: message.order,
          message,
        })),
        ...current.tools.map((tool) => ({
          type: "tool" as const,
          order: tool.order,
        })),
      ].sort((a, b) => a.order - b.order);
      const previous =
        historyCounts.get(conversation.id) ?? recentCount(entries);
      if (previous >= entries.length) return;
      const old = views
        .get("chat:" + conversation.id)
        ?.querySelector<HTMLElement>(".transcript");
      const height = old?.scrollHeight ?? 0;
      const top = old?.scrollTop ?? 0;
      const prefix = entries.slice(0, Math.max(0, entries.length - previous));
      historyCounts.set(
        conversation.id,
        all ? entries.length : previous + recentCount(prefix),
      );
      invalidate();
      if (!all && old)
        requestAnimationFrame(() => {
          old.scrollTop = top + old.scrollHeight - height;
        });
    };
    transcript.onscroll = (event) => {
      if ((event.currentTarget as HTMLElement).scrollTop < 100) earlier();
    };
    transcript.addEventListener("cod:show-complete-history", () =>
      earlier(true),
    );
    if (start) {
      const button = uiButton("Earlier messages", "quiet");
      button.onclick = () => earlier();
      button.dataset.historyNavigation = "true";
      transcript.append(button);
    }
    for (const entry of timeline.slice(start)) {
      if (entry.type === "message") {
        if (
          entry.message.role === "system" &&
          conversation.error &&
          entry.message.text.includes(conversation.error)
        )
          continue;
        const row = document.createElement("div");
        row.className = `chat-message ${entry.message.role}`;
        row.dataset.messageId = entry.message.id;
        if (entry.message.turnId) row.dataset.turnId = entry.message.turnId;
        if (entry.message.phase) row.dataset.phase = entry.message.phase;
        if (entry.message.interactive) row.dataset.actionRequired = "true";
        const role = document.createElement("div");
        role.className = "message-role";
        role.textContent =
          entry.message.role === "assistant"
            ? providerLabel(conversation.provider)
            : entry.message.role;
        const text = document.createElement("div");
        text.className = "message-text";
        const structured = structuredMessageLabel(
          entry.message.text,
          getState(),
        );
        if (structured) {
          const details = document.createElement("details");
          details.className = "structured-message";
          const label = document.createElement("summary");
          label.textContent = structured;
          const payload = document.createElement("pre");
          payload.textContent = JSON.stringify(
            JSON.parse(entry.message.text),
            null,
            2,
          );
          details.append(label, payload);
          text.append(details);
        } else
          appendChatReferences(
            text,
            entry.message.text,
            conversation.workspaceId,
            entry.message.id,
            conversation.id,
          );
        if (entry.message.role === "system") row.append(role);
        row.append(text);
        if (entry.message.images?.length)
          row.append(imageStrip(entry.message.images));
        transcript.append(row);
      } else {
        const tool = document.createElement("details");
        tool.className = "tool-activity";
        tool.dataset.toolId = entry.tool.id;
        if (entry.tool.turnId) tool.dataset.turnId = entry.tool.turnId;
        const label = document.createElement("summary");
        const info = entry.tool.details as Record<string, unknown> | null;
        tool.dataset.toolPhase = entry.tool.phase;
        tool.dataset.compactCaption = compactToolCaption(info);
        const failed = !!(
          info?.error ||
          info?.isError ||
          ["failed", "error"].includes(String(info?.status))
        );
        label.textContent =
          compactToolCaption(info) + (failed ? " · failed" : "");
        label.title = toolCaption(info);
        const actionable = /request.?user.?input|ask.?user|question/i.test(
          String(info?.name ?? info?.toolName ?? ""),
        );
        if (actionable) {
          tool.dataset.actionRequired = "true";
        }
        const expansionKey = `${conversation.id}:${entry.tool.id}`;
        tool.open = actionable || expandedTools.has(expansionKey);
        tool.append(label);
        if (tool.open) {
          const details = document.createElement("pre");
          details.textContent =
            JSON.stringify(entry.tool.details, null, 2) ??
            String(entry.tool.details);
          tool.append(details);
        }
        tool.ontoggle = (event) => {
          const current = event.currentTarget as HTMLDetailsElement;
          if (!current.isConnected || actionable) return;
          if (current.open === expandedTools.has(expansionKey)) return;
          if (current.open) expandedTools.add(expansionKey);
          else expandedTools.delete(expansionKey);
          invalidate();
        };
        transcript.append(tool);
      }
    }
    groupTurnActivity(transcript, conversation);
    const setup = integration.offer(conversation.provider);
    if (setup && !conversation.messages.length && !conversation.error)
      transcript.append(setup);
    body.append(transcript);
    if (conversation.historyPartial) {
      const warning = document.createElement("div");
      warning.className = "history-warning";
      warning.textContent = "Earlier messages are not shown";
      transcript.prepend(warning);
    }
    for (const permission of conversation.pendingPermissions) {
      const card = document.createElement("div");
      card.className = "permission-card";
      card.dataset.focusKey = `permission-card:${permission.id}`;
      const title = document.createElement("div");
      title.className = "permission-title";
      title.textContent = "Approval requested";
      card.append(title);
      card.append(permissionContent(permission.details));
      for (const option of permission.options) {
        const permissionButton = paneButton(option.label, () =>
          invoke("conversation.permission", {
            id: conversation.id,
            requestId: permission.id,
            optionId: option.id,
          }),
        );
        permissionButton.dataset.focusKey = JSON.stringify([
          "permission",
          permission.id,
          option.id,
        ]);
        card.append(permissionButton);
      }
      body.append(card);
    }
    const currentStatus = document.createElement("div");
    currentStatus.className = "conversation-status";
    currentStatus.setAttribute("role", "status");
    currentStatus.setAttribute("aria-label", "Conversation status");
    currentStatus.textContent =
      sendErrors.get(conversation.id) ??
      (conversation.error
        ? `Provider failed: ${conversation.error}`
        : conversation.status === "starting"
          ? `Starting ${providerLabel(conversation.provider)}...`
          : "");
    if (conversation.handoffTerminalId)
      currentStatus.textContent =
        "Open in the CLI terminal. Exit the CLI before returning to chat.";
    currentStatus.hidden = !currentStatus.textContent;
    body.append(currentStatus);

    const waiting = (conversation.queuedMessages ?? []).filter(
      (m) => m.status !== "sending",
    );
    if (waiting.length) {
      const queue = document.createElement("section");
      queue.className = "message-queue";
      queue.setAttribute("aria-label", "Queued messages");
      const heading = document.createElement("div");
      heading.className = "queue-heading";
      heading.textContent = conversation.queuePaused
        ? "Queue paused"
        : "Queued";
      queue.append(heading);
      if (
        conversation.queuePaused &&
        waiting.every((m) => m.status === "queued")
      ) {
        const resume = paneButton("Continue queue", () =>
          invoke("conversation.queue-resume", { id: conversation.id }),
        );
        resume.classList.add("quiet");
        queue.append(resume);
      }
      for (const message of waiting) {
        const row = document.createElement("div");
        row.className = "queued-message";
        row.dataset.focusKey = `queued:${message.id}`;
        if (message.editing && !queueEdits.has(message.id))
          queueEdits.set(message.id, message.text);
        if (queueEdits.has(message.id)) {
          const field = document.createElement("textarea");
          field.setAttribute("aria-label", "Edit queued message");
          field.value = queueEdits.get(message.id)!;
          field.oninput = () => queueEdits.set(message.id, field.value);
          const save = paneButton("Save", async () => {
            await invoke("conversation.queue-edit", {
              id: conversation.id,
              messageId: message.id,
              text: queueEdits.get(message.id),
            });
            queueEdits.delete(message.id);
            invalidate();
          });
          const cancel = paneButton("Cancel", async () => {
            await invoke("conversation.queue-edit", {
              id: conversation.id,
              messageId: message.id,
            });
            queueEdits.delete(message.id);
            invalidate();
          });
          cancel.classList.add("quiet");
          field.onkeydown = (event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              cancel.click();
            }
          };
          row.append(field, actionRow(cancel, save));
        } else {
          const preview = document.createElement("div");
          preview.className = "queued-message-text";
          preview.textContent = message.text || "Image attachment";
          row.append(preview);
          if (message.images?.length) row.append(imageStrip(message.images));
          const actions = actionRow();
          if (message.status === "queued") {
            const edit = paneButton("Edit", async () => {
              await invoke("conversation.queue-edit", {
                id: conversation.id,
                messageId: message.id,
                editing: true,
              });
              queueEdits.set(message.id, message.text);
              invalidate();
              requestAnimationFrame(() => {
                const field = panes.querySelector<HTMLTextAreaElement>(
                  `[data-focus-key="queued:${message.id}"] textarea`,
                );
                field?.focus();
              });
            });
            edit.classList.add("quiet");
            edit.setAttribute("aria-label", "Edit queued message");
            actions.append(edit);
          } else {
            const warning = document.createElement("span");
            warning.textContent =
              "Delivery uncertain. Check the conversation before resending.";
            row.append(warning);
          }
          const remove = paneButton(
            message.status === "uncertain" ? "Dismiss" : "Cancel",
            () =>
              invoke("conversation.queue-remove", {
                id: conversation.id,
                messageId: message.id,
              }),
          );
          remove.classList.add("quiet");
          remove.setAttribute("aria-label", "Cancel queued message");
          actions.append(remove);
          row.append(actions);
        }
        queue.append(row);
      }
      body.append(queue);
    }

    const composer = document.createElement("div");
    composer.className = "composer";
    const input = document.createElement("textarea");
    input.setAttribute("aria-label", "Message");
    input.placeholder = `Message ${providerLabel(conversation.provider)}...`;
    input.value = composerDrafts.get(conversation.id) ?? "";
    input.addEventListener("input", () => {
      composerDrafts.set(conversation.id, input.value);
      persistComposer(conversation.id, true);
    });
    const actions = document.createElement("div");
    actions.className = "composer-actions";
    const provider = document.createElement("span");
    provider.textContent = providerLabel(conversation.provider);
    actions.append(provider);
    if (!conversation.handoffTerminalId)
      actions.append(modelChoices(conversation));
    if (conversation.backgroundActivities?.length)
      actions.append(
        backgroundActivity(
          conversation.backgroundActivities,
          conversation.status === "ready",
          views
            .get("chat:" + conversation.id)
            ?.querySelector<HTMLDetailsElement>(".composer-background")?.open ??
            false,
          invalidate,
        ),
      );
    if (
      !conversation.handoffTerminalId &&
      ["working", "waiting"].includes(conversation.status)
    ) {
      const stop = iconButton(
        "stop",
        "Stop",
        () => void invoke("conversation.interrupt", { id: conversation.id }),
      );
      stop.style.marginLeft = "auto";
      actions.append(stop);
    }
    composer.oncontextmenu = (e) => {
      if (e.target === input) return;
      e.preventDefault();
      menu({ x: e.clientX, y: e.clientY }, [
        { label: "Send message", run: () => void sendMessage(conversation.id) },
        {
          label: "Session info...",
          run: () =>
            showProviderCommands(commandOptions(conversation.id), "status"),
        },
        {
          label: "Session commands...",
          run: () => showProviderCommands(commandOptions(conversation.id)),
        },
      ]);
    };
    composer.append(input, actions);
    bindImages(composer, input, conversation.id);
    const conflict = draftConflict(conversation.id, conversation.paneId);
    if (conflict) body.append(conflict);
    body.append(composer);
    return body;
  }

  function commandOptions(id: string) {
    return {
      id,
      invoke,
      insertSkill: (skill: { name: string; path: string }) => {
        skillDrafts.set(id, [
          ...(skillDrafts.get(id) ?? []).filter(
            (item) => item.name !== skill.name,
          ),
          skill,
        ]);
        const text = composerDrafts.get(id) ?? "";
        const names = new Set(text.match(/\$[\w.-]+/g) ?? []);
        if (!names.has(`$${skill.name}`))
          composerDrafts.set(
            id,
            text + (text && !/\s$/.test(text) ? " " : "") + `$${skill.name} `,
          );
        void persistComposer(id);
        invalidate();
        requestAnimationFrame(() => {
          const pane = getState().conversations.find(
            (c) => c.id === id,
          )?.paneId;
          const input = [
            ...panes.querySelectorAll<HTMLTextAreaElement>(
              ".composer textarea",
            ),
          ].find(
            (node) =>
              node.closest<HTMLElement>("[data-pane-id]")?.dataset.paneId ===
              pane,
          );
          input?.focus();
          input?.setSelectionRange(input.value.length, input.value.length);
        });
      },
    };
  }
  async function sendMessage(id: string): Promise<void> {
    if (pendingSends.has(id)) return;
    if (loadingImages.has(id)) {
      setStatus("Wait for the image to finish loading");
      return;
    }
    if (getState().conversations.find((c) => c.id === id)?.handoffTerminalId) {
      setStatus("Exit the CLI and use Return to chat before sending.");
      return;
    }
    const text = composerDrafts.get(id) ?? "";
    const images = [...(attachmentDrafts.get(id) ?? [])];
    const skills = selectedSkills(id);
    if (!text.trim() && !images.length) return;
    await saves.get(id)?.promise;
    if (pendingSends.has(id)) return;
    if (composerConflicts.has(id) || dirtyComposers.has(id)) {
      setStatus("Resolve or save this unsent message before sending.");
      return;
    }
    sendErrors.delete(id);
    hydratedComposers.add(id);
    pendingSends.add(id);
    try {
      if (routeProviderCommand(text, commandOptions(id))) {
        if (composerDrafts.get(id) === text) {
          composerDrafts.delete(id);
          skillDrafts.delete(id);
        }
        await persistComposer(id);
        invalidate();
        return;
      }
      await invoke(
        "conversation.send",
        { id, text, images, skills, writer },
        { reportError: false },
      );
    } catch (error) {
      sendErrors.set(
        id,
        error instanceof Error ? error.message : String(error),
      );
      invalidate();
      return;
    } finally {
      pendingSends.delete(id);
    }

    if (composerDrafts.get(id) === text) {
      composerDrafts.delete(id);
      skillDrafts.delete(id);
    }
    const remaining = attachmentDrafts.get(id) ?? [];
    const unsentImages = remaining.filter((image) => !images.includes(image));
    if (unsentImages.length !== remaining.length) {
      if (unsentImages.length) attachmentDrafts.set(id, unsentImages);
      else attachmentDrafts.delete(id);
      // Preserve attachments added during admission, removing only the ones
      // already admitted with the submitted text from the next unsent message.
      if (composerDrafts.has(id) || unsentImages.length)
        await persistComposer(id);
    }
    // The backend retains the submitted version's empty transition. A delayed
    // snapshot must not reset our acknowledged version before the next save.
    invalidate();
  }

  function reconcile() {
    for (const workspace of getState().workspaces)
      for (const [paneId, draft] of Object.entries(
        workspace.chatDrafts ?? {},
      )) {
        const conversation = getState().conversations.find(
          (c) => c.paneId === paneId,
        );
        const key = conversation?.id ?? paneId;
        const version = draft.version ?? "";
        const hydrated = hydratedComposers.has(key);
        if (hydrated && version === seenVersions.get(key)) continue;
        hydratedComposers.add(key);
        seenVersions.set(key, version);
        if (draft.writer === writer && (hydrated || versions.has(key))) {
          const acknowledged = versions.get(key);
          // An autosave reply can overtake rendering an older own snapshot.
          // Only a clear rooted at the current acknowledgement may advance it.
          if (
            acknowledged === undefined ||
            draft.clearedFromVersion === acknowledged
          )
            versions.set(key, version);
        } else if (!hydrated) {
          if (!composerDrafts.has(key) && !dirtyComposers.has(key)) {
            acceptDraft(key, paneId, draft.localDraft ?? draft);
            versions.set(key, version);
            if (draft.localDraft) composerConflicts.set(key, draft);
          } else versions.set(key, version);
        } else if (
          composerConflicts.has(key) ||
          dirtyComposers.has(key) ||
          loadingImages.has(key)
        ) {
          composerConflicts.set(key, draft);
          void persistComposer(key);
        } else acceptDraft(key, paneId, draft);
      }
  }
  const views = new Map<string, HTMLElement>();
  function stable(id: string, next: HTMLElement) {
    const previous = views.get(id);
    if (previous) {
      reconcileView(previous, next);
      return previous;
    }
    views.set(id, next);
    return next;
  }
  return {
    draft: (workspace: WorkspaceState, pane: PaneState) =>
      stable("draft:" + pane.id, renderDraftChat(workspace, pane)),
    conversation: (conversation: import("../types").ConversationState) =>
      stable("chat:" + conversation.id, renderConversation(conversation)),
    integration: integration.open,
    send: sendMessage,
    reconcile() {
      reconcile();
      for (const id of views.keys())
        if (
          id.startsWith("chat:")
            ? !getState().workspaces.some((w) =>
                w.panes.some(
                  (p) =>
                    p.kind === "conversation" &&
                    p.conversationId === id.slice(5),
                ),
              )
            : !getState().workspaces.some((w) =>
                w.panes.some((p) => p.id === id.slice(id.indexOf(":") + 1)),
              )
        ) {
          views.delete(id);
          historyCounts.delete(id.slice(id.indexOf(":") + 1));
        }
    },
  };
}
