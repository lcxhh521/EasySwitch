import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Evidence that EasySwitch leaves each harness's own configuration alone: a
 * fingerprint of every native config file, and whether any of them mentions
 * EasySwitch. Sessions are configured at launch, so all should stay clean.
 */
export interface NativeFile {
  harness: string;
  path: string;
  exists: boolean;
  sha256?: string;
  modifiedAt?: string;
  mentionsEasySwitch: boolean;
}

/**
 * Codex records every folder the user trusts as a `[projects."<path>"]` table. When the user works on
 * EasySwitch itself the path contains the product's name, which is the user's own folder and not a
 * trace of EasySwitch in their configuration; those headers are not looked at.
 */
export function withoutProjectPaths(text: string): string {
  return text.replace(/^\s*\[projects\.(?:"[^"\n]*"|'[^'\n]*')\]\s*$/gm, "");
}

function codexHome(): string {
  return process.env.CODEX_HOME ?? join(homedir(), ".codex");
}

function claudeDir(): string {
  return process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
}

export function nativeFiles(): NativeFile[] {
  const files = [
    { harness: "Codex", path: join(codexHome(), "config.toml") },
    { harness: "Claude Code", path: join(claudeDir(), "settings.json") },
  ];
  return files.map(({ harness, path }) => {
    try {
      const bytes = readFileSync(path);
      return {
        harness, path, exists: true,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        modifiedAt: statSync(path).mtime.toISOString(),
        mentionsEasySwitch: /easyswitch/i.test(withoutProjectPaths(bytes.toString("utf8"))),
      };
    } catch {
      return { harness, path, exists: false, mentionsEasySwitch: false };
    }
  });
}
