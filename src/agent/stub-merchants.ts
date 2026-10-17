import type {
  Action,
  BookingRequest,
  BookingResult,
  JsonLdConfirmation,
  MerchantAgent,
  MerchantInfo,
  Merchants,
  SelfServeCancelResult,
  Timestamp,
} from "../types.js";
import type { AgentPayments } from "./payments.js";

export interface ConfirmationEnvelope {
  action: Action;
  confirmation: JsonLdConfirmation;
  stripe_charge_id: string;
  task_email: string;
}

export interface ConfirmationSink {
  deliver(envelope: ConfirmationEnvelope): Promise<void>;
}

interface PendingBooking {
  envelope: ConfirmationEnvelope;
  result: BookingResult;
}

const MERCHANTS: MerchantInfo[] = [
  { merchant_id: "airline", name: "Demo Airline", category: "flight", has_agent: false },
  { merchant_id: "hotel", name: "Demo Hotel", category: "hotel", has_agent: true, agent_identity: "hotel-agent" },
  {
    merchant_id: "transfer",
    name: "Demo Transfer",
    category: "transfer",
    has_agent: false,
    support_email: "support@metrotransfer.example",
  },
];

function confirmationType(merchantId: string): JsonLdConfirmation["@type"] {
  if (merchantId === "airline") return "FlightReservation";
  if (merchantId === "hotel") return "LodgingReservation";
  return "TaxiReservation";
}

export class StubMerchants implements Merchants {
  private readonly pending = new Map<string, PendingBooking>();
  private sequence = 0;

  constructor(
    private readonly payments: AgentPayments,
    private readonly sink: ConfirmationSink,
  ) {}

  list(): MerchantInfo[] {
    return [...MERCHANTS];
  }

  get(merchantId: string): MerchantInfo | null {
    return MERCHANTS.find((merchant) => merchant.merchant_id === merchantId) ?? null;
  }

  async book(request: BookingRequest): Promise<BookingResult> {
    const merchant = this.get(request.merchant_id);
    if (!merchant) throw new Error(`Unknown demo merchant ${request.merchant_id}`);
    this.sequence += 1;
    const actionId = `act_${request.merchant_id}_${this.sequence}`;
    const ref = `${request.merchant_id.toUpperCase()}-${String(this.sequence).padStart(3, "0")}`;
    const action: Action = {
      action_id: actionId,
      task_id: request.task_id,
      merchant: request.merchant_id,
      category: merchant.category,
      summary: request.item,
      amount: request.amount,
      dates: request.dates,
      ref,
      source: "email",
      received_at: request.booked_at,
      state: "found",
    };
    const { charge_id } = await this.payments.charge(action, `demo:charge:${request.task_id}:${request.merchant_id}`);
    const result = { ref, amount: request.amount, stripe_charge_id: charge_id };
    this.pending.set(ref, {
      result,
      envelope: {
        action,
        stripe_charge_id: charge_id,
        task_email: request.task_email,
        confirmation: {
          "@context": "https://schema.org",
          "@type": confirmationType(request.merchant_id),
          reservationNumber: ref,
          underName: request.task_email,
          reservationFor: request.item,
          startDate: request.dates?.start,
          endDate: request.dates?.end,
          totalPrice: request.amount,
          priceCurrency: "USD",
        },
      },
    });
    return result;
  }

  async releaseConfirmation(ref: string, receivedAt: Timestamp): Promise<void> {
    const pending = this.pending.get(ref);
    if (!pending) throw new Error(`No pending confirmation ${ref}`);
    pending.envelope.action.received_at = receivedAt;
    await this.sink.deliver(pending.envelope);
    this.pending.delete(ref);
  }

  async selfServeCancel(): Promise<SelfServeCancelResult> {
    return { ok: false, refund_amount: 0, stripe_refund_id: null, reason: "Demo agent does not cancel merchant stubs directly" };
  }

  agent(): MerchantAgent | null {
    return null;
  }
}
