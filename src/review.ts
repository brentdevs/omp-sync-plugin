import { createHash } from "node:crypto";
import type { Issue } from "./types";

/** Never truncate the compared values. Large previews use OMP's scrollable editor. */
export function reviewPreview(issue: Issue): string {
  return JSON.stringify({ server: issue.remote, local: issue.local }, (key, value) => {
    if (/api.?key|token|secret|password|headers|authorization|cookie|credentials/i.test(key)) {
      const digest = createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
      return `[redacted; sha256:${digest}]`;
    }
    return value;
  }, 2);
}
