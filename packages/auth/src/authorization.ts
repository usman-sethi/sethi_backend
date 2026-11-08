import { ForbiddenError } from "./errors.js";
import {
  roleHasPermission,
  type Permission,
  type PublicAuthUser,
  type UserRole,
} from "./types.js";

export function requireRole(
  user: Pick<PublicAuthUser, "role">,
  ...allowedRoles: readonly UserRole[]
): void {
  if (!allowedRoles.includes(user.role)) {
    throw new ForbiddenError();
  }
}

export function requirePermission(
  user: Pick<PublicAuthUser, "role">,
  permission: Permission,
): void {
  if (!roleHasPermission(user.role, permission)) {
    throw new ForbiddenError();
  }
}
