'use client';

import React, { createContext, useContext, useReducer, ReactNode } from 'react';

export interface DirtyFile {
  original: string;
  current: string;
  addedLines: number;
  removedLines: number;
  status: 'M' | 'A' | 'D';
}

export interface DirtyState {
  files: Map<string, DirtyFile>;
}

export type DirtyAction =
  | { type: 'SET_ORIGINAL'; path: string; content: string }
  | { type: 'UPDATE'; path: string; content: string }
  | { type: 'MARK_DELETED'; path: string }
  | { type: 'CLEAR_ALL' }
  | { type: 'CLEAR_FILE'; path: string };

function countLines(content: string): number {
  return (content.match(/\n/g) || []).length;
}

export function dirtyReducer(state: DirtyState, action: DirtyAction): DirtyState {
  const newFiles = new Map(state.files);

  switch (action.type) {
    case 'SET_ORIGINAL': {
      if (newFiles.has(action.path)) {
        const existing = newFiles.get(action.path)!;
        existing.original = action.content;
        existing.current = action.content;
        if (existing.current === existing.original) {
          newFiles.delete(action.path);
        }
      } else {
        newFiles.set(action.path, {
          original: action.content,
          current: action.content,
          addedLines: 0,
          removedLines: 0,
          status: 'M',
        });
        newFiles.delete(action.path);
      }
      return { files: newFiles };
    }

    case 'UPDATE': {
      const dirty = newFiles.get(action.path) || {
        original: '',
        current: '',
        addedLines: 0,
        removedLines: 0,
        status: 'M' as const,
      };

      const newContent = action.content;
      const originalLineCount = countLines(dirty.original);
      const newLineCount = countLines(newContent);
      const addedLines = Math.max(0, newLineCount - originalLineCount);
      const removedLines = Math.max(0, originalLineCount - newLineCount);

      if (newContent === dirty.original) {
        newFiles.delete(action.path);
      } else {
        newFiles.set(action.path, {
          original: dirty.original,
          current: newContent,
          addedLines,
          removedLines,
          status: 'M',
        });
      }
      return { files: newFiles };
    }

    case 'MARK_DELETED': {
      const dirty = newFiles.get(action.path) || {
        original: '',
        current: '',
        addedLines: 0,
        removedLines: 0,
        status: 'D' as const,
      };
      newFiles.set(action.path, {
        ...dirty,
        status: 'D',
        current: '',
      });
      return { files: newFiles };
    }

    case 'CLEAR_ALL': {
      return { files: new Map() };
    }

    case 'CLEAR_FILE': {
      newFiles.delete(action.path);
      return { files: newFiles };
    }

    default:
      return state;
  }
}

const DirtyStateContext = createContext<{
  state: DirtyState;
  dispatch: React.Dispatch<DirtyAction>;
} | undefined>(undefined);

export function DirtyStateProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(dirtyReducer, { files: new Map() });

  return (
    <DirtyStateContext.Provider value={{ state, dispatch }}>
      {children}
    </DirtyStateContext.Provider>
  );
}

export function useDirtyState() {
  const context = useContext(DirtyStateContext);
  if (!context) {
    throw new Error('useDirtyState must be used inside DirtyStateProvider');
  }
  return context;
}
