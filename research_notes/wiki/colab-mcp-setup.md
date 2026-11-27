# Google Colab MCP Server Setup

Documented 2026-11-23 following installation and verification on this machine.

## Overview and Upstream Source
Google's official Colab MCP server connects local AI clients (such as Claude Code) to Google Colab sessions running in a local browser.

- **Announcement**: [Announcing the Colab MCP Server: Connect Any AI Agent to Google Colab](https://developers.googleblog.com/announcing-the-colab-mcp-server-connect-any-ai-agent-to-google-colab/) (Google Developers Blog)
- **Official Repository**: [googlecolab/colab-mcp](https://github.com/googlecolab/colab-mcp)
- **Installed Release / Version**: `v1.0.2` (tag `v1.0.2`, commit `b85ab6ec5206e06fdd289ff4ff3f9c4ee767b422`; repository HEAD `b9ab3899e0f1fa493390b1fd6d54aa2e464ecdf1`)

## Prerequisites & Installation
- **Prerequisites**: Python (>=3.13), git, `uv` / `uvx` package manager (`uv 0.13.9` installed to `/home/yacine105/.local/bin`), an MCP client supporting `notifications/tools/list_changed`.
- **Install Command**:
  ```bash
  claude mcp add --scope user colab-mcp -- uvx git+https://github.com/googlecolab/colab-mcp@v1.0.2
  ```
- **Configuration Scope**: User scope (`~/.claude.json`), accessible across all projects on this machine.
- **Verification Status**: `claude mcp list` confirms `colab-mcp: uvx git+https://github.com/googlecolab/colab-mcp@v1.0.2 - ✔ Connected`.

## Tool List & Architecture
The server operates as a local WebSocket proxy (`colab_mcp.websocket_server.ColabWebSocketServer` on an ephemeral localhost port) bridging Claude Code to the browser frontend:

1. **Bootstrap Tool (Initially Visible)**:
   - `open_colab_browser_connection`: Generates a single-use proxy token and port, and directs the browser to `https://colab.research.google.com/notebooks/empty.ipynb#mcpProxyToken=<token>&mcpProxyPort=<port>`.
2. **Notebook Management Tools (Dynamically Injected)**:
   Once the Colab browser tab attaches to the local WebSocket, the server fires `notifications/tools/list_changed` to dynamically expose:
   - `add_code_cell`: Insert executable Python code cell.
   - `add_text_cell`: Insert markdown/text block.
   - `update_cell`: Modify content of an existing cell.
   - `get_cells`: Retrieve notebook cell structure and contents.
   - `move_cell`: Reorder cells within the notebook.
   - `delete_cell`: Remove an existing cell.
   - `run_code_cell`: Execute a code cell and receive live output/tracebacks.

## User-Side Steps to Connect
1. Ensure Google Colab is open in the browser and logged into the intended Google account.
2. When Claude Code executes `open_colab_browser_connection`, a new Colab tab opens automatically (or the user visits the provided URL fragment).
3. The user approves/connects the browser tab to the local server session.
4. Once connected, the agent receives the full suite of notebook tools to build and execute code.

## Known Limits & GPU Selection
- **GPU Runtime Selection**: The official `colab-mcp` server **cannot** programmatically select or change the GPU/TPU accelerator type (verified in `session.py` and upstream Discussions #47, #69, #74). The user must manually select their desired hardware accelerator (e.g., T4, L4, A100) via the Colab UI menu: **Runtime** -> **Change runtime type**.
- **Client Dynamic Tools Requirement**: The client must support `notifications/tools/list_changed`. If unsupported, only `open_colab_browser_connection` is visible.
- **Exclusivity**: Only one browser session can connect to the proxy at a time (concurrent connection attempts are rejected with HTTP 1013 "Server is busy").

Related: [decision-2026-11-23-colab-hybrid](decision-2026-11-23-colab-hybrid.md), [hunyuan3d-21-feasibility](hunyuan3d-21-feasibility.md), [goal-trellis-41-dish-page](goal-trellis-41-dish-page.md).
