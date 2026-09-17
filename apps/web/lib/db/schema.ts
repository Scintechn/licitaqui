import {
  bigint,
  boolean,
  char,
  customType,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core'

/**
 * Drizzle definitions for the tables task F1 touches. They mirror
 * `db/migrations/0001_initial.sql` (spec §6.3) and are deliberately partial:
 * the schema is owned by `db/migrations`, so nothing here may drift from it and
 * nothing here creates or alters a table. Columns are named explicitly rather
 * than inferred, so a rename in one place can never silently rename the other.
 */

/**
 * `citext` — case-insensitive text, the type `founders_list.email` uses so that
 * `Maria@empresa.com` and `maria@empresa.com` are the same founder.
 */
const citext = customType<{ data: string; driverData: string }>({
  dataType: () => 'citext',
})

export const foundersList = pgTable('founders_list', {
  id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
  name: text('name').notNull(),
  email: citext('email').notNull().unique(),
  whatsapp: text('whatsapp'),
  cnpj: char('cnpj', { length: 14 }),
  sells: text('sells'),
  /** utm_source, influencer or coupon — never anything that identifies a person. */
  source: text('source'),
  /** 1..48 gets the founder price; null means the waitlist. */
  seat: integer('seat').unique(),
  contactConsent: boolean('contact_consent').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export const jobs = pgTable('jobs', {
  id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
  kind: text('kind').notNull(),
  key: text('key').notNull(),
  priority: integer('priority').notNull().default(5),
  payload: jsonb('payload'),
  status: text('status').notNull().default('queued'),
  attempts: integer('attempts').notNull().default(0),
  runAfter: timestamp('run_after', { withTimezone: true }).notNull().defaultNow(),
  error: text('error'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export const events = pgTable('events', {
  id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
  userId: bigint('user_id', { mode: 'number' }),
  visitorId: uuid('visitor_id'),
  name: text('name').notNull(),
  props: jsonb('props'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})
