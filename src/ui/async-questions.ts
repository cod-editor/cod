import type { CodexQuestion } from "../codex-questions";
import { actionRow, uiButton } from "../ui-kit";
import type { Invoke } from "./contracts";

interface QuestionDraft {
  selected: number;
  answer: string;
  sending?: boolean;
  error?: string;
}

export function createAsyncQuestions(invoke: Invoke, invalidate: () => void) {
  const drafts = new Map<string, QuestionDraft>();

  return function renderQuestion(
    conversationId: string,
    question: CodexQuestion,
    status: string,
    enabled: boolean,
  ) {
    const key = JSON.stringify([conversationId, question.id]);
    const form = document.createElement("form");
    form.className = "async-question-card";
    form.dataset.focusKey = key;
    form.setAttribute("aria-label", question.title);
    const field = document.createElement("fieldset");
    const legend = document.createElement("legend");
    legend.textContent = question.title;
    field.append(legend);
    form.append(field);
    if (status) {
      const receipt = document.createElement("span");
      receipt.className = "async-question-status";
      receipt.setAttribute("role", "status");
      receipt.textContent = status;
      field.append(receipt);
      if (status === "Answered" || status === "Question closed")
        drafts.delete(key);
      return form;
    }

    const draft = drafts.get(key) ?? {
      selected: 0,
      answer: "",
    };
    const save = () => drafts.set(key, draft);
    const options = document.createElement("div");
    options.className = "async-question-options";
    const otherIndex = question.options.length;
    const ownAnswer = document.createElement("textarea");
    ownAnswer.setAttribute("aria-label", "Your answer");
    ownAnswer.dataset.focusKey = `${key}:answer`;
    ownAnswer.rows = 2;
    ownAnswer.value = draft.answer;
    ownAnswer.maxLength = 16_384;
    ownAnswer.hidden = draft.selected !== otherIndex;
    ownAnswer.oninput = (event) => {
      draft.answer = (event.currentTarget as HTMLTextAreaElement).value;
      save();
    };
    ownAnswer.onkeydown = (event) => {
      if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
      event.preventDefault();
      if (!event.repeat) ownAnswer.form?.requestSubmit();
    };
    if (otherIndex) {
      const labels = [
        ...question.options,
        question.options.includes("Other") ? "Write my own answer" : "Other",
      ];
      for (const [index, caption] of labels.entries()) {
        const label = document.createElement("label");
        label.dataset.focusKey = `${key}:label:${index}`;
        const radio = document.createElement("input");
        radio.type = "radio";
        radio.name = key;
        radio.checked = index === draft.selected;
        radio.dataset.focusKey = `${key}:option:${index}`;
        radio.onchange = () => {
          draft.selected = index;
          save();
          const current = radio.form?.querySelector("textarea");
          if (current) current.hidden = index !== otherIndex;
        };
        radio.onkeydown = (event) => {
          if (event.key !== "Enter" || event.isComposing) return;
          event.preventDefault();
          if (event.repeat) return;
          if (draft.selected === otherIndex)
            radio.form?.querySelector("textarea")?.focus();
          else radio.form?.requestSubmit();
        };
        const text = document.createElement("span");
        text.textContent = caption;
        label.append(radio, text);
        options.append(label);
      }
      field.append(options);
    }
    const submit = uiButton("Send answer", "primary");
    submit.type = "submit";
    field.disabled = !enabled || !!draft.sending;
    field.append(ownAnswer, actionRow(submit));
    if (draft.error || draft.sending) {
      const state = document.createElement("div");
      state.className = draft.error ? "action-error" : "async-question-status";
      state.setAttribute("role", draft.error ? "alert" : "status");
      state.textContent = draft.error ?? "Sending answer…";
      field.append(state);
    }
    form.onsubmit = (event) => {
      event.preventDefault();
      const current = event.currentTarget as HTMLFormElement;
      if (draft.sending || current.querySelector("fieldset")?.disabled) return;
      const answer = (
        draft.selected === otherIndex
          ? draft.answer
          : (question.options[draft.selected] ?? "")
      ).trim();
      if (!answer) {
        current.querySelector("textarea")?.focus();
        return;
      }
      draft.sending = true;
      draft.error = undefined;
      save();
      const pane = current.closest(".chat-body");
      const restore = current.contains(document.activeElement);
      void invoke(
        "conversation.answer-question",
        {
          id: conversationId,
          questionId: question.id,
          answer,
        },
        { reportError: false },
      )
        .then(() => {
          if (!restore) return;
          requestAnimationFrame(() => {
            if (!pane?.isConnected || document.activeElement !== document.body)
              return;
            (
              pane.querySelector<HTMLInputElement>(
                ".async-question-card fieldset:not(:disabled) input:checked, .async-question-card fieldset:not(:disabled) textarea:not([hidden])",
              ) ?? pane.querySelector<HTMLTextAreaElement>(".composer textarea")
            )?.focus();
          });
        })
        .catch((error: unknown) => {
          draft.error = error instanceof Error ? error.message : String(error);
        })
        .finally(() => {
          draft.sending = false;
          invalidate();
        });
      invalidate();
    };
    return form;
  };
}
