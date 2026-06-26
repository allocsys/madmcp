// ---------------------------------------------------------------------------
// connectors/github/resource.js — MCP resource provider for GitHub files
// Exposes files as MCP resources via URI: github://{owner}/{repo}/{path}
// This bypasses tool response size limits — content is fetched via the
// MCP resources channel which handles large payloads correctly.
// ---------------------------------------------------------------------------

import { githubRequest, fromBase64 } from "./client.js";
import { DEFAULT_OWNER } from "../../config.js";

export function register(server) {

  // Resource template: github://{owner}/{repo}/{path}
  server.resource(
    "github-file",
    new (await import("@modelcontextprotocol/sdk/types.js").then(m => m.ResourceTemplate ?? class ResourceTemplate {
      constructor(template, opts) { this.template = template; this.opts = opts; }
    }))("github://{owner}/{repo}/{path}", { list: undefined }),
    async (uri, { owner, repo, path }) => {
      const resolvedOwner = owner || DEFAULT_OWNER;

      // Resolve default branch
      const repoInfo     = await githubRequest(`/repos/${resolvedOwner}/${repo}`);
      const targetBranch = repoInfo.default_branch;

      // Get file blob SHA from tree
      const refData  = await githubRequest(`/repos/${resolvedOwner}/${repo}/git/ref/heads/${encodeURIComponent(targetBranch)}`);
      const tree     = await githubRequest(`/repos/${resolvedOwner}/${repo}/git/trees/${refData.object.sha}?recursive=1`);
      const entry    = tree.tree.find((item) => item.path === path && item.type === "blob");
      if (!entry) throw new Error(`File not found: ${path}`);

      // Fetch full content via Blobs API
      const blob    = await githubRequest(`/repos/${resolvedOwner}/${repo}/git/blobs/${entry.sha}`);
      const content = fromBase64(blob.content.replace(/\n/g, ""));

      return {
        contents: [{
          uri: uri.href,
          mimeType: guessMime(path),
          text: content,
        }],
      };
    }
  );
}

function guessMime(path) {
  const ext = path.split(".").pop().toLowerCase();
  const map = {
    js: "application/javascript",
    ts: "application/typescript",
    json: "application/json",
    sh: "text/x-sh",
    md: "text/markdown",
    html: "text/html",
    css: "text/css",
    py: "text/x-python",
    rs: "text/x-rust",
    go: "text/x-go",
  };
  return map[ext] || "text/plain";
}
