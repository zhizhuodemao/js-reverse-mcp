# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build and Development Commands

```bash
# Install dependencies
npm ci

# Build the project (TypeScript compilation + post-build scripts)
npm run build

# Run all tests
npm test

# Run a single test file (after building)
node --require ./build/tests/setup.js --no-warnings=ExperimentalWarning --test-reporter spec --test-force-exit --test "build/tests/path/to/test.test.js"

# Run only tests marked with { only: true }
npm run test:only

# Update test snapshots
npm run test:update-snapshots

# Type checking without emitting
npm run typecheck

# Lint and format
npm run format

# Check formatting without fixing
npm run check-format

# Start the MCP server (builds first)
npm run start

# Start with debug logging
npm run start-debug

# Generate documentation (after changing tools)
npm run docs
```

## Testing with MCP Inspector

```bash
npx @modelcontextprotocol/inspector node build/src/index.js
```

## Architecture Overview

This is an MCP (Model Context Protocol) server that exposes Chrome DevTools functionality to AI coding assistants via Puppeteer.

### Core Components

- **`src/main.ts`**: Entry point. Creates the MCP server, registers all tools, and handles tool execution with mutex-based serialization.

- **`src/McpContext.ts`**: Central state management class. Maintains:
  - Browser and page state (selected page, page list)
  - Accessibility tree snapshots for element interaction
  - Network and console collectors
  - Debugger context for script/breakpoint management
  - Performance trace state

- **`src/McpResponse.ts`**: Response builder that tools use to construct their output (text, images, snapshots, network data, console data).

- **`src/browser.ts`**: Browser lifecycle management. Handles launching new Chrome instances or connecting to existing ones via browserURL/wsEndpoint.

### Tool System

Tools are defined in `src/tools/` using the `defineTool()` helper from `src/tools/ToolDefinition.ts`. Each tool has:

- `name`: Tool identifier
- `description`: For MCP clients
- `annotations`: Category and read-only hint
- `schema`: Zod schema for input validation
- `handler`: Implementation that receives request, response builder, and context

Tool categories are defined in `src/tools/categories.ts` and can be disabled via CLI flags (e.g., `--categoryNetwork=false`).

### Data Collection

- **`src/PageCollector.ts`**: Base class for collecting page events. Extended by `NetworkCollector` and `ConsoleCollector` to track requests and console messages across pages.

- **`src/formatters/`**: Convert collected data to text format for MCP responses.

### Third-Party Integration

- **`src/third_party/index.ts`**: Re-exports from bundled dependencies (puppeteer, @modelcontextprotocol/sdk, zod).

- **`chrome-devtools-frontend`**: Used for performance trace analysis and issue descriptions. Included via tsconfig.json.

### Testing

Tests use Node.js built-in test runner. Test files mirror source structure under `tests/`. Snapshots are stored alongside test files with `.snapshot` extension.

- `tests/setup.ts`: Configures snapshot paths and serializers
- `tests/server.ts`: Test utilities for MCP server testing
- `tests/utils.ts`: Shared test helpers

## Conventions

- Follow [conventional commits](https://www.conventionalcommits.org/) for PR and commit titles
- Run `npm run docs` after adding or modifying tools to update documentation
- Node version: v22 (see .nvmrc)
