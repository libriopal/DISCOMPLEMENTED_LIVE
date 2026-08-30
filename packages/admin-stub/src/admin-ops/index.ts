/**
 * Stub admin-ops module — all operations throw "admin module required"
 */
import type { User } from '@bicameral/shared';
import { BicameralError } from '@bicameral/shared';

const ADMIN_REQUIRED = (op: string) =>
  new BicameralError(`"${op}" requires the private @bicameral/admin module.`, 'ADMIN_MODULE_REQUIRED', 501);

export async function banUser(): Promise<void> { throw ADMIN_REQUIRED('banUser'); }
export async function suspendUser(): Promise<void> { throw ADMIN_REQUIRED('suspendUser'); }
export async function promoteUser(): Promise<User> { throw ADMIN_REQUIRED('promoteUser'); }
export async function moderateProject(): Promise<void> { throw ADMIN_REQUIRED('moderateProject'); }
export async function overrideDeploy(): Promise<void> { throw ADMIN_REQUIRED('overrideDeploy'); }
