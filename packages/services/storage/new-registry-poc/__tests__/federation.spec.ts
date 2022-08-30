import { createPool, sql, DatabasePool } from 'slonik';

let pool: DatabasePool;

beforeAll(async () => {
  pool = await createPool('postgres://postgres:postgres@localhost:5432/poc');
  await pool.query(sql`
    DROP TABLE IF EXISTS public.version_commit CASCADE;
    DROP TABLE IF EXISTS public.commits CASCADE;
    DROP TABLE IF EXISTS public.versions CASCADE;
    DROP TABLE IF EXISTS public.targets CASCADE;
    DROP TABLE IF EXISTS public.schema_changes CASCADE;
    DROP TYPE IF EXISTS public.commit_action CASCADE;
    DROP TYPE IF EXISTS public.schema_change_criticality_level CASCADE;
    
    CREATE TYPE commit_action AS ENUM ('ADD', 'MODIFY', 'DELETE');
    CREATE TYPE schema_change_criticality_level AS ENUM ('SAFE', 'DANGEROUS', 'BREAKING');
    
    CREATE TABLE public.targets (
      id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
      name text NOT NULL,
      created_at timestamp with time zone NOT NULL DEFAULT NOW()
    );

    CREATE TABLE public.commits (
      id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
      author text NOT NULL,
      created_at timestamp with time zone NOT NULL DEFAULT NOW(),
      service_name text,
      service_url text,
      sdl text,
      commit text NOT NULL,
      action commit_action NOT NULL
    );

    CREATE TABLE public.versions (
      id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
      created_at timestamp with time zone NOT NULL DEFAULT NOW(),
      is_composable boolean NOT NULL,
      target_id uuid NOT NULL REFERENCES public.targets(id) ON DELETE CASCADE,
      commit_id uuid NOT NULL REFERENCES public.commits(id) ON DELETE CASCADE
    );

    CREATE TABLE public.version_commit (
      version_id uuid NOT NULL REFERENCES public.versions(id) ON DELETE CASCADE,
      commit_id uuid NOT NULL REFERENCES public.commits(id) ON DELETE CASCADE,
      PRIMARY KEY(version_id, commit_id)
    );

    CREATE TABLE public.commit_changes (
      id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
      commit_id uuid NOT NULL REFERENCES public.commits(id) ON DELETE CASCADE,
      coordinate text NOT NULL,
      code text NOT NULL,
      criticality schema_change_criticality_level NOT NULL,
      description text NOT NULL
    );
  `);
});

beforeEach(async () => {
  await pool.query(sql`
    TRUNCATE TABLE public.targets, public.commits, public.versions, public.version_commit, public.commit_changes;
  `);
});

function createTarget() {
  return pool.one<{
    id: string;
  }>(sql`
    INSERT INTO public.targets (name) VALUES ('test') RETURNING id;
  `);
}

