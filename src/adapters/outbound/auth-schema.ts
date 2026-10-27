import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  integer,
  pgTable,
  text,
  timestamp,
  index,
  check,
  foreignKey,
} from 'drizzle-orm/pg-core';

// Names and column casing match Better Auth's existing persistent models.
const date = (name: string) => timestamp(name, { withTimezone: true });

export const admin_auth_user = pgTable('admin_auth_user', {
  id: text().primaryKey(),
  name: text().notNull(),
  email: text().notNull().unique('admin_auth_user_email_key'),
  emailVerified: boolean('emailVerified').notNull().default(false),
  image: text(),
  createdAt: date('createdAt').notNull().defaultNow(),
  updatedAt: date('updatedAt').notNull().defaultNow(),
  username: text().unique('admin_auth_user_username_key'),
  displayUsername: text('displayUsername'),
  twoFactorEnabled: boolean('twoFactorEnabled').default(false),
});

export const admin_auth_session = pgTable(
  'admin_auth_session',
  {
    id: text().primaryKey(),
    expiresAt: date('expiresAt').notNull(),
    token: text().notNull().unique('admin_auth_session_token_key'),
    createdAt: date('createdAt').notNull().defaultNow(),
    updatedAt: date('updatedAt').notNull(),
    ipAddress: text('ipAddress'),
    userAgent: text('userAgent'),
    userId: text('userId').notNull(),
  },
  (table) => [
    foreignKey({
      name: 'admin_auth_session_userId_fkey',
      columns: [table.userId],
      foreignColumns: [admin_auth_user.id],
    }).onDelete('cascade'),
    index('admin_auth_session_userId_idx').on(table.userId),
  ],
);

export const admin_auth_account = pgTable(
  'admin_auth_account',
  {
    id: text().primaryKey(),
    accountId: text('accountId').notNull(),
    providerId: text('providerId').notNull(),
    userId: text('userId').notNull(),
    accessToken: text('accessToken'),
    refreshToken: text('refreshToken'),
    idToken: text('idToken'),
    accessTokenExpiresAt: date('accessTokenExpiresAt'),
    refreshTokenExpiresAt: date('refreshTokenExpiresAt'),
    scope: text(),
    password: text(),
    createdAt: date('createdAt').notNull().defaultNow(),
    updatedAt: date('updatedAt').notNull(),
  },
  (table) => [
    foreignKey({
      name: 'admin_auth_account_userId_fkey',
      columns: [table.userId],
      foreignColumns: [admin_auth_user.id],
    }).onDelete('cascade'),
    index('admin_auth_account_userId_idx').on(table.userId),
  ],
);

export const admin_auth_verification = pgTable(
  'admin_auth_verification',
  {
    id: text().primaryKey(),
    identifier: text().notNull(),
    value: text().notNull(),
    expiresAt: date('expiresAt').notNull(),
    createdAt: date('createdAt').notNull().defaultNow(),
    updatedAt: date('updatedAt').notNull().defaultNow(),
  },
  (table) => [index('admin_auth_verification_identifier_idx').on(table.identifier)],
);

export const admin_auth_rate_limit = pgTable('admin_auth_rate_limit', {
  id: text().primaryKey(),
  key: text().notNull().unique('admin_auth_rate_limit_key_key'),
  count: integer().notNull(),
  lastRequest: bigint('lastRequest', { mode: 'number' }).notNull(),
});

export const admin_auth_two_factor = pgTable(
  'admin_auth_two_factor',
  {
    id: text().primaryKey(),
    secret: text().notNull(),
    backupCodes: text('backupCodes').notNull(),
    userId: text('userId').notNull(),
    verified: boolean().default(true),
    failedVerificationCount: integer('failedVerificationCount').default(0),
    lockedUntil: date('lockedUntil'),
  },
  (table) => [
    foreignKey({
      name: 'admin_auth_two_factor_userId_fkey',
      columns: [table.userId],
      foreignColumns: [admin_auth_user.id],
    }).onDelete('cascade'),
    index('admin_auth_two_factor_userId_idx').on(table.userId),
    index('admin_auth_two_factor_secret_idx').on(table.secret),
  ],
);

export const admin_auth_passkey = pgTable(
  'admin_auth_passkey',
  {
    id: text().primaryKey(),
    name: text(),
    publicKey: text('publicKey').notNull(),
    userId: text('userId').notNull(),
    credentialID: text('credentialID').notNull(),
    counter: integer().notNull(),
    deviceType: text('deviceType').notNull(),
    backedUp: boolean('backedUp').notNull(),
    transports: text(),
    createdAt: date('createdAt'),
    aaguid: text(),
  },
  (table) => [
    foreignKey({
      name: 'admin_auth_passkey_userId_fkey',
      columns: [table.userId],
      foreignColumns: [admin_auth_user.id],
    }).onDelete('cascade'),
    index('admin_auth_passkey_userId_idx').on(table.userId),
    index('admin_auth_passkey_credentialID_idx').on(table.credentialID),
  ],
);

export const passwordRecovery = pgTable(
  'admin_password_recovery',
  {
    id: integer().primaryKey(),
    digest: text(),
    recipient: text(),
    expires_at: date('expires_at'),
    requested_at: date('requested_at'),
    attempts: integer().notNull().default(0),
    user_id: text(),
  },
  (table) => [check('admin_password_recovery_id_check', sql`${table.id} = 1`)],
);

export const mobileRecovery = pgTable('admin_mobile_recovery', {
  user_id: text().primaryKey(),
  profile_chat_id: text(),
  service: text(),
  ha_user_id: text(),
  verified_at: date('verified_at'),
  pending_profile: text(),
  pending_service: text(),
  pending_ha_user: text(),
  pending_digest: text(),
  pending_expires: date('pending_expires'),
  pending_attempts: integer().notNull().default(0),
  requested_at: date('requested_at'),
});
