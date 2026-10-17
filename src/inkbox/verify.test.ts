import { describe, expect, it } from "vitest";
import { createVerifier } from "./verify.js";

const post = (headers: Record<string, string> = {}) => ({ body: "{}", headers });

describe("webhook verifier", () => {
  it("rejects everything when nothing is configured, except in dry run", async () => {
    expect(await createVerifier({})("{}", {})).toBe(false);
    expect(await createVerifier({ INKBOX_DRY_RUN: "1" })("{}", {})).toBe(true);
  });

  it("accepts the shared bearer token and nothing else", async () => {
    const verify = createVerifier({ INKBOX_WEBHOOK_TOKEN: "s3cret-token" });
    expect(await verify("{}", { authorization: "Bearer s3cret-token" })).toBe(true);
    expect(await verify("{}", { authorization: "bearer s3cret-token" })).toBe(true);
    expect(await verify("{}", { authorization: "Bearer wrong-token!" })).toBe(false);
    expect(await verify("{}", { authorization: "Bearer s3cret-token-and-more" })).toBe(false);
    expect(await verify("{}", {})).toBe(false);
  });

  it("a token alone is not bypassed by a missing header or a dry-run flag", async () => {
    const verify = createVerifier({ INKBOX_WEBHOOK_TOKEN: "t", INKBOX_DRY_RUN: "1" });
    expect(await verify(post().body, post().headers)).toBe(false);
  });
});
