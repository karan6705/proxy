// Renders a realistic merchant email: readable HTML for people, a plain-text alternative, and a schema.org
// JSON-LD block that Proxy's capture reads first (it only asks an LLM when this is missing).

import { MS_PER_DAY, dateToMs } from "../logic/dates.js";
import type { CalendarDate, Cents, JsonLdConfirmation } from "../types.js";
import type { MerchantEmail } from "./deps.js";
import type { JsonLdMessage } from "./jsonld.js";

export function plainAmount(cents: Cents): string {
  return (cents / 100).toFixed(2);
}

export function formatMoney(cents: Cents): string {
  return `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function formatDate(date: CalendarDate): string {
  return new Date(dateToMs(date)).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

export function nightsBetween(start: CalendarDate, end: CalendarDate): number {
  return Math.round((dateToMs(end) - dateToMs(start)) / MS_PER_DAY);
}

export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export interface EmailSpec {
  from: { name: string; address: string };
  to: string;
  subject: string;
  heading: string;
  intro: string;
  details: Array<[label: string, value: string]>;
  footer: string;
  /** schema.org markup: a reservation or order confirmation, or an EmailMessage for a message the agent sent. */
  jsonld?: JsonLdConfirmation | JsonLdMessage;
}

export function renderEmail(spec: EmailSpec): MerchantEmail {
  const text = [
    spec.heading,
    "",
    spec.intro,
    "",
    ...spec.details.map(([label, value]) => `${label}: ${value}`),
    "",
    spec.footer,
    "",
    `${spec.from.name}`,
  ].join("\n");

  // "<" is escaped as \u003c inside the JSON so the block can never close the script tag early.
  const jsonld = spec.jsonld
    ? `<script type="application/ld+json">${JSON.stringify(spec.jsonld).replace(/</g, "\\u003c")}</script>`
    : "";

  const rows = spec.details
    .map(
      ([label, value]) =>
        `<tr><td style="padding:4px 16px 4px 0;color:#555">${escapeHtml(label)}</td><td style="padding:4px 0"><strong>${escapeHtml(value)}</strong></td></tr>`,
    )
    .join("");

  const html = [
    "<!doctype html>",
    `<html><head><meta charset="utf-8"><title>${escapeHtml(spec.subject)}</title>${jsonld}</head>`,
    `<body style="font-family:Arial,Helvetica,sans-serif;color:#222;max-width:560px;margin:0 auto;padding:16px">`,
    `<h2 style="margin:0 0 12px">${escapeHtml(spec.heading)}</h2>`,
    `<p>${escapeHtml(spec.intro)}</p>`,
    `<table style="border-collapse:collapse;margin:16px 0">${rows}</table>`,
    `<p style="color:#555;font-size:13px">${escapeHtml(spec.footer)}</p>`,
    `<p style="color:#555;font-size:13px">${escapeHtml(spec.from.name)}</p>`,
    "</body></html>",
  ].join("");

  return { from: spec.from, to: spec.to, subject: spec.subject, body: text, html };
}
