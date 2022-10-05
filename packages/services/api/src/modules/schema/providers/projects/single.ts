import { Injectable, Scope } from 'graphql-modules';
import type { Schema, Project, Target, SingleSchema } from './../../../../shared/entities';
import { SingleSchemaModel, GraphQLDocumentStringInvalidError } from '../../../../shared/entities';
import { HiveError } from '../../../../shared/errors';
import { SingleOrchestrator } from '../orchestrators/single';
import type { CheckInput, PublishInput } from '../schema-publisher';
import { SchemaValidator } from './../schema-validator';
import { SchemaManager } from '../schema-manager';
import { ensureSchemaWithSDL, SchemaHelper } from '../schema-helper';

@Injectable({
  scope: Scope.Operation,
})
export class SingleProject {
  constructor(
    private schemaManager: SchemaManager,
    private schemaValidator: SchemaValidator,
    private orchestrator: SingleOrchestrator,
    private helper: SchemaHelper
  ) {}

  async check({ input, project, currentSchemas }: { project: Project; input: CheckInput; currentSchemas: Schema[] }) {
    const baseSchema = await this.schemaManager.getBaseSchema({
      organization: input.organization,
      project: input.project,
      target: input.target,
    });

    if (currentSchemas.length > 1) {
      throw new Error('Single-schema project can only have a single schema');
    }

    const existing = currentSchemas.length === 1 ? ensureSchemaWithSDL(currentSchemas[0]) : null;
    const existingObject = existing ? this.helper.createSchemaObject(SingleSchemaModel.parse(existing)) : null;

    const incoming: SingleSchema = {
      id: 'temp',
      author: 'temp',
      commit: 'temp',
      target: input.target,
      date: new Date().toISOString(),
      sdl: input.sdl,
    };
    const incomingObject = this.helper.createSchemaObject(incoming);

    const isInitial = existing === null;

    const validationResult = await this.schemaValidator.validate({
      orchestrator: this.orchestrator,
      isInitial,
      incoming: incomingObject,
      existing: existingObject,
      before: existingObject ? [existingObject] : [],
      after: [incomingObject],
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
        schema: {
          before: existing,
          after: incoming,
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
    const {
      validationResult,
      isInitial,
      artifacts: { schema },
    } = await this.check({
      input: {
        organization: input.organization,
        project: input.project,
        target: input.target,
        sdl: input.sdl,
      },
      project,
      currentSchemas,
    }).catch(async error => {
      if (error instanceof GraphQLDocumentStringInvalidError) {
        throw new HiveError(error.message);
      }
      throw error;
    });

    const incoming: SingleSchema = {
      id: 'new-schema',
      author: input.author,
      sdl: input.sdl,
      commit: input.commit,
      target: target.id,
      date: new Date().toISOString(),
    };

    const { changes, errors, valid } = validationResult;

    const hasNewUrl = false;
    const hasSchemaChanges = changes.length > 0;
    const hasErrors = errors.length > 0;
    const isForced = input.force === true;
    let hasDifferentChecksum = false;

    if (!!version && !!schema.before) {
      hasDifferentChecksum = this.helper.createChecksum(schema.before) !== this.helper.createChecksum(incoming);
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

    return {
      action: valid ? ('PUBLISH' as const) : ('REJECT' as const),
      valid,
      changes,
      errors,
      updates: [],
      service: {
        before: schema.before,
        after: schema.after,
      },
      schemas: {
        before: schema.before ? [schema.before] : [],
        after: [schema.after],
      },
      cdn: valid
        ? {
            schemas: [schema.after],
            supergraph: null,
          }
        : null,
      isForced,
      isInitial,
      hasErrors,
    };
  }
}
