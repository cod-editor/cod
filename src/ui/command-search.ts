/** Command metadata only: no application content is retained or searched. */
export const commandHistoryLimit = 20;
export interface SearchableCommand {
  id: string;
  title: string;
  aliases: readonly string[];
}
const normalize = (value: string) =>
  value
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

export function validCommandHistory(
  value: unknown,
  commands: readonly SearchableCommand[],
): string[] {
  if (!Array.isArray(value)) return [];
  const known = new Set(commands.map((command) => command.id));
  return [
    ...new Set(
      value.filter(
        (id): id is string => typeof id === "string" && known.has(id),
      ),
    ),
  ].slice(0, commandHistoryLimit);
}
function tokenCost(field: string, token: string): number {
  const index = field.indexOf(token);
  if (index >= 0)
    return (index === 0 ? 0 : field[index - 1] === " " ? 2 : 5) + index / 100;
  let cursor = 0,
    first = -1,
    last = -1;
  for (const character of token) {
    const position = field.indexOf(character, cursor);
    if (position < 0) return Infinity;
    if (first < 0) first = position;
    last = position;
    cursor = position + 1;
  }
  return 20 + (last - first + 1 - token.length) / 10 + first / 100;
}
export function commandMatchCost(
  command: SearchableCommand,
  query: string,
): number | undefined {
  const text = normalize(query.slice(0, 256));
  if (!text) return 0;
  const title = normalize(command.title);
  const aliases = command.aliases.map(normalize);
  let cost = 0;
  for (const token of text.split(/\s+/)) {
    const match = Math.min(
      tokenCost(title, token),
      ...aliases.map((alias) => tokenCost(alias, token) + 3),
    );
    if (!Number.isFinite(match)) return undefined;
    cost += match;
  }
  return cost - (title === text ? 20 : title.startsWith(text) ? 6 : 0);
}
export function rankCommands<T extends SearchableCommand>(
  commands: readonly T[],
  query: string,
  recent: readonly string[],
): T[] {
  const history = new Map(recent.map((id, index) => [id, index]));
  return commands
    .map((command, index) => ({
      command,
      index,
      cost: commandMatchCost(command, query),
    }))
    .filter(
      (row): row is typeof row & { cost: number } => row.cost !== undefined,
    )
    .sort(
      (a, b) =>
        a.cost - b.cost ||
        (history.get(a.command.id) ?? Infinity) -
          (history.get(b.command.id) ?? Infinity) ||
        a.index - b.index,
    )
    .map((row) => row.command);
}
