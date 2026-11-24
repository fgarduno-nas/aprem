import { prisma } from "../../config/database.js";
import { buildAuditRecord } from "./audit-record.js";

export async function createAuditLog(parameters, client = prisma) {
  return client.auditLog.create({ data: buildAuditRecord(parameters) });
}
