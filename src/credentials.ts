import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { CredentialProvider } from "./contracts.ts";
const execFileAsync = promisify(execFile);
export class CredentialStoreError extends Error {
  readonly code: string;
  constructor(code: string) { super("credential provider failed"); this.name = "CredentialStoreError"; this.code = code; }
}
export type CommandRunner = (file: string, args: readonly string[], options: { timeout: number }) => Promise<{ stdout: string; stderr: string }>;
const defaultRunner: CommandRunner = async (file, args, options) => {
  try { const { stdout, stderr } = await execFileAsync(file, [...args], { encoding: "utf8", timeout: options.timeout, maxBuffer: 65536 }); return { stdout, stderr }; }
  catch (error) { const code = (error as { code?: unknown }).code; throw new CredentialStoreError(typeof code === "number" || typeof code === "string" ? String(code) : "COMMAND_FAILED"); }
};
export class EnvironmentCredentialProvider implements CredentialProvider {
  private readonly env: NodeJS.ProcessEnv;
  constructor(env: NodeJS.ProcessEnv = process.env) { this.env = env; }
  async get(ref: string): Promise<string | undefined> { return this.env[`PI_PROXY_SECRET_${ref}`] || undefined; }
}
export class MacOSKeychainCredentialProvider implements CredentialProvider {
  private readonly runner: CommandRunner;
  constructor(runner: CommandRunner = defaultRunner) { this.runner = runner; }
  async get(ref: string): Promise<string | undefined> {
    if (!/^[A-Za-z0-9_.-]{1,64}$/.test(ref)) throw new CredentialStoreError("INVALID_REFERENCE");
    try { const result = await this.runner("/usr/bin/security", ["find-generic-password", "-s", `pi-proxy-${ref}`, "-w"], { timeout: 5000 }); return result.stdout.replace(/[\r\n]+$/, "") || undefined; }
    catch (error) {
      const code = (error as { code?: unknown })?.code;
      if (code === 44 || code === "44") return undefined;
      throw new CredentialStoreError("KEYCHAIN_FAILED");
    }
  }
}
export class ChainCredentialProvider implements CredentialProvider {
  private readonly providers: readonly CredentialProvider[];
  constructor(providers: readonly CredentialProvider[]) { this.providers = providers; }
  async get(ref: string): Promise<string | undefined> { for (const provider of this.providers) { const value = await provider.get(ref); if (value) return value; } return undefined; }
}
