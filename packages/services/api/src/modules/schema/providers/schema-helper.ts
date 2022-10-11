import { Injectable, Scope } from 'graphql-modules';
import { print } from 'graphql';
import { createHash } from 'crypto';
import { createSchemaObject } from '../../../shared/entities';
import type {
  SchemaWithSDL,
  Schema,
  CompositeSchema,
  AddedCompositeSchema,
  ModifiedCompositeSchema,
  DeletedCompositeSchema,
  SchemaObject,
} from '../../../shared/entities';
import { CompositeSchemaModel } from './../../../shared/entities';
import { sortDocumentNode } from '../../../shared/schema';
import { cache } from '../../../shared/helpers';

export function isModified(schema: CompositeSchema): schema is ModifiedCompositeSchema {
  return schema.action === 'MODIFY';
}

export function isAdded(schema: CompositeSchema): schema is AddedCompositeSchema {
  return schema.action === 'ADD';
}

export function isDeleted(schema: CompositeSchema): schema is DeletedCompositeSchema {
  return schema.action === 'DELETE';
}

export function isCompositeSchema(schema: Schema): schema is CompositeSchema {
  return 'action' in schema && typeof schema.action === 'string';
}

export function isAddedOrModified(schema: Schema): schema is AddedCompositeSchema | ModifiedCompositeSchema {
  return isCompositeSchema(schema) && (isAdded(schema) || isModified(schema));
}

export function isSchemaWithSDL(schema: Schema): schema is SchemaWithSDL {
  return 'sdl' in schema && typeof schema.sdl === 'string';
}

export function ensureCompositeSchemas(schemas: readonly Schema[]): CompositeSchema[] | never {
  return schemas.map(schema => CompositeSchemaModel.parse(schema));
}

export function ensureSchemaWithSDL(schema: Schema): SchemaWithSDL | never {
  if (isSchemaWithSDL(schema)) {
    return schema;
  }

  throw new Error('Schema does not have SDL');
}

export function ensureSchemasWithSDL(schemas: readonly Schema[]): SchemaWithSDL[] | never {
  return schemas.map(ensureSchemaWithSDL);
}

export function serviceExists(schemas: CompositeSchema[], serviceName: string) {
  return schemas.some(s => s.service_name === serviceName);
}

export function swapServices(
  schemas: CompositeSchema[],
  newSchema: CompositeSchema
): {
  schemas: CompositeSchema[];
  existing: CompositeSchema | null;
} {
  let swapped: CompositeSchema | null = null;
  const output = schemas.map(existing => {
    if (existing.service_name === newSchema.service_name) {
      swapped = existing;
      return newSchema;
    }

    return existing;
  });

  if (!swapped) {
    output.push(newSchema);
  }

  return {
    schemas: output,
    existing: swapped,
  };
}

@Injectable({
  scope: Scope.Operation,
  global: true,
})
export class SchemaHelper {
  @cache<SchemaWithSDL>(schema => JSON.stringify(schema))
  createSchemaObject(schema: SchemaWithSDL): SchemaObject {
    return createSchemaObject(schema);
  }

  sortSchemas(schemas: CompositeSchema[]) {
    return schemas.sort((a, b) => (a.service_name ?? '').localeCompare(b.service_name ?? ''));
  }

  createChecksum(schema: Schema): string {
    return createHash('md5')
      .update(
        isCompositeSchema(schema) && isDeleted(schema)
          ? `${schema.service_name}:DELETED`
          : print(sortDocumentNode(this.createSchemaObject(schema).document)),
        'utf-8'
      )
      .digest('hex');
  }

  ensureJSONMetadata(metadata: string | null | undefined): Record<string, any> | null {
    if (metadata) {
      try {
        return JSON.parse(metadata);
      } catch (e) {
        throw new Error(`Failed to parse schema metadata JSON: ${e instanceof Error ? e.message : e}`);
      }
    }

    return null;
  }
}
