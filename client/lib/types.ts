export interface Attachment {
  id: string;
  name: string;
  preview?: string;
  file?: File;
}

export interface GithubRepo {
  id: number;
  name: string;
  fullName?: string;
  description?: string;
  url?: string;
  cloneUrl?: string;
  owner?: string;
  defaultBranch?: string;
  private: boolean;
  language?: string;
}

export interface ClarificationQuestion {
  key: string;
  question: string;
}

export interface WSMessage {
  type: string;
  payload: any;
  meta?: {
    requestId?: string;
    userId?: string;
    workspaceId?: string;
  };
}

export interface Workspace {
  _id: string;
  name: string;
  summary?: string;
  config?: { idea?: string; framework?: string };
  sandboxId?: string;
  port?: number;
  backendPort?: number;
  status?: string;
  updatedAt: number | string;
  github?: string;
  image?: string;
  deployments?: { cloudfrontUrl?: string; previewUrl?: string; status?: string }[];
}
