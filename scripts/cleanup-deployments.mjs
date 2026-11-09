import { pathToFileURL } from 'node:url';

export async function cleanupDeployments(github, repo, log = console.log) {
  const deployments = await github.paginate(github.rest.repos.listDeployments, {
    ...repo, environment: 'github-pages', per_page: 100,
  });
  deployments.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at) || b.id - a.id);
  let deleted = 0;
  for (const deployment of deployments.slice(5)) {
    const { data: statuses } = await github.rest.repos.listDeploymentStatuses({
      ...repo, deployment_id: deployment.id, per_page: 1,
    });
    // Never deactivate a deployment to make it deletable. Unknown states stay.
    if (statuses[0]?.state !== 'inactive') continue;
    await github.rest.repos.deleteDeployment({ ...repo, deployment_id: deployment.id });
    deleted += 1;
    log(`Deleted inactive deployment ${deployment.id} (${deployment.created_at})`);
  }
  log(`Deleted ${deleted} deployment records; kept ${deployments.length - deleted}.`);
}

// Runnable offline regression check: node scripts/cleanup-deployments.mjs
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { default: assert } = await import('node:assert/strict');
  const states = ['inactive', 'inactive', 'inactive', 'inactive', 'inactive',
    'success', 'in_progress', 'queued', 'pending', 'error', 'failure', undefined, 'inactive'];
  const deployments = states.map((state, id) => ({ id, created_at: new Date(2026, 0, 20 - id).toISOString() }));
  const deleted = [];
  const checked = [];
  const github = {
    paginate: async (_method, options) => {
      assert.equal(options.environment, 'github-pages');
      return [...deployments].reverse();
    },
    rest: { repos: {
      listDeployments() {},
      listDeploymentStatuses: async ({ deployment_id }) => {
        checked.push(deployment_id);
        return { data: states[deployment_id] ? [{ state: states[deployment_id] }] : [] };
      },
      deleteDeployment: async ({ deployment_id }) => { deleted.push(deployment_id); },
    } },
  };
  await cleanupDeployments(github, { owner: 'test', repo: 'test' }, () => {});
  assert.deepEqual(checked, [5, 6, 7, 8, 9, 10, 11, 12]);
  assert.deepEqual(deleted, [12]);
  console.log('Deployment cleanup check passed: newest five and non-inactive records preserved.');
}
