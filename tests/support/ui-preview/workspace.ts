import {
  choiceTrigger,
  setChoiceTriggerCaption,
  toolbar,
  uiButton,
  icon,
  iconButton,
  menu,
} from "../../../src/ui-kit";
import { previewFrame } from "./frame";

const stage = previewFrame("Cod workspace preview");
stage.classList.add("workspace-preview");

const exchange = document.createElement("header");
exchange.textContent = "Example workspace";
const transcript = document.createElement("div");
transcript.className = "preview-transcript";
transcript.innerHTML =
  "<p>Compare two fixture builds.</p><p>Both builds passed. One has an invented warning to inspect.</p>";
const input = document.createElement("textarea");
input.setAttribute("aria-label", "Message");
input.placeholder = "Message Codex…";

const model = choiceTrigger("Fixture model");
model.setAttribute("aria-label", "Model");
model.onclick = () =>
  menu(
    model,
    ["Fixture model", "Fixture model with a deliberately long name"].map(
      (label) => ({
        label,
        selected: label === model.title,
        run: () => setChoiceTriggerCaption(model, label),
      }),
    ),
  );
const effort = choiceTrigger("Medium");
effort.setAttribute("aria-label", "Reasoning effort");
effort.onclick = () =>
  menu(
    effort,
    ["Low", "Medium", "High"].map((label) => ({
      label,
      selected: label === effort.title,
      run: () => setChoiceTriggerCaption(effort, label),
    })),
  );
const composeControls = toolbar(model, effort);
composeControls.classList.add("preview-choice-row");

const agents = uiButton("2 agents", "quiet");
agents.classList.add("compact-text", "preview-running");
const shells = uiButton("1 shell", "quiet");
shells.classList.add("compact-text", "preview-running");
agents.onclick = () =>
  menu(agents, [
    { label: "Fixture agent A", run: () => undefined },
    { label: "Fixture agent B", run: () => undefined },
  ]);
shells.onclick = () =>
  menu(shells, [{ label: "Fixture build command", run: () => undefined }]);
const stop = iconButton("stop", "Stop", () => {
  agents.hidden = shells.hidden = stop.hidden = true;
  input.focus();
});
const activity = toolbar(agents, shells, stop);
const controls = document.createElement("div");
controls.className = "preview-composer-controls";
controls.append(composeControls, activity);
const chat = document.createElement("section");
chat.className = "preview-chat";
const chatTab = uiButton("Conversation", "quiet", icon("conversation"));
chatTab.onclick = () => input.focus();
const chatBar = toolbar(chatTab);
chatBar.classList.add("preview-tabs");
chat.append(chatBar, transcript, input, controls);

const documentPane = document.createElement("section");
documentPane.className = "preview-document";
const fileTab = uiButton("Results.md", "quiet", icon("file"));
const fixture = document.createElement("pre");
fixture.tabIndex = 0;
fixture.textContent =
  "# Verification results\n\n- Build A passed\n- Build B passed\n- Inspect one warning";
fileTab.onclick = () => fixture.focus();
const fileBar = toolbar(fileTab);
fileBar.classList.add("preview-tabs");
documentPane.append(fileBar, fixture);
const panes = document.createElement("div");
panes.className = "preview-panes";
panes.append(documentPane, chat);
stage.append(exchange, panes);
