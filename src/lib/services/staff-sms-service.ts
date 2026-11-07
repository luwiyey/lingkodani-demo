import type { SmsProvider } from "@/lib/providers/sms/types";
import { normalizePhone } from "@/lib/sms-simulator";
import { getUserAssignmentId, resolveSmsAssignee } from "@/lib/sms-assignment";
import { createAuditEntry } from "@/lib/services/audit-service";
import { sendOutboundMessage } from "@/lib/services/outbound-sms-service";
import { requestFarmerResolutionConfirmation } from "@/lib/services/resolution-confirmation-service";
import { applySmsStatusUpdate } from "@/lib/services/sms-workflow-service";
import { defaultSystemSettings } from "@/lib/system-settings";
import type { LogbookEntry, SmsMessage, SystemSettings, User } from "@/lib/types";

const OFFICIAL_REMINDER_INTERVAL_MINUTES = 60;
/** After this many reminders for one case, staff see it in the queue instead of getting more texts. */
export const MAX_OFFICIAL_REMINDERS = 3;

function addMinutes(isoTimestamp: string, minutes: number) {
  return new Date(new Date(isoTimestamp).getTime() + minutes * 60 * 1000).toISOString();
}

function normalizeName(value: string | undefined) {
  return value?.trim().toLowerCase() ?? "";
}

function summarizeSms(value: string, maxLength = 90) {
  const compact = value.replace(/\s+/g, " ").trim();

  if (compact.length <= maxLength) {
    return compact;
  }

  return `${compact.slice(0, Math.max(0, maxLength - 1)).trimEnd()}...`;
}

function buildOfficialCommandPrompt(caseId: string) {
  return `REPLY ${caseId} <payo> o RESOLVE ${caseId} <tala>`;
}

function buildReminderPriority(user: User) {
  const haystack = `${user.title ?? ""} ${user.name}`.toLowerCase();

  if (haystack.includes("aew")) return 0;
  if (haystack.includes("admin")) return 1;
  if (haystack.includes("secretary") || haystack.includes("sec.")) return 2;
  if (haystack.includes("captain") || haystack.includes("kapitan")) return 3;
  return 4;
}

function getOfficialReminderDueAt(timestamp: string) {
  return addMinutes(timestamp, OFFICIAL_REMINDER_INTERVAL_MINUTES);
}

export function findOfficialUserByPhone(users: User[], phone: string) {
  const normalizedPhone = normalizePhone(phone);

  return users.find((user) => user.phone && normalizePhone(user.phone) === normalizedPhone) ?? null;
}

export function buildOfficialReminderBody(message: SmsMessage) {
  const caseId = message.caseId ?? message.id;
  const summary = summarizeSms(message.message, 84);

  return `Lingkod-Ani ${caseId}: ${message.farmerName} - ${summary}. Paki-follow up. ${buildOfficialCommandPrompt(caseId)}`;
}

function buildOfficialAckBody(message: SmsMessage, action: "reply" | "resolve") {
  const caseId = message.caseId ?? message.id;

  if (action === "resolve") {
    return `Lingkod-Ani: Naipadala na sa farmer ang confirmation request para sa ${caseId}. Hihintayin ang YES/NO reply bago tuluyang isara ang case.`;
  }

  return `Lingkod-Ani: Naipadala na sa farmer ang inyong sagot para sa ${caseId}. Mag-RESOLVE ${caseId} <tala> kapag tapos na ang concern.`;
}

function buildOfficialHelpBody(officialName: string, activeMessages: SmsMessage[]) {
  const caseList = activeMessages
    .slice(0, 3)
    .map((message) => message.caseId ?? message.id)
    .join(", ");
  const suffix = caseList ? ` Active cases: ${caseList}` : "";

  return `Lingkod-Ani: Hi ${officialName}. I-format ang sagot bilang REPLY CASE-... <payo> o RESOLVE CASE-... <tala>.${suffix}`;
}

function pickReminderRecipient(input: {
  message: SmsMessage;
  users: User[];
  settings: SystemSettings;
}) {
  const usersWithPhone = input.users
    .filter((user) => user.phone && user.status !== "disabled")
    .sort((left, right) => buildReminderPriority(left) - buildReminderPriority(right));

  if (input.message.officialReminderRecipientPhone) {
    return {
      name: input.message.officialReminderRecipientName ?? input.message.assignedTo ?? "Barangay agriculture team",
      phone: input.message.officialReminderRecipientPhone,
      userId: input.message.assignedToUserId,
    };
  }

  const assignedUser = resolveSmsAssignee(usersWithPhone, input.message);

  if (assignedUser?.phone) {
    return {
      name: assignedUser.name,
      phone: assignedUser.phone,
      userId: getUserAssignmentId(assignedUser),
    };
  }

  const fallbackUser = usersWithPhone[0];

  if (fallbackUser?.phone) {
    return {
      name: fallbackUser.name,
      phone: fallbackUser.phone,
      userId: getUserAssignmentId(fallbackUser),
    };
  }

  if (input.settings.adminPhone) {
    return {
      name: "Barangay agriculture hotline",
      phone: input.settings.adminPhone,
    };
  }

  return null;
}

