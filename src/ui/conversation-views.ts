import { showActionError } from "./action-feedback";
import { permissionContent } from "./permission-content";
import { groupTurnActivity, toolCaption } from "./turn-activity";
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
  const pendingStarts = new Set<string>();
  const sendErrors = new Map<string, string>();
  const integration = createIntegrationSetup(invoke, invalidate);
  function providerLabel(provider: string): string {
    return provider === "codex"
      ? "Codex"
      : provider === "kimi"
        ? "Kimi"
        : "Claude Code";
  }
  const hydratedComposers = new Set<string>();
  async function persistComposer(key: string): Promise<void> {
    const conversation = getState().conversations.find((c) => c.id === key);
    const paneId = conversation?.paneId ?? key;
    const workspace = getState().workspaces.find((w) =>
      w.panes.some((p) => p.id === paneId),
    );
    if (!workspace) return;
    try {
      await invoke("conversation.composer", {
        workspace: workspace.id,
        paneId,
        text: composerDrafts.get(key) ?? "",
        images: attachmentDrafts.get(key) ?? [],
        skills: selectedSkills(key),
        ...(draftProviders.has(paneId)
          ? { provider: draftProviders.get(paneId) }
          : {}),
      });
    } catch {
      setStatus(
        "Could not save the conversation draft. Keep Cod open and try again.",
      );
    }
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
      persistComposer(pane.id);
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
        dialog.append(
          large,
          iconButton("close", "Close image", () => dialog.close()),
        );
        document.body.append(dialog);
        dialog.onclose = () => {
          dialog.remove();
          if (preview.isConnected) preview.focus();
        };
        dialog.showModal();
      };
      preview.append(img);
      item.append(preview);
      if (remove)
        item.append(iconButton("close", "Remove image", () => remove(index)));
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
            images.splice(index, 1);
            attachmentDrafts.set(key, images);
            persistComposer(key);
            refresh();
          }),
        );
    };
    const add = async (files: File[]) => {
      const images = attachmentDrafts.get(key) ?? [];
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
        const data = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result).split(",")[1]);
          reader.onerror = reject;
          reader.readAsDataURL(file);
        });
        images.push({
          mimeType: file.type as ChatImage["mimeType"],
          data,
          name: file.name,
        });
      }
      attachmentDrafts.set(key, images);
      await persistComposer(key);
      refresh();
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
    for (const entry of timeline) {
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
        const failed = !!(
          info?.error ||
          info?.isError ||
          ["failed", "error"].includes(String(info?.status))
        );
        label.textContent =
          toolCaption(info) + ` · ${failed ? "failed" : entry.tool.phase}`;
        label.title = toolCaption(info);
        const details = document.createElement("pre");
        details.textContent =
          JSON.stringify(entry.tool.details, null, 2) ??
          String(entry.tool.details);
        const actionable = !!(
          failed ||
          /request.?user.?input|ask.?user|question/i.test(
            String(info?.name ?? info?.toolName ?? ""),
          )
        );
        if (actionable) {
          tool.dataset.actionRequired = "true";
          tool.open = true;
        }
        tool.append(label, details);
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
          : conversation.status === "working"
            ? `${providerLabel(conversation.provider)} is working...`
            : conversation.status === "waiting"
              ? "Waiting for your response"
              : "");
    if (conversation.handoffTerminalId)
      currentStatus.textContent =
        "Open in the CLI terminal. Exit the CLI before returning to chat.";
    currentStatus.hidden = !currentStatus.textContent;
    body.append(currentStatus);

    const composer = document.createElement("div");
    composer.className = "composer";
    const input = document.createElement("textarea");
    input.setAttribute("aria-label", "Message");
    input.placeholder = `Message ${providerLabel(conversation.provider)}...`;
    input.value = composerDrafts.get(conversation.id) ?? "";
    input.addEventListener("input", () => {
      composerDrafts.set(conversation.id, input.value);
      persistComposer(conversation.id);
    });
    const actions = document.createElement("div");
    actions.className = "composer-actions";
    const provider = document.createElement("span");
    provider.textContent = providerLabel(conversation.provider);
    actions.append(provider);
    if (!conversation.handoffTerminalId)
      actions.append(modelChoices(conversation));
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
    if (getState().conversations.find((c) => c.id === id)?.handoffTerminalId) {
      setStatus("Exit the CLI and use Return to chat before sending.");
      return;
    }
    const text = composerDrafts.get(id) ?? "";
    const images = attachmentDrafts.get(id) ?? [];
    if (!text.trim() && !images.length) return;
    sendErrors.delete(id);
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
        { id, text, images, skills: selectedSkills(id) },
        { reportError: false },
      );
    } catch (error) {
      sendErrors.set(
        id,
        error instanceof Error ? error.message : String(error),
      );
      invalidate();
      return;
    }

    if (composerDrafts.get(id) === text) {
      composerDrafts.delete(id);
      skillDrafts.delete(id);
    }
    if (attachmentDrafts.get(id) === images) attachmentDrafts.delete(id);
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
        if (!hydratedComposers.has(key)) {
          hydratedComposers.add(key);
          if (draft.provider) draftProviders.set(paneId, draft.provider);
          if (!composerDrafts.has(key)) composerDrafts.set(key, draft.text);
          if (draft.skills && !skillDrafts.has(key))
            skillDrafts.set(key, draft.skills);
          if (draft.images && !attachmentDrafts.has(key))
            attachmentDrafts.set(key, draft.images);
        }
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
      stable("chat:" + conversation.paneId, renderConversation(conversation)),
    integration: integration.open,
    send: sendMessage,
    reconcile() {
      reconcile();
      for (const id of views.keys())
        if (
          !getState().workspaces.some((w) =>
            w.panes.some((p) => p.id === id.slice(id.indexOf(":") + 1)),
          )
        )
          views.delete(id);
    },
  };
}
