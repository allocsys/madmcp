// ---------------------------------------------------------------------------
// connectors/github/resource.js — MCP resource provider for GitHub files
// Exposes files as MCP resources via URI: github://{owner}/{repo}/{path}
// Uses the SDK's ResourceTemplate for URI pattern matching.
// ---------------------------------------------------------------------------

import { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { githubRequest, fromBase64 } from "./client.js";
import { DEFAULT_OWNER } from "../../config.js";

function guessMime(path) {
  const ext = path.split(".").pop().toLowerCase();
  const map = {
    js:   "application/javascript",
    ts:   "application/typescript",
    json: "application/json",
    sh:   "text/x-sh",
    md:   "text/markdown",
    html: "text/html",
    css:  "text/css",
    py:   "text/x-python",
    rs:   "text/x-rust",
    go:   "text/x-go",
  };
  return map[ext] || "text/plain";
}

export function register(server) {
  server.resource(
    "github-file",
    new ResourceTemplate("github://{owner}/{repo}/{+path}", { list: undefined }),
    async (uri, variables) => {
      const owner = variables.owner || DEFAULT_OWNER;
      const repo  = variables.repo;
      const path  = variables.path;

      // Resolve default branch
      const repoInfo     = await githubRequest(`/repos/${owner}/${repo}`);
      const targetBranch = repoInfo.default_branch;

      // Get blob SHA from tree
      const refData = await githubRequest(`/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(targetBranch)}`);
      const tree    = await githubRequest(`/repos/${owner}/${repo}/git/trees/${refData.object.sha}?recursive=1`);
      const entry   = tree.tree.find((item) => item.path === path && item.type === "blob");
      if (!entry) throw new Error(`File not found in tree: ${path}`);

      // Fetch full content via Blobs API (no size limit)
      const blob    = await githubRequest(`/repos/${owner}/${repo}/git/blobs/${entry.sha}`);
      const content = fromBase64(blob.content.replace(/\n/g, ""));

      return {
        contents: [{
          uri:      uri.href,
          mimeType: guessMime(path),
          text:     content,
        }],
      };
    }
  );
}
