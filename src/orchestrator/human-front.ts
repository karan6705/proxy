// In front of the human channel (src/inkbox/human.ts): the replies its parser doesn't forward yet.
//   STOP / PAUSE          freezes all undo work
//   RESUME / GO           lifts it, and paused work carries on
//   "no, the 13th"        a correction, confirmed once ("Just to check...") before acting
//   YES / NO              the answer to that check
// Everything else goes to the channel unchanged. Only the registered number counts.
import type { HumanChannel, InboundResult } from "../inkbox/index.js";
import type { Clock } from "../types.js";
import type { Proxy } from "./proxy.js";

const digits = (n: string) => n.replace(/\D/g, "");
const CORRECTION = /\b(\d{1,2})(st|nd|rd|th)\b|\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2}\b|\bthe\s+\d{1,2}\b/i;

export interface FrontDeps {
  human: HumanChannel;
  proxy: Proxy;
  clock: Clock;
  humanNumber: string;
  /** Texts the human outside any chain (e.g. STOP with nothing open). */
  say(body: string): Promise<unknown>;
}

export function frontHumanChannel(deps: FrontDeps): HumanChannel {
  const { human, proxy, clock } = deps;
  const registered = digits(deps.humanNumber);

  async function reply(body: string) {
    const chain = await proxy.mostRecentlyAlertedOpenChain();
    if (chain) await proxy.textHuman(chain.chain_id, "reminder", body);
    else await deps.say(body);
  }

  async function handleInbound(msg: Parameters<HumanChannel["handleInbound"]>[0]): Promise<InboundResult> {
    if (digits(msg.from) !== registered) return human.handleInbound(msg);
    const text = msg.body.normalize("NFKC").trim();
    const task = proxy.deps.demo?.current ?? (await proxy.mostRecentlyAlertedOpenChain())?.task_id;
    if (task) proxy.note({ task_id: task, chain_id: null, actor: "human", kind: "text_in", text: `Human: ${text.slice(0, 200)}`, data: { via: msg.via ?? "sms" } });
    const word = text.toUpperCase().replace(/[^A-Z ]+/g, " ").replace(/\s+/g, " ").trim();
    const received_at = clock.now();

    if (word === "STOP" || word === "PAUSE" || word === "STOP ALL") {
      await proxy.onHumanReply({ kind: "stop", received_at });
      await reply("Paused. Nothing more will be undone until you reply RESUME.");
      return { status: "replied", reason: "stopped" };
    }
    if ((word === "RESUME" || word === "GO" || word === "UNPAUSE" || word === "CONTINUE") && proxy.isFrozen()) {
      await proxy.resume();
      await reply("Resumed. Picking up where I left off.");
      return { status: "replied", reason: "resumed" };
    }

    // "1" or "2" answers an open question about the intent ("Your agent understood X. You said Y.").
    if (/^[12]$/.test(text) && (await proxy.answerIntent(text === "1" ? 1 : 2))) {
      return { status: "replied", reason: "intent_answered" };
    }

    const chain = await proxy.mostRecentlyAlertedOpenChain();
    if (chain && proxy.pendingCorrections.has(chain.chain_id) && (word === "YES" || word === "Y" || word === "NO" || word === "N")) {
      await proxy.confirmCorrection(chain.chain_id, word.startsWith("Y"));
      return { status: "replied", reason: "correction_answered" };
    }
    if (chain && CORRECTION.test(text) && !/^(PICK|UNDO|KEEP)\b/.test(word) && !/^[\d ,]+$/.test(text)) {
      await proxy.onHumanReply({ kind: "correction", chain_id: chain.chain_id, corrected_text: text.slice(0, 200), received_at });
      return { status: "replied", reason: "correction_check" };
    }
    return human.handleInbound(msg);
  }

  return { ...human, handleInbound };
}
