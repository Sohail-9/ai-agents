import { Sandbox } from "@e2b/code-interpreter";
import { ReadFileParams, ToolResult } from "../types";

export async function read_file(params: ReadFileParams): Promise<ToolResult> {
  try {
    const sandbox = await Sandbox.connect(params.sandboxId);
    const content = await sandbox.files.read(params.path);
    return { success: true, output: content };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}
