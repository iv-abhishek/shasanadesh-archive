/**
 * npm run workspace:purge — really delete every profile whose 30-day restore
 * window is over (ADR-079): departments, conversations, messages, sessions and
 * feedback go with it. The API also purges at start-up and whenever the
 * "Recently deleted" list loads; this step (run by sync:daily) covers the rest.
 */
import { closeWorkspacePool, hasDeletionColumns, purgeDeletedProfiles } from "./store.js";

async function main() {
  if (!(await hasDeletionColumns())) {
    console.log("Profile deletion is not set up yet (run npm run db:migrate).");
    return;
  }
  const purged = await purgeDeletedProfiles();
  console.log(`Purged ${purged} deleted profile(s) past their restore window.`);
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => closeWorkspacePool());