export function isOfficialReminderDue(message: SmsMessage, now = Date.now(), force = false) {
  if (!message.autoReplySentAt) return false;
  if (message.closedAt || message.caseStatus === "closed") return false;

  if (force) {
    return true;
  }

  // Without a cap every open case texted an official every hour, forever.
  if ((message.officialReminderCount ?? 0) >= MAX_OFFICIAL_REMINDERS) {
    return false;
  }

  if (!message.officialReminderDueAt) {
    return true;
  }

  return new Date(message.officialReminderDueAt).getTime() <= now;
}

export async function processOfficialReminderMessage(input: {
  message: SmsMessage;
  users: User[];
  settings?: SystemSettings;
  provider: SmsProvider;
  providerName: string;
  actorName?: string;
  now?: number;
  force?: boolean;
}) {
  if (!isOfficialReminderDue(input.message, input.now, input.force)) {
    return null;
  }

  const settings = input.settings ?? defaultSystemSettings;
  const recipient = pickReminderRecipient({
    message: input.message,
    users: input.users,
    settings,
  });

  if (!recipient?.phone) {
    return null;
  }

  const timestamp = new Date(input.now ?? Date.now()).toISOString();
  const nextReminderCount = (input.message.officialReminderCount ?? 0) + 1;
  const updatedMessage: SmsMessage = {
    ...input.message,
    assignedTo: input.message.assignedTo ?? recipient.name,
    assignedAt: input.message.assignedAt ?? timestamp,
    caseStatus:
      input.message.caseStatus && input.message.caseStatus !== "open"
        ? input.message.caseStatus
        : "assigned",
    assignedToUserId: input.message.assignedToUserId ?? recipient.userId,
    officialReminderRecipientName: recipient.name,
    officialReminderRecipientPhone: recipient.phone,
    officialReminderLastSentAt: timestamp,
    officialReminderDueAt: getOfficialReminderDueAt(timestamp),
    officialReminderCount: nextReminderCount,
  };
  const body = buildOfficialReminderBody(updatedMessage);
  const outboundRecord = await sendOutboundMessage({
    sourceMessage: updatedMessage,
    recipientPhone: recipient.phone,
    body,
    provider: input.provider,
    providerName: input.providerName,
    audience: "official",
    purpose: "official_reminder",
  });
  const caseId = updatedMessage.caseId ?? updatedMessage.id;

  return {
    updatedMessage,
    body,
    auditLog: createAuditEntry({
      id: `AUD${Date.now()}-OFFICIAL-REMINDER`,
      timestamp,
      user: input.actorName ?? "system",
      action: "OFFICIAL_REMINDER_SMS_SENT",
      details: `Nagpadala ng reminder #${nextReminderCount} kay ${recipient.name} para sa ${caseId}.`,
    }),
    logbookEntry: {
      id: `LOG${Date.now()}-${updatedMessage.id}-OFFICIAL-REMINDER`,
      farmerId: updatedMessage.farmerId,
      timestamp,
      type: "SMS",
      title: "Paalala sa opisyal",
      description: `Nagpadala ng follow-up kay ${recipient.name}: ${body}`,
    } satisfies LogbookEntry,
    outboundRecord,
  };
}

type StaffSmsAction = "reply" | "resolve" | "help";

export type ParsedStaffSmsCommand = {
  action: StaffSmsAction;
  caseId?: string;
  content?: string;
};

function extractCaseId(value: string) {
  return value.match(/\bCASE-[A-Z0-9-]+\b/i)?.[0]?.toUpperCase();
}

function stripCaseId(value: string, caseId?: string) {
  if (!caseId) {
    return value.trim();
  }

  return value.replace(new RegExp(caseId, "i"), "").replace(/\s+/g, " ").trim();
}

