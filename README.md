# notes-mcp-server

A minimal MCP (Model Context Protocol) server for managing notes/todos.
Built to be deployed on Manufact Cloud.

## Tools

- **add_note** — add a new note/todo (`text`)
- **list_notes** — list all notes, optionally filtering out completed ones (`includeDone`)
- **complete_note** — mark a note as done (`id`)
- **delete_note** — permanently remove a note (`id`)

## Storage

Notes are stored **in memory**. They will reset whenever the server restarts
or redeploys. This is intentional for a first, simple deployment. To persist
data across restarts, swap the in-memory `Map` in `server.js` for a real
database.

## Running locally

```bash
npm install
npm start
```

The server listens on `PORT` (default `8080`) and exposes the MCP endpoint
at `POST /mcp` (stateless streamable-HTTP transport). A basic health check
is available at `GET /`.

## Deploying

This repo is set up to deploy directly to Manufact Cloud:
- Start command: `npm start`
- Port: `8080` (or whatever `PORT` is set to in the environment)
