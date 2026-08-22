// Dialogue agent behavior limits (tool loop, etc.).

export const DEFAULT_DIALOGUE_MAX_TOOL_ROUNDS = 5;
const MIN_DIALOGUE_MAX_TOOL_ROUNDS = 1;
const MAX_DIALOGUE_MAX_TOOL_ROUNDS = 30;

/** Read the user-configured Dialogue tool-loop limit, with fallback/clamping. */
export function getDialogueMaxToolRounds(settings) {
  const n = Number(settings?.dialogueMaxToolRounds);
  if (!Number.isFinite(n)) return DEFAULT_DIALOGUE_MAX_TOOL_ROUNDS;
  return Math.min(
    MAX_DIALOGUE_MAX_TOOL_ROUNDS,
    Math.max(MIN_DIALOGUE_MAX_TOOL_ROUNDS, Math.floor(n))
  );
}
