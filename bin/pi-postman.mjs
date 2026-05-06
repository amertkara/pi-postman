#!/usr/bin/env node
/**
 * pi-postman CLI.
 *
 * Subcommands:
 *   pi-postman install-skill         Symlink the bundled skill into ~/.pi/agent/skills/pi-postman/
 *   pi-postman uninstall-skill       Remove the symlink (only if it points to this package)
 *   pi-postman extension-path        Print the absolute path to the extension TS file (for --extension)
 *   pi-postman help                  Show this help
 *
 * Designed to be called either directly (after `npm install -g`) or via npx.
 */

import { existsSync, lstatSync, mkdirSync, readlinkSync, symlinkSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");
const SKILL_SOURCE = join(REPO_ROOT, "skills", "pi-postman");
const EXTENSION_PATH = join(REPO_ROOT, "extension", "pi-postman.ts");

const PI_SKILLS_DIR = join(homedir(), ".pi", "agent", "skills");
const SKILL_LINK = join(PI_SKILLS_DIR, "pi-postman");

const [, , subcommand] = process.argv;

switch (subcommand) {
  case "install-skill":
    installSkill();
    break;
  case "uninstall-skill":
    uninstallSkill();
    break;
  case "extension-path":
    console.log(EXTENSION_PATH);
    break;
  case "help":
  case "--help":
  case "-h":
  case undefined:
    printHelp();
    break;
  default:
    console.error(`pi-postman: unknown subcommand "${subcommand}"\n`);
    printHelp();
    process.exit(2);
}

function printHelp() {
  console.log(`pi-postman — agent-to-agent messaging for Pi

Usage:
  pi-postman install-skill        Symlink the skill into ~/.pi/agent/skills/pi-postman/
  pi-postman uninstall-skill      Remove the skill symlink
  pi-postman extension-path       Print the absolute path to the extension file
  pi-postman help                 Show this help

After install:
  # 1. Install the skill (one-time)
  pi-postman install-skill

  # 2. Wire the extension into your Pi sessions:
  pi --extension "$(pi-postman extension-path)"

  # Or alias it in your shell rc:
  alias pi='pi --extension "$(pi-postman extension-path)"'
`);
}

function installSkill() {
  if (!existsSync(SKILL_SOURCE)) {
    console.error(`pi-postman: skill source not found at ${SKILL_SOURCE}.`);
    console.error(`This usually means the package is corrupted. Try \`npm install -g pi-postman\` again.`);
    process.exit(1);
  }
  mkdirSync(PI_SKILLS_DIR, { recursive: true });

  if (existsSync(SKILL_LINK) || isSymlink(SKILL_LINK)) {
    if (isSymlink(SKILL_LINK)) {
      const current = readlinkSync(SKILL_LINK);
      if (resolve(SKILL_LINK, "..", current) === SKILL_SOURCE) {
        console.log(`pi-postman: skill already installed at ${SKILL_LINK}.`);
        return;
      }
      console.log(`pi-postman: replacing existing symlink at ${SKILL_LINK} (was → ${current}).`);
      unlinkSync(SKILL_LINK);
    } else {
      console.error(
        `pi-postman: ${SKILL_LINK} exists and is not a symlink. Move/delete it first if you want to install.`,
      );
      process.exit(1);
    }
  }

  symlinkSync(SKILL_SOURCE, SKILL_LINK, "dir");
  console.log(`pi-postman: skill installed.`);
  console.log(`  ${SKILL_LINK} → ${SKILL_SOURCE}`);
  console.log("");
  console.log(`Next: wire the extension into Pi:`);
  console.log(`  pi --extension "$(pi-postman extension-path)"`);
}

function uninstallSkill() {
  if (!existsSync(SKILL_LINK) && !isSymlink(SKILL_LINK)) {
    console.log(`pi-postman: skill not installed (${SKILL_LINK} does not exist).`);
    return;
  }
  if (!isSymlink(SKILL_LINK)) {
    console.error(
      `pi-postman: refusing to remove ${SKILL_LINK} — it's not a symlink (someone made it a real directory).`,
    );
    process.exit(1);
  }
  const current = readlinkSync(SKILL_LINK);
  const resolved = resolve(SKILL_LINK, "..", current);
  if (resolved !== SKILL_SOURCE) {
    console.error(
      `pi-postman: refusing to remove ${SKILL_LINK} — it points to ${resolved}, not this package's skill (${SKILL_SOURCE}).`,
    );
    process.exit(1);
  }
  unlinkSync(SKILL_LINK);
  console.log(`pi-postman: skill uninstalled.`);
}

function isSymlink(path) {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}
