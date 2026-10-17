# Proxy — Demo Flow

Target length: about 4 minutes. Ask the demo slot length at kickoff and adjust. Submissions are due Sun 10 AM and live demos follow.

## The story in one line

"Every agent will make mistakes in the real world. Proxy catches them, traces everything they broke, and undoes it all, agent to agent, before the window closes."

## The demo scenario

The intent: "NYC trip for the Nov 13 conference, under $1,500." The buying agent books with the wrong date, Nov 3.

| Action | Merchant | Amount | Route |
|---|---|---|---|
| Flight SFO to JFK, Nov 3 | Airline (has an agent) | $412 | 24-hour rule, cancel for a full refund |
| Hotel, 3 nights from Nov 3 | Hotel (has an agent) | $640 | Reversal Protocol: negotiate |
| Airport transfer, Nov 3 | Transfer service (no agent) | $188 | Email support |
| Arrival email to the host | A person | $0 | Correction message |

Total at risk: $1,240 across 4 things, 3h 40m left on the tightest window. All amounts, times and merchants are ours and the clock is simulated. We say so.

## The order, and why

Judges form an opinion early, and they remember the last thing they saw out of 30 demos. So we open with the problem, show the agent saying it's done while the evidence says otherwise, then spend most of the time on the chain turning green, and end with the redo and the numbers.

1. Agents make mistakes and can't reliably catch their own. The evidence arrives after they've left.
2. Anchor the intent, capture what happened, and show the mismatch.
3. One text.
4. UNDO ALL: the live chain, including the negotiation with the hotel's agent.
5. Redo, correctly.
6. The scoreboard.

## Roles on stage

These are suggestions. Swap them if someone prefers a different job.

| Person | Job |
|---|---|
| Karan | Opens (step 1), drives the buying agent and the screen, narrates the chain turning green (step 4), closes and states the limits (step 7), answers judge questions |
| Sarah | Holds the phone: receives the text and replies UNDO ALL (step 3), receives the final text (step 5), cues the teammate on the merchant inbox, plays the backup video if needed |
| Dhwanil | Narrates the capture and the mismatch (step 2), narrates the negotiation (step 4), shows the scoreboard and explains the numbers (step 6) |

## Before we go on stage (checklist)

- [ ] Server deployed on Manufact Cloud and answering, MCP App loading
- [ ] Scripted agent mode tested: the wrong-date booking fires every time, and one confirmation arrives late
- [ ] Hotel agent behavior set: counters with store credit first, then 85% partial refund
- [ ] Stripe is in test mode, and the demo task, preferences ("no store credit, partial refunds over 80% are fine") and clock are reset
- [ ] Demo page and MCP App open on the big screen
- [ ] Sarah's phone is on, volume up, texts and iMessage open
- [ ] Transfer-support inbox is open and the reply wording is rehearsed
- [ ] Scoreboard results from the final run are loaded and saved as a screenshot
- [ ] Backup video of the full undo is on the laptop, ready to play
- [ ] Wi-Fi tested, with a phone hotspot as a backup
- [ ] Everyone knows who clicks what

## Step by step

### 1. Hook (20 seconds)
**Karan says:** the problem. People hand agents real tasks every day. Agents make mistakes, they can't reliably catch their own, and the proof, a confirmation email or a charge, usually shows up after the session is over. Every refund window keeps running while nobody is watching.
**Screen:** the demo page.

### 2. Intent, capture, mismatch (40 seconds)
**Karan:** starts the buying agent. It calls `log_intent`: "NYC trip for the Nov 13 conference, under $1,500." Proxy returns a task address. The agent books with that address, with the wrong date, Nov 3.
**What happens:**
1. The confirmations land in the task inbox on screen. Each one becomes an Action, and Stripe shows the charges.
2. The agent says it is finished and everything went well. This is the naive agent's own check.
3. `review` runs. Proxy returns the exact mismatch: date expected Nov 13, got Nov 3.
4. For the demo the agent has already left. The hotel's confirmation arrives late and joins the same chain.

**Dhwanil says:** "The agent says it's done. The receipts say it isn't."

### 3. One text (25 seconds)
**What happens:** **Sarah's phone buzzes:**
> Your agent used the wrong date (Nov 3, not Nov 13). 4 things are affected, $1,240 at risk. Fully reversible for 3h 40m. Reply UNDO ALL, PICK, or KEEP.

Sarah holds it up and replies UNDO ALL.
**Karan says:** "One text per chain, not four emails. If she hadn't answered, an iMessage and then a phone call would follow before the deadline."

