export type MemoryCategory = 'config' | 'architecture' | 'errors' | 'preferences' | 'decisions';

export interface ErrorPattern {
  pattern: string;
  resolution: string;
  frequency: number;
  lastSeen: string; // ISO date
}

export interface DecisionRecord {
  decision: string;
  reason: string;
  createdAt: string; // ISO date
}

export interface StructuredMemory {
  config?: Record<string, unknown>;
  architecture?: Record<string, unknown>;
  errors?: ErrorPattern[];
  preferences?: Record<string, unknown>;
  decisions?: DecisionRecord[];
}
