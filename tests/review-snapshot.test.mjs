import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { createReviewSnapshot, diffSnapshotDirectory, captureDirectorySnapshot, REVIEW_CONTEXT_FILE_NAME } from "../scripts/lib/review-snapshot.mjs";

function git(cwd, args) {
  execFileSync("git", args, { cwd, stdio: "pipe" });
}

function initRepo() {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agy-review-snapshot-repo-"));
  git(repoRoot, ["init", "-q"]);
  git(repoRoot, ["config", "user.email", "test@example.com"]);
  git(repoRoot, ["config", "user.name", "Test"]);
  return repoRoot;
}

function withRepo(fn) {
  const repoRoot = initRepo();
  try {
    return fn(repoRoot);
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
}

test("review-snapshot: excludes .git from the snapshot", () => {
  withRepo((repoRoot) => {
    fs.writeFileSync(path.join(repoRoot, "a.txt"), "hello\n");
    git(repoRoot, ["add", "."]);
    git(repoRoot, ["commit", "-q", "-m", "init"]);

    const snapshot = createReviewSnapshot(repoRoot);
    try {
      assert.ok(!fs.existsSync(path.join(snapshot.dir, ".git")));
      assert.ok(fs.existsSync(path.join(snapshot.dir, "a.txt")));
    } finally {
      snapshot.cleanup();
    }
  });
});

test("review-snapshot: includes untracked files and staged/unstaged modifications", () => {
  withRepo((repoRoot) => {
    fs.writeFileSync(path.join(repoRoot, "tracked.txt"), "v1\n");
    git(repoRoot, ["add", "."]);
    git(repoRoot, ["commit", "-q", "-m", "init"]);

    fs.writeFileSync(path.join(repoRoot, "tracked.txt"), "v2 unstaged\n");
    fs.writeFileSync(path.join(repoRoot, "staged.txt"), "staged content\n");
    git(repoRoot, ["add", "staged.txt"]);
    fs.writeFileSync(path.join(repoRoot, "untracked.txt"), "untracked content\n");

    const snapshot = createReviewSnapshot(repoRoot);
    try {
      assert.equal(fs.readFileSync(path.join(snapshot.dir, "tracked.txt"), "utf8"), "v2 unstaged\n");
      assert.equal(fs.readFileSync(path.join(snapshot.dir, "staged.txt"), "utf8"), "staged content\n");
      assert.equal(fs.readFileSync(path.join(snapshot.dir, "untracked.txt"), "utf8"), "untracked content\n");
    } finally {
      snapshot.cleanup();
    }
  });
});

test("review-snapshot: excludes gitignored files", () => {
  withRepo((repoRoot) => {
    fs.writeFileSync(path.join(repoRoot, ".gitignore"), "ignored.txt\n");
    fs.writeFileSync(path.join(repoRoot, "ignored.txt"), "should not appear\n");
    git(repoRoot, ["add", ".gitignore"]);
    git(repoRoot, ["commit", "-q", "-m", "init"]);

    const snapshot = createReviewSnapshot(repoRoot);
    try {
      assert.ok(!fs.existsSync(path.join(snapshot.dir, "ignored.txt")));
    } finally {
      snapshot.cleanup();
    }
  });
});

test("review-snapshot: strips known agent-instruction files at any depth and casing", () => {
  withRepo((repoRoot) => {
    fs.writeFileSync(path.join(repoRoot, "AGENTS.md"), "top-level instructions\n");
    fs.mkdirSync(path.join(repoRoot, "nested", "deep"), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, "nested", "deep", "claude.md"), "nested lowercase instructions\n");
    fs.mkdirSync(path.join(repoRoot, ".cursor"), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, ".cursor", "rules.md"), "cursor rule\n");
    fs.writeFileSync(path.join(repoRoot, "real-code.js"), "console.log('hi');\n");
    git(repoRoot, ["add", "."]);
    git(repoRoot, ["commit", "-q", "-m", "init"]);

    const snapshot = createReviewSnapshot(repoRoot);
    try {
      assert.ok(!fs.existsSync(path.join(snapshot.dir, "AGENTS.md")));
      assert.ok(!fs.existsSync(path.join(snapshot.dir, "nested", "deep", "claude.md")));
      assert.ok(!fs.existsSync(path.join(snapshot.dir, ".cursor")));
      assert.ok(fs.existsSync(path.join(snapshot.dir, "real-code.js")));
      assert.deepEqual(
        snapshot.strippedInstructionFiles.sort(),
        [".cursor/rules.md", "AGENTS.md", "nested/deep/claude.md"].sort()
      );
    } finally {
      snapshot.cleanup();
    }
  });
});

