import { Injectable, Scope } from 'graphql-modules';
import { parse, concatAST } from 'graphql';
import { Orchestrator, SchemaObject, Project } from '../../../shared/entities';
import { buildSchema, hashSchema } from '../../../shared/schema';
import * as Types from '../../../__generated__/types';
import { Logger } from '../../shared/providers/logger';
import { sentry } from '../../../shared/sentry';
import { SchemaHelper } from './schema-helper';
import { Inspector } from './inspector';

export type ValidationResult = {
  valid: boolean;
  isComposable: boolean;
  errors: Array<Types.SchemaError>;
  changes: Array<Types.SchemaChange>;
};

@Injectable({
  scope: Scope.Operation,
})
export class SchemaValidator {
  private logger: Logger;

  constructor(logger: Logger, private inspector: Inspector, private helper: SchemaHelper) {
    this.logger = logger.child({ service: 'SchemaValidator' });
  }

  @sentry('SchemaValidator.validate')
  async validate({
    orchestrator,
    selector,
    incoming,
    existing,
    isInitial,
    before,
    after,
    baseSchema,
    experimental_acceptBreakingChanges,
    project,
  }: {
    orchestrator: Orchestrator;
    isInitial: boolean;
    incoming: SchemaObject;
    existing: SchemaObject | null;
    before: readonly SchemaObject[];
    after: readonly SchemaObject[];
    selector: Types.TargetSelector;
    baseSchema: string | null;
    experimental_acceptBreakingChanges: boolean;
    project: Project;
  }): Promise<ValidationResult> {
    this.logger.debug('Validating Schema');
    const afterWithBase = baseSchema
      ? after.map((schema, index) => {
          if (index === 0) {
            return {
              ...schema,
              raw: (baseSchema || '') + schema.raw,
              document: concatAST([parse(baseSchema || ''), schema.document]),
            };
          } else {
            return schema;
          }
        })
      : after;

    const areIdentical = existing && hashSchema(existing) === hashSchema(incoming);

    if (areIdentical) {
      return {
        valid: true,
        isComposable: true,
        errors: [],
        changes: [],
      };
    }

    const errors = await orchestrator.validate(
      afterWithBase,
      project.externalComposition.enabled ? project.externalComposition : null
    );

    if (isInitial) {
      return {
        valid: errors.length === 0,
        isComposable: errors.length === 0,
        errors: errors,
        changes: [],
      };
    }

    let changes: Types.SchemaChange[] = [];

    try {
      const [existingSchema, incomingSchema] = await Promise.all([
        orchestrator.build(before, project.externalComposition),
        orchestrator.build(after, project.externalComposition),
      ]);
      if (existingSchema) {
        changes = await this.inspector.diff(buildSchema(existingSchema), buildSchema(incomingSchema), selector);

        const hasBreakingChanges = changes.some(change => change.criticality === 'Breaking');

        if (hasBreakingChanges) {
          if (experimental_acceptBreakingChanges) {
            this.logger.debug('Schema contains breaking changes, but the experimental safe mode is enabled');
          } else {
            changes.forEach(change => {
              if (change.criticality === 'Breaking') {
                errors.push({
                  message: `Breaking Change: ${change.message}`,
                  path: change.path,
                });
              }
            });
          }
        }
      }
    } catch (error) {
      errors.push({
        message: `Failed to compare schemas: ${(error as Error).message}`,
      });
    }

    const hasErrors = errors.length > 0; // no errors means no breaking changes
    const valid = !hasErrors;

    return {
      valid,
      isComposable: valid,
      errors,
      changes,
    };
  }
}