async function publish(input: {
  target: {
    id: string;
  };
  author: string;
  serviceName: string;
  serviceUrl: string;
  sdl: string | null;
  commit: string;
  action?: 'DELETE';
  composable: boolean;
  changes: Array<{
    code: string;
    criticality: 'SAFE' | 'DANGEROUS' | 'BREAKING';
    description: string;
    coordinate: string;
  }>;
}) {
  await pool.transaction(async t => {
    const previousCommits = await t.query<{
      commit_id: string;
      version_id: string;
      action: string;
      service_name: string;
    }>(sql`
        SELECT vc.commit_id, vc.version_id, c.action, c.service_name
        FROM public.version_commit as vc 
        INNER JOIN public.commits as c ON (c.id = vc.commit_id)
        WHERE vc.version_id = (
          SELECT id FROM public.versions
          WHERE target_id = ${input.target.id}
          ORDER BY created_at DESC
          LIMIT 1
        )
    `);

    const serviceNameExists =
      previousCommits.rowCount > 0 && previousCommits.rows.some(r => r.service_name === input.serviceName);
    const action = input.action ?? (serviceNameExists ? 'MODIFY' : 'ADD');

    const commit = await t.one<{
      id: string;
      author: string;
      service_name: string;
      service_url: string;
      sdl: string;
      commit: string;
      action: string;
    }>(sql`
      INSERT INTO public.commits
        (author, service_name, service_url, sdl, commit, action)
        VALUES
        (${input.author}, ${input.serviceName}, ${input.serviceUrl}, ${input.sdl}, ${input.commit}, ${action}) RETURNING *;
    `);

    const version = await t.one<{
      id: string;
    }>(sql`
      INSERT INTO public.versions (is_composable, target_id, commit_id) VALUES (${input.composable}, ${input.target.id}, ${commit.id}) RETURNING id;
    `);

    const commits =
      previousCommits.rowCount > 0
        ? previousCommits.rows
            .filter(r => r.service_name !== commit.service_name)
            .map(r => r.commit_id)
            .concat(commit.id)
        : [commit.id];

    await t.query<{}>(sql`
      INSERT INTO public.version_commit (version_id, commit_id) VALUES (${sql.join(
        commits.map(commitId => sql`${version.id}, ${commitId}`),
        sql`), (`
      )});
    `);

    await t.query<{}>(sql`
      INSERT INTO public.commit_changes (
        commit_id,
        coordinate,
        code,
        criticality,
        description
      ) VALUES (${sql.join(
        input.changes.map(
          change =>
            sql`${commit.id}, ${change.coordinate}, ${change.code}, ${change.criticality}, ${change.description}`
        ),
        sql`), (`
      )});
    `);
  });
}

test('add a subgraph', async () => {
  const target = await createTarget();

  // initial publish, non-composable because of missing reviews subgraph
  await publish({
    target,
    author: 'Kamil',
    serviceName: 'products',
    serviceUrl: 'http://products.com/graphql',
    sdl: 'products-sdl',
    commit: '1',
    composable: false,
    changes: [],
  });

  // publish reviews subgraph, turn into composable
  await publish({
    target,
    author: 'Kamil',
    serviceName: 'reviews',
    serviceUrl: 'http://reviews.com/graphql',
    sdl: 'reviews-sdl',
    commit: '2',
    composable: true,
    changes: [],
  });

  // latest version should be composable and point to the reviews subgraph (commit 2)
  const latestVersion = await pool.one<{
    id: string;
    is_composable: boolean;
    commit_id: string;
  }>(sql`
    SELECT id, is_composable, commit_id FROM public.versions WHERE target_id = ${target.id} ORDER BY created_at DESC LIMIT 1
  `);

  expect(latestVersion.is_composable).toBe(true);

  // should have the reviews and products subgraphs
  const commits = await pool.many<{
    commit_id: string;
    action: string;
    service_name: string;
    commit: string;
  }>(sql`
    SELECT vc.commit_id, c.action, c.service_name, c.commit
    FROM public.version_commit as vc
    LEFT JOIN public.commits as c ON (c.id = vc.commit_id)
    WHERE vc.version_id = ${latestVersion.id}
  `);

  expect(commits.length).toBe(2);

  const products = commits.find(c => c.service_name === 'products');
  const reviews = commits.find(c => c.service_name === 'reviews');

  expect(products).toBeDefined();
  expect(reviews).toBeDefined();

  expect(products?.action).toBe('ADD');
  expect(reviews?.action).toBe('ADD');

  expect(products?.commit).toBe('1');
  expect(reviews?.commit).toBe('2');

  expect(latestVersion.commit_id).toBe(reviews?.commit_id);
});

