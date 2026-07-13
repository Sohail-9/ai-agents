FROM node:21-slim

# Arguments for cache busting and version control
ARG FRONTEND_COMMIT=cc505df8632fa71ec94660d169408aaa3430a60c
ARG BACKEND_COMMIT=master

# Install system dependencies
RUN apt-get update && apt-get install -y \
  git \
  curl \
  && apt-get clean \
  && rm -rf /var/lib/apt/lists/*

# Base directory for the application
WORKDIR /workspace

# 1. Setup Backend (Express + Drizzle)
RUN echo "Building backend at commit: ${BACKEND_COMMIT}"
RUN git clone https://github.com/PrettiFlow/express-backend-template.git ./backend \
  && cd ./backend \
  && git checkout ${BACKEND_COMMIT} \
  && npm install

# 2. Setup Frontend (Next.js)
RUN echo "Building frontend at commit: ${FRONTEND_COMMIT}"
RUN git clone https://github.com/PrettiFlow/pettiflow-nextjs-template.git ./frontend \
  && cd ./frontend \
  && git checkout ${FRONTEND_COMMIT} \
  && npm install

# Copy start script
COPY start_server.sh /start_server.sh
RUN chmod +x /start_server.sh

# Expose ports: 3000 (Frontend), 8000 (Backend)
EXPOSE 3000
EXPOSE 8000

# Metadata
ENV FRONTEND_DIR=/workspace/frontend
ENV BACKEND_DIR=/workspace/backend

WORKDIR /workspace
