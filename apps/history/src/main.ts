import { RunStore } from "./store.ts";
import { createHistoryServer } from "./server.ts";
import { HistoryAuth } from "./auth.ts";

const port = Number(process.env.HISTORY_PORT ?? 3100);
const store = new RunStore(process.env.HISTORY_DATA_FILE);
const auth = new HistoryAuth({
  writeToken: process.env.RUNSTAGE_HISTORY_TOKEN,
  readToken: process.env.RUNSTAGE_HISTORY_READ_TOKEN,
  cookieSecure: process.env.HISTORY_COOKIE_SECURE === "1",
});
if (auth.open) {
  console.warn(
    "[history] WARNING: no RUNSTAGE_HISTORY_TOKEN or RUNSTAGE_HISTORY_READ_TOKEN set; UI and API are open to anyone who can reach this port (local dev only).",
  );
} else if (!auth.writesEnabled) {
  console.warn("[history] RUNSTAGE_HISTORY_TOKEN is not set: POST /runs is disabled (read-only mode).");
}
createHistoryServer(store, auth).listen(port, () =>
  console.log(`[history] listening on :${port} (GET / UI, GET /runs JSON; auth ${auth.open ? "off" : "on"})`),
);