export function parseStaffSmsCommand(message: string): ParsedStaffSmsCommand {
  const trimmed = message.replace(/\s+/g, " ").trim();
  const lower = trimmed.toLowerCase();

  if (!trimmed) {
    return { action: "help" };
  }

  if (/^(help|tulong)\b/i.test(trimmed)) {
    return { action: "help" };
  }

  const firstToken = trimmed.split(" ", 1)[0]?.toLowerCase() ?? "";

  if (["resolve", "resolved", "close", "closed", "done", "solved"].includes(firstToken)) {
    const remainder = trimmed.slice(firstToken.length).trim();
    const caseId = extractCaseId(remainder);
    const content = stripCaseId(remainder, caseId);
    return {
      action: "resolve",
      caseId,
      content,
    };
  }

  if (["reply", "sagot"].includes(firstToken)) {
    const remainder = trimmed.slice(firstToken.length).trim();
    const caseId = extractCaseId(remainder);
    const content = stripCaseId(remainder, caseId);
    return {
      action: "reply",
      caseId,
      content,
    };
  }

  const caseId = extractCaseId(trimmed);

  if (/^(resolved?|close|closed|done|solved)\b/i.test(lower)) {
    return {
      action: "resolve",
      caseId,
      content: stripCaseId(trimmed, caseId).replace(/^(resolved?|close|closed|done|solved)\b/i, "").trim(),
    };
  }

  return {
    action: "reply",
    caseId,
    content: stripCaseId(trimmed, caseId),
  };
}

function getActiveMessagesForOfficial(messages: SmsMessage[], official: User) {
  const normalizedPhone = normalizePhone(official.phone ?? "");
  const normalizedName = normalizeName(official.name);

  return messages
    .filter((message) => !message.closedAt && message.caseStatus !== "closed")
    .filter((message) => {
      const ownerMatches = normalizeName(message.assignedTo) === normalizedName;
      const recipientMatches =
        Boolean(message.officialReminderRecipientPhone) &&
        normalizePhone(message.officialReminderRecipientPhone ?? "") === normalizedPhone;

      return ownerMatches || recipientMatches;
    })
    .sort((left, right) => new Date(right.timestamp).getTime() - new Date(left.timestamp).getTime());
}

async function sendDirectOfficialSms(input: {
  provider: SmsProvider;
  phone: string;
  body: string;
}) {
  try {
    await input.provider.sendMessage({
      to: input.phone,
      body: input.body,
    });
  } catch {
    // Best-effort only: official acknowledgements should not block case updates.
  }
}

