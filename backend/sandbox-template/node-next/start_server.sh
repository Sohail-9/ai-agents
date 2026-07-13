#!/bin/bash

# Configuration
FRONTEND_DIR="/workspace/frontend"
BACKEND_DIR="/workspace/backend"

# Start the Backend (Express + Drizzle)
if [ -d "$BACKEND_DIR" ]; then
  echo "🚀 Starting Backend (Express) on port 8000..."
  cd "$BACKEND_DIR"
  
  # Load environment variables if .env exists
  if [ -f .env ]; then
    export $(grep -v '^#' .env | xargs)
  fi

  # Run database migrations if DATABASE_URL is set
  if [ -n "$DATABASE_URL" ]; then
    echo "Running database migrations..."
    npm run db:push 2>/dev/null || echo "No migrations to run"
  fi

  # Start the backend in background
  export PORT=8000
  npm run dev &
fi

# Start the Frontend (Next.js)
if [ -d "$FRONTEND_DIR" ]; then
  echo "🚀 Starting Frontend (Next.js) on port 3000..."
  cd "$FRONTEND_DIR"
  npx next dev -H 0.0.0.0 -p 3000
fi
