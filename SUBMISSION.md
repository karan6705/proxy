# Submission: Proxy

Deadline: **Sunday, October 18, 10:00 AM PT: "Submissions Due + Live Demos"** (judging completes 11:00, winners 12:15), from the event page https://events.ycombinator.com/MakeSomethingAgentsWant. One entry per team.
Form: https://url.mcp-use.com/yc-submit (a Google Form titled "Manufact Track — Best MCP Server for Agents").
Its requirement: "Include a working MCP server URL and a demo video showing the server in multiple MCP clients."

Everything in `<angle brackets>` is not known yet. Fill it in before submitting. Do not submit with a placeholder.

## Manufact form: answers

The labels are word for word from the form. The form has no Inkbox field, so the Inkbox description is further down.

| Field | Required | Answer |
|---|---|---|
| Team name | yes | `Proxy` |
| MCP server URL | yes | `https://bold-zero-0m4lf.run.mcp-use.com/mcp` (deployed on Manufact Cloud, verified over MCP: six tools). It is a dry-run copy with an in-memory store, which is fine for judges to connect to. Do not use a tunnel URL: it changes when the laptop restarts. |
| Manufact organization ID | yes | `9833fb6a-873c-4b80-b5a6-16c3f30ba17c`: the organization that owns the deployed server (Sarah Khadder's Projects, slug `org-3e8505eb-iovbr`). If the server is ever redeployed under a different organization, use that organization's ID instead. |
| Demo video URL (YouTube/Loom/etc.) | yes | `<PUBLIC VIDEO LINK>`. It must show the server working in more than one MCP client (Claude Code, Codex, Cursor), and judges must be able to watch it without requesting access. Open the link in a private window before pasting. |
| Setup instructions for judges | no | See the draft below. |
| What was the biggest blocker while building your project? | no | See the draft below. |
| What is one missing capability that would unlock your next step? | no | See the draft below. |
| Which capabilities would you use in the next 30 days? (up to 2) | no | Suggested: "Durable state or memory across agent sessions" and "Test workflows across MCP clients and catch regressions". The team should confirm. |
| Email or Discord handle (only if you'd like a follow-up) | no | `<your choice, or leave blank>` |

### Setup instructions for judges (draft)

> Connect any MCP client to `https://bold-zero-0m4lf.run.mcp-use.com/mcp` (streamable HTTP, no authentication). It exposes six tools: `log_intent`, `reversibility`, `review`, `undo`, `get_chain`, `list_chains`; a `mistakes` resource; and a live-chain view.
>
> Try it: call `log_intent` with a goal and constraints (it returns a `task_email` unique to that task), book through that address, then call `review(task_id)`. Every error has `retryable` and `next_action`; follow `next_action`. `undo` only touches the agent's own free, full-refund actions; anything else waits for the human, who answers UNDO ALL, PICK or KEEP by text, so no tool lets the agent approve its own undo.
>
> To watch a full run without setting anything up, open `https://bold-zero-0m4lf.run.mcp-use.com/web/stage?fixture=1`. The merchants and their agents in our demo are our own mocks, the clock is simulated, and money is Stripe test mode. Clients shown in the video: `<list only the clients you actually recorded, for example Claude Code, Codex, Cursor>`.

### Builder feedback (drafts from what actually happened in this build; edit or delete anything you did not experience)

**Biggest blocker.** Getting a real, two-way agent identity to work end to end. Inbound iMessage replies reached our agent only some of the time and an unexplained auto-reply sometimes answered in its place, and outbound SMS was dropped by the carrier's spam filter after the API accepted it (we reported both to Inkbox support, who escalated but could not name the cause). Separately, deploying to Manufact from a repo owned by one teammate needed the GitHub App connected to the right organization, which cost us time we had not planned for. We worked around both by making iMessage the alert channel, adding demo-page buttons as the reply path, and polling the A2A and email transport.

**One missing capability.** A way to prove that a deployed URL is serving *our* server. The platform gateway answers `/health` itself, and it returned `{"status":"healthy"}` for a hostname we never created, so a green health check told us nothing and we had to check `serverInfo` and `tools/list` over MCP ourselves. A per-server health or identity endpoint, or the gateway passing `/health` through to the server, would have saved us a wrong conclusion.

## Inkbox track

**Does it need its own submission? Not answerable from the public page.** The event page lists an Inkbox prize track ("Interesting projects giving agents a persistent identity with email, phone, iMessage, and A2A, so they can communicate with humans and each other") but gives no submission channel for it. The only form anywhere is the Manufact one above, which has no Inkbox field. The mcp-use Discord could not be read from here (it needs a login). **Ask an organizer or Inkbox at the event, or check the Discord, before 10:00 AM**; it may be judged at the live demos. The text below is ready to paste into whatever channel they name.

**Description (3 sentences):**

> Proxy gives every agent task its own Inkbox identity, so each confirmation email lands at `task-<id>@inkboxmail.com` and is tied to the right intent automatically. When it finds a mistake it texts the human once, over iMessage with SMS as the alternative channel, and the human's replies (UNDO ALL, PICK, KEEP) are accepted only from their registered number. To undo the damage it negotiates refunds with merchant agents over Inkbox A2A, using a typed Reversal Protocol limited to three rounds, and it falls back to email carrying the same JSON when A2A is not available.

What to show if asked, all from Karan's laptop run (see the table): the task address receiving a confirmation, the alert on the phone, the reply arriving, and the hotel negotiation over A2A. Say plainly that the merchants and their agents are our own mocks.

## Claims check: what is verified, what is not

Do not say anything in the video, the form or at the live demo that this table does not support.

**Two separate things exist, and they are not the same.**

- **The cloud copy** (`https://bold-zero-0m4lf.run.mcp-use.com/mcp`) is a **dry-run sandbox**: `INKBOX_DRY_RUN=1`, `PROXY_MODE=cloud`, and **no Inkbox, Stripe, Supabase or Anthropic keys**. It uses an in-memory store, a stand-in Inkbox and **simulated payments**. Nothing on it sends a real email, text or A2A message, and no refund on it is confirmed by Stripe. Judges can connect to it and run the sandbox demo.
- **The live run** (real phone, real email, real A2A; Stripe test mode if Karan's laptop has the test key) is **Karan's laptop only**, on his tunnel. That is what the video shows for the Inkbox and Stripe parts.

| Claim | Where it is true | Status and evidence |
|---|---|---|
| MCP server with six tools (seven with `try_proxy_demo`), a `mistakes` resource and a live-chain view | Cloud copy and laptop | Verified over MCP on the cloud URL: `initialize` answers as "proxy", `tools/list` returns six. The seventh tool and the sandbox example arrive with Karan's `demo-v1` change; **re-verify after the redeploy** |
| Error contract (`retryable`, `next_action`) | Cloud copy and laptop | Verified on the cloud URL with a real call |
| A unique Inkbox address per task | Laptop only | Verified live: a task address was created and an email with schema.org markup parsed into the right Action. Not on the cloud copy (stand-in addresses) |
| Capture reads structured data first, an LLM only as a fallback | Laptop; tested in code | JSON-LD, microdata and the LLM path are covered by tests, and the demo fixtures parse exactly. The LLM path has not been exercised live in this build |
| A2A negotiation with a merchant agent | Laptop only | Verified live: request, store-credit counter, push back, 85% counter, accept against the real hotel agent, about 6 s over A2A. Merchant agents are our mocks |
| Email fallback carrying the same JSON | Laptop only | Verified live: the same negotiation over email, about 29 s |
| Alert by iMessage | Laptop only | Verified live: delivered to the registered number |
| Human replies by iMessage | Laptop only | **Partly.** `UNDO ALL` and `KEEP` arrived and parsed; `PICK` and a loose reply were not seen, and replies can be slow. The demo page buttons are the reliable reply path |
| **SMS** | Laptop only | **Outbound did not work.** Inkbox accepted both sends we made after the recipient opted in, and the carrier dropped both (error 40002, spam filter). **Inbound `START` arrived** (so the number receives). Claim only: "SMS is supported as an alternative alert channel in the code". Do **not** claim SMS delivery or SMS replies |
| **Phone calls** | Nowhere | **Never run live.** The call escalation exists in the code (`placeCall`) and runs only against the dry-run logger. Do not claim a call was placed. |
| "A refund only counts when Stripe shows it" | Laptop, if it has the Stripe test key (Karan to confirm) | True in the code and tests. **On the cloud copy payments are simulated**, so "confirmed in Stripe" there means the simulated ledger, not Stripe. Confirm with a recorded real test charge before saying "Stripe confirmed" on camera |
| Reversal Protocol limited to three rounds, with a hard deadline | Code and tests | Enforced in the state machine and unit-tested; live runs used 3 messages from Proxy |
| Deployed on Manufact Cloud | Cloud copy | Verified: running, reachable over HTTPS, no runtime errors. A managed upload, not linked to GitHub: pushes to `main` do not redeploy it; redeploy steps are in HANDOFF.md |
| Works in several MCP clients | Not yet shown | Name only the clients you actually recorded |
| Cloud copy's end-to-end sandbox demo (`try_proxy_demo`) | Cloud copy | **Pending Karan's `demo-v1`.** Verify that it ends at $1,144 of $1,240 on the redeployed URL before claiming it |

## Before you submit

- [x] The server is deployed and answers `tools/list` over MCP (checked, and re-checked after a test redeploy).
- [ ] After Karan's `demo-v1` merges: redeploy with `PROXY_MODE=cloud`, `PROXY_DEMO_ROUTES=1`, `INKBOX_DRY_RUN=1` and still no keys, then re-verify seven tools, `sandbox_example` in `list_chains`, `try_proxy_demo` ending at $1,144 of $1,240, and the Inkbox webhook routes returning 404. Update the "Pending" rows above.
- [ ] The demo video is public, shows more than one MCP client, and the link works in a private window.
- [ ] Nothing in the text says more than the claims table allows. Merchants are mocks, the clock is simulated, the cloud copy is a dry-run sandbox, SMS and calls are scoped as the table says.
- [ ] Ask an organizer or Inkbox whether the Inkbox track needs its own submission (the event page does not say).
- [ ] **Disclose if relevant:** the Manufact track's listed judges include "Andrew Khadder". If that is a relative of a team member, tell the organizers before judging.
- [ ] Submitted before **Sunday 10:00 AM PT** ("Submissions Due + Live Demos"). Have the cloud URL, the video and a laptop ready for the live demo.
