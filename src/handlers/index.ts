import { charge } from "../payments";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * What the worker hands every handler alongside its input.
 *
 * `idempotencyKey` is derived from the step row, not from the attempt, so all
 * of a step's retries carry the same key. Keying on attempt_no would hand a
 * fresh key to every retry, which is exactly the double-charge this prevents.
 */
export type StepContext = {
  idempotencyKey: string;
};

export async function createAccount(input: unknown, _ctx: StepContext) {
    console.log("Creating account with input:", input);

  // Long enough to kill the worker mid-job while testing crash recovery.
  await sleep(4000);

    return {
        success: true,
        accountId: "fake-account-123",
    }
}

export async function chargeCard(input: unknown, ctx: StepContext) {
  const { amountCents } = input as { amountCents: number };
  console.log("chargeCard called with:", input, "key:", ctx.idempotencyKey);

  // The retry safety is entirely the gateway's: it will hand back the original
  // charge for a key it has already seen rather than making a second one.
  const result = await charge(amountCents, ctx.idempotencyKey);

  return {
    success: true,
    chargeId: result.id,
    amountCents: result.amountCents,
  };
}

export async function sendEmail(input: unknown, _ctx: StepContext) {
  console.log("sendEmail called with:", input);

  // Long enough to kill the worker mid-job while testing crash recovery.
  await sleep(4000);

  return {
    success: true,
    messageId: "fake-message-123",
  };
}

export async function addToCrm(input: unknown, _ctx: StepContext) {
  console.log("addToCrm called with:", input);

  // Long enough to kill the worker mid-job while testing crash recovery.
  await sleep(4000);

  return {
    success: true,
    crmContactId: "fake-crm-contact-123",
  };
}

export const handlers = {
  createAccount,
  chargeCard,
  sendEmail,
  addToCrm,
};