test('modify a subgraph', async () => {
  const target = await createTarget();

  // initial publish, non-composable because of missing reviews subgraph
  await publish({
    target,
    author: 'Kamil',
    serviceName: 'products',
    serviceUrl: 'http://products.com/graphql',
    sdl: 'products-sdl',
    commit: '1',
    composable: false,
    changes: [],
  });

  // publish reviews subgraph, turn into composable
  await publish({
    target,
    author: 'Kamil',
    serviceName: 'reviews',
    serviceUrl: 'http://reviews.com/graphql',
    sdl: 'reviews-sdl',
    commit: '2',
    composable: true,
    changes: [],
  });

  // publish reviews subgraph again
  await publish({
    target,
    author: 'Kamil',
    serviceName: 'reviews',
    serviceUrl: 'http://reviews.com/graphql',
    sdl: 'reviews-modified-sdl',
    commit: '3',
    composable: true,
    changes: [],
  });

  const latestVersion = await pool.one<{
    id: string;
    is_composable: boolean;
    commit_id: string;
  }>(sql`
    SELECT id, is_composable, commit_id FROM public.versions WHERE target_id = ${target.id} ORDER BY created_at DESC LIMIT 1
  `);

  expect(latestVersion.is_composable).toBe(true);

  // should have the reviews and products subgraphs
  const commits = await pool.many<{
    commit_id: string;
    action: string;
    service_name: string;
    commit: string;
  }>(sql`
    SELECT vc.commit_id, c.action, c.service_name, c.commit
    FROM public.version_commit as vc
    LEFT JOIN public.commits as c ON (c.id = vc.commit_id)
    WHERE vc.version_id = ${latestVersion.id}
  `);

  expect(commits.length).toBe(2);

  const products = commits.find(c => c.service_name === 'products');
  const reviews = commits.find(c => c.service_name === 'reviews');

  expect(products).toBeDefined();
  expect(reviews).toBeDefined();

  expect(products?.action).toBe('ADD');
  expect(reviews?.action).toBe('MODIFY');

  expect(products?.commit).toBe('1');
  expect(reviews?.commit).toBe('3');

  expect(latestVersion.commit_id).toBe(reviews?.commit_id);
});

test('delete a subgraph', async () => {
  const target = await createTarget();

  // initial publish, non-composable because of missing reviews subgraph
  await publish({
    target,
    author: 'Kamil',
    serviceName: 'products',
    serviceUrl: 'http://products.com/graphql',
    sdl: 'products-sdl',
    commit: '1',
    composable: false,
    changes: [],
  });

  // publish reviews subgraph, turn into composable
  await publish({
    target,
    author: 'Kamil',
    serviceName: 'reviews',
    serviceUrl: 'http://reviews.com/graphql',
    sdl: 'reviews-sdl',
    commit: '2',
    composable: true,
    changes: [],
  });

  // remove the reviews subgraph
  await publish({
    target,
    author: 'Kamil',
    serviceName: 'reviews',
    serviceUrl: 'http://reviews.com/graphql',
    sdl: null,
    commit: '3',
    composable: true,
    action: 'DELETE',
    changes: [],
  });

  const latestVersion = await pool.one<{
    id: string;
    is_composable: boolean;
    commit_id: string;
  }>(sql`
    SELECT id, is_composable, commit_id FROM public.versions WHERE target_id = ${target.id} ORDER BY created_at DESC LIMIT 1
  `);

  expect(latestVersion.is_composable).toBe(true);

  // should have the reviews and products subgraphs
  const commits = await pool.many<{
    commit_id: string;
    action: string;
    service_name: string;
    commit: string;
  }>(sql`
    SELECT vc.commit_id, c.action, c.service_name, c.commit
    FROM public.version_commit as vc
    LEFT JOIN public.commits as c ON (c.id = vc.commit_id)
    WHERE vc.version_id = ${latestVersion.id}
  `);

  expect(commits.length).toBe(2);

  const products = commits.find(c => c.service_name === 'products');
  const reviews = commits.find(c => c.service_name === 'reviews');

  expect(products).toBeDefined();
  expect(reviews).toBeDefined();

  expect(products?.action).toBe('ADD');
  expect(reviews?.action).toBe('DELETE');

  expect(products?.commit).toBe('1');
  expect(reviews?.commit).toBe('3');

  expect(latestVersion.commit_id).toBe(reviews?.commit_id);
});

