// Connection state: poll Studio's health endpoint and reflect it on the mode +
// connection pills, and gate the faithful render tier on Tesserae being reachable.

import { getHealth } from "./api";
import { healthPills } from "./logic";
import { updateTierButtons } from "./preview";
import { state } from "./state";
import { setPill } from "./ui";

export async function refreshHealth() {
  try {
    const h = await getHealth();
    const { mode, conn } = healthPills(h);
    setPill("mode", "mode-text", mode.kind, mode.label);
    setPill("conn", "conn-text", conn.kind, conn.label);
    state.faithful = h.faithful;
    updateTierButtons();
  } catch {
    setPill("conn", "conn-text", "bad", "studio server unreachable");
    state.faithful = false;
    updateTierButtons();
  }
}
