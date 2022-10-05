import { Injectable, Scope } from 'graphql-modules';
import type { Schema, AddedCompositeSchema, ModifiedCompositeSchema, Project } from './../../../../shared/entities';
import { CustomOrchestrator } from '../orchestrators/custom';
import type { CheckInput } from '../schema-publisher';
import { SchemaValidator } from './../schema-validator';
import { SchemaManager } from '../schema-manager';
import { SchemaHelper, ensureCompositeSchemas, serviceExists, isAddedOrModified, swapServices } from '../schema-helper';

// todo: drop custom project and implement "external" composition for all projects instead

@Injectable({
  scope: Scope.Operation,
})
export class CustomProject {
  constructor(
    private schemaManager: SchemaManager,
    private schemaValidator: SchemaValidator,
    private orchestrator: CustomOrchestrator,
    private helper: SchemaHelper
  ) {}

  async check({ input, project, currentSchemas }: { project: Project; input: CheckInput; currentSchemas: Schema[] }) {
    const baseSchema = await this.schemaManager.getBaseSchema({
      organization: input.organization,
      project: input.project,
      target: input.target,
    });

    const schemas = ensureCompositeSchemas(currentSchemas);
    const action = serviceExists(schemas, input.service!) ? 'MODIFY' : 'ADD'; // no DELETE yet
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

    const { schemas: afterSchemas, existing } = swapServices(schemas, incoming);

    const before = schemas.filter(isAddedOrModified).map(s => this.helper.createSchemaObject(s));
    const after = afterSchemas.filter(isAddedOrModified).map(s => this.helper.createSchemaObject(s));
    const isInitial = schemas.length === 0;

    const validationResult = await this.schemaValidator.validate({
      orchestrator: this.orchestrator,
      isInitial,
      incoming: this.helper.createSchemaObject(incoming),
      existing: existing && isAddedOrModified(existing) ? this.helper.createSchemaObject(existing) : null,
      before,
      after,
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
    };
  }
}