export async function processOfficialInboundSms(input: {
  phone: string;
  body: string;
  official: User;
  messages: SmsMessage[];
  provider: SmsProvider;
  providerName: string;
  actorName?: string;
  now?: number;
}) {
  const parsed = parseStaffSmsCommand(input.body);
  const activeMessages = getActiveMessagesForOfficial(input.messages, input.official);
  const caseId = parsed.caseId?.toUpperCase();
  const targetMessage = caseId
    ? input.messages.find((message) => !message.closedAt && (message.caseId ?? "").toUpperCase() === caseId) ?? null
    : activeMessages.length === 1
      ? activeMessages[0]
      : null;

  if (parsed.action === "help" || (!caseId && activeMessages.length > 1)) {
    if (input.official.phone) {
      await sendDirectOfficialSms({
        provider: input.provider,
        phone: input.official.phone,
        body: buildOfficialHelpBody(input.official.name, activeMessages),
      });
    }

    return {
      handled: true,
      message: null,
      auditLogs: [],
      logbookEntries: [],
      outboundRecords: [],
      kind: "help" as const,
    };
  }

  if (!targetMessage) {
    if (input.official.phone) {
      await sendDirectOfficialSms({
        provider: input.provider,
        phone: input.official.phone,
        body: activeMessages.length
          ? buildOfficialHelpBody(input.official.name, activeMessages)
          : "Lingkod-Ani: Walang active case na naka-link sa numerong ito. Buksan ang app o isama ang tamang CASE-ID.",
      });
    }

    return {
      handled: true,
      message: null,
      auditLogs: [],
      logbookEntries: [],
      outboundRecords: [],
      kind: "help" as const,
    };
  }

  const timestamp = new Date(input.now ?? Date.now()).toISOString();
  const resolvedRecipientPhone = targetMessage.officialReminderRecipientPhone ?? input.official.phone;
  const resolvedRecipientName = targetMessage.officialReminderRecipientName ?? input.official.name;

  if (parsed.action === "resolve") {
    const confirmationResult = await requestFarmerResolutionConfirmation({
      message: {
        ...targetMessage,
        status:
          targetMessage.respondedAt || targetMessage.autoReplySentAt
            ? "replied"
            : targetMessage.status,
        assignedTo: targetMessage.assignedTo ?? input.official.name,
        assignedAt: targetMessage.assignedAt ?? timestamp,
        resolutionNote: parsed.content || targetMessage.resolutionNote || "Naresolba sa follow-up ng barangay official sa SMS.",
        officialReminderRecipientName: resolvedRecipientName,
        officialReminderRecipientPhone: resolvedRecipientPhone,
        officialReminderDueAt: undefined,
      },
      provider: input.provider,
      providerName: input.providerName,
      actorName: input.actorName ?? input.official.name,
      note: parsed.content || targetMessage.resolutionNote || "Naresolba sa follow-up ng barangay official sa SMS.",
      now: input.now,
    });
    const updatedMessage: SmsMessage = confirmationResult.updatedMessage;

    if (input.official.phone) {
      await sendDirectOfficialSms({
        provider: input.provider,
        phone: input.official.phone,
        body: buildOfficialAckBody(updatedMessage, "resolve"),
      });
    }

    return {
      handled: true,
      kind: "resolve" as const,
      message: updatedMessage,
      auditLogs: [
        createAuditEntry({
          id: `AUD${Date.now()}-OFFICIAL-RESOLVE`,
          timestamp,
          user: input.actorName ?? input.official.name,
          action: "OFFICIAL_SMS_CASE_READY_FOR_CONFIRMATION",
          details: `${updatedMessage.caseId ?? updatedMessage.id} minarkahang handa nang isara sa SMS ni ${input.official.name}. Hihintayin ang kumpirmasyon ng magsasaka.`,
        }),
        confirmationResult.auditLog,
      ],
      logbookEntries: [
        {
          id: `LOG${Date.now()}-${updatedMessage.id}-OFFICIAL-RESOLVE`,
          farmerId: updatedMessage.farmerId,
          timestamp,
          type: "Tala sa Bukid",
          title: "Handa nang isara ang case",
          description: updatedMessage.resolutionNote ?? "Hinihintay ang kumpirmasyon ng magsasaka matapos ang SMS follow-up ng opisyal.",
        } satisfies LogbookEntry,
        confirmationResult.logbookEntry,
      ],
      outboundRecords: [confirmationResult.outboundRecord],
    };
  }

  const replyBody = parsed.content?.trim();

  if (!replyBody) {
    if (input.official.phone) {
      await sendDirectOfficialSms({
        provider: input.provider,
        phone: input.official.phone,
        body: buildOfficialHelpBody(input.official.name, [targetMessage]),
      });
    }

    return {
      handled: true,
      kind: "help" as const,
      message: targetMessage,
      auditLogs: [],
      logbookEntries: [],
      outboundRecords: [],
    };
  }

  const workflow = applySmsStatusUpdate({
    currentMessage: targetMessage,
    updates: {
      status: "replied",
      aiAdvice: replyBody,
    },
    actorName: input.actorName ?? input.official.name,
    timestamp,
  });
  const nextMessageBase = workflow.nextMessage ?? targetMessage;
  const updatedMessage: SmsMessage = {
    ...nextMessageBase,
    assignedTo: nextMessageBase.assignedTo ?? input.official.name,
    assignedAt: nextMessageBase.assignedAt ?? timestamp,
    caseStatus: nextMessageBase.closedAt ? "closed" : "monitoring",
    officialReminderRecipientName: resolvedRecipientName,
    officialReminderRecipientPhone: resolvedRecipientPhone,
    officialReminderDueAt: getOfficialReminderDueAt(timestamp),
  };
  const outboundRecord = await sendOutboundMessage({
    sourceMessage: updatedMessage,
    body: replyBody,
    provider: input.provider,
    providerName: input.providerName,
    audience: "farmer",
    purpose: "manual_reply",
  });

  if (input.official.phone) {
    await sendDirectOfficialSms({
      provider: input.provider,
      phone: input.official.phone,
      body: buildOfficialAckBody(updatedMessage, "reply"),
    });
  }

  return {
    handled: true,
    kind: "reply" as const,
    message: updatedMessage,
    auditLogs: [
      ...(workflow.auditLog ? [workflow.auditLog] : []),
    ],
    logbookEntries: [
      {
        id: `LOG${Date.now()}-${updatedMessage.id}-OFFICIAL-REPLY`,
        farmerId: updatedMessage.farmerId,
        timestamp,
        type: "Payo",
        title: "Sagot ng opisyal via SMS",
        description: replyBody,
      } satisfies LogbookEntry,
    ],
    outboundRecords: [outboundRecord],
  };
}
