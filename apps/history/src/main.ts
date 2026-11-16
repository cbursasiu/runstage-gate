import { RunStore } from "./store.ts";
import { createHistoryServer } from "./server.ts";

const port = Number(process.env.HISTORY_PORT ?? 3100);
const store = new RunStore(process.env.HISTORY_DATA_FILE);
createHistoryServer(store, process.env.RUNSTAGE_HISTORY_TOKEN).listen(port, () =>
  console.log(`[history] listening on :${port} (GET / UI, GET /runs JSON)`),
);
