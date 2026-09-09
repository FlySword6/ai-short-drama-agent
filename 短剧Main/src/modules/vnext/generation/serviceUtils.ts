/** Shared utility used by service and worker. */
export function safeMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
