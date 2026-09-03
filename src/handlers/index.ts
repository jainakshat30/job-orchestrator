const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function createAccount(input : unknown){
    console.log("Creating account with input:", input);

  // Long enough to kill the worker mid-job while testing crash recovery.
  await sleep(4000);

    return {
        success: true,
        accountId: "fake-account-123",
    }
}

export async function sendEmail(input: unknown) {
  console.log("sendEmail called with:", input);

  // Long enough to kill the worker mid-job while testing crash recovery.
  await sleep(4000);

  return {
    success: true,
    messageId: "fake-message-123",
  };
}

export async function addToCrm(input: unknown) {
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
  sendEmail,
  addToCrm,
};