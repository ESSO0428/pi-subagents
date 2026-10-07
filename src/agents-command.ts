import type { AutocompleteItem } from "@earendil-works/pi-tui";

/** Sub-commands accepted by `/agents`. */
export const AGENTS_ARGUMENT_COMPLETIONS: AutocompleteItem[] = [
  {
    value: "re-focus",
    label: "re-focus",
    description: "Rebuild the agents list widget registration",
  },
];

/**
 * Argument completion for `/agents`.
 *
 * Same contract pi-goal uses for `/goal`: everything when nothing is typed
 * yet, prefix-filtered after that, and `null` once a space makes the
 * sub-command unambiguous (or nothing matches, so pi keeps its own list).
 */
export function completeAgentsArguments(argumentPrefix: string): AutocompleteItem[] | null {
  const prefix = argumentPrefix.trimStart();
  if (prefix === "") return [...AGENTS_ARGUMENT_COMPLETIONS];
  if (/\s/.test(prefix)) return null;
  const matches = AGENTS_ARGUMENT_COMPLETIONS.filter(
    (item) => item.value.startsWith(prefix) || item.label.startsWith(prefix),
  );
  return matches.length > 0 ? matches : null;
}

/** True when the `/agents` argument asks for the list to be rebuilt. */
export function isRefocusArgument(args: unknown): boolean {
  // pi passes the argument string as the handler's first parameter; be tolerant
  // of anything else rather than throwing on `/agents` itself.
  const value = String(args ?? "").trim().toLowerCase();
  return value === "re-focus" || value === "refocus" || value === "re-register";
}
