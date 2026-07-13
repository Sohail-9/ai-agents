import "../env";
import { executeSkill as executeTool } from "../skills";
import { SandboxManager } from "../sandbox/sandboxManager";
import { workspaceService } from "../services";

async function main() {
  console.log("=== Testing Web Search ===");
  const webResult = await executeTool({
    tool: "web_search",
    params: { query: "How to fetch data in Next js", max_results: 2 },
  });
  console.log("web_search result:", webResult);

  console.log("\n=== Testing execute_shell ===");
  console.log("Creating temporary E2B Sandbox (takes a few seconds)...");
  try {
    const { sandboxId } = await SandboxManager.getInstance().openAndInit({ prettiflowMd: "Test context" });
    
    const shellResult = await executeTool({
      tool: "execute_shell",
      params: { command: "node -v", sandboxId },
    });
    console.log("execute_shell result:", shellResult);
  } catch (err) {
    console.error("Failed to create Sandbox or execute shell. Are E2B credentials set?", err);
  }

  console.log("\n=== Testing todo_manager ===");
  console.log("Creating temporary Workspace in Prisma...");
  try {
    const workspace = await workspaceService.createWorkspace({
      userId: "test-user",
      name: "tool-test-project",
      idea: "Test Idea",
      framework: "Next.js",
      language: "TypeScript",
      database: "None",
      prettiflowMd: "Test MD",
      summary: "Test",
      sandboxId: "sandbox_test",
    });

    const workspaceId = workspace.id;
    console.log(`Created workspace: ${workspaceId}`);

    const todoResult = await executeTool({
      tool: "todo_manager",
      params: { action: "list_pending_todos", workspaceId },
    });
    console.log("list_pending_todos result:", todoResult);

    const getResult = await executeTool({
      tool: "todo_manager",
      params: { action: "get_current_todo", workspaceId },
    });
    console.log("get_current_todo result:", getResult);
  } catch (err) {
    console.error("Failed to test Prisma todo_manager. Error:", err);
  }

  console.log("\n=== Done ===");
  process.exit(0);
}

main().catch(console.error);
