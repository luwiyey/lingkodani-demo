import type { SmsProvider } from "@/lib/providers/sms/types";
import { firebaseCollections } from "@/lib/firebase/collections";
import { getServerFirestore } from "@/lib/firebase/server";
import { compareMessagesForOutboundPriority } from "@/lib/outbound-priority";
import { readLiveSmsProvider } from "@/lib/providers/sms/live-sms-config";
import { getServerSystemSettings } from "@/lib/server/system-settings";
import { processDueFollowUpMessage } from "@/lib/services/follow-up-service";
import { sendLiveSms } from "@/lib/services/server-live-outbound-sms-service";
import { processOfficialReminderMessage } from "@/lib/services/staff-sms-service";
import { isWithinReplyWindow } from "@/lib/system-settings";
import type { SmsMessage, User } from "@/lib/types";

const liveServerSmsProvider: SmsProvider = {
  async sendMessage(input) {
    return sendLiveSms(input);
  },
};

function withoutUndefined<T extends Record<string, unknown>>(value: T) {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined)
  ) as Partial<T>;
}

export async function processLiveFollowUpMessages(actorName = "system") {
  const db = getServerFirestore();
  const systemSettings = await getServerSystemSettings();
  const nowTimestamp = new Date().toISOString();
  const withinReplyWindow = isWithinReplyWindow(nowTimestamp, systemSettings);
  const snapshot = await db.collection(firebaseCollections.smsMessages).get();
  const userSnapshot = await db.collection(firebaseCollections.users).get();
  const messages = snapshot.docs
    .map((item) => item.data() as SmsMessage)
    .sort((left, right) => compareMessagesForOutboundPriority(left, right, "follow_up"));
  const users = userSnapshot.docs.map((item) => item.data() as User);
  const processed: Array<{ id: string; followUpSentAt?: string }> = [];
  const failed: Array<{ id: string; error: string }> = [];

  for (const message of messages) {
    try {
      const allowAfterHoursAutomation = message.parsedIntent === "EMERGENCY";

      if (!withinReplyWindow && !allowAfterHoursAutomation) {
        continue;
      }

      const result = await processDueFollowUpMessage({
        message,
        provider: liveServerSmsProvider,
        providerName: `live-${readLiveSmsProvider(process.env)}`,
        actorName,
      });

      const baseMessage = result?.updatedMessage ?? message;
      const reminderResult = await processOfficialReminderMessage({
        message: baseMessage,
        users,
        settings: systemSettings,
        provider: liveServerSmsProvider,
        providerName: `live-${readLiveSmsProvider(process.env)}`,
        actorName,
      });

      if (!result && !reminderResult) {
        continue;
      }

      await db.collection(firebaseCollections.smsMessages).doc(message.id).update(withoutUndefined({
        followUpSentAt: result?.updatedMessage.followUpSentAt ?? message.followUpSentAt,
        // Save the whole follow-up ladder state. Saving only followUpSentAt left the attempt count at 0
        // and the due time in the past, so a follow-up was texted on every run (every 30 minutes).
        ...(result
          ? {
              followUpLastReminderAt: result.updatedMessage.followUpLastReminderAt,
              followUpAttemptCount: result.updatedMessage.followUpAttemptCount,
              followUpDueAt: result.updatedMessage.followUpDueAt ?? null,
              followUpStopReason: result.updatedMessage.followUpStopReason ?? null,
              followUpOutcome: result.updatedMessage.followUpOutcome ?? null,
            }
          : {}),
        assignedTo: reminderResult?.updatedMessage.assignedTo ?? baseMessage.assignedTo,
        assignedAt: reminderResult?.updatedMessage.assignedAt ?? baseMessage.assignedAt,
        caseStatus: reminderResult?.updatedMessage.caseStatus ?? baseMessage.caseStatus,
        officialReminderRecipientName: reminderResult?.updatedMessage.officialReminderRecipientName ?? baseMessage.officialReminderRecipientName,
        officialReminderRecipientPhone: reminderResult?.updatedMessage.officialReminderRecipientPhone ?? baseMessage.officialReminderRecipientPhone,
        officialReminderDueAt: reminderResult?.updatedMessage.officialReminderDueAt ?? baseMessage.officialReminderDueAt,
        officialReminderLastSentAt: reminderResult?.updatedMessage.officialReminderLastSentAt ?? baseMessage.officialReminderLastSentAt,
        officialReminderCount: reminderResult?.updatedMessage.officialReminderCount ?? baseMessage.officialReminderCount,
      }));

      if (result) {
        await db.collection(firebaseCollections.auditLogs).doc(result.auditLog.id).set(result.auditLog);
        await db.collection(firebaseCollections.logbookEntries).doc(result.logbookEntry.id).set(result.logbookEntry);
        await db.collection(firebaseCollections.outboundMessages).doc(result.outboundRecord.id).set(result.outboundRecord);
      }

      if (reminderResult) {
        await db.collection(firebaseCollections.auditLogs).doc(reminderResult.auditLog.id).set(reminderResult.auditLog);
        await db.collection(firebaseCollections.logbookEntries).doc(reminderResult.logbookEntry.id).set(reminderResult.logbookEntry);
        await db.collection(firebaseCollections.outboundMessages).doc(reminderResult.outboundRecord.id).set(reminderResult.outboundRecord);
      }

      processed.push({
        id: message.id,
        followUpSentAt: result?.updatedMessage.followUpSentAt,
      });
    } catch (error) {
      failed.push({
        id: message.id,
        error: error instanceof Error ? error.message : "Unknown follow-up error",
      });
    }
  }

  return {
    checked: messages.length,
    processedCount: processed.length,
    processed,
    failedCount: failed.length,
    failed,
  };
}
