import { existsSync } from "node:fs";
import * as path from "node:path";
import { runTests } from "@vscode/test-electron";

function installedVsCodePath(): string | undefined {
  const executable = process.platform === "win32" ? "code.cmd" : "code";
  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    const command = path.join(directory, executable);
    if (!existsSync(command)) {
      continue;
    }
    if (process.platform === "win32") {
      const codeExe = path.resolve(directory, "..", "Code.exe");
      return existsSync(codeExe) ? codeExe : undefined;
    }
    return command;
  }
  return undefined;
}

async function main(): Promise<void> {
  const extensionDevelopmentPath = path.resolve(__dirname, "..");
  const extensionTestsPath = path.resolve(__dirname, "suite", "index");
  const fixturePath = path.resolve(
    extensionDevelopmentPath,
    "test",
    "fixture",
    "multi-root.code-workspace"
  );
  const workspacePath =
    process.env.TEST_WORKSPACE_PATH === undefined
      ? fixturePath
      : path.resolve(process.env.TEST_WORKSPACE_PATH);
  const vscodeExecutablePath = process.env.VSCODE_EXECUTABLE_PATH ?? installedVsCodePath();

  await runTests({
    extensionDevelopmentPath,
    extensionTestsPath,
    vscodeExecutablePath,
    launchArgs: [workspacePath, "--disable-extensions"]
  });
}

main().catch((error: unknown) => {
  console.error("VS Code integration tests failed.", error);
  process.exitCode = 1;
});
