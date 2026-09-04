/**
 * Busy-waits (with 1ms sleeps) until `epochMs`. Used so racing worker
 * processes - each with its own bun-startup and import overhead - line up
 * on a shared start time instead of contending purely by accident of
 * process-spawn ordering.
 */
export async function waitUntil(epochMs: number): Promise<void> {
  while (Date.now() < epochMs) {
    await Bun.sleep(1);
  }
}
