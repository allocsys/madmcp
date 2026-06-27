// ---------------------------------------------------------------------------
// connectors/github/tools.js — orchestrator only.
// Each domain is implemented in its own module; register them all here.
// To add a new group: create connectors/github/<name>.js and call register().
// ---------------------------------------------------------------------------

import { register as registerDownload  } from "./download.js";
import { register as registerFiles     } from "./files.js";
import { register as registerBranches  } from "./branches.js";
import { register as registerPRs       } from "./prs.js";
import { register as registerIssues    } from "./issues.js";
import { register as registerReleases  } from "./releases.js";
import { register as registerRepo      } from "./repo.js";
import { register as registerSearch    } from "./search.js";
import { register as registerActions   } from "./actions.js";
import { register as registerStrReplace} from "./str_replace.js";
import { register as registerDiff      } from "./diff.js";
import { register as registerRepoMgmt } from "./repo_mgmt.js";

export function register(server) {
  registerDownload(server);
  registerFiles(server);
  registerBranches(server);
  registerPRs(server);
  registerIssues(server);
  registerReleases(server);
  registerRepo(server);
  registerSearch(server);
  registerActions(server);
  registerStrReplace(server);
  registerDiff(server);
  registerRepoMgmt(server);
}