### 4. The chain turns green (70 seconds) — the key moment
**What happens:** the MCP App shows the four actions. Each turns green only when Stripe verifies the refund.
1. **Flight:** the 24-hour rule applies, so Proxy cancels for a full refund. Stripe shows it. Green.
2. **Transfer:** the service has no agent, so Proxy emails support from its own address. The teammate replies. Green once Stripe shows it.
3. **Host email:** Proxy sends a correction. Green.
4. **Hotel:** the hotel has its own agent. The screen shows the Reversal Protocol:
   - Proxy sends `request_reversal` with the evidence.
   - The hotel agent counters with store credit.
   - Proxy checks the saved preferences ("no store credit"), pushes back once.
   - The hotel agent counters with an 85% partial refund.
   - Preferences say partial refunds over 80% are fine. Proxy accepts. Stripe shows the refund. Green.

**Dhwanil says:** "It's a state machine, not a chat. Three rounds, a hard deadline, and the merchant's messages are treated as data. The row turns green when Stripe shows the money, not when someone says they sent it."

If A2A or email isn't working by the midnight checkpoint, the protocol runs over email with the same steps, the merchant reply comes from the demo page button, and the backup video shows the real moment.

### 5. Redo (25 seconds)
**What happens:** Proxy hands the corrected intent (Nov 13) back to the original agent. The agent rebooks. The new confirmations arrive, `review` finds no mismatch, and **Sarah's phone buzzes:**
> Fixed. $1,240 refunded, correct bookings made, and the host has been updated.

Sarah holds it up.

### 6. The scoreboard (40 seconds)
**Dhwanil:** shows the ~30 scenarios on the naive arm (the agent checking its own work) vs the Proxy arm: Layer 1 (scripted) first, then Layer 2 (live agent). Mention that Layer 2 reports what a real agent did, including when it made no mistake.
**Numbers to show:** mistakes caught, chain completeness, money recovered and chains fixed in time, redo correct, false "done" claims, time to alert, tokens per task. The naive arm has no capture or undo, and we say so.
**Dhwanil says:** [Write this line after the final run, from what the numbers actually show.]

### 7. Close and limits (25 seconds)
**Karan says:** what we built and the tracks it fits (Manufact: six tools, a resource and an MCP App that works in any client; Inkbox: email, texts, phone and agent to agent in one identity). Then the honest limits: "The merchants and their agents are our mocks and the clock is simulated. Some mistakes can't be undone, and reversal needs the merchant's cooperation. Proxy only sees what reaches its task address and Stripe."

**Optional beat if time allows (20 seconds):** a second chain left unanswered, and the phone rings. Skip this first.

## If a judge asks

| Question | Answer |
|---|---|
| Are these real merchants? | No. They are our mock merchants and mock merchant agents, built with real-world refund rules in mind, and we say so. The capture, tracing, protocol and verification logic are what is real. |
| Why is the countdown "3h 40m"? | The demo uses seeded booking times on a simulated clock. Real windows are hours to days. |
| How does Proxy see what the agent did? | The agent gives every booking the task address, so confirmations land in Proxy's inbox, and Stripe events show what was charged. If an agent uses a different address, Proxy can't see it. |
| What if the emails are messy? | Structured data in the email first, an LLM only for messy ones. Either way, money is checked in Stripe, not in the message. |
| What if the human doesn't reply? | iMessage, then a phone call before the deadline. If they opted in, Proxy undoes automatically when the window is about to close. |
| What stops two agents from agreeing forever? | The protocol is a state machine with fixed steps, three rounds and a hard deadline. |
| Can a merchant agent trick Proxy? | Its messages are untrusted data. Proxy only reads typed fields and never shares more than the evidence packet. |
| What does this not stop? | Non-refundable purchases after the window closes, merchants that refuse, and anything that never reaches the task address or Stripe. |
| Isn't this just rules? | The comparison and planning are rules on purpose, so they are predictable and testable. The product is the loop around them: capture, trace, tell, undo, verify, redo. We measured against a baseline. |
| Is the demo staged? | The scripted agent mode makes the mistake fire reliably, and we say so. Layer 2 of the scoreboard shows what a real agent did. |
| Can the agent undo or keep things on its own? | It can only undo its own actions that `review` showed don't match the intent. Everything else needs the human's text. |

## If something breaks

| Problem | What to do |
|---|---|
| Text doesn't arrive or the reply isn't received | Use the demo page buttons for UNDO ALL. Say the text flow is in the backup video. |
| A2A or the support email doesn't work | The protocol runs over email, or the reply is posted from the demo page. Or play the backup video of the undo and say "here's that run from earlier". |
| Stripe fails | Show the chain and event feed only. Say the refund is in test mode (or a mock refund) and move on. |
| Agent does something odd | Reset the task and the clock, rerun that step once. If it fails again, skip to the next step. |
| Wi-Fi drops | Switch to the phone hotspot. If that fails, play the full backup video. |
| Running out of time | Skip the optional beat. Shorten step 6. Keep steps 2 to 5. |

## Rehearsal

- Sun 8 AM: run the full flow at least twice, with a timer.
- Do steps 3 to 5 on the real phone and the real inboxes each time, so we know the texts and emails arrive fast enough.
- Write down the exact tasks typed into the agent, the seeded booking times, and the exact merchant replies, so nobody has to improvise.
