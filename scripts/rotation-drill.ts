// #1236: prove a token rotation, do not assume one.
//
//   npm run rotate:drill            # dry run: prints the steps, writes nothing
//   npm run rotate:drill -- --apply # mint, use, rotate and verify in a throwaway DB
//
// The drill never opens the live database. Without `--db` it creates a fresh
// temporary directory; `--db` is refused unless it is inside the temporary root
// and is not the configured DB_PATH or DATA_DIR. A production environment is
// refused before the file is opened. No token is printed: the audit rows name
// the job and repository only.

import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Store } from '../src/db.js'
import { drillDbRefusal, runRotationDrill } from './lib/rotationDrill.js'

function argValue(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag)
  if (index === -1) return undefined
  const value = argv[index + 1]
  return value === undefined || value.startsWith('--') ? undefined : value
}

export function main(argv = process.argv.slice(2)): number {
  const apply = argv.includes('--apply')
  const keep = argv.includes('--keep')
  const dbArg = argValue(argv, '--db')

  if (!apply) {
    console.log('rotation: dry run — pass --apply to mint, rotate and verify in a throwaway database')
    console.log('rotation: steps: mint a job token and an instance token; use both; revoke and replace; verify the old ones are refused and the new ones work; audit each step')
    return 0
  }

  const refusal = drillDbRefusal({ dbPath: dbArg })
  if (refusal !== null) {
    console.error(`rotation: ${refusal}`)
    return 2
  }

  const tempDir = dbArg === undefined ? mkdtempSync(join(tmpdir(), 'fledge-rotation-drill-')) : undefined
  const store = new Store(dbArg ?? join(tempDir!, 'drill.db'))
  try {
    const user = store.upsertGithubUser({
      id: 'usr_rotation_drill',
      githubId: 0,
      login: 'rotation-drill',
      name: 'Rotation drill',
      email: null,
      avatarUrl: null,
      isAdmin: false,
      initialQuotaCny: 0,
    })
    store.setUserStatus(user.id, 'approved', 'rotation-drill')
    const repo = store.createRepo({
      id: 'repo_rotation_drill',
      userId: user.id,
      owner: 'drill',
      name: 'rotation',
      defaultBranch: 'main',
      tokenEnc: '',
      permission: 'admin',
      repoRole: 'maintainer',
      goal: '',
      autoIterate: false,
      intervalMinutes: 1440,
    })
    const job = store.createJob({
      id: 'job_rotation_drill',
      repoId: repo.id,
      userId: user.id,
      trigger: 'manual',
      goal: 'rotation drill',
      callbackHash: 'rotation-drill',
      platformTokenHash: '',
    })

    const result = runRotationDrill({
      store,
      userId: user.id,
      repoId: repo.id,
      jobId: job.id,
      key: randomBytes(32).toString('base64'),
    })
    for (const step of result.steps) console.log(`rotation: ${step}`)
    const actions = store
      .listAudit(20)
      .filter((row) => row.action.startsWith('rotation.drill.'))
      .map((row) => row.action)
    console.log(`rotation: audit ${actions.join(', ')}`)
    if (!result.ok) {
      console.error(`rotation: drill failed — ${String(result.reason)}`)
      return 1
    }
    console.log('rotation: drill passed')
    return 0
  } finally {
    store.close()
    if (tempDir !== undefined) {
      if (keep) console.log(`rotation: kept ${tempDir}`)
      else rmSync(tempDir, { recursive: true, force: true })
    }
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main()
}
