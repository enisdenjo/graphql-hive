import { createModule } from 'graphql-modules';
import { resolvers } from './resolvers';
import { SchemaManager } from './providers/schema-manager';
import { SchemaPublisher } from './providers/schema-publisher';
import { SchemaValidator } from './providers/schema-validator';
import { SchemaHelper } from './providers/schema-helper';
import { orchestrators } from './providers/orchestrators';
import { SingleProject } from './providers/projects/single';
import { CompositeProject } from './providers/projects/composite';
import { CustomProject } from './providers/projects/custom';
import { Inspector } from './providers/inspector';
import typeDefs from './module.graphql';

export const schemaModule = createModule({
  id: 'schema',
  dirname: __dirname,
  typeDefs,
  resolvers,
  providers: [
    SchemaManager,
    SchemaValidator,
    SchemaPublisher,
    Inspector,
    SchemaHelper,
    ...orchestrators,
    SingleProject,
    CompositeProject,
    CustomProject,
  ],
});
