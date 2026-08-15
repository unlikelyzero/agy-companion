import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { getHeadCommit, isGitRepository } from "../scripts/lib/git.mjs";

function git(cwd, args) {
  execFileSync("git", args, { cwd, stdio: "pipe" });
}

function withRepo(fn) {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agy-git-test-repo-"));
  git(repoRoot, ["init", "-q"]);
  git(repoRoot, ["config", "user.email", "test@example.com"]);
  git(repoRoot, ["config", "user.name", "Test"]);
  try {
    return fn(repoRoot);
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
}

test("isGitRepository: true inside a real git repo", () => {
  withRepo((repoRoot) => {
    assert.equal(isGitRepository(repoRoot), true);
  });
});

test("isGitRepository: false outside any git repo", () => {
  const bareDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-git-test-nonrepo-"));
  try {
    assert.equal(isGitRepository(bareDir), false);
  } finally {
    fs.rmSync(bareDir, { recursive: true, force: true });
  }
});

test("getHeadCommit: returns null before the first commit", () => {
  withRepo((repoRoot) => {
    assert.equal(getHeadCommit(repoRoot), null);
  });
});

test("getHeadCommit: returns the current HEAD sha after a commit", () => {
  withRepo((repoRoot) => {
    fs.writeFileSync(path.join(repoRoot, "a.txt"), "hello\n");
    git(repoRoot, ["add", "."]);
    git(repoRoot, ["commit", "-q", "-m", "init"]);
    const head = getHeadCommit(repoRoot);
    assert.match(head, /^[0-9a-f]{40}$/);
  });
});
