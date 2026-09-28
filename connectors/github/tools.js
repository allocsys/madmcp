// ---------------------------------------------------------------------------
// connectors/github/tools.js — orchestrator only.
// Each domain is implemented in its own module; register them all here.
// To add a new group: create connectors/github/<name>.js and call register().
// ---------------------------------------------------------------------------

import { register as registerFiles     } from "./files.js";
import { register as registerRepoInspect } from "./repo_inspect.js";
import { register as registerPRRead     } from "./pr_read.js";
import { register as registerPRWrite    } from "./pr_write.js";
import { register as registerIssues    } from "./issues.js";
import { register as registerReleases  } from "./releases.js";
import { register as registerRepo      } from "./repo.js";
import { register as registerSearch    } from "./search.js";
import { register as registerActions   } from "./actions.js";
import { register as registerCiControl } from "./ci_control.js";
import { register as registerReviewControl } from "./review_control.js";
import { register as registerRepoMgmt } from "./repo_mgmt.js";
import { register as registerCloneToken } from "./clone_token.js";
import { register as registerCodespaces } from "./codespaces.js";
import { register as registerEditor     } from "../delegate/editor/editor_tools.js";

export function register(server) {
  registerFiles(server);
  registerRepoInspect(server);
  registerPRRead(server);
  registerPRWrite(server);
  registerIssues(server);
  registerReleases(server);
  registerRepo(server);
  registerSearch(server);
  registerActions(server);
  registerCiControl(server);
  registerReviewControl(server);
  registerRepoMgmt(server);
  registerCloneToken(server);
  registerCodespaces(server);
  // Self-gates on EDITOR_AGENT_ENABLED -- a no-op call unless the flag 
  // is on, so delegate_editor doesn't appear on the MCP surface until a 
  // human flips it on deliberately.
  registerEditor(server);
}
