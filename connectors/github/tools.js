// ---------------------------------------------------------------------------
// connectors/github/tools.js — orchestrator only.
// Each domain is implemented in its own module; register them all here.
// To add a new group: create connectors/github/<name>.js and call register().
// ---------------------------------------------------------------------------

import { register as registerFiles     } from "./files.js";
import { register as registerRepoInspect } from "./repo_inspect.js";
import { register as registerSearchCode } from "./search_code.js";
import { register as registerCreateBranch } from "./create_branch.js";
import { register as registerPRRead     } from "./pr_read.js";
import { register as registerPRWrite    } from "./pr_write.js";
import { register as registerIssueManage } from "./issue_manage.js";
import { register as registerReleases  } from "./releases.js";
import { register as registerRepo      } from "./repo.js";
import { register as registerCiManage  } from "./ci_manage.js";
import { register as registerNotifications } from "./notifications.js";
import { register as registerRepoMgmt } from "./repo_mgmt.js";
import { register as registerCloneToken } from "./clone_token.js";
import { register as registerCodespaceManage } from "./codespace_manage.js";
import { register as registerCodespaces } from "./codespaces.js";
import { register as registerEditor     } from "../delegate/editor/editor_tools.js";

export function register(server) {
  registerFiles(server);
  registerRepoInspect(server);
  registerSearchCode(server);
  registerCreateBranch(server);
  registerPRRead(server);
  registerPRWrite(server);
  registerIssueManage(server);
  registerReleases(server);
  registerRepo(server);
  registerCiManage(server);
  registerNotifications(server);
  registerRepoMgmt(server);
  registerCloneToken(server);
  registerCodespaceManage(server);
  registerCodespaces(server);
  // Self-gates on EDITOR_AGENT_ENABLED -- a no-op call unless the flag 
  // is on, so delegate_editor doesn't appear on the MCP surface until a 
  // human flips it on deliberately.
  registerEditor(server);
}
