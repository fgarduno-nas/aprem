// Shared audit payload: never include passwords or password hashes in metadata.
export function buildAuditRecord({
  actorId = null,
  entityType,
  entityId,
  action,
  description,
  metadata = null,
  ipAddress = null,
  userAgent = null,
}) {
  return { actorId, entityType, entityId, action, description, metadata, ipAddress, userAgent };
}
