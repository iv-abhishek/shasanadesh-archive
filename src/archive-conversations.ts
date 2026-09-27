/**
 * npm run chats:archive — move every conversation with no activity for
 * WORKSPACE_ARCHIVE_AFTER_DAYS (default 30) to Archives (ADR-066). The history
 * list also does this for its own user whenever it loads; this step (run by
 * sync:daily) covers people who have not opened the app for a while.
 */
import { ARCHIVE_AFTER_DAYS, archiveInactiveConversations, closeWorkspacePool } from "./workspace/store.js";

async function main() {
  if (ARCHIVE_AFTER_DAYS <= 0) {
    console.log("Auto-archive is off (WORKSPACE_ARCHIVE_AFTER_DAYS=0).");
    return;
  }
  const moved = await archiveInactiveConversations(null);
  console.log(`Archived ${moved} conversation(s) inactive for more than ${ARCHIVE_AFTER_DAYS} days.`);
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => closeWorkspacePool());