test("review-snapshot: does not dereference a symlink that escapes the repo root", () => {
  withRepo((repoRoot) => {
    const secretFile = path.join(os.tmpdir(), `agy-review-snapshot-secret-${process.pid}.txt`);
    fs.writeFileSync(secretFile, "outside the repo\n");
    try {
      fs.symlinkSync(secretFile, path.join(repoRoot, "escape-link"));
      fs.writeFileSync(path.join(repoRoot, "normal.txt"), "fine\n");
      git(repoRoot, ["add", "-A"]);
      git(repoRoot, ["commit", "-q", "-m", "init"]);

      const snapshot = createReviewSnapshot(repoRoot);
      try {
        assert.ok(!fs.existsSync(path.join(snapshot.dir, "escape-link")));
        assert.equal(snapshot.skippedSymlinks.length, 1);
        assert.equal(snapshot.skippedSymlinks[0].path, "escape-link");
      } finally {
        snapshot.cleanup();
      }
    } finally {
      fs.rmSync(secretFile, { force: true });
    }
  });
});

test("review-snapshot: recreates a symlink that stays inside the repo root", () => {
  withRepo((repoRoot) => {
    fs.writeFileSync(path.join(repoRoot, "target.txt"), "linked content\n");
    fs.symlinkSync("target.txt", path.join(repoRoot, "link.txt"));
    git(repoRoot, ["add", "-A"]);
    git(repoRoot, ["commit", "-q", "-m", "init"]);

    const snapshot = createReviewSnapshot(repoRoot);
    try {
      const linkPath = path.join(snapshot.dir, "link.txt");
      assert.ok(fs.lstatSync(linkPath).isSymbolicLink());
      assert.equal(fs.readFileSync(linkPath, "utf8"), "linked content\n");
    } finally {
      snapshot.cleanup();
    }
  });
});

test("review-snapshot: snapshotHash is stable for identical content and changes when content changes", () => {
  withRepo((repoRoot) => {
    fs.writeFileSync(path.join(repoRoot, "a.txt"), "hello\n");
    git(repoRoot, ["add", "."]);
    git(repoRoot, ["commit", "-q", "-m", "init"]);

    const first = createReviewSnapshot(repoRoot);
    const second = createReviewSnapshot(repoRoot);
    assert.equal(first.snapshotHash, second.snapshotHash);
    first.cleanup();
    second.cleanup();

    fs.writeFileSync(path.join(repoRoot, "a.txt"), "hello again\n");
    const third = createReviewSnapshot(repoRoot);
    assert.notEqual(first.snapshotHash, third.snapshotHash);
    third.cleanup();
  });
});

test("review-snapshot: cleanup() removes the snapshot directory", () => {
  withRepo((repoRoot) => {
    fs.writeFileSync(path.join(repoRoot, "a.txt"), "hello\n");
    git(repoRoot, ["add", "."]);
    git(repoRoot, ["commit", "-q", "-m", "init"]);

    const snapshot = createReviewSnapshot(repoRoot);
    assert.ok(fs.existsSync(snapshot.dir));
    snapshot.cleanup();
    assert.ok(!fs.existsSync(snapshot.dir));
  });
});

test("review-snapshot: diffSnapshotDirectory reports files written after the baseline", () => {
  withRepo((repoRoot) => {
    fs.writeFileSync(path.join(repoRoot, "a.txt"), "hello\n");
    git(repoRoot, ["add", "."]);
    git(repoRoot, ["commit", "-q", "-m", "init"]);

    const snapshot = createReviewSnapshot(repoRoot);
    try {
      const before = captureDirectorySnapshot(snapshot.dir);
      fs.writeFileSync(path.join(snapshot.dir, "surprise.txt"), "unexpected write\n");
      const changed = diffSnapshotDirectory(before, snapshot.dir);
      assert.deepEqual(changed, ["surprise.txt"]);
    } finally {
      snapshot.cleanup();
    }
  });
});

test("review-snapshot: REVIEW_CONTEXT_FILE_NAME is a stable constant usable as a filename", () => {
  assert.match(REVIEW_CONTEXT_FILE_NAME, /^[\w.-]+$/);
});
