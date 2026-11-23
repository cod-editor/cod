import type { ConversationMessage, ConversationState } from "./types";

export interface CodexQuestion {
  itemId: string;
  id: string;
  title: string;
  options: string[];
}

const start = "<send_user_message_question_reply>";
const end = "</send_user_message_question_reply>";
const maxTitleBytes = 512;

export function codexQuestions(
  itemId: string,
  value: unknown,
): CodexQuestion[] {
  if (!Array.isArray(value) || value.length > 32) return [];
  const questions = [];
  for (const [index, question] of value.entries()) {
    if (
      typeof question?.title !== "string" ||
      !question.title.trim() ||
      question.title.length > 4096 ||
      (question.options !== null &&
        (!Array.isArray(question.options) ||
          question.options.length > 32 ||
          question.options.some(
            (option: unknown) =>
              typeof option !== "string" ||
              !option.trim() ||
              option.length > 512,
          )))
    )
      return [];
    const id = JSON.stringify(["request_user_input_async", itemId, index]);
    if (new TextEncoder().encode(id).length > maxTitleBytes) return [];
    questions.push({
      itemId,
      id,
      title: question.title,
      options: question.options ?? [],
    });
  }
  return questions;
}

export function encodeQuestionAnswer(question: CodexQuestion, answer: string) {
  let title = "";
  let length = 0;
  const encoder = new TextEncoder();
  for (const character of question.title) {
    length += encoder.encode(character).length;
    if (length > maxTitleBytes) break;
    title += character;
  }
  return `${start}\n${JSON.stringify([
    {
      answer,
      question: title.replace(/[\r\n]/g, " "),
      questionItemId: question.id,
    },
  ])}\n${end}`;
}

interface Answer {
  questionItemId: string;
  question: string;
  answer: string;
}

export function questionAnswers(value: string): Answer[] {
  let content = value.trim();
  if (content.startsWith("# Context from my IDE setup:\n")) {
    const delimiter = "\n## My request for Codex:\n";
    const tail = content.lastIndexOf(delimiter);
    if (tail < 0) return [];
    content = content.slice(tail + delimiter.length).trim();
  }
  if (!content.startsWith(start) || !content.endsWith(end)) return [];
  try {
    const decoded: unknown = JSON.parse(
      content.slice(start.length, -end.length),
    );
    const answers = Array.isArray(decoded) ? decoded : [decoded];
    if (answers.length > 32) return [];
    return answers.every(
      (item) =>
        typeof item?.questionItemId === "string" &&
        typeof item.question === "string" &&
        typeof item.answer === "string",
    )
      ? answers
      : [];
  } catch {
    return [];
  }
}

export function questionTranscriptText(message: ConversationMessage): string {
  const questions = message.questions;
  if (!questions?.length) return message.text;
  const canonical = questions
    .map(({ title, options }) =>
      [title, ...options.map((label) => "- " + label)].join("\n"),
    )
    .join("\n\n");
  const normal = (text: string) => text.replaceAll("\r\n", "\n").trim();
  return normal(message.text) === normal(canonical) ? "" : message.text;
}

export function questionHistory(conversation: ConversationState) {
  const acknowledged = new Map<string, string>();
  const completed = new Set(
    conversation.turns
      ?.filter(({ outcome }) => outcome === "completed")
      .map(({ id }) => id),
  );
  let latestPrompt = -1;
  for (const message of conversation.messages) {
    if (message.role !== "user") continue;
    const answers = questionAnswers(message.text);
    if (!answers.length) latestPrompt = Math.max(latestPrompt, message.order);
    else if (
      message.id.startsWith("codex/") ||
      completed.has(message.turnId ?? "")
    ) {
      for (const answer of answers)
        acknowledged.set(answer.questionItemId, answer.answer);
    }
  }
  return {
    acknowledged,
    latestPrompt,
    wasAnswered: (question: CodexQuestion) =>
      acknowledged.has(question.id) || acknowledged.has(question.itemId),
  };
}
