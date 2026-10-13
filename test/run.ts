import { runTests } from '@vscode/test-electron';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'shadow-host-'));
  const workspace = path.join(root, 'workspace'); await fs.mkdir(workspace);
  try {
    for (const phase of ['initial', 'recovery']) await runTests({
      extensionDevelopmentPath: path.resolve(__dirname, '../..'),
      extensionTestsPath: path.resolve(__dirname, 'integration.js'),
      extensionTestsEnv: { SHADOW_TEST_PHASE: phase },
      ...(process.env.VSCODE_EXECUTABLE_PATH ? { vscodeExecutablePath: process.env.VSCODE_EXECUTABLE_PATH } : {}),
      launchArgs: [workspace, '--user-data-dir=' + path.join(root, 'user'), '--extensions-dir=' + path.join(root, 'extensions'), '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes'],
    });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
