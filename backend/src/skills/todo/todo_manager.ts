import { todoService } from "../../services";
import { TodoManagerParams, ToolResult } from "../types";

export async function todo_manager(params: TodoManagerParams): Promise<ToolResult> {
  const { action, workspaceId, todo_id, notes } = params;

  try {
    if (action === "get_current_todo") {
      const todo = await todoService.getCurrentTodo(workspaceId);
      if (!todo) return { success: true, output: JSON.stringify({ todo: null, message: "No pending todos." }) };
      return { success: true, output: JSON.stringify({ todo }) };
    }

    if (action === "list_pending_todos") {
      const todos = await todoService.listPendingTodos(workspaceId);
      return { success: true, output: JSON.stringify({ todos }) };
    }

    if (action === "mark_todo_complete") {
      if (!todo_id) return { success: false, error: "todo_id is required for mark_todo_complete." };
      try {
        const result = await todoService.markComplete(todo_id, notes);
        return { success: true, output: JSON.stringify({ marked_complete: result.id }) };
      } catch (err: any) {
        if (err.message && err.message.includes("already completed")) {
          return { success: true, output: "Todo was already marked complete." };
        }
        throw err;
      }
    }

    return { success: false, error: `Unknown action: ${action}` };
  } catch (err: any) {
    console.error(`[todo_manager] action=${action} error:`, err.message);
    return { success: false, error: err.message };
  }
}
