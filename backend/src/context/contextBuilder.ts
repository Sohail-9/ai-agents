/**
 * @module contextBuilder
 * @description Pure sync module that converts poll answers into a AI Agents.md
 *              markdown string.
 */

export interface PollAnswers {
  idea: string;
  framework: string;
  language?: string;
  database?: string;
  databaseName?: string;
}

export class ContextBuilder {
  private static instance: ContextBuilder;

  private constructor() {}

  static getInstance(): ContextBuilder {
    if (!ContextBuilder.instance) {
      ContextBuilder.instance = new ContextBuilder();
    }
    return ContextBuilder.instance;
  }

  build(input: PollAnswers): string {
    return [
      `# Project: ${input.idea}`,
      "",
      "## Stack",
      `- Framework: ${input.framework}`,
      input.language ? `- Language: ${input.language}` : "",
      input.database ? `- Database: ${input.database}` : "",
      input.databaseName ? `- Database Name: ${input.databaseName}` : "",
      "",
      "## Status",
      "- [ ] Scaffolding",
      "- [ ] Core features",
      "- [ ] Done",
      "",
      "## Agent Notes",
      "(agent fills this over sessions)",
      "",
    ].join("\n");
  }
}
