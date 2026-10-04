---
name: open-tasklane
description: Open or reuse a TaskLane board in the native Codex application panel. Use when the user asks to open TaskLane, a project board, or the global board. Honor explicit requests to use a browser or local web page.
---

Open the native application panel through TaskLane's `open_tasklane` MCP tool. If the tool is not exposed, use the environment's tool discovery capability to find it. If it remains unavailable, report that the plugin is not loaded or the tool is not provided.

Once the connected panel identifies Codex, handle its actual execution request with `native-execution`; check native capabilities inside that request, without a separate verification chat or `nativeExecution` declaration.

- Project conversation: explicitly pass the absolute path of the current conversation's workspace as `projectDir`. Do not use the plugin installation directory or infer the path from another conversation. Pass `baseBranch` if the user specifies a base branch; otherwise, the current implementation defaults to `main`. Example: `open_tasklane({ projectDir: "/path/to/current-workspace" })`.
- An initialized Git repository with no commits can open a board when `baseBranch` matches its current unborn branch. For a repository initialized with `git init -b master`, pass `baseBranch: "master"`. Opening a board, creating or editing tasks, assignment and manual status changes do not require commits. Assignment only changes ownership; it never creates a chat or a Git workspace. Independent native workspaces require explicit user selection and actual Codex capability. Never create the first commit on the user's behalf to open a board or enable a workspace.
- Global board: call `open_tasklane({})` only when the user explicitly requests the global board or the conversation has no project context. The host displays global and thread entrypoints, but an entrypoint does not guarantee that the host automatically supplies `projectDir`.
- Reuse an existing panel when you can confirm that it belongs to the requested project or global scope. Call the tool again when the user asks to reopen or refresh it.
- If the tool returns an error, explain the specific cause, such as an invalid base branch or an invalid path. Do not fall back to the global board or a browser URL, or start a bridge on your own. Do not create Git commits merely to open the board.
- Use browser mode only when the user explicitly requests it. Verify the native panel and standalone browser separately; a successful tool call does not confirm that the host displayed the panel correctly.
