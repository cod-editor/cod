import type { InspectionSection } from "./providers/inspection.ts";
export const providerCommandSections: InspectionSection[] = [
  "status",
  "skills",
  "plugins",
  "config",
  "agents",
];
export function parseProviderCommand(
  text: string,
): InspectionSection | "commands" | "unknown" | undefined {
  const value = text.trim();
  if (value === "/" || value === "/help") return "commands";
  if (!/^\/[a-z][a-z-]*$/i.test(value)) return undefined;
  const name = value.slice(1);
  return providerCommandSections.includes(name as InspectionSection)
    ? (name as InspectionSection)
    : "unknown";
}
