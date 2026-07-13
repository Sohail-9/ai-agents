export interface ChatImage {
    id: string;
    filename: string;
    mimeType: string;
    width?: number;
    height?: number;
}

export interface ChatMessage {
    id: string;
    role: "user" | "assistant" | "system" | "agent";
    content: string;
    eventType?: string;
    thinking?: string;
    toolCall?: string;
    toolCallId?: string;
    toolArgs?: Record<string, any>;
    toolArgsStream?: string;
    commandExecution?: {
        command: string;
        output: string;
    };
    modifiedFiles?: string[];
    timestamp?: number;
    subAgentSummary?: SubAgentState[];
    images?: ChatImage[];
}

export interface TodoItem {
    id: string;
    title: string;
    description?: string;
    status: "pending" | "completed" | "in_progress";
    order: number;
    createdAt?: string | Date;
}

export interface WSEvent {
    type: string;
    payload: Record<string, unknown>;
    meta?: {
        requestId?: string;
        workspaceId?: string;
        userId?: string;
        timestamp?: number;
    };
}

export interface PlanOption {
    id: string;
    text: string;
}

export interface PlanQuestion {
    id: string;
    question: string;
    options: PlanOption[];
}

export interface PlanQuestionsData {
    questions: PlanQuestion[];
    summary?: string;
}

export interface PlanReadyData {
    content: string;
    path: string;
}

export interface FileNode {
    path: string;
    type: "file" | "directory";
    size?: number;
    children?: FileNode[];
    isOpen?: boolean;
}

export interface Commit {
    sha: string;
    shortSha: string;
    message: string;
    timestamp: string;
    author?: string;
}

export interface FileContent {
    path: string;
    content: string;
    size?: number;
    language?: string;
}

export interface CommitDetails {
    sha: string;
    message: string;
    timestamp: string;
    author?: string;
    files?: FileNode[];
}

export interface SubAgentLog {
    type: "goal" | "thinking" | "tool_started" | "tool_completed" | "complete";
    message: string;
    tool?: string;
    timestamp: number;
}

export interface SubAgentState {
    name: string;
    displayName: string;
    status: string;
    logs: SubAgentLog[];
    isComplete: boolean;
    currentTool?: string;
}
