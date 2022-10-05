import { Injectable, Scope } from 'graphql-modules';
import { StitchingOrchestrator } from './../orchestrators/stitching';
import {
  GraphQLDocumentStringInvalidError,
  AddedCompositeSchema,
  ModifiedCompositeSchema,
  Schema,
  Target,
  Project,
  ProjectType,
} from './../../../../shared/entities';
import { HiveError } from '../../../../shared/errors';
import { FederationOrchestrator } from '../orchestrators/federation';
import { SchemaManager } from '../schema-manager';
import type { CheckInput, PublishInput } from '../schema-publisher';
import { SchemaValidator } from './../schema-validator';
import { SchemaHelper, ensureCompositeSchemas, serviceExists, swapServices, isAddedOrModified } from '../schema-helper';

// base_schema is used for everything except federation
// TODO: disable base_schema for federation projects

@Injectable({
  scope: Scope.Operation,
})
export class CompositeProject {
  constructor(
    private schemaManager: SchemaManager,
    private schemaValidator: SchemaValidator,
    private federation: FederationOrchestrator,
    private stitching: StitchingOrchestrator,
    private helper: SchemaHelper
  ) {}

  private supportsMetadata(project: Project) {
    return project.type !== ProjectType.FEDERATION;
  }

  private supportsBaseSchema(project: Project) {
    return project.type !== ProjectType.FEDERATION;
  }

  private supportsSupergraph(project: Project) {
    return project.type === ProjectType.FEDERATION;
  }

  private requiresServiceUrl(project: Project) {
    return project.type === ProjectType.FEDERATION;
  }

  async check({
    input,
    project,
    currentSchemas,
  }: {
    project: Project;
    input: Pick<CheckInput, 'target' | 'sdl' | 'service' | 'organization' | 'project'>;
    currentSchemas: Schema[];
  }) {
    const orchestrator = project.type === ProjectType.FEDERATION ? this.federation : this.stitching;
    const schemas = ensureCompositeSchemas(currentSchemas);
    const action = serviceExists(schemas, input.service!) ? 'MODIFY' : 'ADD';
    const incoming: AddedCompositeSchema | ModifiedCompositeSchema = {
      id: 'temp',
      author: 'temp',
      commit: 'temp',
      target: input.target,
      date: new Date().toISOString(),
      sdl: input.sdl,
      service_name: input.service!,
      service_url: 'temp',
      action,
    };

    const baseSchema = this.supportsBaseSchema(project)
      ? await this.schemaManager.getBaseSchema({
          target: input.target,
          project: input.project,
          organization: input.organization,
        })
      : null;

    const { schemas: afterSchemas, existing } = swapServices(schemas, incoming);

    if (existing?.action === 'DELETE') {
      throw new Error('DELETE is not supported yet');
    }

    const schemaObjects = {
      before: schemas.filter(isAddedOrModified).map(s => this.helper.createSchemaObject(s)),
      after: afterSchemas.filter(isAddedOrModified).map(s => this.helper.createSchemaObject(s)),
    };

    const isInitial = schemas.length === 0;

    const validationResult = await this.schemaValidator.validate({
      orchestrator,
      isInitial,
      incoming: this.helper.createSchemaObject(incoming),
      existing: existing ? this.helper.createSchemaObject(existing) : null,
      before: schemaObjects.before,
      after: schemaObjects.after,
      selector: {
        organization: input.organization,
        project: input.project,
        target: input.target,
      },
      baseSchema,
      experimental_acceptBreakingChanges: false,
      project,
    });

    return {
      validationResult,
      isInitial,
      artifacts: {
        previousService: existing,
        schemaObjects,
        schemas: {
          before: schemas,
          after: afterSchemas,
        },
      },
    };
  }

  async publish({
    input,
    project,
    target,
    currentSchemas,
    version,
  }: {
    input: PublishInput;
    project: Project;
    target: Target;
    currentSchemas: Schema[];
    version: string | null;
  }) {
    const serviceName = input.service;
    const serviceUrl = input.url;
    const orchestrator = project.type === ProjectType.FEDERATION ? this.federation : this.stitching;

    if (!serviceName || typeof serviceName !== 'string' || serviceName.trim() === '') {
      return {
        error: 'MISSING_SERVICE_NAME' as const,
        message: `Can not publish schema for a '${project.type.toLowerCase()}' project without a service name.`,
      };
    }

    if (
      this.requiresServiceUrl(project) &&
      (!serviceUrl || typeof serviceUrl !== 'string' || serviceUrl.trim() === '')
    ) {
      return {
        error: 'MISSING_SERVICE_URL' as const,
        message: `Can not publish schema for a '${project.type.toLowerCase()}' project without a service url.`,
      };
    }

    if (this.supportsMetadata(project)) {
      if (input.metadata) {
        try {
          JSON.parse(input.metadata);
        } catch (e) {
          throw new Error(`Failed to parse schema metadata JSON: ${e instanceof Error ? e.message : e}`);
        }
      }
    }

    const {
      validationResult,
      isInitial,
      artifacts: { previousService, schemas, schemaObjects },
    } = await this.check({
      input: {
        organization: input.organization,
        project: input.project,
        target: input.target,
        sdl: input.sdl,
        service: serviceName,
      },
      project,
      currentSchemas,
    }).catch(async error => {
      if (error instanceof GraphQLDocumentStringInvalidError) {
        throw new HiveError(error.message);
      }
      throw error;
    });

    const incoming: AddedCompositeSchema | ModifiedCompositeSchema = {
      action: previousService ? 'MODIFY' : 'ADD',
      id: 'new-schema',
      author: input.author,
      sdl: input.sdl,
      service_name: serviceName,
      service_url: serviceUrl ?? null,
      commit: input.commit,
      target: target.id,
      date: new Date().toISOString(),
    };

    const { changes, errors, valid } = validationResult;

    const hasNewUrl = version && previousService && previousService.service_url !== incoming.service_url;
    const hasSchemaChanges = changes.length > 0;
    const hasErrors = errors.length > 0;
    const isForced = input.force === true;
    let hasDifferentChecksum = false;

    if (!!version && !!previousService) {
      const before = this.helper
        .sortSchemas(schemas.before)
        .map(s => this.helper.createChecksum(s))
        .join(',');
      const after = this.helper
        .sortSchemas(schemas.after)
        .map(s => this.helper.createChecksum(s))
        .join(',');

      hasDifferentChecksum = before !== after;
    }

    const isModified = hasNewUrl || hasSchemaChanges || hasErrors || hasDifferentChecksum;

    if (!isModified && !isInitial) {
      return {
        action: 'NO_ACTION' as const,
        valid: true,
        isInitial,
        isModified,
      };
    }

    const updates: string[] = [];

    if (hasNewUrl) {
      updates.push(`Updated: New service url: ${incoming.service_url} (previously: ${previousService.service_url})`);
    }

    return {
      action: valid ? ('PUBLISH' as const) : ('REJECT' as const),
      valid,
      changes,
      errors,
      updates,
      service: {
        before: previousService,
        after: incoming,
      },
      schemas: {
        before: schemas.before.filter(isAddedOrModified),
        after: schemas.after.filter(isAddedOrModified),
      },
      cdn: valid
        ? {
            schemas: schemas.after.filter(isAddedOrModified),
            supergraph: this.supportsSupergraph(project)
              ? await orchestrator.supergraph(
                  schemaObjects.after,
                  project.externalComposition.enabled ? project.externalComposition : null
                )
              : null,
          }
        : null,
      isForced,
      isInitial,
      hasErrors,
    };
  }
}