test('tell when subgraph was added', async () => {
  const target = await createTarget();

  // initial publish, non-composable because of missing reviews subgraph
  await publish({
    target,
    author: 'Kamil',
    serviceName: 'products',
    serviceUrl: 'http://products.com/graphql',
    sdl: 'products-sdl',
    commit: '1',
    composable: false,
    changes: [],
  });

  // publish reviews subgraph, turn into composable
  await publish({
    target,
    author: 'Kamil',
    serviceName: 'reviews',
    serviceUrl: 'http://reviews.com/graphql',
    sdl: 'reviews-sdl',
    commit: '2',
    composable: true,
    changes: [],
  });

  // remove the reviews subgraph
  await publish({
    target,
    author: 'Kamil',
    serviceName: 'reviews',
    serviceUrl: 'http://reviews.com/graphql',
    sdl: 'reviews-modified-sdl',
    commit: '3',
    composable: true,
    changes: [],
  });

  const added = await pool.one<{
    created_at: string;
    commit: string;
  }>(sql`
    SELECT c.created_at, c.commit FROM public.commits as c
    INNER JOIN public.versions as v ON (v.commit_id = c.id)
    WHERE v.target_id = ${target.id} AND c.action = 'ADD' AND c.service_name = 'reviews'
    ORDER BY c.created_at DESC LIMIT 1
  `);

  expect(added.commit).toBe('2');
  expect(added.created_at).toBeDefined();
});

test('tell when subgraph was most recently modified', async () => {
  const target = await createTarget();

  // initial publish, non-composable because of missing reviews subgraph
  await publish({
    target,
    author: 'Kamil',
    serviceName: 'products',
    serviceUrl: 'http://products.com/graphql',
    sdl: 'products-sdl',
    commit: '1',
    composable: false,
    changes: [],
  });

  // publish reviews subgraph, turn into composable
  await publish({
    target,
    author: 'Kamil',
    serviceName: 'reviews',
    serviceUrl: 'http://reviews.com/graphql',
    sdl: 'reviews-sdl',
    commit: '2',
    composable: true,
    changes: [],
  });

  // remove the reviews subgraph
  await publish({
    target,
    author: 'Kamil',
    serviceName: 'reviews',
    serviceUrl: 'http://reviews.com/graphql',
    sdl: 'reviews-modified-sdl',
    commit: '3',
    composable: true,
    changes: [],
  });

  const modified = await pool.one<{
    created_at: string;
    commit: string;
  }>(sql`
    SELECT c.created_at, c.commit FROM public.commits as c
    INNER JOIN public.versions as v ON (v.commit_id = c.id)
    WHERE v.target_id = ${target.id} AND c.action = 'MODIFY' AND c.service_name = 'reviews'
    ORDER BY c.created_at DESC LIMIT 1
  `);

  expect(modified.commit).toBe('3');
  expect(modified.created_at).toBeDefined();
});

test('tell when subgraph was deleted', async () => {
  const target = await createTarget();

  // initial publish, non-composable because of missing reviews subgraph
  await publish({
    target,
    author: 'Kamil',
    serviceName: 'products',
    serviceUrl: 'http://products.com/graphql',
    sdl: 'products-sdl',
    commit: '1',
    composable: false,
    changes: [],
  });

  // publish reviews subgraph, turn into composable
  await publish({
    target,
    author: 'Kamil',
    serviceName: 'reviews',
    serviceUrl: 'http://reviews.com/graphql',
    sdl: 'reviews-sdl',
    commit: '2',
    composable: true,
    changes: [],
  });

  // remove the reviews subgraph
  await publish({
    target,
    author: 'Kamil',
    serviceName: 'reviews',
    serviceUrl: 'http://reviews.com/graphql',
    sdl: null,
    commit: '3',
    composable: true,
    action: 'DELETE',
    changes: [],
  });

  // add the reviews subgraph again
  await publish({
    target,
    author: 'Kamil',
    serviceName: 'reviews',
    serviceUrl: 'http://reviews.com/graphql',
    sdl: 'reviews-added-again-sdl',
    commit: '4',
    composable: true,
    changes: [],
  });

  const deleted = await pool.one<{
    created_at: string;
    commit: string;
  }>(sql`
    SELECT c.created_at, c.commit FROM public.commits as c
    INNER JOIN public.versions as v ON (v.commit_id = c.id)
    WHERE v.target_id = ${target.id} AND c.action = 'DELETE' AND c.service_name = 'reviews'
    ORDER BY c.created_at DESC LIMIT 1
  `);

  expect(deleted.commit).toBe('3');
  expect(deleted.created_at).toBeDefined();
});
