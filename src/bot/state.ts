/** Shared, observable bot lifecycle state for health reporting. */
export const botState = {
  running: false,
  failed: false,
  lastError: null as string | null,
  attempts: 0,
};
