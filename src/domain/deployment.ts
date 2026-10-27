export interface BuildRelease {
  runId: string;
  attempt: number;
  runNumber: number;
  sha: string;
}

/** Only this repository's successful main-branch image workflow may deploy. */
export function successfulBuild(payload: any, repository: string): BuildRelease | undefined {
  const run = payload?.workflow_run;
  if (
    payload?.action !== 'completed' ||
    payload?.repository?.full_name !== repository ||
    run?.head_repository?.full_name !== repository ||
    run?.path !== '.github/workflows/images.yaml' ||
    run?.head_branch !== 'main' ||
    !['push', 'workflow_dispatch'].includes(run?.event) ||
    run?.status !== 'completed' ||
    run?.conclusion !== 'success'
  )
    return;
  if (
    !Number.isSafeInteger(run.id) ||
    run.id < 1 ||
    !Number.isSafeInteger(run.run_attempt) ||
    run.run_attempt < 1 ||
    !Number.isSafeInteger(run.run_number) ||
    run.run_number < 1 ||
    !/^[a-f0-9]{40}$/.test(run.head_sha)
  )
    throw new Error('Invalid completed build');
  return {
    runId: String(run.id),
    attempt: run.run_attempt,
    runNumber: run.run_number,
    sha: run.head_sha,
  };
}
