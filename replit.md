# Workspace

## Overview

pnpm workspace monorepo using TypeScript. Each package manages its own dependencies. The API server now also runs a Telegram WhatsApp automation bot through grammY when `TELEGRAM_BOT_TOKEN` is configured.

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **API framework**: Express 5
- **Telegram bot**: grammY
- **WhatsApp automation**: Baileys
- **Database**: PostgreSQL + Drizzle ORM; optional MongoDB for Telegram bot user/session persistence
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **API codegen**: Orval (from OpenAPI spec)
- **Build**: esbuild (CJS bundle)

## Recent Changes

- Auto Chat hides the 2nd WhatsApp connect button after the second account is connected and shows live status with message counts and a stop button.
- Chat Friend now runs continuously until stopped and uses random delay rotation across 10 seconds, 1 minute, 10 minutes, 20 minutes, 30 minutes, 1 hour, and 2 hours.
- Chat Friend stop now cancels any pending delay before another message can be sent, and the status message shows the next delay immediately.
- Group Auto Chat no longer asks for a manual message; it rotates funny/study messages across all selected common groups until stopped, with 5 minutes to 2 hours random delay rotation.
- `/help` now includes the Auto Chat feature, covering 2nd WhatsApp setup, Chat Friend, group rotation, delay rotation, live status, refresh, and stop controls.
- Auto Chat bot screens and `/help` copy are in English while WhatsApp auto-chat messages remain Hinglish/original.

## Key Commands

- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- `pnpm --filter @workspace/api-server run dev` — run API server and Telegram bot locally

## Bot Configuration

- `TELEGRAM_BOT_TOKEN` is required for the Telegram bot to start.
- `MONGODB_URI` is optional at startup, but needed for persisted bot data and WhatsApp session restore.
- `MONGODB_DB_NAME` defaults to `whatsapp_bot` when not set.
- `ADMIN_USER_ID` and `FORCE_SUB_CHANNEL` are optional bot controls.

## GitHub Access Note

- The GitHub integration flow was dismissed, so repository publishing used the `GITHUB_TOKEN` secret instead.

See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details.
