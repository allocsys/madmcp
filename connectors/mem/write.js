// ---------------------------------------------------------------------------
// connectors/mem/write.js — consolidated Mem0 write tool
//
// Consolidation of the old mem0_add, mem0_add_batch and mem0_update into one
// mem0_write tool dispatched on `action` ("add" | "add_batch" | "update").
// Behavior, request shapes and result shapes are identical to the originals;
// only required-ness moved from the zod schema into the handler (a missing
// param for the chosen action returns a clear isError result) and the
// tool-name pointers inside messages now name mem0_write.
//
// The shared helpers (entity_id lookup, relation cleaning, Tier 2 duplicate
// search, add-then-verify) stay in ./tools.js and are passed in by register()
// so this file has no circular import.
//
// See the long NOTE blocks at the top of ./tools.js for the history behind
// entity_id upsert, Tier 2 duplicate flagging/blocking, relations, add-then-
// verify, replacements and metadata_patch/metadata_delete_keys.
// ---------------------------------------------------------------------------

import { z } from "zod";
import { mem0Request } from "./client.js";
import { MEM0_USER_ID } from "../../config.js";

export function register(server, { STATUS_VALUES, BLOCKING_DUPLICATE_THRESHOLD, findByEntityId, processRelations, findPossibleDuplicates, verifyLanded }) {

  const relationsSchema = (desc) => z.array(z.object({
    to_entity_id: z.string().describe("The entity_id of the other entity this one relates to"),
    relation: z.string().describe("The relation type, e.g. 'blocks', 'depends_on', 'relates_to' — free text; known synonyms/variants are canonicalized automatically, unrecognized strings pass through unchanged"),
  })).optional().describe(desc);

  const batchItemSchema = z.object({
    content:    z.string().describe("The text or fact to remember (markdown supported)"),
    user_id:    z.string().optional().describe(`Mem0 user ID to scope this memory (default: ${MEM0_USER_ID})`),
    agent_id:   z.string().optional().describe("Optional agent ID for finer-grained scoping"),
    run_id:     z.string().optional().describe("Optional run/session ID for finer-grained scoping"),
    categories: z.array(z.string()).optional().describe("Optional tags for this memory — stored under metadata.tags (see the top-level categories param for why)"),
    entity_id:  z.string().optional().describe("Optional stable identifier for this fact/entity — see the top-level entity_id param. If a memory already exists for it, this item is skipped (not duplicated) and the existing id + content is reported instead."),
    status:     z.enum(STATUS_VALUES).optional().describe("Optional lifecycle status (open/resolved/superseded) — see the top-level status param."),
    relations:  relationsSchema("Optional list of relations for this item — see the top-level relations param."),
    metadata:   z.record(z.any()).optional().describe("Optional arbitrary metadata object for this memory"),
    infer:      z.boolean().optional().describe("If true, uses Mem0's LLM extraction to atomize/rephrase the content instead of storing it verbatim. Default: false."),
    skip_duplicate_check: z.boolean().optional().describe("If true, skip the Tier 2 similarity check for this item. Default: false — the check runs whether or not entity_id is given (an entity_id that doesn't exactly match an existing one still gets the semantic check)."),
    duplicate_threshold:  z.number().optional().describe("Minimum relevance score (0-1) to flag an existing memory as a possible duplicate of this item. Default: 0.75. Candidates below this are not considered at all, so a value above 0.92 also raises the hard-block cutoff to that value."),
  });

  server.tool(
    "mem0_write",
    "DOES: Add or update memories in your Mem0 workspace. MUTATES memory. Use `action` to pick.\n" +
    "RULE: action 'add' requires content and adds one new memory (Mem0 uses LLM extraction to store facts from your message; verbatim by default). If a memory already exists for the given entity_id, or existing content is near-identical (score >= 0.92), nothing is added and the existing id + content is returned so you can merge and call action 'update'.\n" +
    "RULE: action 'add_batch' requires items (non-empty) and adds several memories in one call to reduce round trips. Each item takes the same fields as 'add' and is submitted as its own extraction request; returns a per-item report.\n" +
    "RULE: action 'update' requires memory_id plus at least one of content, replacements, status, relations, metadata_patch, metadata_delete_keys or clear_duplicate_flag. `content` and `replacements` are mutually exclusive — use `replacements` for small edits to avoid resending the whole memory body.\n" +
    "RULE: params by action — 'add': content, user_id, agent_id, run_id, categories, entity_id, status, relations, metadata, infer, skip_duplicate_check, duplicate_threshold. 'add_batch': items only. 'update': memory_id, content, replacements, status, relations, metadata_patch, metadata_delete_keys, clear_duplicate_flag.",
    {
      action:     z.enum(["add", "add_batch", "update"]).describe("Which operation to perform"),
      content:    z.string().optional().describe("For 'add': the text or fact to remember (markdown supported). Required. For 'update': new content for the memory (replaces existing content in full); omit to change only the status/metadata, or use `replacements` for a targeted edit instead. Mutually exclusive with `replacements`."),
      user_id:    z.string().optional().describe(`Mem0 user ID to scope the memory (default: ${MEM0_USER_ID}). Used by 'add' only.`),
      agent_id:   z.string().optional().describe("Optional agent ID for finer-grained scoping (e.g. per-project), in addition to user_id. Used by 'add' only."),
      run_id:     z.string().optional().describe("Optional run/session ID for finer-grained scoping. Used by 'add' only."),
      categories: z.array(z.string()).optional().describe("Optional tags to attach to this memory (e.g. ['manager.js','decisions']) — stored under metadata.tags and used for later tag-filtered mem0_find, since Mem0's own category classifier can't be overridden per-call. Used by 'add' only."),
      entity_id:  z.string().optional().describe("Optional stable identifier for the fact/entity this memory is about (e.g. 'bug-4', 'nexus-file-naming'). BEFORE inventing a new one, use mem0_find for an existing entity on the same topic — entity_id only prevents duplicates when it EXACTLY matches a string used before; a new entity_id for something that already has a different entity_id will NOT be caught by the exact-match check (though it will still get flagged by the Tier 2 similarity check, so check the response for a possible_duplicate_of warning). If a memory already exists with this exact entity_id, 'add' will NOT create a duplicate — it returns the existing memory's id and content instead, so you can merge old + new content yourself (keeping everything not explicitly contradicted) and call action 'update'. Use this whenever you're recording an update to something you've stored before. Used by 'add' only."),
      status:     z.enum(STATUS_VALUES).optional().describe("Lifecycle status (open/resolved/superseded). For 'add': left unset by default; memories marked \"superseded\" are hidden from mem0_find by default. For 'update': omit to leave status unchanged; existing tags/entity_id/other metadata are preserved regardless."),
      relations:  relationsSchema("For 'add': optional list of relations from this memory's entity to others, e.g. [{to_entity_id:'bug-4', relation:'blocks'}]. Stored under metadata.relations. Requires this memory's own entity_id to be set for self-loop protection. Dangling to_entity_id values (no matching entity_id found yet) are flagged non-blocking. For 'update': REPLACES the existing metadata.relations array whole (not merged); omit to leave relations unchanged; pass an empty array to clear all relations."),
      metadata:   z.record(z.any()).optional().describe("Optional arbitrary metadata object to attach (e.g. {project: 'manager.js'}). Used by 'add' only; use metadata_patch for 'update'."),
      infer:      z.boolean().optional().describe("If true, uses Mem0's LLM extraction to atomize/rephrase the content into inferred facts instead of storing it verbatim. Default: false (stores content verbatim as a 'direct import') to prevent extraction from scattering or restructuring stored memories. With infer:true the landed-check can't match rephrased content, so it only runs when an entity_id is given; otherwise the response says landing was not verified. Used by 'add' only."),
      skip_duplicate_check: z.boolean().optional().describe("If true, skip the Tier 2 similarity check against existing memories. Default: false — the check runs automatically, including when entity_id is given but doesn't exactly match anything existing. Set true for bulk/import scenarios where the extra search call's latency isn't worth it. Used by 'add' only."),
      duplicate_threshold:  z.number().optional().describe("Minimum relevance score (0-1) for an existing memory to be flagged as a possible duplicate of this one. Default: 0.75. A candidate scoring >= 0.92 hard-blocks the add entirely (same as an exact entity_id match) rather than just flagging — but only candidates at or above this threshold are considered at all, so a threshold above 0.92 also raises the blocking cutoff to that value. Used by 'add' only."),
      items:      z.array(batchItemSchema).min(1).optional().describe("List of memories to add. Required (non-empty) for action 'add_batch'."),
      memory_id:  z.string().optional().describe("The memory ID to update. Required for action 'update'."),
      replacements: z.array(z.object({
        find:    z.string().describe("Exact string to find in the current memory content — must appear exactly once"),
        replace: z.string().describe("String to replace it with"),
      })).optional().describe("List of find-and-replace operations to apply sequentially to the memory's current content, without resending the full body. Each `find` must match exactly once in the content at the time it's applied (fails loudly on zero or multiple matches, same rule as the github edit_file tool's `replacements` mode). Mutually exclusive with `content`. Used by 'update' only."),
      metadata_patch: z.record(z.any()).optional().describe("Arbitrary metadata keys to merge into this memory's existing metadata (shallow merge — each key you supply overwrites that key only, everything else in metadata is preserved). Applied before metadata_delete_keys if both are given. Used by 'update' only."),
      metadata_delete_keys: z.array(z.string()).optional().describe("Arbitrary metadata keys to remove outright from this memory (e.g. ['possible_duplicate_of'] to clear a stale Tier-2 duplicate flag). Applied after metadata_patch. Used by 'update' only."),
      clear_duplicate_flag: z.boolean().optional().describe("Shorthand for metadata_delete_keys including 'possible_duplicate_of' — kept for convenience/back-compat. Used by 'update' only."),
    },
    async ({ action, content, user_id = MEM0_USER_ID, agent_id, run_id, categories, entity_id, status, relations, metadata, infer = false, skip_duplicate_check = false, duplicate_threshold = 0.75, items, memory_id, replacements, metadata_patch, metadata_delete_keys, clear_duplicate_flag }) => {

      // ── add ────────────────────────────────────────────────────────────────
      if (action === "add") {
        if (content === undefined) {
          return { content: [{ type: "text", text: "action 'add' requires content." }], isError: true };
        }
        if (entity_id) {
          const existing = await findByEntityId({ user_id, agent_id, run_id, entity_id });
          if (existing) {
            return {
              content: [{
                type: "text",
                text:
                  `Not adding — a memory already exists for entity_id "${entity_id}" (id: ${existing.id}). No duplicate was created.\n\n` +
                  `Existing content:\n${existing.memory || existing.text || "(no content)"}\n\n` +
                  `New content you were about to add:\n${content}\n\n` +
                  `Next step: merge these two yourself — keep everything from the existing content that the new content doesn't explicitly contradict — then call mem0_write with action 'update', memory_id="${existing.id}" and the merged text.`,
              }],
            };
          }
        }
        let duplicateWarning = "";
        const meta = { ...metadata };
        if (categories?.length) meta.tags = categories;
        if (entity_id) meta.entity_id = entity_id;
        if (status) meta.status = status;
        let relationWarnings = [];
        if (relations?.length) {
          const { relations: cleanedRelations, warnings } = await processRelations(relations, { ownEntityId: entity_id, user_id, agent_id, run_id });
          if (cleanedRelations.length) meta.relations = cleanedRelations;
          relationWarnings = warnings;
        }
        // Runs regardless of entity_id — an exact entity_id match already
        // returned early, so reaching here with entity_id set means it's a
        // *new* entity_id, which still needs this semantic check.
        if (!skip_duplicate_check) {
          const candidates = await findPossibleDuplicates({ user_id, agent_id, run_id, content, threshold: duplicate_threshold });
          const blocking = candidates.filter((c) => c.score >= BLOCKING_DUPLICATE_THRESHOLD);
          if (blocking.length) {
            const top = blocking[0];
            return {
              content: [{
                type: "text",
                text:
                  `Not adding — content is near-identical (score ${top.score.toFixed(2)} >= ${BLOCKING_DUPLICATE_THRESHOLD}) to existing memory ${top.id}. Hard-blocked, same as an exact entity_id match — no duplicate was created.\n\n` +
                  `Existing content:\n${top.memory || top.text || "(no content)"}\n\n` +
                  `New content you were about to add:\n${content}\n\n` +
                  `Next step: merge these two yourself — keep everything from the existing content that the new content doesn't explicitly contradict — then call mem0_write with action 'update', memory_id="${top.id}" and the merged text. If this really is distinct content despite the score, retry with skip_duplicate_check:true.`,
              }],
            };
          }
          if (candidates.length) {
            meta.possible_duplicate_of = candidates.map((c) => c.id);
            duplicateWarning =
              `\n\n⚠ Possible duplicate(s) found — added anyway (not blocked), flagged for review:\n` +
              candidates.map((c) => `  ${c.id} (score ${c.score.toFixed(2)}): ${(c.memory || c.text || "").slice(0, 70)}`).join("\n") +
              `\nCheck with mem0_inspect (action 'get'); if it's a real duplicate, merge via mem0_write (action 'update') and mark the stale one status="superseded".`;
          }
        }
        const messages = [{ role: "user", content }];
        const body = { messages, user_id, infer };
        if (agent_id) body.agent_id = agent_id;
        if (run_id) body.run_id = run_id;
        if (Object.keys(meta).length) body.metadata = meta;
        const data = await mem0Request("/v3/memories/add/", { method: "POST", body });
        const eventId = data.event_id || data.id;
        // infer:true without an entity_id can't be verified: Mem0 may have
        // rephrased the content, so the verbatim-content match would always
        // report a false "could not confirm" after a wasted 3s wait + list call.
        const verifiable = !(infer && !entity_id);
        const landed = verifiable ? await verifyLanded({ user_id, agent_id, run_id, entity_id, content }) : null;
        const landedNote = !verifiable
          ? ` Landing not verified — infer:true lets Mem0 rephrase the content so it can't be matched verbatim (pass an entity_id to enable the check). Re-run mem0_find shortly to confirm.`
          : landed
            ? ` Confirmed landed (id: ${landed.id}).`
            : `\n\n⚠ Could not confirm this memory landed after a single verification check (~3s wait; only the 20 most recent memories in scope are inspected) — Mem0's async job may have silently failed, or may just be slow (see madmcp-mem0-add-silent-failure-diagnostic). Re-run mem0_find shortly to check, and retry mem0_write (action 'add') if it's still missing.`;
        const relationNote = relationWarnings.length ? `\n\n⚠ Relations:\n${relationWarnings.map((w) => `  ${w}`).join("\n")}` : "";
        return {
          content: [{
            type: "text",
            text: (eventId
              ? `Memory extraction started (event_id: ${eventId}).${landedNote}`
              : `Memory added: ${JSON.stringify(data)}`) + duplicateWarning + relationNote,
          }],
        };
      }

      // ── add_batch ──────────────────────────────────────────────────────────
      if (action === "add_batch") {
        if (!items?.length) {
          return { content: [{ type: "text", text: "action 'add_batch' requires items (at least one)." }], isError: true };
        }
        // Items run concurrently and Mem0's add is async, so two items in ONE
        // batch can't see each other through findByEntityId or the Tier 2
        // search (neither has landed yet) and would both pass dedup. Catch the
        // deterministic cases up front: same scope + same entity_id, or (unless
        // skip_duplicate_check) same scope + identical trimmed/case-folded
        // content. First occurrence wins; later ones are skipped. Similar but
        // non-identical items inside one batch are still not caught here.
        const scopeKey = (it) => [it.user_id ?? MEM0_USER_ID, it.agent_id ?? "", it.run_id ?? ""].join("|");
        const seenBatchKeys = new Map();
        const inBatchDuplicateOf = items.map((it, idx) => {
          const keys = [];
          if (it.entity_id) keys.push(`e|${scopeKey(it)}|${it.entity_id}`);
          if (!it.skip_duplicate_check) keys.push(`c|${scopeKey(it)}|${(it.content || "").trim().toLowerCase()}`);
          let dupOf = null;
          for (const k of keys) {
            if (seenBatchKeys.has(k)) dupOf = dupOf ?? seenBatchKeys.get(k);
            else seenBatchKeys.set(k, idx);
          }
          return dupOf;
        });
        const results = await Promise.allSettled(items.map(async ({ content, user_id = MEM0_USER_ID, agent_id, run_id, categories, entity_id, status, relations, metadata, infer = false, skip_duplicate_check = false, duplicate_threshold = 0.75 }, idx) => {
          if (inBatchDuplicateOf[idx] !== null) {
            return { skipped: true, inBatch: true, ofIndex: inBatchDuplicateOf[idx] };
          }
          if (entity_id) {
            const existing = await findByEntityId({ user_id, agent_id, run_id, entity_id });
            if (existing) {
              return { skipped: true, entity_id, existingId: existing.id, existingContent: existing.memory || existing.text || "(no content)" };
            }
          }
          const meta = { ...metadata };
          if (categories?.length) meta.tags = categories;
          if (entity_id) meta.entity_id = entity_id;
          if (status) meta.status = status;
          let relationWarnings = [];
          if (relations?.length) {
            const { relations: cleanedRelations, warnings } = await processRelations(relations, { ownEntityId: entity_id, user_id, agent_id, run_id });
            if (cleanedRelations.length) meta.relations = cleanedRelations;
            relationWarnings = warnings;
          }
          let duplicatesFlagged = null;
          if (!skip_duplicate_check) {
            const candidates = await findPossibleDuplicates({ user_id, agent_id, run_id, content, threshold: duplicate_threshold });
            const blocking = candidates.filter((c) => c.score >= BLOCKING_DUPLICATE_THRESHOLD);
            if (blocking.length) {
              const top = blocking[0];
              return { skipped: true, blocked: true, existingId: top.id, existingScore: top.score, existingContent: top.memory || top.text || "(no content)" };
            }
            if (candidates.length) {
              meta.possible_duplicate_of = candidates.map((c) => c.id);
              duplicatesFlagged = candidates.map((c) => c.id);
            }
          }
          const body = { messages: [{ role: "user", content }], user_id, infer };
          if (agent_id) body.agent_id = agent_id;
          if (run_id) body.run_id = run_id;
          if (Object.keys(meta).length) body.metadata = meta;
          const result = await mem0Request("/v3/memories/add/", { method: "POST", body });
          // infer:true without an entity_id can't be matched verbatim -- see 'add'.
          const verifiable = !(infer && !entity_id);
          const landed = verifiable ? await verifyLanded({ user_id, agent_id, run_id, entity_id, content }) : null;
          return { ...result, duplicatesFlagged, relationWarnings, landed: !!landed, landedId: landed?.id, unverifiable: !verifiable };
        }));
        const lines = results.map((r, i) => {
          const title = (items[i].content || "").split("\n")[0].slice(0, 60);
          if (r.status === "fulfilled") {
            if (r.value?.skipped) {
              if (r.value.inBatch) {
                return `⏭ [${i}] "${title}" — skipped, duplicate of item [${r.value.ofIndex}] in this same batch (same entity_id or identical content). Send one merged item instead.`;
              }
              if (r.value.blocked) {
                return `⛔ [${i}] "${title}" — blocked, near-identical (score ${r.value.existingScore.toFixed(2)}) to existing memory (id: ${r.value.existingId}). No duplicate created. Merge and call mem0_write (action 'update') yourself if this content adds anything new.`;
              }
              return `⏭ [${i}] "${title}" — skipped, entity_id "${r.value.entity_id}" already exists (id: ${r.value.existingId}). Merge and call mem0_write (action 'update') yourself if this content adds anything new.`;
            }
            const eventId = r.value.event_id || r.value.id || "ok";
            const dupNote = r.value.duplicatesFlagged?.length ? ` ⚠ flagged as possible duplicate of ${r.value.duplicatesFlagged.join(", ")}` : "";
            const relNote = r.value.relationWarnings?.length ? ` ⚠ relations: ${r.value.relationWarnings.join("; ")}` : "";
            const landedNote = r.value.unverifiable
              ? ` — landing not verified (infer:true without entity_id can't be matched verbatim)`
              : r.value.landed ? ` — confirmed landed (id: ${r.value.landedId})` : ` — ⚠ could not confirm this landed, check manually`;
            return `✓ [${i}] "${title}" — event_id: ${eventId}${dupNote}${relNote}${landedNote}`;
          }
          return `✗ [${i}] "${title}" — error: ${r.reason?.message || r.reason}`;
        });
        return { content: [{ type: "text", text: lines.join("\n") }] };
      }

      // ── update ─────────────────────────────────────────────────────────────
      if (!memory_id) {
        return { content: [{ type: "text", text: "action 'update' requires memory_id." }], isError: true };
      }
      const deleteKeys = new Set(metadata_delete_keys || []);
      if (clear_duplicate_flag) deleteKeys.add("possible_duplicate_of");
      if (content === undefined && replacements === undefined && status === undefined && relations === undefined && metadata_patch === undefined && deleteKeys.size === 0) {
        return {
          content: [{ type: "text", text: "Nothing to update — provide content, replacements, status, relations, metadata_patch, metadata_delete_keys, or clear_duplicate_flag." }],
          isError: true,
        };
      }
      if (content !== undefined && replacements !== undefined) {
        return {
          content: [{ type: "text", text: "Provide either content or replacements, not both — they're mutually exclusive update modes." }],
          isError: true,
        };
      }
      // Mem0's PUT replaces the whole metadata object, so fetch current
      // metadata first and merge changes in client-side, rather than risk
      // wiping out tags/entity_id set at add-time. This fetch also supplies
      // the base text that `replacements` is applied against.
      const current = await mem0Request(`/v1/memories/${memory_id}/`);
      let finalText = current.memory || current.text || "";
      if (content !== undefined) {
        finalText = content;
      } else if (replacements !== undefined) {
        for (const { find, replace } of replacements) {
          const count = finalText.split(find).length - 1;
          if (count === 0) {
            return {
              content: [{ type: "text", text: `Update aborted, nothing written — "${find.slice(0, 60)}${find.length > 60 ? "…" : ""}" was not found in the current memory content. Content may have changed since you last read it — re-fetch with mem0_inspect (action 'get') and retry.` }],
              isError: true,
            };
          }
          if (count > 1) {
            return {
              content: [{ type: "text", text: `Update aborted, nothing written — "${find.slice(0, 60)}${find.length > 60 ? "…" : ""}" appears ${count} times in the current memory content, but must be unique. Include more surrounding context in "find" to disambiguate.` }],
              isError: true,
            };
          }
          finalText = finalText.replace(find, replace);
        }
      }
      let relationWarnings = [];
      const metadataUpdates = { ...(status !== undefined ? { status } : {}) };
      if (relations !== undefined) {
        const { relations: cleanedRelations, warnings } = await processRelations(relations, { ownEntityId: current.metadata?.entity_id, user_id: current.user_id || MEM0_USER_ID, agent_id: current.agent_id, run_id: current.run_id });
        metadataUpdates.relations = cleanedRelations;
        relationWarnings = warnings;
      }
      const finalMetadata = { ...current.metadata, ...metadataUpdates, ...metadata_patch };
      for (const key of deleteKeys) delete finalMetadata[key];
      const body = { text: finalText };
      if (Object.keys(finalMetadata).length) body.metadata = finalMetadata;
      const data = await mem0Request(`/v1/memories/${memory_id}/`, { method: "PUT", body });
      const parts = [];
      if (content !== undefined) parts.push("content replaced in full");
      if (replacements !== undefined) parts.push(`${replacements.length} targeted edit${replacements.length === 1 ? "" : "s"} applied`);
      if (status !== undefined) parts.push(`status set to "${status}"`);
      if (relations !== undefined) parts.push(`relations replaced (${metadataUpdates.relations.length} stored)`);
      if (metadata_patch !== undefined) parts.push(`metadata patched (${Object.keys(metadata_patch).join(", ")})`);
      if (deleteKeys.size) parts.push(`metadata keys removed (${[...deleteKeys].join(", ")})`);
      const relationNote = relationWarnings.length ? `\n\n⚠ Relations:\n${relationWarnings.map((w) => `  ${w}`).join("\n")}` : "";
      return { content: [{ type: "text", text: `Updated memory (ID: ${data.id || memory_id}) — ${parts.join(", ")}.\nUpdated: ${data.updated_at?.slice(0, 10) || "unknown"}${relationNote}` }] };
    }
  );
}
