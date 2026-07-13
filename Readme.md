# AI Agents

AI-powered code assistant that scaffolds and edits full-stack projects inside E2B sandboxes.

## Setup Instructions

1. Rename configuration files:
   - `backend/.env.example` -> `backend/.env`
   - `client/.env.example` -> `client/.env`
2. Install dependencies:
   ```bash
   npm install
   ```
3. Generate database client:
   ```bash
   npm run generate
   ```
4. Start development services:
   ```bash
   npm run dev
   ```

For detailed architecture and command references, see CLAUDE.md.
