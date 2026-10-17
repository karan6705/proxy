// In-memory stand-ins for Merchants, Payments and Store, so orchestrator routes run before the
// real implementations land. Used by tests and the stub server; not for production paths.
import type {
  Action,
  BookingRequest,
  BookingResult,
  Cents,
  Chain,
  Merchants,
  Payments,
  SelfServeCancelResult,
  Step,
  Store,
  Timestamp,
} from "../types.js";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

interface Booking {
  request: BookingRequest;
  charge_id: string;
  cancelled: boolean;
}

/** Only the airline is modelled: full refund within 24h of booking if booked at least 7 days before departure. */
export function createStubMerchants(): Pick<Merchants, "book" | "selfServeCancel"> & { bookings: Map<string, Booking> } {
  const bookings = new Map<string, Booking>();
  let seq = 0;
  return {
    bookings,
    async book(request): Promise<BookingResult> {
      seq += 1;
      const ref = `${request.merchant_id.toUpperCase()}-${seq}`;
      const charge_id = `ch_stub_${seq}`;
      bookings.set(ref, { request, charge_id, cancelled: false });
      return { ref, amount: request.amount, stripe_charge_id: charge_id };
    },
    async selfServeCancel(merchant_id, ref, now): Promise<SelfServeCancelResult> {
      const b = bookings.get(ref);
      if (!b || b.request.merchant_id !== merchant_id) return { ok: false, refund_amount: 0, stripe_refund_id: null, reason: "unknown booking" };
      if (merchant_id !== "airline") return { ok: false, refund_amount: 0, stripe_refund_id: null, reason: "no self-serve cancel" };
      if (b.cancelled) return { ok: true, refund_amount: b.request.amount, stripe_refund_id: null };
      const booked = Date.parse(b.request.booked_at);
      const departs = b.request.dates ? Date.parse(b.request.dates.start) : NaN;
      if (Date.parse(now) - booked > DAY) {
        return { ok: false, refund_amount: 0, stripe_refund_id: null, reason: "outside the 24-hour window" };
      }
      if (!(departs - booked >= 7 * DAY)) {
        return { ok: false, refund_amount: 0, stripe_refund_id: null, reason: "booked less than 7 days before departure" };
      }
      b.cancelled = true;
      return { ok: true, refund_amount: b.request.amount, stripe_refund_id: null };
    },
  };
}

interface FakeCharge {
  action_id: string;
  amount: Cents;
  refunded: Cents;
}

/** Fake Stripe. `settleRefunds: false` leaves refunds pending, so verifyRefund reports not verified. */
export function createFakePayments(opts: { settleRefunds?: boolean } = {}) {
  const settle = opts.settleRefunds ?? true;
  const charges = new Map<string, FakeCharge>();
  const refundsByKey = new Map<string, { refund_id: string; charge_id: string; amount: Cents }>();
  let disputes = 0;
  const payments: Payments = {
    async findChargeForAction(action) {
      for (const [id, c] of charges) if (c.action_id === action.action_id) return id;
      return null;
    },
    async refund(charge_id, amount, idempotency_key) {
      const prior = refundsByKey.get(idempotency_key);
      if (prior) return { refund_id: prior.refund_id };
      const c = charges.get(charge_id);
      if (!c) throw new Error(`No charge ${charge_id}`);
      if (c.refunded + amount > c.amount) throw new Error("Refund exceeds charge");
      const refund_id = `re_fake_${refundsByKey.size + 1}`;
      refundsByKey.set(idempotency_key, { refund_id, charge_id, amount });
      if (settle) c.refunded += amount;
      return { refund_id };
    },
    async verifyRefund(charge_id, amount) {
      const c = charges.get(charge_id);
      const refunded_amount = c?.refunded ?? 0;
      return { verified: refunded_amount >= amount, refunded_amount };
    },
    async createDispute(charge_id) {
      if (!charges.has(charge_id)) throw new Error(`No charge ${charge_id}`);
      disputes += 1;
      return { dispute_id: `dp_fake_${disputes}` };
    },
  };
  return {
    payments,
    refunds: refundsByKey,
    addCharge(charge_id: string, action_id: string, amount: Cents) {
      charges.set(charge_id, { action_id, amount, refunded: 0 });
    },
  };
}

export function createRecordingStore() {
  const actions = new Map<string, Action>();
  const steps: Step[] = [];
  const store: Pick<Store, "upsertAction" | "appendStep" | "getAction"> = {
    async upsertAction(action) {
      actions.set(action.action_id, action);
      return action;
    },
    async appendStep(step) {
      steps.push(step);
    },
    async getAction(action_id) {
      return actions.get(action_id) ?? null;
    },
  };
  return { store, actions, steps };
}

export function emptyChain(chain_id: string, task_id: string, root: Action, window_ends_at: Timestamp | null): Chain {
  return {
    chain_id,
    task_id,
    root_action_id: root.action_id,
    action_ids: [root.action_id],
    money_at_risk: root.amount,
    window_ends_at,
    state: "undoing",
    alerts: [],
    plan: [],
    steps: [],
  };
}
