import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { createTempDir } from "./fs.mjs";
import { runCommandChecked } from "./process.mjs";

/**
 * Filenames that count as "agent instructions" this plugin knows *some*
 * coding CLI treats as auto-loaded system-level guidance, matched
 * case-insensitively at any depth in the tree. `agy` itself doesn't
 * document which of these (if any) it honors, so this list is deliberately
 * broader than "confirmed agy behavior" — it's cheap insurance against a
 * review snapshot quietly inheriting instructions committed by the very
 * code under review, which is the actual threat this snapshot exists to
 * remove (see the "Disposable review snapshot" section of README.md).
 */
const INSTRUCTION_FILE_BASENAMES = new Set(
  ["AGENTS.md", "CLAUDE.md", "GEMINI.md", "ANTIGRAVITY.md", ".cursorrules", ".clauderules", ".windsurfrules", ".clinerules"].map((name) =>
    name.toLowerCase()
  )
);
const INSTRUCTION_DIR_BASENAMES = new Set([".cursor", ".claude", ".antigravity", ".windsurf"].map((name) => name.toLowerCase()));
const INSTRUCTION_NESTED_FILES = new Set([path.posix.join(".github", "copilot-instructions.md")]);

export const REVIEW_CONTEXT_FILE_NAME = "AGY_REVIEW_FULL_DIFF.md";

function normalizeRelativePath(relativePath) {
  return relativePath.split(path.sep).join("/").toLowerCase();
}

function isInstructionFilePath(relativePath) {
  const normalized = normalizeRelativePath(relativePath);
  if (INSTRUCTION_NESTED_FILES.has(normalized)) {
    return true;
  }
  const segments = normalized.split("/");
  return INSTRUCTION_FILE_BASENAMES.has(segments[segments.length - 1]);
}

function isInstructionDirPath(relativePath) {
  return instructionDirOf(relativePath) !== null;
}

/** The relative path (in original casing) of the first instruction-directory segment in `relativePath`, or null. */
function instructionDirOf(relativePath) {
  const rawSegments = relativePath.split(path.sep);
  const normalizedSegments = normalizeRelativePath(relativePath).split("/");
  const index = normalizedSegments.findIndex((segment) => INSTRUCTION_DIR_BASENAMES.has(segment));
  return index === -1 ? null : rawSegments.slice(0, index + 1).join("/");
}

/**
 * Every path git considers part of the working tree right now: tracked
 * (index) content plus untracked-but-not-ignored files, in one pass. Since
 * the snapshot copies file *bytes straight off disk* rather than from git
 * objects, staged and unstaged edits to a tracked path are both captured
 * automatically — only the path list itself needs to come from git.
 */
function listReviewableFiles(repoRoot) {
  const output = runCommandChecked("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--deduplicate"], {
    cwd: repoRoot,
    shell: false
  }).stdout;
  return output.split("\0").filter(Boolean);
}

