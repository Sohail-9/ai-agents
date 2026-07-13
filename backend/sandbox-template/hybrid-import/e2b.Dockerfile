FROM ubuntu:22.04

# Avoid interactive prompts
ENV DEBIAN_FRONTEND=noninteractive

# Install system dependencies: Node.js 21, Python 3, git, curl, wget, unzip, build tools
RUN apt-get update && apt-get install -y \
  curl \
  git \
  wget \
  unzip \
  build-essential \
  python3 \
  python3-pip \
  python3-venv \
  ca-certificates \
  gnupg \
  && apt-get clean \
  && rm -rf /var/lib/apt/lists/*

# Install Node.js 21 via NodeSource
RUN curl -fsSL https://deb.nodesource.com/setup_21.x | bash - \
  && apt-get install -y nodejs \
  && apt-get clean \
  && rm -rf /var/lib/apt/lists/*

# Install pnpm and yarn globally (agents may need them)
RUN npm install -g pnpm yarn

# Verify tools
RUN node -v && npm -v && git --version && python3 --version

# Working directory — repo will be cloned here by the agent
WORKDIR /workspace

# Pre-create workspace dirs and make them world-writable so the sandbox
# non-root user (e2b / user) can clone into them without permission errors.
RUN mkdir -p /workspace/repo && chmod -R 777 /workspace

# Expose common dev-server ports
EXPOSE 3000
EXPOSE 5173
EXPOSE 8000
EXPOSE 4173
