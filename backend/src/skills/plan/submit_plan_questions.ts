import { ToolResult } from "../types";

export interface PlanQuestionOption {
  id: string;
  text: string;
}

export interface PlanQuestionItem {
  id: string;
  question: string;
  options: PlanQuestionOption[];
}

export interface SubmitPlanQuestionsParams {
  summary: string;
  questions: PlanQuestionItem[];
}

/**
 * submit_plan_questions
 *
 * Called by the agent in plan mode to present clarifying questions to the user.
 * The actual event emission and answer-waiting logic is intercepted in agentRunner.ts,
 * similar to how request_env_vars is handled.
 *
 * The skill itself just returns a holding message so the agent knows to wait.
 */
export async function submit_plan_questions(params: SubmitPlanQuestionsParams): Promise<ToolResult> {
  return {
    success: true,
    output: `Questions submitted to the user (${params.questions.length} questions). Waiting for their answers. Do not continue until you receive the answers.`,
  };
}
