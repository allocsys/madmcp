// ---------------------------------------------------------------------------
// connectors/github/notifications.js — standalone list_notifications tool.
// (Relocated unchanged from review_control.js in group 9; the rest of that
// file's tools moved into repo_inspect / pr_read / pr_write earlier.)
// ---------------------------------------------------------------------------

import { z } from "zod";
import { githubRequest } from "./client.js";

export function register(server) {

  server.tool(
    "list_notifications",
    "DOES: Authenticated-token notification feed (mentions, review requests, replies, CI failures on watched runs) -- same feed as github.com/notifications.\n" +
    "RULE: 'did anyone reply to me' / 'is anything waiting on me' -> this, instead of re-polling specific issues/PRs one at a time.",
    {
      all:           z.boolean().optional().describe("If true, include notifications already marked as read (default: false — unread only)"),
      participating: z.boolean().optional().describe("If true, only show notifications where the token owner is directly @mentioned or involved (not just watching) (default: false)"),
      owner:         z.string().optional().describe("Restrict to a single repository owner. Omit for all repos the token can see."),
      repo:          z.string().optional().describe("Restrict to a single repository (requires owner). Omit for all repos."),
      per_page:      z.number().optional().describe("Number of notifications to return, max 100 (default: 30)"),
    },
    async ({ all = false, participating = false, owner, repo, per_page = 30 }) => {
      const query = new URLSearchParams({ all: String(all), participating: String(participating), per_page: String(per_page) });
      const endpoint = owner && repo
        ? `/repos/${owner}/${repo}/notifications?${query}`
        : `/notifications?${query}`;
      const data = await githubRequest(endpoint);
      if (!data.length) return { content: [{ type: "text", text: all ? "No notifications." : "No unread notifications." }] };
      const icon = (reason) => ({
        mention: "💬", review_requested: "👀", assign: "📌", author: "✍️",
        comment: "💬", state_change: "🔄", ci_activity: "🏗️",
      }[reason] || "🔔");
      const lines = data.map((n) =>
        `${icon(n.reason)} [${n.reason}] ${n.subject.type}: ${n.subject.title}\n` +
        `  ${n.repository.full_name} | updated ${n.updated_at.slice(0, 16).replace("T", " ")}${n.unread ? "" : " (read)"}`
      );
      return { content: [{ type: "text", text: lines.join("\n\n") }] };
    }
  );
}
