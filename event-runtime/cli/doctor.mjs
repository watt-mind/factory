import { status } from "./status.mjs";
import { withClient } from "./shared.mjs";

export async function doctor(client) {
  const anomalyLines = await status(client);
  if (anomalyLines.length > 0) process.exit(1);
}

export default function doctorCommand() {
  return withClient(doctor);
}
