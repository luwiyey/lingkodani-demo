/**
 * Regression tests for the automation loop found on 7 Nov 2026: the follow-up job texted farmers every
 * 30 minutes and officials got an uncapped hourly reminder, because the follow-up ladder state was not saved
 * and official reminders had no limit (~9,600 texts for 87 cases).
 */
import type { SmsMessage } from "@/lib/types";

const store = new Map<string, Record<string, unknown>>();
const sent: Array<{ to: string; purpose?: string }> = [];

jest.mock("@/lib/firebase/server", () => ({
  getServerFirestore: () => ({
    collection: (name: string) => ({
      get: async () => ({
        docs: [...store.entries()]
          .filter(([key]) => key.startsWith(`${name}/`))
          .map(([, data]) => ({ data: () => data })),
      }),
      doc: (id: string) => ({
        update: async (patch: Record<string, unknown>) => {
          const key = `${name}/${id}`;
          store.set(key, { ...(store.get(key) ?? {}), ...patch });
        },
        set: async (data: Record<string, unknown>) => {
          store.set(`${name}/${id}`, data);
        },
      }),
    }),
  }),
}));

jest.mock("@/lib/server/system-settings", () => {
  const { defaultSystemSettings } = jest.requireActual("@/lib/system-settings");
  return {
    getServerSystemSettings: async () => ({
      ...defaultSystemSettings,
      replyStartTime: "00:00",
      replyEndTime: "23:59",
      adminPhone: "+639170000000",
    }),
  };
});

jest.mock("@/lib/services/server-live-outbound-sms-service", () => ({
  sendLiveSms: async (input: { to?: string; recipientPhone?: string; purpose?: string }) => {
    sent.push({ to: String(input.to ?? input.recipientPhone ?? ""), purpose: input.purpose });
    return { status: "sent", providerMessageId: `p-${sent.length}` };
  },
}));

import { processLiveFollowUpMessages } from "@/lib/services/server-follow-up-service";
import { isOfficialReminderDue, MAX_OFFICIAL_REMINDERS } from "@/lib/services/staff-sms-service";

function message(overrides: Partial<SmsMessage> = {}): SmsMessage {
  return {
    id: "SMS-LOOP",
    farmerId: "F-1",
    farmerName: "Sample Farmer",
    phone: "+639171234567",
    message: "May uod ang palay.",
    timestamp: "2026-11-01T00:00:00.000Z",
    caseId: "CASE-LOOP",
    caseStatus: "assigned",
    status: "replied",
    parsedIntent: "PEST_DISEASE",
    urgency: "medium",
    aiAdvice: "Payo",
    aiConfidence: 0.8,
    safetyFlag: "Low",
    autoReplySentAt: "2026-11-01T00:05:00.000Z",
    respondedAt: "2026-11-01T01:00:00.000Z",
    followUpDueAt: "2026-11-02T01:00:00.000Z",
    ...overrides,
  } as SmsMessage;
}

describe("SMS automation loop guards", () => {
  beforeEach(() => {
    store.clear();
    sent.length = 0;
  });

  it("stops official reminders after the cap unless forced (e.g. a farmer reopens the case)", () => {
    const now = Date.parse("2026-11-07T00:00:00.000Z");
    expect(isOfficialReminderDue(message({ officialReminderCount: 0 }), now)).toBe(true);
    expect(isOfficialReminderDue(message({ officialReminderCount: MAX_OFFICIAL_REMINDERS }), now)).toBe(false);
    expect(isOfficialReminderDue(message({ officialReminderCount: MAX_OFFICIAL_REMINDERS }), now, true)).toBe(true);
    expect(isOfficialReminderDue(message({ caseStatus: "closed" }), now)).toBe(false);
  });

  it("saves the follow-up ladder so a second run does not text the farmer again", async () => {
    store.set("smsMessages/SMS-LOOP", message() as unknown as Record<string, unknown>);

    await processLiveFollowUpMessages("test");
    const afterFirst = store.get("smsMessages/SMS-LOOP")!;
    expect(afterFirst.followUpAttemptCount).toBe(1);
    expect(Date.parse(String(afterFirst.followUpDueAt))).toBeGreaterThan(Date.now());
    const firstRunTexts = sent.length;
    expect(firstRunTexts).toBeGreaterThan(0);

    // Run again right away, as the scheduler does every 30 minutes.
    await processLiveFollowUpMessages("test");
    expect(sent.length).toBe(firstRunTexts);
  });

  it("never sends more than the follow-up cap plus the reminder cap, however often the job runs", async () => {
    store.set(
      "smsMessages/SMS-LOOP",
      message({ followUpDueAt: "2020-01-01T00:00:00.000Z" }) as unknown as Record<string, unknown>,
    );
    for (let run = 0; run < 20; run++) {
      // Pretend the next due times have passed before every run.
      const current = store.get("smsMessages/SMS-LOOP")!;
      store.set("smsMessages/SMS-LOOP", {
        ...current,
        followUpDueAt: current.followUpDueAt ? "2020-01-01T00:00:00.000Z" : current.followUpDueAt,
        officialReminderDueAt: "2020-01-01T00:00:00.000Z",
      });
      await processLiveFollowUpMessages("test");
    }
    expect(sent.length).toBeLessThanOrEqual(3 + MAX_OFFICIAL_REMINDERS);
  });
});
