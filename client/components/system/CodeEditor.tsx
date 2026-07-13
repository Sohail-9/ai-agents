'use client';

import React, { useEffect, useRef, forwardRef } from 'react';
import { EditorState } from '@codemirror/state';
import {
  EditorView,
  lineNumbers,
  highlightActiveLine,
  keymap,
} from '@codemirror/view';
import { indentWithTab } from '@codemirror/commands';
import { LanguageSupport, language } from '@codemirror/language';
import { javascript } from '@codemirror/lang-javascript';
import { python } from '@codemirror/lang-python';
import { css } from '@codemirror/lang-css';
import { html } from '@codemirror/lang-html';
import { json } from '@codemirror/lang-json';
import { markdown } from '@codemirror/lang-markdown';
import { oneDark } from '@codemirror/theme-one-dark';

interface CodeEditorProps {
  path: string;
  content: string;
  onChange: (newContent: string) => void;
  readOnly?: boolean;
}

function getLanguageSupport(filePath: string): LanguageSupport | null {
  const ext = filePath.split('.').pop()?.toLowerCase() || '';

  const map: Record<string, LanguageSupport> = {
    ts: javascript({ typescript: true }),
    tsx: javascript({ typescript: true, jsx: true }),
    js: javascript(),
    jsx: javascript({ jsx: true }),
    py: python(),
    css: css(),
    scss: css(),
    html: html(),
    htm: html(),
    json: json(),
    md: markdown(),
    markdown: markdown(),
  };

  return map[ext] || null;
}

const CodeEditor = forwardRef<HTMLDivElement, CodeEditorProps>(
  ({ path, content, onChange, readOnly = false }, ref) => {
    const containerRef = useRef<HTMLDivElement>(null);
    const viewRef = useRef<EditorView | null>(null);
    const lastPathRef = useRef(path);

    const theme = EditorView.theme({
      '&': {
        background: '#0d0d0f',
        height: '100%',
        cursor: 'text',
        fontSize: '12px',
        fontFamily: 'monospace',
      },
      '.cm-content': {
        caretColor: '#E93D82',
        padding: '16px 0',
        lineHeight: '1.65',
      },
      '.cm-activeLine': {
        backgroundColor: 'rgba(255, 255, 255, 0.03)',
      },
      '.cm-activeLineGutter': {
        backgroundColor: 'rgba(255, 255, 255, 0.03)',
      },
      '.cm-cursor': {
        borderLeftColor: '#E93D82',
        borderLeftWidth: '2px',
      },
      '.cm-cursor-primary': {
        borderLeftColor: '#E93D82',
      },
      '.cm-gutters': {
        background: '#0d0d0f',
        border: 'none',
        color: 'rgba(255, 255, 255, 0.15)',
      },
      '.cm-lineNumbers .cm-gutterElement': {
        padding: '0 8px 0 4px',
        width: 'auto',
        minWidth: '40px',
      },
    }, { dark: true });

    useEffect(() => {
      if (!containerRef.current) return;

      const langSupport = getLanguageSupport(path);
      const extensions = [
        lineNumbers(),
        highlightActiveLine(),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            const newContent = update.state.doc.toString();
            onChange(newContent);
          }
        }),
        keymap.of([indentWithTab]),
        langSupport ?? [],
        theme,
        oneDark,
        EditorState.allowMultipleSelections.of(true),
      ];

      const state = EditorState.create({
        doc: content,
        extensions,
      });

      const view = new EditorView({
        state,
        parent: containerRef.current,
      });

      viewRef.current = view;
      lastPathRef.current = path;

      return () => {
        view.destroy();
        viewRef.current = null;
      };
    }, []);

    useEffect(() => {
      if (!viewRef.current) return;

      if (path !== lastPathRef.current) {
        const langSupport = getLanguageSupport(path);
        const extensions = [
          lineNumbers(),
          highlightActiveLine(),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) {
              const newContent = update.state.doc.toString();
              onChange(newContent);
            }
          }),
          keymap.of([indentWithTab]),
          langSupport ?? [],
          theme,
          oneDark,
        ];

        const newState = EditorState.create({
          doc: content,
          extensions,
        });

        viewRef.current.setState(newState);
        lastPathRef.current = path;
      } else if (viewRef.current.state.doc.toString() !== content) {
        viewRef.current.dispatch({
          changes: {
            from: 0,
            to: viewRef.current.state.doc.length,
            insert: content,
          },
        });
      }
    }, [path, content, onChange]);

    return (
      <div
        ref={containerRef}
        className="flex-1 overflow-hidden bg-[#0d0d0f] rounded-lg border border-[#161618]"
        style={{ height: '100%' }}
      />
    );
  }
);

CodeEditor.displayName = 'CodeEditor';

export default CodeEditor;
