# Submission: Proxy

Deadline: **Sunday, October 18, 10:00 AM PT.** One entry per team.
Form: https://url.mcp-use.com/yc-submit (a Google Form titled "Manufact Track — Best MCP Server for Agents").
Its requirement: "Include a working MCP server URL and a demo video showing the server in multiple MCP clients."

Everything in `<angle brackets>` is not known yet. Fill it in before submitting. Do not submit with a placeholder.

## Manufact form: answers

The labels are word for word from the form. The form has no Inkbox field, so the Inkbox description is further down.

| Field | Required | Answer |
|---|---|---|
| Team name | yes | `Proxy` (confirm: the repo lists three people, Dhwanil Ranpura, Karan Raval and Sarah Khadder, and no separate team name) |
| MCP server URL | yes | `<https://SLUG.run.mcp-use.com/mcp>`, from the deployed Manufact server. It must be a working HTTPS endpoint judges can connect to. A tunnel URL (`*.tunnel.mcp-use.run`) is not acceptable: it changes when the laptop restarts. |
| Manufact organization ID | yes | `<ORG ID>`: the organization the server is deployed under. Get it with `npx mcp-use org list --json` while logged in as the person who deployed. Sarah's personal organization is `9833fb6a-873c-4b80-b5a6-16c3f30ba17c`; use that only if the server is deployed under it. If Karan deploys under his own, use his. |
| Demo video URL (YouTube/Loom/etc.) | yes | `<PUBLIC VIDEO LINK>`. It must show the server working in more than one MCP client (Claude Code, Codex, Cursor), and judges must be able to watch it without requesting access. Open the link in a private window before pasting. |
| Setup instructions for judges | no | See the draft below. |
| What was the biggest blocker while building your project? | no | See the draft below. |
| What is one missing capability that would unlock your next step? | no | See the draft below. |
| Which capabilities would you use in the next 30 days? (up to 2) | no | Suggested: "Durable state or memory across agent sessions" and "Test workflows across MCP clients and catch regressions". The team should confirm. |
| Email or Discord handle (only if you'd like a follow-up) | no | `<your choice, or leave blank>` |

### Setup instructions for judges (draft)

> Connect any MCP client to `<MCP URL>` (streamable HTTP, no authentication). It exposes six tools: `log_intent`, `reversibility`, `review`, `undo`, `get_chain`, `list_chains`; a `mistakes` resource; and a live-chain view.
>
> Try it: call `log_intent` with a goal and constraints (it returns a `task_email` unique to that task), book through that address, then call `review(task_id)`. Every error has `retryable` and `next_action`; follow `next_action`. `undo` only touches the agent's own free, full-refund actions; anything else waits for the human, who answers UNDO ALL, PICK or KEEP by text, so no tool lets the agent approve its own undo.
>
> To watch a full run without setting anything up, open `<MCP URL minus /mcp>/web/stage?fixture=1`. The merchants and their agents in our demo are our own mocks, the clock is simulated, and money is Stripe test mode. Clients shown in the video: `<list only the clients you actually recorded, for example Claude Code, Codex, Cursor>`.

### Builder feedback (drafts from what actually happened in this build; edit or delete anything you did not experience)

**Biggest blocker.** Getting a real, two-way agent identity to work end to end. Inbound iMessage replies reached our agent only some of the time and an unexplained auto-reply sometimes answered in its place, and outbound SMS was dropped by the carrier's spam filter after the API accepted it (we reported both to Inkbox support, who escalated but could not name the cause). Separately, deploying to Manufact from a repo owned by one teammate needed the GitHub App connected to the right organization, which cost us time we had not planned for. We worked around both by making iMessage the alert channel, adding demo-page buttons as the reply path, and polling the A2A and email transport.

**One missing capability.** A way to prove that a deployed URL is serving *our* server. The platform gateway answers `/health` itself, and it returned `{"status":"healthy"}` for a hostname we never created, so a green health check told us nothing and we had to check `serverInfo` and `tools/list` over MCP ourselves. A per-server health or identity endpoint, or the gateway passing `/health` through to the server, would have saved us a wrong conclusion.

## Inkbox track: description (3 sentences)

> Proxy gives every agent task its own Inkbox identity, so each confirmation email lands at `task-<id>@inkboxmail.com` and is tied to the right intent automatically. When it finds a mistake it texts the human once, over iMessage with SMS as the alternative channel, and the human's replies (UNDO ALL, PICK, KEEP) are accepted only from their registered number. To undo the damage it negotiates refunds with merchant agents over Inkbox A2A, using a typed Reversal Protocol limited to three rounds, and it falls back to email carrying the same JSON when A2A is not available.

Word count: 3 sentences. Say "mocks" if asked: the merchants and their agents are ours.

## Claims check: what is verified, what is not

Do not say anything in the video or the form that this table does not support.

| Claim | Status | Evidence |
|---|---|---|
| A unique Inkbox address per task | Verified live | A task address was created and an email with schema.org markup parsed into the right Action |
| Capture reads structured data first, an LLM only as a fallback | Verified | JSON-LD, microdata and the LLM path are tested; the demo fixtures parse exactly |
| A2A negotiation with a merchant agent | Verified live | Request, store-credit counter, push back, 85% counter, accept against the real hotel agent: about 6 s over A2A |
| Email fallback with the same JSON | Verified live | The same negotiation over email: about 29 s |
| Alert by iMessage | Verified live | Delivered to the registered number |
| Human replies by iMessage | Partly | `UNDO ALL` and `KEEP` arrived and parsed; `PICK` and a loose reply were not seen, and replies can be slow |
| SMS | Not working outbound | The carrier dropped it with error 40002 after the API accepted it. Inbound `START` arrived. Do not claim SMS delivery. |
| Phone call escalation | Not tested | Do not claim it |
| "A refund only counts when Stripe shows it" | Verified in code and tests | Per Karan's orchestrator; confirm against a real Stripe test charge before saying it on camera |
| Deployed on Manufact Cloud | **Not yet** | The server runs through a tunnel today. Deploy first, then check `<MCP URL>` with `src/inkbox/cutover-check.ts` |
| Works in several MCP clients | Not yet shown | Record each client you name |

## Before you submit

- [ ] The server is deployed and `<MCP URL>` answers `tools/list` with six tools. Note that the Manufact gateway answers `/health` itself, so a 200 there proves nothing; use `src/inkbox/cutover-check.ts` or a real MCP client.
- [ ] The Inkbox webhooks point at the deployed URL (the cutover steps are in HANDOFF.md).
- [ ] The video is public, shows more than one MCP client, and the link works in a private window.
- [ ] The organization ID belongs to the organization that owns the deployed server.
- [ ] Nothing in the text says more than the claims table allows. Merchants are mocks, the clock is simulated, Stripe is test mode.
- [ ] Submitted before Sunday 10:00 AM PT.
