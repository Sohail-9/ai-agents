Add Hard Guardrails for Language/Framework Drift in Agent System Prompt

We need to fix agent language/framework drift where the agent generates code in technologies outside the workspace stack (e.g. Python code inside a TypeScript + Next.js workspace).

Problem

Currently, the agent’s system prompt is generic and does not enforce strict stack boundaries per workspace.

Because of this:

Agent may generate Python code in a Node/TypeScript workspace
Agent may use Flask/FastAPI when backend stack is Node
Agent may introduce React Native / Vue / other frameworks when workspace is Next.js
Drift can happen mid-iteration, even if earlier steps were correct

This creates invalid code, broken execution, and wasted loops.

Goal

Inject workspace-specific hard rules into the system prompt dynamically on:

initial system prompt creation
every iteration loop (since systemPrompt is rebuilt/reused)

The rules must be derived from workspace.config.

Example:

workspace.config = {
"idea": "Build an AI chat app",
"database": "None",
"language": "TypeScript",
"framework": "Next.js",
"coregitNamespace": "user-3caaz4gd9bwvp57buqgbkfvuqqb"
}

Expected enforcement:

Language = TypeScript only
Frontend framework = Next.js only
No Python
No Flask
No FastAPI
No Django
No Vue
No Angular
No Java
No Go
No Rust unless explicitly configured
Implementation Reference

Agent execution flow:

runAgentForTodo() // agentRunner.ts:960

Prompt creation path:

getSystemPrompt() // systemPrompt.ts:250
getPlanModePrompt() // systemPrompt.ts:277

Iteration loop:

FOR iteration 0 to 20:
build message array
inject system prompt
call LLM

Current message structure:

[
{ role: "system", content: systemPrompt },
...
]
Required Change

Create a helper:

buildWorkspaceStackGuardrails(workspaceConfig)

Example output:

=== WORKSPACE STACK RULES (MANDATORY) ===

This workspace is locked to the following stack:

Language: TypeScript
Framework: Next.js
Database: None

STRICT RULES:

- ONLY generate TypeScript code.
- NEVER generate Python, JavaScript (unless config allows), Java, Go, Rust, Ruby, PHP, C#, or other languages.
- ONLY use Next.js framework conventions.
- NEVER use Flask, FastAPI, Django, Express (unless configured), Vue, Angular, React Native, Laravel, Spring Boot, or other frameworks.
- Do NOT introduce alternative stacks.
- Do NOT "helpfully" switch technologies.
- If a requested implementation would require another language/framework, adapt the solution to the configured stack instead.
- Tool commands, file edits, package installs, and generated code must comply with this stack.
- Any response violating these rules is invalid.
  Injection Points

Append this guardrail block to BOTH:

Main prompt
getSystemPrompt()
Plan mode prompt
getPlanModePrompt()

And ensure it is present in:

runAgentForTodo()

before:

messages = [
{ role: "system", content: systemPrompt }
]

So every iteration gets the enforced rules.

Acceptance Criteria

Must pass:

Case 1
Config:

{
"language": "TypeScript",
"framework": "Next.js"
}

Bad output:

from flask import Flask

Expected:
Agent refuses and stays in TS/Next.js.

Case 2
Bad output:

pip install openai

Expected:
Uses:

npm install openai

Case 3
Bad output:

const app = express()

Expected:
Uses Next.js API routes / route handlers.

Important

This is a hard constraint, not a soft recommendation.

The model should treat stack violations as invalid behavior.

Prefer deterministic enforcement wording over vague guidance.
