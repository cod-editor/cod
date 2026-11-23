import { selectField, toolbar } from "../../../src/ui-kit";

export function sampleSelect(
  label: string,
  entries: readonly [string, string][],
) {
  const select = document.createElement("select");
  select.setAttribute("aria-label", label);
  for (const [value, text] of entries) select.add(new Option(text, value));
  return { select, field: selectField(select) };
}

export function previewFrame(title: string) {
  const heading = document.createElement("h1");
  heading.textContent = title;
  const font = sampleSelect("Interface font size", [
    ["13", "13 px"],
    ["14", "14 px"],
    ["18", "18 px"],
  ]);
  font.select.value = "14";
  const width = sampleSelect("Preview width", [
    ["available", "Available width"],
    ["narrow", "Narrow"],
  ]);
  const stage = document.createElement("main");
  stage.className = "preview-stage";
  stage.setAttribute("aria-label", title);
  font.select.onchange = () =>
    document.documentElement.style.setProperty(
      "--ui-font-size",
      `${font.select.value}px`,
    );
  width.select.onchange = () =>
    stage.classList.toggle("narrow", width.select.value === "narrow");
  const actions = toolbar(font.field, width.field);
  const header = document.createElement("header");
  header.className = "preview-header";
  header.append(heading, actions);
  document.body.append(header, stage);
  return stage;
}
