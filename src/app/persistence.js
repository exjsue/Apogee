// Asks the browser to keep this app's data on every launch and stores the
// latest answer, so the Backup section (in Settings) can show it. The request is never assumed
// to succeed: the browser's answer is recorded as it is.

// request: () => Promise<{ supported, persisted, error }> (requestPersistentStorage)
// store:   needs setPersistStatus(status)
export async function checkPersistence({ request, store, now = () => new Date() }) {
  const result = await request();
  const status = {
    supported: result.supported,
    persisted: result.persisted,
    error: result.error,
    checkedAt: now().toISOString(),
  };
  await store.setPersistStatus(status);
  return status;
}

// What the Backup section says. `status` is null until the first check is stored.
export function describePersistence(status) {
  if (status === null) {
    return { label: "Checking storage…", detail: "" };
  }
  if (status.persisted) {
    return { label: "Storage protected", detail: "The browser agreed to keep your data. Exporting is still a good idea." };
  }
  if (!status.supported) {
    return {
      label: "Not guaranteed, back up regularly",
      detail: "This browser does not let Apogee ask, so it cannot tell whether your data is protected.",
    };
  }
  return {
    label: "Not guaranteed, back up regularly",
    detail: status.error
      ? `The browser reported an error when asked: ${status.error}`
      : "The browser did not promise to keep your data.",
  };
}
