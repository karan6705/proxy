// A merchant whose agent says "refunds go through our return form" (Northwind Market): after its agent denies the
// refund, Proxy opens the merchant's return form, fills it field by field, submits it, gets an RMA number and a
// return label with a QR code, tells the human where to drop the package, and waits for the carrier's scan. When the
// scan arrives the store agrees the refund, and the refund is issued and verified like any other (refundAndVerify).
// The form's fields and options come from the merchant's portal; Proxy picks options by id, never by their wording,
// and fills the values from its own record of the order, so nothing the merchant writes is acted on.
import type { CarrierScan, ReturnFieldId, ReturnsPortal } from "../merchants/deps.js";
import { qrSvgPath } from "../merchants/qr.js";
import type { Action, Cents, Chain, ChainId, Clock, MerchantId, Step } from "../types.js";
import { humanDate, money } from "./copy.js";
import type { FeedActor, FeedEntry } from "./feed.js";

/** What Proxy puts in the form's free-text reason. */
export const RETURN_REASON = "Wrong item, ordered in error by an AI agent on my behalf";

export interface ReturnFlowDeps {
  clock: Clock;
  portal(merchant: MerchantId): ReturnsPortal | null;
  merchantName(merchant: MerchantId): string;
  note(chain: Pick<Chain, "task_id" | "chain_id">, actor: FeedActor, kind: FeedEntry["kind"], text: string, data?: FeedEntry["data"]): void;
  step(chain: Chain, action: Action, route: Step["route"], outcome: Step["outcome"], message: string): Promise<void>;
  setState(action: Action, state: Action["state"]): Promise<Action>;
  getAction(action_id: string): Promise<Action | null>;
  getChain(chain_id: ChainId): Promise<Chain | null>;
  textHuman(chain_id: ChainId, kind: "progress", body: string): Promise<void>;
  refundAndVerify(chain: Chain, action: Action, agreed: Cents, route: Step["route"], note: string): Promise<Action["state"]>;
  finishIfDone(chain_id: ChainId): Promise<void>;
  isFrozen(): boolean;
}

interface Pending {
  chain_id: ChainId;
  action_id: string;
  merchant: MerchantId;
}

export interface ReturnFlow {
  /** True when this merchant has a return form, so the flow took over from the denied protocol. */
  start(chain: Chain, action: Action): Promise<boolean>;
  /** The carrier scanned a returned package. */
  onScan(scan: CarrierScan): Promise<void>;
}

export function createReturnFlow(deps: ReturnFlowDeps): ReturnFlow {
  const pending = new Map<string, Pending>();

  return {
    async start(chain, action) {
      const portal = deps.portal(action.merchant);
      if (!portal) return false;
      const name = deps.merchantName(action.merchant);
      const form = portal.form();
      const base = { merchant: action.merchant, action_id: action.action_id, form_title: form.title, form_url: form.url, total: form.fields.length };

      await deps.setState(action, "requested");
      await deps.step(chain, action, "reversal_protocol", "pending", `${name} sends refunds through its return form; filling it in`);
      deps.note(chain, "proxy", "form_field", `Proxy opened ${name}'s return form (${form.url}).`, { ...base, field: "_open", index: 0 });

      // Proxy's own record of the order fills every field. A refund is the only resolution Proxy asks for.
      const wanted: Record<ReturnFieldId, string> = {
        order_number: action.ref,
        item: action.summary,
        reason: RETURN_REASON,
        resolution: "refund_original",
        method: "drop_off",
      };
      const values: Partial<Record<ReturnFieldId, string>> = {};
      for (const [i, field] of form.fields.entries()) {
        const value = wanted[field.id];
        values[field.id] = value;
        const shown = field.kind === "choice" ? (field.options?.find((o) => o.id === value)?.label ?? value) : value;
        deps.note(chain, "proxy", "form_field", `Proxy filled in "${field.label}": ${shown}`, {
          ...base,
          field: field.id,
          label: field.label,
          value: shown,
          input: field.kind,
          index: i + 1,
        });
      }

      const result = portal.submit(values, deps.clock.now());
      deps.note(chain, "proxy", "form_field", "Proxy submitted the return form.", { ...base, field: "_submit", index: form.fields.length + 1 });
      if (!result.ok) {
        deps.note(chain, "store", "form_field", `${name} did not accept the form (${Object.keys(result.errors).join(", ")}).`, { ...base, field: "_rejected", index: form.fields.length + 2 });
        await deps.setState(action, "failed");
        await deps.step(chain, action, "reversal_protocol", "failed", `${name}'s return form was not accepted`);
        return true;
      }

      const label = result.label;
      const qr = qrSvgPath(label.qr_payload);
      pending.set(label.rma, { chain_id: chain.chain_id, action_id: action.action_id, merchant: action.merchant });
      deps.note(chain, "store", "return_label", `${name} issued return ${label.rma}: drop it off by ${humanDate(label.drop_off_by)}.`, {
        merchant: action.merchant,
        action_id: action.action_id,
        rma: label.rma,
        ref: label.ref,
        carrier: label.carrier,
        drop_off_by: label.drop_off_by,
        drop_off_point: label.drop_off_point,
        qr_payload: label.qr_payload,
        qr_path: qr.path,
        qr_size: qr.size,
      });
      await deps.step(chain, action, "reversal_protocol", "pending", `Return ${label.rma} created; waiting for the drop-off scan`);
      await deps.textHuman(chain.chain_id, "progress", `Your return label is ready. Drop it off by ${humanDate(label.drop_off_by)}.`);
      return true;
    },

    async onScan(scan) {
      const found = pending.get(scan.rma);
      if (!found || deps.isFrozen()) return;
      pending.delete(scan.rma);
      const chain = await deps.getChain(found.chain_id);
      const action = await deps.getAction(found.action_id);
      const portal = deps.portal(found.merchant);
      if (!chain || !action || !portal) return;
      const name = deps.merchantName(found.merchant);
      deps.note(chain, "carrier", "carrier_scan", `${scan.event} (${scan.rma}).`, { merchant: found.merchant, action_id: action.action_id, rma: scan.rma, event: scan.event, location: scan.location });
      const receipt = portal.receive(scan.rma, deps.clock.now());
      if (!receipt.approved) {
        await deps.setState(action, "failed");
        await deps.step(chain, action, "reversal_protocol", "failed", `${name} did not approve the return`);
        await deps.finishIfDone(chain.chain_id);
        return;
      }
      deps.note(chain, "store", "email_in", `${name}: return received, refund approved, ${money(receipt.refund_amount)}.`, {
        merchant: found.merchant,
        action_id: action.action_id,
        approved: true,
        amount: receipt.refund_amount,
        return_received: true,
      });
      await deps.refundAndVerify(chain, action, receipt.refund_amount, "reversal_protocol", `${name} received the return`);
      await deps.finishIfDone(chain.chain_id);
    },
  };
}
