// Bakes the git commit into src/build-info.ts at build time, so /health can say which commit a deployed server runs.
// Falls back to the usual CI variables when there is no .git (a deploy from a tarball), else "unknown".
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const file = new URL("../src/build-info.ts", import.meta.url);
function commit(): string {
  try {
    const sha = execSync("git rev-parse --short=7 HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    if (/^[0-9a-f]{7,}$/.test(sha)) return sha;
  } catch {
    // no git here
  }
  for (const name of ["GIT_COMMIT", "GITHUB_SHA", "COMMIT_SHA", "SOURCE_COMMIT", "VERCEL_GIT_COMMIT_SHA", "RENDER_GIT_COMMIT"]) {
    const v = process.env[name]?.trim();
    if (v && /^[0-9a-f]{7,40}$/i.test(v)) return v.slice(0, 7);
  }
  return "unknown";
}
const next = `// Written by scripts/write-build-info.ts before every build. Committed as "unknown": never edit by hand.\nexport const BUILD_COMMIT: string = ${JSON.stringify(commit())};\n`;
let current = "";
try {
  current = readFileSync(file, "utf8");
} catch {
  // first run
}
// A deploy from `git archive` has no .git and no CI variable: keep a commit that was put into the file by hand
// (see "Redeploy" in HANDOFF.md) instead of overwriting it with "unknown".
const already = /BUILD_COMMIT: string = "([0-9a-f]{7,})"/.exec(current)?.[1];
const final = commit() === "unknown" && already ? current : next;
if (current !== final) writeFileSync(file, final);
console.log(`build info: commit ${commit() === "unknown" && already ? already : commit()}`);
