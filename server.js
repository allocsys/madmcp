import express from "express";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

// ---------------------------------------------------------------------------
// In-memory data store
//
// NOTE: This resets whenever the server restarts/redeploys. That's fine for
// a first deploy. If you want notes to survive restarts, swap this out for
// a real database (e.g. Postgres, SQLite on a persistent volume, etc.) and
// replace the four functions below (listNotes/addNote/completeNote/deleteNote)
// with calls to that database.
// ---------------------------------------------------------------------------
const notes = new Map(); // id -> { id, text, done, createdAt }

function addNote(text) {
  const id = randomUUID().slice(0, 8);
  const note = { id, text, done: false, createdAt: new Date().toISOString() };
  notes.set(id, note);
  return note;
}

function listNotes({ includeDone = true } = {}) {
  const all = Array.from(notes.values()).sort((a, b) =>
    a.createdAt < b.createdAt ? -1 : 1
  );
  return includeDone ? all : all.filter((n) => !n.done);
}

function completeNote(id) {
  const note = notes.get(id);
  if (!note) return null;
  note.done = true;
  return note;
}

function deleteNote(id) {
  return notes.delete(id);
}

// ---------------------------------------------------------------------------
// MCP server definition
// ---------------------------------------------------------------------------
function buildServer() {
  const server = new McpServer({
    name: "notes-mcp-server",
    version: "1.0.0",
  });

  server.tool(
    "add_note",
    "Add a new note or todo item to the list.",
    { text: z.string().min(1).describe("The content of the note or todo item") },
    async ({ text }) => {
      const note = addNote(text);
      return {
        content: [
          {
            type: "text",
            text: `Added note ${note.id}: "${note.text}"`,
          },
        ],
      };
    }
  );

  server.tool(
    "list_notes",
    "List all notes/todos, optionally excluding completed ones.",
    {
      includeDone: z
        .boolean()
        .optional()
        .describe("Whether to include completed notes (default true)"),
    },
    async ({ includeDone }) => {
      const result = listNotes({ includeDone: includeDone ?? true });
      if (result.length === 0) {
        return { content: [{ type: "text", text: "No notes found." }] };
      }
      const lines = result.map(
        (n) => `[${n.done ? "x" : " "}] ${n.id} — ${n.text}`
      );
      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );

  server.tool(
    "complete_note",
    "Mark a note/todo as done by its ID.",
    { id: z.string().describe("The ID of the note to mark complete") },
    async ({ id }) => {
      const note = completeNote(id);
      if (!note) {
        return {
          content: [{ type: "text", text: `No note found with ID ${id}.` }],
          isError: true,
        };
      }
      return {
        content: [{ type: "text", text: `Marked "${note.text}" as done.` }],
      };
    }
  );

  server.tool(
    "delete_note",
    "Permanently delete a note/todo by its ID.",
    { id: z.string().describe("The ID of the note to delete") },
    async ({ id }) => {
      const ok = deleteNote(id);
      return {
        content: [
          {
            type: "text",
            text: ok ? `Deleted note ${id}.` : `No note found with ID ${id}.`,
          },
        ],
        isError: !ok,
      };
    }
  );

  return server;
}

// ---------------------------------------------------------------------------
// HTTP transport (stateless: a fresh MCP server/transport pair per request)
// ---------------------------------------------------------------------------
const app = express();
app.use(express.json());

app.get("/", (_req, res) => {
  res.json({ status: "ok", service: "notes-mcp-server" });
});

app.post("/mcp", async (req, res) => {
  try {
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless mode
    });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("MCP request error:", err);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`notes-mcp-server listening on port ${PORT}`);
});
