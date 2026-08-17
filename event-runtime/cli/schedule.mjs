import { pad, withClient } from "./shared.mjs";

export async function schedule(client) {
  const { schedules } = await client.schedules();
  if (schedules.length === 0) {
    console.log("no schedules registered (event-runtime/schedules.json)");
    return;
  }
  console.log(
    `${pad("LOOP", 16)}${pad("EVERY", 8)}${pad("ENABLED", 9)}${pad("APPROVAL", 10)}${pad("CATCHUP", 9)}${pad("LAST SLOT", 26)}${pad("NEXT DUE", 26)}STATE`,
  );
  for (const s of schedules) {
    const state = s.error
      ? `error: ${s.error}`
      : s.stopped
        ? `STOPPED (${s.intervalsLate} intervals late)`
        : s.enabled
          ? "ok"
          : "off";
    console.log(
      `${pad(s.loop, 16)}${pad(s.every, 8)}${pad(s.enabled ? "yes" : "no", 9)}${pad(s.approval, 10)}${pad(s.catchUp, 9)}${pad(s.lastSlot ?? "-", 26)}${pad(s.nextDue ?? "-", 26)}${state}`,
    );
  }
}

export default function scheduleCommand(args) {
  return withClient((client) => schedule(client));
}
