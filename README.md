# More Connect

More Connect is a VS Code extension for working with databases, servers, REST APIs, Docker hosts, web links, and local development tools from one sidebar.

It is designed for developers who want quick access to connection targets and common actions without leaving VS Code.

## Main Features

### Database Connections

More Connect supports:

- MySQL
- MariaDB
- PostgreSQL
- SQLite
- Oracle
- Redis

With the database explorer you can:

- Add, edit, duplicate, reorder, and remove connections
- Connect and disconnect from saved databases
- Browse databases and tables
- Run SQL from the editor or from saved snippets
- Preview table data
- Save favorite SQL per connection and database

Redis browser:

- Supports Redis instances with or without authentication
- Uses saved passwords from VS Code Secret Storage when present
- Supports Redis ACL authentication with username and password
- Shows only Redis DB indexes that contain data

Passwords are stored in VS Code Secret Storage.

## S3 Browser (AWS S3 / MinIO)

Manage S3-compatible hosts and browse buckets and objects from the sidebar.

- Add/edit/remove S3 hosts (AWS S3, MinIO, S3 compatible)
- List buckets, folders, and files (tree view)
- Upload file / upload local folder (recursive)
- Create folder (creates a trailing-slash object)
- Delete file or delete folder (recursive)

S3 secrets are stored in VS Code Secret Storage.

## SSH Connections

Manage SSH targets directly from the sidebar.

- Add, edit, remove, and reorder SSH hosts
- Import hosts from `~/.ssh/config`
- Open an SSH terminal from a saved target
- Open **SSH File Explorer** to browse and download files over SSH (no `ssh2` driver required)

SSH File Explorer:

- Starts at the remote home folder (`~`)
- Navigate with `..`, folder click, or typing a path (breadcrumbs support quick jumps)
- Shows name, size, owner/group, and permissions
- View small files inside VS Code
- Download files via `scp`
- Delete files/folders (with confirmation)

Notes:

- Uses your system `ssh`/`scp` in non-interactive mode (key/agent auth recommended)
- If it’s the first time connecting to a host, run `ssh user@host` once in a terminal to accept the host key

## REST API Explorer

More Connect includes a REST client and REST tree explorer.

- Create collections, folders, and requests
- Rename, duplicate, delete, and reorder REST items
- Organize requests in a tree structure
- Open and run REST requests inside VS Code
- Manage environments and imported REST data

## Docker Explorer

Add Docker hosts and inspect resources from the sidebar.

Supported host formats:

- `unix:///var/run/docker.sock`
- `ssh://...`
- `tcp://...`

For each Docker host, you can view:

- Containers
- Images
- Volumes
- Networks

Container actions:

- Open a shell inside a running container
- Start a stopped container
- Stop a running container
- Force remove a container

Image actions:

- Force remove an image

## LLM Endpoints

The extension also supports local and remote LLM endpoints.

- Manage Ollama and vLLM endpoints
- Browse available models
- Pull and delete Ollama models
- Open chat sessions inside VS Code
- View model information such as size, quantization, and context length
- Save chat sessions by model

## VS Code Favorites

Save frequently used folders and workspace files for quick access.

- Add folders or `.code-workspace` files
- Add Remote SSH folders with `vscode-remote://ssh-remote+host/path`
- Open favorites in a new VS Code window
- Manage saved entries from the sidebar

## Web Links

Keep useful development URLs in one place.

- Save internal tools, dashboards, and documentation links
- Open links quickly from the explorer

## Storage

Saved data can use a shared storage folder so connection information and related settings stay together.

This includes:

- Database connections
- SSH connections
- Web links
- REST API data
- Docker hosts
- S3 hosts
- VS Code favorites
- Ollama/vLLM endpoints

## Sidebar Overview

The More Connect sidebar includes:

- DB Connections
- SSH Connections
- Web Links
- REST APIs
- S3 Browser
- Docker
- Folder/Workspace Favorites
- LLM (Ollama/vLLM)

## Use Cases

More Connect is useful when you want to:

- query databases without leaving VS Code
- keep SSH, REST, Docker, and database targets together
- manage local development environments from one explorer
- switch quickly between infrastructure, APIs, and data tools
