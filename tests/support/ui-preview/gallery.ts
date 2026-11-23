import {
  actionRow,
  choiceTrigger,
  dialogRegions,
  dialogSurface,
  keyHintButton,
  settingEntry,
  setChoiceTriggerCaption,
  toolbar,
  uiButton,
  uiSwitch,
  icon,
  menu,
} from "../../../src/ui-kit";
import { previewFrame, sampleSelect } from "./frame";

const stage = previewFrame("Cod component gallery");
stage.classList.add("gallery");

function section(title: string, ...controls: Node[]) {
  const row = document.createElement("section");
  const heading = document.createElement("h2");
  heading.textContent = title;
  row.append(heading, ...controls);
  stage.append(row);
}

const save = uiButton("Save", "primary", icon("check"));
const reset = uiButton("Reset");
const more = uiButton("More actions", "quiet");
const disabled = uiButton("Unavailable");
disabled.disabled = true;
const actionStatus = document.createElement("output");
save.onclick = () => {
  actionStatus.textContent = "Saved";
};
reset.onclick = () => {
  actionStatus.textContent = "";
};
more.onclick = () =>
  menu(more, [
    { label: "Save", run: () => save.click() },
    { label: "Reset", run: () => reset.click() },
    { label: "Unavailable", disabled: true, run: () => undefined },
  ]);
section("Actions", toolbar(save, reset, more, disabled), actionStatus);

const modelNames = [
  "Fixture model",
  "Fixture model with a deliberately long readable name",
  "Unavailable model",
];
const model = choiceTrigger(modelNames[1]);
model.setAttribute("aria-label", "Model");
const effort = choiceTrigger("Medium");
effort.setAttribute("aria-label", "Reasoning effort");
for (const [trigger, options] of [
  [model, modelNames],
  [effort, ["Low", "Medium", "High"]],
] as const)
  trigger.onclick = () =>
    menu(
      trigger,
      options.map((label) => ({
        label,
        selected: trigger.title === label,
        disabled: label === "Unavailable model",
        run: () => setChoiceTriggerCaption(trigger, label),
      })),
    );
const choices = toolbar(model, effort);
choices.classList.add("preview-choice-row");
section("Compact choices", choices);

const { select, field } = sampleSelect("Cursor shape", [
  ["block", "Block"],
  ["bar", "Bar"],
  ["underline", "An invented long option that wraps at narrow widths"],
  ["unavailable", "Unavailable"],
]);
select.options[3].disabled = true;
const readOnlySelect = sampleSelect("Unavailable select", [
  ["disabled", "Unavailable"],
]);
readOnlySelect.select.disabled = true;
section("Select", toolbar(field, readOnlySelect.field));

function switchRow(label: string, initial = false, disabled = false) {
  const input = uiSwitch();
  input.checked = initial;
  input.disabled = disabled;
  const { row, reset } = settingEntry(label, input);
  const refresh = () => {
    const hidden = disabled || input.checked === initial;
    reset.style.visibility = hidden ? "hidden" : "visible";
    reset.disabled = hidden;
  };
  input.onchange = refresh;
  reset.onclick = () => {
    input.checked = initial;
    input.focus();
    refresh();
  };
  refresh();
  return row;
}

section(
  "Switch",
  switchRow("Wrap long lines"),
  switchRow("Run new sessions detached", true),
  switchRow("Read-only preference", false, true),
);

const open = uiButton("Open example dialog");
open.onclick = () => {
  const dialog = dialogSurface("Example dialog");
  const { body, actions } = dialogRegions(dialog, "Example dialog");
  for (const name of [
    "Wrap long lines",
    "Show recent activity",
    "Show file extensions",
    "Run new sessions detached",
    "Use browser suggestions",
    "Follow available system appearance",
  ])
    body.append(switchRow(name));
  const cancel = keyHintButton(uiButton("Cancel", "quiet"), "Esc");
  const done = uiButton("Done", "primary");
  cancel.onclick = done.onclick = () => dialog.close();
  actions.append(actionRow(cancel, done));
  dialog.onclose = () => {
    dialog.remove();
    open.focus();
  };
  document.body.append(dialog);
  dialog.showModal();
};
section("Dialog", open);