function isPathInsideRoot(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * Copies one file into the snapshot. A symlink is never dereferenced —
 * only recreated as a symlink, and only when its resolved target stays
 * inside the repo root. A symlink escaping the repo (e.g. crafted to point
 * at `/etc/passwd` or another host path) is skipped rather than having its
 * target's content silently pulled into the snapshot.
 */
function copyIntoSnapshot(repoRoot, snapshotDir, relativePath, skipped) {
  const sourcePath = path.join(repoRoot, relativePath);
  const destPath = path.join(snapshotDir, relativePath);
  let lstat;
  try {
    lstat = fs.lstatSync(sourcePath);
  } catch {
    return null; // Gone by the time we got to it (e.g. a staged deletion) — nothing to copy.
  }

  fs.mkdirSync(path.dirname(destPath), { recursive: true });

  if (lstat.isSymbolicLink()) {
    const linkTarget = fs.readlinkSync(sourcePath);
    const resolvedTarget = path.resolve(path.dirname(sourcePath), linkTarget);
    if (!isPathInsideRoot(repoRoot, resolvedTarget)) {
      skipped.push({ path: relativePath, reason: "symlink escapes the repository root" });
      return null;
    }
    fs.symlinkSync(linkTarget, destPath);
    return { path: relativePath, content: `symlink:${linkTarget}` };
  }

  if (lstat.isDirectory()) {
    return null; // git never lists a bare directory path; defensive no-op.
  }

  const content = fs.readFileSync(sourcePath);
  fs.writeFileSync(destPath, content);
  return { path: relativePath, content };
}

function computeSnapshotHash(entries) {
  const hash = createHash("sha256");
  for (const entry of [...entries].sort((left, right) => left.path.localeCompare(right.path))) {
    hash.update(entry.path);
    hash.update("\0");
    hash.update(entry.content);
    hash.update("\0");
  }
  return hash.digest("hex").slice(0, 16);
}

/**
 * Builds a disposable, `.git`-free copy of the repo's current working-tree
 * state (staged + unstaged + untracked, exactly what `git status` already
 * considers part of the repo) in a scratch directory, with any file this
 * plugin recognizes as an agent-instruction convention stripped out. A
 * review runs against this copy instead of the live checkout, so a tool
 * call the review model makes — intentional or not — can't touch the real
 * repository, and can't pick up instructions committed by the code it's
 * reviewing as if they were trusted guidance.
 *
 * Callers must call `cleanup()` when done, typically in a `finally` block.
 */
export function createReviewSnapshot(repoRoot) {
  const snapshotDir = createTempDir("agy-review-");
  const skipped = [];
  const entries = [];

  for (const relativePath of listReviewableFiles(repoRoot)) {
    const entry = copyIntoSnapshot(repoRoot, snapshotDir, relativePath, skipped);
    if (entry) {
      entries.push(entry);
    }
  }

  // Directories are stripped wholesale (not just the files git happened to
  // track inside them), so an instruction directory never lingers empty.
  const strippedDirs = new Set(entries.filter((entry) => isInstructionDirPath(entry.path)).map((entry) => instructionDirOf(entry.path)));
  for (const relativeDir of strippedDirs) {
    fs.rmSync(path.join(snapshotDir, relativeDir), { recursive: true, force: true });
  }

  const strippedInstructionFiles = [];
  for (const entry of entries) {
    if (strippedDirs.has(instructionDirOf(entry.path))) {
      strippedInstructionFiles.push(entry.path);
      continue;
    }
    if (isInstructionFilePath(entry.path)) {
      try {
        fs.rmSync(path.join(snapshotDir, entry.path), { force: true });
        strippedInstructionFiles.push(entry.path);
      } catch {
        // Best effort — leave it in retainedEntries below if removal failed, since it's still on disk.
      }
    }
  }

  const retainedEntries = entries.filter((entry) => !strippedInstructionFiles.includes(entry.path));

  return {
    dir: snapshotDir,
    fileCount: retainedEntries.length,
    snapshotHash: computeSnapshotHash(retainedEntries),
    strippedInstructionFiles,
    skippedSymlinks: skipped,
    cleanup() {
      fs.rmSync(snapshotDir, { recursive: true, force: true });
    }
  };
}

function captureDirectorySnapshot(dir) {
  const entries = new Map();
  const walk = (currentDir) => {
    for (const dirent of fs.readdirSync(currentDir, { withFileTypes: true })) {
      const fullPath = path.join(currentDir, dirent.name);
      const relativePath = path.relative(dir, fullPath);
      if (dirent.isDirectory()) {
        walk(fullPath);
        continue;
      }
      try {
        const stat = fs.lstatSync(fullPath);
        entries.set(relativePath, `${stat.size}:${stat.mtimeMs}`);
      } catch {
        entries.set(relativePath, "unreadable");
      }
    }
  };
  walk(dir);
  return entries;
}

/**
 * The snapshot equivalent of `captureGitStatusSnapshot`/`diffGitStatusSnapshots`
 * for the live repo: since the snapshot has no `.git`, "did anything change"
 * has to be answered by walking the directory rather than asking git.
 */
export function diffSnapshotDirectory(beforeMap, dir) {
  const afterMap = captureDirectorySnapshot(dir);
  const changed = new Set();
  for (const [relativePath, signature] of afterMap) {
    if (beforeMap.get(relativePath) !== signature) {
      changed.add(relativePath);
    }
  }
  for (const relativePath of beforeMap.keys()) {
    if (!afterMap.has(relativePath)) {
      changed.add(relativePath);
    }
  }
  return [...changed].sort();
}

export { captureDirectorySnapshot };
