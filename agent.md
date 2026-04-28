# Agent

Working notes based on the `more-connect` project analysis.

## Purpose
- Provide quick reference for the VS Code extension (`More Connect`) structure, commands, and operational details.
- Share common context for maintenance and release work.

## Project Summary
- Name: `more-connect`
- Type: VS Code Extension (Node.js + TypeScript)
- Description: Tool for MySQL/MariaDB/PostgreSQL/SQLite/Oracle/Redis connections and query execution.
- Entry: `dist/extension.js` (source: `src/extension.ts`)
- Minimum VS Code version: `^1.85.0`

## Tech Stack
- Language: TypeScript
- Bundling: `esbuild` (`scripts/esbuild.mjs`)
- Main dependencies: `mysql2`, `pg`, `ssh2`
- Optional runtime drivers: `sqlite3`, `oracledb` (installed in the global storage drivers path)

## Main Directories
- `src/db`: DB client implementations (mysql/postgres/sqlite/oracle/redis + factory)
- `src/ui`: Explorer tree, results panel, info panel, connection wizard
- `src/ssh`: SSH configuration, storage, and tunnel management
- `scripts/esbuild.mjs`: Build and watch
- `dist`: Build output

## Common Commands
- Install dependencies: `npm i`
- Build: `npm run build`
- Development watch: `npm run dev`
- Package: `npm run vsc:pac`
- Publish: `npm run vsc:pub`

## Main Extension Features
- Add/edit/duplicate/remove connections, connect/disconnect
- Run SQL from input, editor selection, or current line
- Preview tables, refresh schema, view database/table info
- Add/edit/remove SSH connections, import `~/.ssh/config`
- Run/save SQL files, run SQL favorites

## Operational Notes
- Passwords use VS Code Secret Storage.
- `vsc:pub` increments the patch version, packages, and publishes.
- If publishing fails, check PAT expiration first (`vsce login` re-authentication).

## Notes
- TODO:
  - Document the test/verification checklist.
  - Review error handling consistency by DB type.
  - Organize command UX for messages, loading states, and failure cases.
