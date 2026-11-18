import { constants } from 'node:fs';
import { access, readdir, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { message } from './util.js';

type SearchOptions = {
  env?: NodeJS.ProcessEnv;
  home?: string;
  cwd?: string;
  platform?: NodeJS.Platform;
  arch?: string;
};
export type CodexExecutable = { bin: string; source: 'CODEX_BIN' | 'PATH' | 'editor extension' };

async function executable(path: string): Promise<boolean> {
  try { await access(path, constants.X_OK); return (await stat(path)).isFile(); }
  catch { return false; }
}

// Resolve once and share the same executable between version checks and execution.
// Editor terminals do not necessarily inherit the extension host's PATH.
export async function findCodex(options: SearchOptions = {}): Promise<CodexExecutable> {
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  const cwd = options.cwd ?? process.cwd();
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const name = platform === 'win32' ? 'codex.exe' : 'codex';
  const pathDirectories = (env.PATH ?? '').split(delimiter).map(path => resolve(cwd, path));

  async function onPath(command: string): Promise<string | undefined> {
    for (const directory of pathDirectories) {
      const candidate = join(directory, command);
      if (await executable(candidate)) return candidate;
    }
  }

  if (env.CODEX_BIN) {
    const override = env.CODEX_BIN;
    const bin = isAbsolute(override) || /[/\\]/.test(override)
      ? resolve(cwd, override) : await onPath(override);
    if (!bin || !await executable(bin)) throw new Error(`CODEX_BIN points to a missing or non-executable file: ${override}. Correct it or unset CODEX_BIN to enable discovery.`);
    return { bin, source: 'CODEX_BIN' };
  }

  const installed = await onPath(name);
  if (installed) return { bin: installed, source: 'PATH' };

  const architectures: Record<string, string | undefined> = { x64: 'x86_64', arm64: 'aarch64' };
  const platforms: Partial<Record<NodeJS.Platform, string>> = { linux: 'linux', darwin: 'darwin', win32: 'windows' };
  const targetArch = architectures[arch];
  const targetOS = platforms[platform];
  if (targetArch && targetOS) {
    const extensionRoots = ['.vscode-server', '.vscode-server-insiders', '.vscode', '.vscode-insiders'];
    for (const folder of extensionRoots) {
      const directory = join(home, folder, 'extensions');
      let names: string[];
      try { names = await readdir(directory); }
      catch (error) {
        if (['ENOENT', 'EACCES', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) continue;
        throw error;
      }
      const extensions = names.filter(entry => /^openai\.chatgpt-\d/.test(entry))
        .sort((a, b) => b.localeCompare(a, 'en', { numeric: true }));
      for (const extension of extensions) {
        const bin = join(directory, extension, 'bin', `${targetOS}-${targetArch}`, name);
        if (await executable(bin)) return { bin, source: 'editor extension' };
      }
    }
  }
  throw new Error('Codex executable not found on PATH or in VS Code extensions. Set CODEX_BIN to its executable path, or install the official CLI with npm install -g @openai/codex.');
}

export async function runtimeVersion(bin: string): Promise<string> {
  try {
    const { stdout } = await promisify(execFile)(bin, ['--version'], { timeout: 10_000 });
    if (!stdout.trim()) throw new Error('Executable returned no version');
    return stdout.trim();
  } catch (error) {
    throw new Error(`Cannot execute ${bin}: ${message(error)}. Set CODEX_BIN to a working Codex executable.`);
  }
}
