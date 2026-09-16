// FRACTAL: implements F1 | component C9
import path from "node:path";
import { route } from "@/api/respond";
import { resetServices, services } from "@/api/services";
import { restoreFromPrevious, listPreviousGenerations } from "@/store/open";
import { HIGHEST_KNOWN_MIGRATION } from "@/store/migrations";
import { loadConfig } from "@/core/config";
import { paths } from "@/core/paths";
import type { RecoveryInfo } from "@/api/shapes";

// WHY (H13): the recovery screen is the one surface that must name the folder and the
// backup file by their real names, or the learner is left guessing in a file manager.
// It lives here rather than on /api/health so the broad diagnostic surface stays path-free.
export const GET = route(
  async (): Promise<RecoveryInfo> => {
    const p = paths(loadConfig().dataRoot);
    // Snapshots are stamped with the schema version of the data they hold, so the name to
    // show is the one Recover would actually restore: the newest kept generation. With no
    // snapshot yet there is nothing to restore, and the name of the generation this build
    // would write is the most useful thing to point the learner at.
    const restorable = listPreviousGenerations(p.dataRoot)[0];
    return {
      dataRoot: p.dataRoot,
      dataFileName: path.basename(p.dbFile),
      backupFileName:
        restorable?.fileName ?? path.basename(p.dbPrevForVersion(HIGHEST_KNOWN_MIGRATION)),
    };
  },
  { requiresStore: false },
);

// WHY (H3): the recovery action exists precisely because the store is broken, so it
// is the one route that must not require the store to have opened.
export const POST = route(
  async () => {
    resetServices();
    restoreFromPrevious(loadConfig().dataRoot);
    return { restored: services() !== null };
  },
  { requiresStore: false },
);
