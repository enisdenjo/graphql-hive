import { DocumentNode, GraphQLError, SourceLocation } from 'graphql';
import { z } from 'zod';
import type {
  SchemaError,
  AlertChannelType,
  AlertType,
  AuthProvider,
  OrganizationAccessScope,
  ProjectAccessScope,
  TargetAccessScope,
} from '../__generated__/types';
import { parse } from 'graphql';

export const SingleSchemaModel = z
  .object({
    id: z.string(),
    author: z.string(),
    date: z.number(),
    commit: z.string(),
    target: z.string(),
    sdl: z.string(),
    metadata: z.any().nullish(),
  })
  .required();

export type SingleSchema = z.infer<typeof SingleSchemaModel>;

export const DeletedCompositeSchemaModel = z
  .object({
    id: z.string(),
    author: z.string(),
    date: z.number(),
    commit: z.string(),
    target: z.string(),
    service_name: z.string(),
    action: z.literal('DELETE'),
  })
  .required();

export type DeletedCompositeSchema = z.infer<typeof DeletedCompositeSchemaModel>;

export const AddedCompositeSchemaModel = z
  .object({
    id: z.string(),
    author: z.string(),
    date: z.number(),
    commit: z.string(),
    target: z.string(),
    sdl: z.string(),
    service_name: z.string(),
    service_url: z.string().nullable(),
    action: z.literal('ADD'),
    metadata: z.any().nullish(),
  })
  .required();

export type AddedCompositeSchema = z.infer<typeof AddedCompositeSchemaModel>;

export const ModifiedCompositeSchemaModel = z
  .object({
    id: z.string(),
    author: z.string(),
    date: z.number(),
    commit: z.string(),
    target: z.string(),
    sdl: z.string(),
    service_name: z.string(),
    service_url: z.string().nullable(),
    action: z.literal('MODIFY'),
    metadata: z.any().nullish(),
  })
  .required();

export type ModifiedCompositeSchema = z.infer<typeof ModifiedCompositeSchemaModel>;

export const CompositeSchemaModel = z.union([
  DeletedCompositeSchemaModel,
  AddedCompositeSchemaModel,
  ModifiedCompositeSchemaModel,
]);
export type CompositeSchema = z.infer<typeof CompositeSchemaModel>;
export type Schema = SingleSchema | CompositeSchema;
export type SchemaWithSDL = SingleSchema | AddedCompositeSchema | ModifiedCompositeSchema;

export interface DateRange {
  from: Date;
  to: Date;
}

export interface SchemaVersion {
  id: string;
  isComposable: boolean;
  date: number;
  commit: string;
  base_schema: string | null;
}

export interface SchemaObject {
  document: DocumentNode;
  source: string;
  url?: string | null;
  raw: string;
}

export interface PersistedOperation {
  id: string;
  operationHash: string;
  name: string;
  kind: string;
  project: string;
  content: string;
  date: string;
}

export const emptySource = '*';

export class GraphQLDocumentStringInvalidError extends Error {
  constructor(message: string, location?: SourceLocation) {
    const locationString = location ? ` at line ${location.line}, column ${location.column}` : '';
    super(`The provided SDL is not valid${locationString}\n: ${message}`);
  }
}

export function createSchemaObject(
  schema: SingleSchema | AddedCompositeSchema | ModifiedCompositeSchema
): SchemaObject {
  let document: DocumentNode;

  try {
    document = parse(schema.sdl);
  } catch (err) {
    if (err instanceof GraphQLError) {
      throw new GraphQLDocumentStringInvalidError(err.message, err.locations?.[0]);
    }
    throw err;
  }

  return {
    document,
    raw: schema.sdl,
    source: 'service_name' in schema ? schema.service_name : emptySource,
    url: 'service_url' in schema ? schema.service_url : null,
  };
}

export enum ProjectType {
  FEDERATION = 'FEDERATION',
  STITCHING = 'STITCHING',
  SINGLE = 'SINGLE',
  CUSTOM = 'CUSTOM',
}

export enum OrganizationType {
  PERSONAL = 'PERSONAL',
  REGULAR = 'REGULAR',
}

export interface OrganizationGetStarted {
  id: string;
  creatingProject: boolean;
  publishingSchema: boolean;
  checkingSchema: boolean;
  invitingMembers: boolean;
  reportingOperations: boolean;
  enablingUsageBasedBreakingChanges: boolean;
}

export interface Organization {
  id: string;
  cleanId: string;
  name: string;
  type: OrganizationType;
  billingPlan: string;
  monthlyRateLimit: {
    retentionInDays: number;
    operations: number;
  };
  getStarted: OrganizationGetStarted;
}

export interface OrganizationInvitation {
  organization_id: string;
  code: string;
  email: string;
  created_at: string;
  expires_at: string;
}

export interface OrganizationBilling {
  organizationId: string;
  externalBillingReference: string;
  billingEmailAddress?: string | null;
}

export interface Project {
  id: string;
  cleanId: string;
  orgId: string;
  name: string;
  type: ProjectType;
  buildUrl?: string | null;
  validationUrl?: string | null;
  gitRepository?: string | null;
  externalComposition:
    | {
        enabled: true;
        endpoint: string;
        encryptedSecret: string;
      }
    | {
        enabled: false;
        endpoint: null;
        encryptedSecret: null;
      };
}

export interface Target {
  id: string;
  cleanId: string;
  projectId: string;
  orgId: string;
  name: string;
}

export interface Token {
  token: string;
  tokenAlias: string;
  name: string;
  target: string;
  project: string;
  organization: string;
  date: string;
  lastUsedAt: string;
  scopes: readonly string[];
}

export interface User {
  id: string;
  email: string;
  fullName: string;
  displayName: string;
  provider: AuthProvider;
  superTokensUserId: string | null;
  isAdmin: boolean;
  externalAuthUserId: string | null;
}

export interface Member {
  id: string;
  user: User;
  organization: string;
  scopes: Array<OrganizationAccessScope | ProjectAccessScope | TargetAccessScope>;
}

export interface TargetSettings {
  validation: {
    enabled: boolean;
    period: number;
    percentage: number;
    targets: readonly string[];
    excludedClients: readonly string[];
  };
}

export interface Orchestrator {
  ensureConfig(config: any): void | never;
  validate(schemas: readonly SchemaObject[], config: any): Promise<SchemaError[]>;
  build(schemas: readonly SchemaObject[], config: any): Promise<SchemaObject>;
  supergraph(schemas: readonly SchemaObject[], config: any): Promise<string | null>;
}

export interface ActivityObject {
  id: string;
  type: string;
  meta: any;
  createdAt: Date;
  target?: Target;
  project?: Project;
  organization: Organization;
  user?: User;
}

export interface AlertChannel {
  id: string;
  projectId: string;
  type: AlertChannelType;
  name: string;
  createdAt: string;
  slackChannel: string | null;
  webhookEndpoint: string | null;
}

export interface Alert {
  id: string;
  type: AlertType;
  channelId: string;
  organizationId: string;
  projectId: string;
  targetId: string;
  createdAt: string;
}

export interface AdminOrganizationStats {
  organization: Organization;
  versions: number;
  users: number;
  projects: number;
  targets: number;
  persistedOperations: number;
  daysLimit?: number | null;
}
