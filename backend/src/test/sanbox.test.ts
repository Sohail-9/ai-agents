import Sandbox from "@e2b/code-interpreter";

async function runCmd() {
  const sandbox = await Sandbox.connect("iwe0j5m09soi37d8wccn2");
  const defaultWorkspace = "/workspace";
  const files = await sandbox.files.list(defaultWorkspace);
  console.log(files);
}
runCmd();
